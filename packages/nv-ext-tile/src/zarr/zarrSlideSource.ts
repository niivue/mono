import type {
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideTileManifest,
  NVSlideTileSamples,
  NVSlideWindow,
  SlidePlaneCapable,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { omeLengthToMicrons, settleBy } from '@niivue/niivue'
import * as zarr from '@niivue/zarrita-rs/inline'
import {
  grayInto,
  MAX_DEFAULT_VISIBLE,
  MAX_TILE_SIZE,
  MAX_TILES,
  type Quantize,
  quantizeRange,
  storedToValue,
  storedWindow,
} from '../channelDisplay'
import { sampleLevel } from '../levelSample'
import { anySignal } from '../rangeFetch'
import { resolveChunkWorkerCount } from './chunkWorkerRouting'
import { copyStrided } from './copyStrided'
import {
  checkOmeZarrIndex,
  omeroActiveChannels,
  omeroWindowUsable,
} from './omeZarr'
import {
  ByteLruCache,
  OME_ZARR_CHUNK_ERROR,
  withMetadata,
} from './omeZarrChunkedSource'
import type { OmeZarrChunkWorkerPool } from './omeZarrChunkWorkerPool'
import {
  countingFetch,
  omeZarrChannelName,
  omeZarrFetchStore,
  omeZarrNiftiDatatype,
  openOmeZarr,
  type ZarrFetch,
} from './omeZarrLoader'

export interface ZarrSlideOptions {
  /** Manifest id; defaults to the store name. */
  id?: string
  /**
   * Channel to show in grey. Default: an RGB store (3 uint8 channels) shows
   * in colour, a multi-channel one serves every channel to NVSlide.
   */
  channel?: number
  /** Focal plane shown first (default omero `defaultZ`, else 0); `preparePlane` switches it. */
  z?: number
  /** Timepoint shown first (default omero `defaultT`, else 0); `preparePlane` switches it. */
  t?: number
  /**
   * Budget of the in-memory cache of raw store bytes (chunks, shard indices,
   * absences), so a channel shown again or a tile evicted by NVSlide is not
   * refetched. Default 64 MiB; 0 disables it.
   */
  cacheBytes?: number
}

export interface ZarrSlideUrlOptions extends ZarrSlideOptions {
  /**
   * Custom fetch, e.g. one that adds auth headers ({@link ZarrFetch}). A
   * function cannot cross to a worker, so tiles then decode on this thread.
   */
  fetch?: ZarrFetch
  /**
   * Chunk workers that read and decode tiles. Omit for the default (half the
   * reported cores, at most four); 0 decodes on this thread, as does a page
   * without Workers or a worker that fails. `cacheBytes` is split across them.
   */
  workers?: number
  /** Aborts opening. */
  signal?: AbortSignal
}

/** Default {@link ZarrSlideOptions.cacheBytes}. */
export const ZARR_SLIDE_CACHE_BYTES = 64 * 2 ** 20

type Plane = { z: number; t: number }
type Display = { quantize: Quantize | null; window: NVSlideWindow }
type Samples =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
type Block = { data: Samples; stride: number[] }

/**
 * NVSlide tile source for a 2D OME-Zarr image (0.4 / Zarr v2 and 0.5 / v3):
 * each multiscale dataset is a level and each y/x chunk (the inner chunk of a
 * shard) a tile. Three uint8 channels show as RGB, fluorescence included
 * (pass `channel` for one). Other stores state omero label, colour, window and
 * `active` in `manifest.channelInfo`; with more than one channel each visible
 * channel's samples come through `fetchTileSamples`, so NVSlide composites
 * them, and a single channel (or `channel`) goes as `raw-gray`. uint8/uint16
 * pass through; other dtypes are quantized to uint16 per channel over the
 * omero min..max, else an approximate data range sampled from the coarsest
 * level, stating the inverse as `channelInfo[c].storedToValue`. Without a
 * usable omero window, a channel's default window is the 2-98% range of that
 * sample, as for volumes. A hidden channel that needs that sample reads it
 * when first shown, before its first tile ({@link SlideSourceHost.channelInfoChanged}).
 * A store with z or t > 1 opens at plane {@link ZarrSlideOptions.z}/`t` and
 * switches with `preparePlane`.
 */
export class ZarrSlideSource implements SlideTileSource, SlidePlaneCapable {
  private host: SlideSourceHost | null = null
  private readonly closed = new AbortController()
  /** Set only for a multi-channel store: NVSlide takes this path when present. */
  readonly fetchTileSamples?: SlideTileSource['fetchTileSamples']
  /** Per store channel; null passes samples through, undefined: not resolved yet. */
  private readonly quantize: (Quantize | null | undefined)[]
  /** Hidden channels' deferred display reads, by store channel. */
  private readonly resolving: (Promise<void> | undefined)[] = []
  /** The whole cache budget; this thread's share while a pool runs. */
  private readonly cacheBytes: number
  /** Chunk workers that read and decode tiles off this thread (fromUrl). */
  private pool: OmeZarrChunkWorkerPool | null = null

  private constructor(
    readonly manifest: NVSlideManifest,
    readonly planes: NVSlidePlaneAxes,
    private readonly arrays: zarr.Array<zarr.DataType, zarr.Readable>[],
    private readonly cache: ByteLruCache | null,
    private readonly select: (
      y: zarr.Slice,
      x: zarr.Slice,
      level: number,
      c: zarr.Slice,
      plane: Plane,
    ) => (number | zarr.Slice | null)[],
    /** Levels of `plane`, or the RangeError why it cannot show. */
    private readonly levelsAt: (plane: Plane) => NVSlideLevelManifest[],
    private readonly display: (
      c: number,
      signal: AbortSignal,
    ) => Promise<Display>,
    private readonly rgb: boolean,
    /** Positions of y, x and c among a read's dims (c: -1 without a c axis). */
    private readonly pos: readonly [number, number, number],
    /** The c axis, or -1. */
    private readonly cDim: number,
    /** The channel fetchTileBytes reads (unused for RGB). */
    private readonly channel: number,
    quantize: (Quantize | null | undefined)[],
    /** Level `level`'s index of plane z. */
    private readonly zAt: (level: number, z: number) => number,
    private readonly dtype: string,
  ) {
    this.quantize = quantize
    this.cacheBytes = cache?.maxBytes ?? 0
    if ((manifest.channelInfo?.length ?? 0) > 1)
      this.fetchTileSamples = this.tileSamples.bind(this)
  }

  /** Stream a store by URL (its root group). */
  static async fromUrl(
    url: string,
    options: ZarrSlideUrlOptions = {},
  ): Promise<ZarrSlideSource> {
    let source: ZarrSlideSource | null = null
    // The open's metadata reads, handed to the chunk workers (SRC-17).
    const metadata = new Map<string, Uint8Array | undefined>()
    const counted = countingFetch(options.fetch, (bytes) =>
      source?.host?.addWireBytes(bytes),
    )
    // While opening, the open signal cancels metadata and data-range reads.
    const fetched = omeZarrFetchStore(url, (u, init) =>
      counted(u, {
        ...init,
        signal: anySignal(init?.signal, source ? null : options.signal),
      }),
    )
    const store = withMetadata(fetched, metadata)
    const name = url
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .replace(/^.*\//, '')
    options.signal?.throwIfAborted()
    const workers = resolveChunkWorkerCount(options)
    // On demand, and alongside the metadata reads: the pool bundles an inline
    // worker with zarrita's wasm.
    const poolModule = workers > 0 ? import('./omeZarrChunkWorkerPool') : null
    poolModule?.catch(() => {})
    source = await ZarrSlideSource.fromStore(store, { id: name, ...options })
    const opened = source
    // An open aborted after the store opened releases what it opened.
    const checkOpen = () => {
      if (!options.signal?.aborted) return
      opened.dispose()
      options.signal.throwIfAborted()
    }
    checkOpen()
    // A pool that cannot load leaves tiles on this thread, as does a store
    // whose every level spans c (an RGB store chunked [3, y, x]).
    const mod = await poolModule?.catch(() => null)
    // Levels whose chunks span c are read on this thread.
    const spanning = source.arrays.filter(
      (a) => (a.chunks[source.cDim] ?? 1) !== 1,
    ).length
    if (mod && spanning < source.arrays.length) {
      // One budget: an equal share each, and this thread at least its part of
      // the levels it reads.
      const budget = source.cache?.maxBytes ?? 0
      const mine = Math.floor(
        budget * Math.max(1 / (workers + 1), spanning / source.arrays.length),
      )
      // Infinity - Infinity is NaN: an unbounded budget stays unbounded.
      const share = Number.isFinite(budget)
        ? Math.floor((budget - mine) / workers)
        : budget
      source.cache?.resize(mine)
      source.pool = new mod.OmeZarrChunkWorkerPool(
        url,
        {},
        { size: workers, cacheBytesPerWorker: share, persistPerWorker: false },
        metadata,
      )
      source.pool.onWireBytes = (bytes) => opened.host?.addWireBytes(bytes)
    }
    checkOpen()
    return source
  }

  /** Any zarrita store, e.g. a `Map` or a FileSystemStore. */
  static async fromStore(
    base: zarr.Readable,
    options: ZarrSlideOptions = {},
  ): Promise<ZarrSlideSource> {
    const cacheBytes = options.cacheBytes ?? ZARR_SLIDE_CACHE_BYTES
    const cache = cacheBytes > 0 ? new ByteLruCache(cacheBytes) : null
    // A sync store (a Map) is awaited like an async one.
    const store = cache
      ? zarr.withByteCaching(base as zarr.AsyncReadable, { cache })
      : base
    const src = await openOmeZarr(store)
    const { info, levels, indices, order, axes } = src
    const shape = levels[0].shape
    const dtype = levels[0].dtype
    // Throws on int64, bool and strings, which no sample path reads.
    omeZarrNiftiDatatype(dtype)
    const ys = indices.spatial[order.y]
    const xs = indices.spatial[order.x]
    const zs = order.z < 0 ? -1 : indices.spatial[order.z]
    const cDim = indices.channel
    const count = (dim: number) => (dim < 0 ? 1 : shape[dim])
    // A pyramid may downsample (and shift) z too: each level reads the plane
    // nearest the chosen plane's position, by the declared scale/translation
    // (OME-Zarr: position = index * scale + translation). Without a z scale,
    // by depth ratio.
    const zAxis = (lv: (typeof levels)[number]) => {
      const d = info.datasets[lv.datasetIndex]
      return { s: d?.scale?.[zs], t: d?.translation?.[zs] ?? 0 }
    }
    const z0 = zs < 0 ? null : zAxis(levels[0])
    const zAt = (level: number, z: number) => {
      if (zs < 0 || !z0) return 0
      const lv = levels[level]
      const { s, t } = zAxis(lv)
      const index =
        s && z0.s
          ? Math.round((z * z0.s + z0.t - t) / s)
          : Math.floor(((z + 0.5) * lv.shape[zs]) / shape[zs])
      return Math.min(lv.shape[zs] - 1, Math.max(0, index))
    }
    const rgb =
      options.channel === undefined &&
      src.channelCount === 3 &&
      dtype === 'uint8'
    const multi = !rgb && options.channel === undefined && src.channelCount > 1
    const active = omeroActiveChannels(info.channels, src.channelCount)
    const channel = options.channel ?? active[0]
    checkOmeZarrIndex('channel', channel, src.channelCount)
    // As for t: a coarser level may drop channels the finest level has.
    for (const [i, lv] of levels.entries()) {
      const have = cDim < 0 ? 1 : lv.shape[cDim]
      // Multi-channel mode reads every channel at every level.
      const need = rgb ? 3 : multi ? src.channelCount : channel + 1
      if (have < need)
        throw new Error(
          `OME-Zarr slide: level ${i} has ${have} channels; ${rgb ? 'RGB needs 3' : multi ? `all ${need} are shown` : `channel ${channel} is out of range`}`,
        )
    }
    // Before any read or tile list: chunk shapes a tile can use, level order,
    // and a tile count the manifest can hold.
    let tileCount = 0
    for (const [i, arr] of src.arrays.entries()) {
      const [tw, th] = [arr.chunks[xs], arr.chunks[ys]]
      if (!(Number.isInteger(tw) && Number.isInteger(th) && tw > 0 && th > 0))
        throw new Error(
          `OME-Zarr slide: level ${i} chunk ${tw}x${th} is invalid`,
        )
      if (Math.max(tw, th) > MAX_TILE_SIZE)
        throw new Error(
          `OME-Zarr slide: level ${i} chunk ${tw}x${th} exceeds ${MAX_TILE_SIZE}`,
        )
      // Levels must run finest first: each no larger, and smaller in x or y.
      const [w, h] = [arr.shape[xs], arr.shape[ys]]
      const prev = src.arrays[i - 1]
      if (
        prev &&
        !(
          w <= prev.shape[xs] &&
          h <= prev.shape[ys] &&
          w * h < prev.shape[xs] * prev.shape[ys]
        )
      )
        throw new Error(
          `OME-Zarr slide: level ${i} (${w}x${h}) is not smaller than level ${i - 1}`,
        )
      if (arr.dtype !== dtype)
        throw new Error(
          `OME-Zarr slide: level ${i} dtype ${arr.dtype} differs from ${dtype}`,
        )
      tileCount += Math.ceil(w / tw) * Math.ceil(h / th)
      if (tileCount > MAX_TILES)
        throw new Error(`OME-Zarr slide: more than ${MAX_TILES} tiles`)
    }
    const select = (
      y: zarr.Slice,
      x: zarr.Slice,
      level: number,
      c: zarr.Slice,
      plane: Plane,
    ) =>
      shape.map((_, dim) =>
        dim === ys
          ? y
          : dim === xs
            ? x
            : dim === cDim
              ? c
              : dim === indices.time
                ? plane.t
                : dim === zs
                  ? zAt(level, plane.z)
                  : null,
      )
    // A read keeps y, x and c (when the store has a c axis) in declared order.
    const kept = [ys, xs, cDim].filter((d) => d >= 0).sort((a, b) => a - b)
    const pos = [ys, xs, cDim].map((d) => (d < 0 ? -1 : kept.indexOf(d))) as [
      number,
      number,
      number,
    ]
    // int8/int16 and float32 stay native (raw-gray sampleType); uint32, int32
    // and float64 are quantized to uint16 (contract section 3).
    // Labels by dtype, never by a scan, never quantized (owner Q10): 32-bit
    // IDs read as f32, exact up to 2^24, and a tile holding a larger ID fails
    // on its own. 64-bit labels are refused (int64 already is, as a dtype).
    if (info.isLabel && dtype === 'float64')
      throw new Error(
        'OME-Zarr slide: a float64 label image is not supported (IDs past 2^24 do not read exactly)',
      )
    const wideLabel = info.isLabel && (dtype === 'uint32' || dtype === 'int32')
    const sampleType =
      dtype === 'int8' || dtype === 'int16'
        ? ('i16' as const)
        : dtype === 'float32' || wideLabel
          ? ('f32' as const)
          : undefined
    const quantized = !sampleType && dtype !== 'uint8' && dtype !== 'uint16'
    const bitsStored =
      rgb || dtype === 'uint8' ? 8 : sampleType === 'f32' ? 32 : 16
    const unsignedBits = bitsStored === 8 ? 8 : 16
    const width0 = shape[xs]
    const levelsAt = (plane: Plane): NVSlideLevelManifest[] => {
      checkPlane('z', plane.z, count(zs))
      checkPlane('t', plane.t, count(indices.time))
      return src.arrays.map((arr, index): NVSlideLevelManifest => {
        // Pyramids keep every timepoint; a level that drops some cannot show t.
        if (indices.time >= 0 && plane.t >= arr.shape[indices.time])
          throw new RangeError(
            `OME-Zarr slide: level ${index} has ${arr.shape[indices.time]} timepoints; t ${plane.t} is out of range`,
          )
        const [width, height, tileWidth, tileHeight] = [
          arr.shape[xs],
          arr.shape[ys],
          arr.chunks[xs],
          arr.chunks[ys],
        ]
        const columns = Math.ceil(width / tileWidth)
        const rows = Math.ceil(height / tileHeight)
        const tiles: NVSlideTileManifest[] = []
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < columns; x++)
            tiles.push({
              x,
              y,
              width: Math.min(tileWidth, width - x * tileWidth),
              height: Math.min(tileHeight, height - y * tileHeight),
            })
        return {
          index,
          width,
          height,
          downsample: width0 / width,
          tileWidth,
          tileHeight,
          columns,
          rows,
          tiles,
          plane: { ...plane },
          ...(rgb
            ? { codec: 'raw-rgba' }
            : {
                codec: 'raw-gray',
                photometric: 'MONOCHROME2',
                bitsStored,
                ...(sampleType ? { sampleType } : {}),
              }),
        }
      })
    }
    // The writer's chosen plane (omero rdefs) unless the caller picks one.
    const within = (v: number | null, n: number) =>
      Math.min(n - 1, Math.max(0, v ?? 0))
    const opened = {
      z: options.z ?? within(info.defaults.z, count(zs)),
      t: options.t ?? within(info.defaults.t, count(indices.time)),
    }
    // Out of range at open is the caller's error, not a plane switch's.
    for (const [what, value, n] of [
      ['z', opened.z, count(zs)],
      ['t', opened.t, count(indices.time)],
    ] as const)
      checkOmeZarrIndex(what, value, n)
    const manifestLevels = levelsAt(opened)
    // Quantization and default window of channel c, in stored sample units,
    // from the opened plane. Quantization is fixed per source, so every plane
    // states the same storedToValue.
    const omeroOf = (c: number) => {
      const raw = info.channels[c]?.window
      // A placeholder omero block (0..1 on integer data) is not usable.
      const omero = raw && omeroWindowUsable(raw, dtype) ? raw : null
      const range =
        omero &&
        omero.min !== null &&
        omero.max !== null &&
        omero.max > omero.min
          ? [omero.min, omero.max]
          : null
      return { omero, range }
    }
    // [p2, p98, min, max] is read unless omero states the window and range.
    const needsRead = (c: number) => {
      const { omero, range } = omeroOf(c)
      return !omero || (quantized && !range)
    }
    const display = async (
      c: number,
      signal: AbortSignal,
    ): Promise<Display> => {
      const { omero, range } = omeroOf(c)
      const last = src.arrays.length - 1
      const coarse = src.arrays[last]
      const sample = needsRead(c)
        ? await sampleLevel(
            coarse.shape[xs],
            coarse.shape[ys],
            coarse.chunks[xs],
            coarse.chunks[ys],
            async (y, x) => {
              const { data } = await zarr.get(
                coarse,
                select(
                  zarr.slice(...y),
                  zarr.slice(...x),
                  last,
                  zarr.slice(c, c + 1),
                  opened,
                ),
                { signal },
              )
              return data as ArrayLike<number>
            },
          )
        : null
      const [lo, hi] = range ?? sample?.slice(2) ?? []
      const { quantize = null, noData = false } = quantized
        ? quantizeRange(lo, hi, dtype.startsWith('float'))
        : {}
      // Without a usable omero window: the 2-98% range of the sample, as for
      // volumes (calMinMax).
      const window = sampleType
        ? nativeWindow(
            omero?.start ?? sample?.[0] ?? -32768,
            omero?.end ?? sample?.[1] ?? 32767,
          )
        : omero && !noData
          ? storedWindow(quantize, omero.start, omero.end, unsignedBits)
          : sample
            ? storedWindow(quantize, sample[0], sample[1], unsignedBits)
            : storedWindow(null, 0, 2 ** unsignedBits - 1, unsignedBits)
      return { quantize, window }
    }
    // Only a store that marks some channel inactive has chosen; one marking
    // none (no flags, or every channel active) gets the capped default.
    const chosen = info.channels.some((c) => !c.active)
    const visible = multi
      ? chosen
        ? active
        : active.slice(0, MAX_DEFAULT_VISIBLE)
      : [channel]
    const shown = rgb
      ? []
      : multi
        ? Array.from({ length: src.channelCount }, (_, c) => c)
        : [channel]
    // Visible channels, and hidden ones omero describes, now; a hidden channel
    // that needs a data sample reads it when first shown (ready()).
    const now = shown.filter((c) => visible.includes(c) || !needsRead(c))
    const closed = new AbortController()
    // One channel at a time keeps open at a few chunk reads in flight
    // whatever the channel count.
    const displays: Display[] = []
    for (const c of now) displays.push(await display(c, closed.signal))
    const quantize: (Quantize | null | undefined)[] = []
    const windows: (NVSlideWindow | undefined)[] = []
    for (const [i, c] of now.entries()) {
      quantize[c] = displays[i].quantize
      windows[c] = displays[i].window
    }
    const label = info.isLabel
    const channelInfo: NVSlideChannelInfo[] | undefined = rgb
      ? undefined
      : shown.map((c) => {
          const q = quantize[c]
          const window = windows[c]
          const omero = info.channels[c]
          return {
            name: omeZarrChannelName(src, c),
            // One channel shows in grey, as a monochrome slide does.
            ...(multi && omero?.color ? { rgb: omero.color } : {}),
            ...(window ? { window } : {}),
            active: visible.includes(c),
            ...(q ? { storedToValue: storedToValue(q) } : {}),
            ...(label
              ? {
                  kind: 'label' as const,
                  ...(info.labelColors.length
                    ? { labelColors: info.labelColors }
                    : {}),
                }
              : {}),
          }
        })
    const scale = info.datasets[levels[0].datasetIndex].scale
    const um = (dim: number) => {
      const unit = axes[dim].unit
      return unit && scale ? omeLengthToMicrons(scale[dim], unit) : 0
    }
    const pixelSpacingMM = [um(xs) / 1000, um(ys) / 1000] as const
    const zUnit = zs < 0 ? null : axes[zs].unit
    const zScale = zs < 0 ? undefined : scale?.[zs]
    const zShift =
      zs < 0
        ? 0
        : (info.datasets[levels[0].datasetIndex].translation?.[zs] ?? 0)
    const tUnit =
      indices.time < 0 ? 0 : (TIME_SECONDS[axes[indices.time].unit ?? ''] ?? 0)
    const tScale = indices.time < 0 ? 0 : (scale?.[indices.time] ?? 0)
    const planes: NVSlidePlaneAxes = {
      z: count(zs),
      t: count(indices.time),
      ...(tUnit && tScale
        ? {
            tSeconds: Array.from(
              { length: count(indices.time) },
              (_, i) => i * tScale * tUnit,
            ),
          }
        : {}),
      ...(zUnit && zScale
        ? {
            zPositionsUm: Array.from({ length: count(zs) }, (_, i) =>
              omeLengthToMicrons(i * zScale + zShift, zUnit),
            ),
          }
        : {}),
    }
    const id = options.id ?? info.name ?? 'zarr'
    const source = new ZarrSlideSource(
      {
        id,
        name: `${id} (OME-Zarr)`,
        format: 'ome-zarr',
        width: width0,
        height: shape[ys],
        tileSize: manifestLevels[0].tileWidth,
        dtype:
          bitsStored === 8
            ? 'uint8'
            : sampleType === 'i16'
              ? 'int16'
              : sampleType === 'f32'
                ? 'float32'
                : 'uint16',
        channels: rgb ? 'rgba' : 'gray',
        displayYAxis: 'down',
        levels: manifestLevels,
        ...(pixelSpacingMM[0] > 0 && pixelSpacingMM[1] > 0
          ? { pixelSpacingMM }
          : {}),
        ...(channelInfo ? { channelInfo } : {}),
        ...(info.attribution ? { attribution: info.attribution } : {}),
      },
      planes,
      src.arrays,
      cache,
      select,
      levelsAt,
      display,
      rgb,
      pos,
      cDim,
      channel,
      quantize,
      zAt,
      dtype,
    )
    // Deferred display reads stop with the source.
    source.closed.signal.addEventListener('abort', () => closed.abort())
    return source
  }

  /**
   * The grey channel's default window, null for RGB.
   * @deprecated NVSlide applies `manifest.channelInfo[0].window` itself.
   */
  get window(): NVSlideWindow | null {
    return this.manifest.channelInfo?.[0]?.window ?? null
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  /** Read on this thread from now on, with the whole cache budget. */
  private dropPool(): void {
    const pool = this.pool
    if (!pool) return
    this.pool = null
    pool.dispose()
    this.cache?.resize(this.cacheBytes)
  }

  /** Abort reads and drop the byte cache. Idempotent. */
  dispose(): void {
    if (this.closed.signal.aborted) return
    this.closed.abort()
    this.cache?.clear()
    this.pool?.dispose()
  }

  async preparePlane(
    p: NVSlidePlaneIndex,
    signal?: AbortSignal,
  ): Promise<NVSlideManifest> {
    signal?.throwIfAborted()
    this.closed.signal.throwIfAborted()
    // A quantized multi-channel store states storedToValue per channel;
    // resolve the hidden ones first, so a later channelInfoChanged cannot make
    // this manifest disagree with the live one at commit (contract P7). Only
    // there do channelInfo indices name store channels; one channel resolved
    // at open. A hidden channel whose range read fails stays pending.
    const info = this.manifest.channelInfo
    if (info && info.length > 1 && info.some((c) => c.storedToValue)) {
      const settled = await Promise.allSettled(
        info.map((_, c) => this.ready(c)),
      )
      for (const [c, r] of settled.entries())
        if (r.status === 'rejected' && !this.closed.signal.aborted)
          console.warn(
            `OME-Zarr slide: channel ${c}'s range could not be read; it resolves when shown`,
            r.reason,
          )
    }
    signal?.throwIfAborted()
    // allSettled swallowed a dispose's abort; a closed source has no plane.
    this.closed.signal.throwIfAborted()
    return {
      ...this.manifest,
      levels: this.levelsAt({ z: p.z, t: p.t }),
      ...(this.manifest.channelInfo
        ? { channelInfo: this.manifest.channelInfo.map((c) => ({ ...c })) }
        : {}),
    }
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const c = this.channel
    if (!this.rgb) await untilAborted(this.ready(c), signal)
    const { data, stride } = await this.read(
      level,
      tile,
      this.rgb ? 0 : c,
      this.rgb ? 3 : c + 1,
      label,
      signal,
    )
    const [sy, sx, sc] = this.pos.map((p) => stride[p] ?? 0)
    const { width: w, height: h } = tile
    if (this.rgb) return rgba(data, sy, sx, sc, w, h)
    const q = this.quantize[c] ?? null
    const ids = this.labelIds(level)
    if (!q && !ids && sx === 1 && sy === w && isPlaneOf(level, data))
      return asBytes(data)
    const out = newPlane(level, w * h)
    if (ids) copyLabelIds(out, 0, data, sy, sx, w, h)
    else if (level.sampleType)
      copyStrided(out, data, [w, h, 1], [sx, sy, 0], w, 0)
    else grayInto(out as Uint8Array | Uint16Array, 0, data, sy, sx, w, h, q)
    return asBytes(out)
  }

  /**
   * Planar samples of `channels`. Channels sharing a chunk along c are read
   * with one zarr read, so a c-spanning chunk is fetched and decoded once.
   */
  private async tileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples> {
    await Promise.all(channels.map((c) => untilAborted(this.ready(c), signal)))
    const { width: w, height: h } = tile
    const n = w * h
    const out = newPlane(level, n * channels.length)
    // Native signed/float planes copy; uint8/uint16 (maybe quantized) go
    // through grayInto. Decided per tile, not per sample.
    const native = level.sampleType !== undefined
    const ids = this.labelIds(level)
    const label = `${level.index}/${tile.x}/${tile.y}`
    const cc = this.arrays[level.index].chunks[this.cDim] ?? 1
    const groups = new Map<number, number[]>()
    for (const [plane, c] of channels.entries()) {
      const g = Math.floor(c / cc)
      const list = groups.get(g)
      if (list) list.push(plane)
      else groups.set(g, [plane])
    }
    await Promise.all(
      [...groups.values()].map(async (planes) => {
        const cs = planes.map((p) => channels[p])
        const c0 = Math.min(...cs)
        const c1 = Math.max(...cs) + 1
        const { data, stride } = await this.read(
          level,
          tile,
          c0,
          c1,
          `${label} c${c1 - c0 > 1 ? `${c0}-${c1 - 1}` : c0}`,
          signal,
        )
        const [sy, sx, sc] = this.pos.map((p) => stride[p] ?? 0)
        const span = (h - 1) * sy + (w - 1) * sx + 1
        for (const p of planes) {
          const off = (channels[p] - c0) * sc
          const src = data.subarray(off, off + span)
          if (ids) copyLabelIds(out, p * n, src, sy, sx, w, h)
          else if (native)
            copyStrided(
              out.subarray(p * n, (p + 1) * n),
              src,
              [w, h, 1],
              [sx, sy, 0],
              w,
              0,
            )
          else
            grayInto(
              out as Uint8Array | Uint16Array,
              p * n,
              src,
              sy,
              sx,
              w,
              h,
              this.quantize[channels[p]] ?? null,
            )
        }
      }),
    )
    return {
      samples: out,
      width: w,
      height: h,
      bitsStored: level.bitsStored ?? 16,
      planes: channels.length,
    }
  }

  /** Whether `level`'s samples are f32 label IDs, checked against 2^24. */
  private labelIds(level: NVSlideLevelManifest): boolean {
    return (
      level.sampleType === 'f32' &&
      this.manifest.channelInfo?.[0]?.kind === 'label'
    )
  }

  /**
   * Channel c's quantization and window, read on first use for a hidden
   * channel and stated to NVSlide before its first tile.
   */
  private ready(c: number): Promise<void> | undefined {
    if (this.quantize[c] !== undefined) return
    let run = this.resolving[c]
    if (!run) {
      run = this.display(c, this.closed.signal).then(
        ({ quantize, window }) => {
          // A read that settles after dispose must not reach the host.
          this.closed.signal.throwIfAborted()
          this.quantize[c] = quantize
          const patch = {
            window,
            ...(quantize ? { storedToValue: storedToValue(quantize) } : {}),
          }
          const info = this.manifest.channelInfo
          if (info?.[c]) info[c] = { ...info[c], ...patch }
          this.host?.channelInfoChanged(c, patch)
        },
        (err) => {
          this.resolving[c] = undefined
          throw err
        },
      )
      this.resolving[c] = run
    }
    return run
  }

  /**
   * Channels c0..c1 of a tile read and decoded on the chunk workers, laid out
   * c, y, x; null when a worker failed (not the read), so this thread reads.
   */
  private async readOnPool(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    c0: number,
    c1: number,
    signal?: AbortSignal,
  ): Promise<Block | null> {
    const pool = this.pool
    if (!pool) return null
    const plane = level.plane ?? { z: 0, t: 0 }
    const Typed = TYPED[this.dtype]
    const { width: w, height: h } = tile
    const req = {
      levelIndex: level.index,
      texOrigin: [
        tile.x * (level.tileWidth ?? 0),
        tile.y * (level.tileHeight ?? 0),
        this.zAt(level.index, plane.z),
      ] as [number, number, number],
      texDims: [w, h, 1] as [number, number, number],
      bytesPerVoxel: Typed.BYTES_PER_ELEMENT,
      frame: plane.t,
      ...(signal ? { signal } : {}),
    }
    let planes: Uint8Array[]
    try {
      planes = await Promise.all(
        Array.from({ length: c1 - c0 }, (_, i) =>
          pool.fetchChunk({ ...req, channel: c0 + i }),
        ),
      )
    } catch (err) {
      const name = (err as { name?: unknown })?.name
      // A sibling read's worker failure disposed the pool under this one.
      const dropped =
        this.pool !== pool && !signal?.aborted && !this.closed.signal.aborted
      if (dropped) return null
      if (name === 'AbortError' || name === OME_ZARR_CHUNK_ERROR) throw err
      console.warn(
        `OME-Zarr slide: chunk worker failed, reading on the main thread: ${String(err)}`,
      )
      this.dropPool()
      return null
    }
    // Workers transfer buffers they own outright, so a plane views all of one.
    const one = planes.length === 1 ? planes[0] : null
    const data = one
      ? new Typed(one.buffer as ArrayBuffer)
      : new Typed(new ArrayBuffer(planes.reduce((n, p) => n + p.byteLength, 0)))
    if (!one) {
      const bytes = new Uint8Array(data.buffer)
      let o = 0
      for (const p of planes) {
        bytes.set(p, o)
        o += p.byteLength
      }
    }
    const stride: number[] = []
    stride[this.pos[0]] = w
    stride[this.pos[1]] = 1
    if (this.pos[2] >= 0) stride[this.pos[2]] = w * h
    return { data, stride }
  }

  private async read(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    c0: number,
    c1: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<Block> {
    this.closed.signal.throwIfAborted()
    const x0 = tile.x * (level.tileWidth ?? 0)
    const y0 = tile.y * (level.tileHeight ?? 0)
    const read = anySignal(signal, this.closed.signal)
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      // A chunk spanning c is read once on this thread instead: one worker
      // read per channel would fetch and decode it per channel.
      const cc = this.arrays[level.index].chunks[this.cDim] ?? 1
      const pooled =
        this.pool &&
        cc === 1 &&
        (await this.readOnPool(level, tile, c0, c1, read))
      if (pooled) {
        this.host?.updateRangeEvent(label, 'hit')
        return pooled
      }
      const sel = this.select(
        zarr.slice(y0, y0 + tile.height),
        zarr.slice(x0, x0 + tile.width),
        level.index,
        zarr.slice(c0, c1),
        level.plane ?? { z: 0, t: 0 },
      )
      const { data, stride } = await zarr.get(this.arrays[level.index], sel, {
        signal: read,
      })
      read?.throwIfAborted()
      this.host?.updateRangeEvent(label, 'hit')
      return { data: data as Samples, stride }
    } catch (error) {
      // zarrita shares a shard-index read, so an abort may be another tile's.
      const aborted =
        read?.aborted || (error as { name?: unknown })?.name === 'AbortError'
      this.host?.updateRangeEvent(label, aborted ? 'aborted' : 'failed')
      throw error
    }
  }
}

const TIME_SECONDS: Record<string, number> = {
  hour: 3600,
  minute: 60,
  second: 1,
  millisecond: 1e-3,
  microsecond: 1e-6,
}

const TYPED: Record<
  string,
  { new (buffer: ArrayBuffer): Samples; BYTES_PER_ELEMENT: number }
> = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
}

function checkPlane(what: string, value: number, n: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= n)
    throw new RangeError(
      `OME-Zarr slide: ${what} ${value} is out of range (0..${n - 1})`,
    )
}

// Strides are fixed per tile, so each loop is one case.
function rgba(
  data: ArrayLike<number>,
  sy: number,
  sx: number,
  sc: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0, o = 0; y < h; y++)
    for (let x = 0, i = y * sy; x < w; x++, i += sx, o += 4) {
      out[o] = data[i]
      out[o + 1] = data[i + sc]
      out[o + 2] = data[i + 2 * sc]
      out[o + 3] = 255
    }
  return out
}

/** A level's sample plane: its sampleType, else uint8 or uint16 by bitsStored. */
function newPlane(
  level: NVSlideLevelManifest,
  n: number,
): Uint8Array | Uint16Array | Int16Array | Float32Array {
  return level.sampleType === 'i16'
    ? new Int16Array(n)
    : level.sampleType === 'f32'
      ? new Float32Array(n)
      : level.bitsStored === 8
        ? new Uint8Array(n)
        : new Uint16Array(n)
}

/** Whether `data` already is `level`'s sample plane type. */
function isPlaneOf(level: NVSlideLevelManifest, data: Samples): boolean {
  return level.sampleType === 'i16'
    ? data instanceof Int16Array
    : level.sampleType === 'f32'
      ? data instanceof Float32Array
      : level.bitsStored === 8
        ? data instanceof Uint8Array
        : data instanceof Uint16Array
}

// f32 holds every integer up to 2^24 exactly.
const MAX_EXACT_ID = 2 ** 24

/**
 * Label IDs into an f32 plane from `o0`; a tile with an ID past 2^24 throws,
 * so it fails as a tile error rather than drawing a rounded ID.
 */
function copyLabelIds(
  out: Samples,
  o0: number,
  data: Samples,
  sy: number,
  sx: number,
  w: number,
  h: number,
): void {
  let worst = 0
  for (let y = 0, o = o0; y < h; y++)
    for (let x = 0, i = y * sy; x < w; x++, i += sx, o++) {
      const v = data[i]
      out[o] = v
      worst = Math.max(worst, Math.abs(v))
    }
  if (worst > MAX_EXACT_ID)
    throw new RangeError(
      `OME-Zarr slide: label ID ${worst} exceeds 2^24 and cannot be read exactly`,
    )
}

/** A native window over start..end; one unit either side when degenerate. */
function nativeWindow(start: number, end: number): NVSlideWindow {
  if (end > start) return { calMin: start, calMax: end }
  const mid = Number.isFinite(start) ? start : 0
  return { calMin: mid - 1, calMax: mid + 1 }
}

function asBytes(a: Samples): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}

/**
 * `run`, or the abort as soon as `signal` fires. A channel's range read is
 * shared, so an aborted tile stops waiting rather than cancelling it.
 */
const untilAborted = (run: Promise<void> | undefined, signal?: AbortSignal) =>
  run && settleBy(signal, run)
