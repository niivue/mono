import type {
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  NVSlideTileSamples,
  NVSlideWindow,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { omeLengthToMicrons } from '@niivue/niivue'
import * as zarr from '@niivue/zarrita-rs/inline'
import { sampleLevel } from '../levelSample'
import {
  checkOmeZarrIndex,
  omeroActiveChannels,
  omeroWindowUsable,
} from './omeZarr'
import {
  type OmeZarrSource,
  omeZarrChannelName,
  omeZarrFetchStore,
  omeZarrNiftiDatatype,
  openOmeZarr,
} from './omeZarrLoader'

export interface ZarrSlideOptions {
  /** Manifest id; defaults to the store name. */
  id?: string
  /**
   * Channel to show in grey. Default: an RGB store (3 uint8 channels) shows
   * in colour, a multi-channel one serves every channel to NVSlide.
   */
  channel?: number
  /** Plane of a store with z > 1; required there. */
  z?: number
  /** Timepoint of a store with t > 1; required there. */
  t?: number
}

export interface ZarrSlideUrlOptions extends ZarrSlideOptions {
  /** fetch implementation, e.g. one that adds auth headers. */
  fetch?: (request: Request) => Promise<Response>
  /** Aborts opening. */
  signal?: AbortSignal
}

// As TiffSlideSource: one decoded tile stays under 64 MiB of RGBA.
const MAX_TILE_SIZE = 4096
// As TiffSlideSource: bounds the manifest's tile list.
const MAX_TILES = 1 << 21
// Each visible channel is a sample plane per tile in NVSlide's tile budget
// (tileCapacity): 27 u16 planes of 512² fit 4 tiles in the default cache. Caps a
// store that marks no channel inactive (many exports mark all active); a chosen
// subset is honoured. The rest stay listed, hidden, for the caller to show.
const MAX_DEFAULT_VISIBLE = 4
// Zarr metadata stays HTTP-cacheable; chunk reads do not (see fromUrl).
const METADATA_KEY = /(zarr\.json|\.zarray|\.zattrs|\.zgroup)$/

// Stored = (v * k - lo) / span * 65535, with k = 1/2 when hi - lo overflows;
// dividing before scaling keeps a subnormal span finite.
// scale = 65535 / span, Infinity only for a subnormal span.
type Quantize = { k: number; lo: number; span: number; scale: number }
type Select = (
  y: zarr.Slice,
  x: zarr.Slice,
  level: number,
  c: number | zarr.Slice,
) => (number | zarr.Slice | null)[]

/**
 * NVSlide tile source for a 2D OME-Zarr image (0.4 / Zarr v2 and 0.5 / v3):
 * each multiscale dataset is a level and each y/x chunk (the inner chunk of a
 * shard) a tile, at one fixed t and z. Three uint8 channels show as RGB,
 * fluorescence included (pass `channel` for one). Other multi-channel stores
 * state omero label, colour, window and `active` in `manifest.channelInfo` and
 * serve each visible channel's samples through `fetchTileSamples`, so NVSlide
 * composites them. A single channel (or `channel`) goes to NVSlide as
 * `raw-gray`, windowed like DICOM MONOCHROME. uint8/uint16 pass through; other
 * dtypes are quantized to uint16 per channel over the omero min..max, else an
 * approximate data range sampled from the coarsest level, and state the
 * inverse as `channelInfo[c].storedToValue` (multi-channel). Without a usable
 * omero window, a channel's default window is the 2-98% range of that sample,
 * as for volumes. A store with z or
 * t > 1 is refused unless {@link ZarrSlideOptions} picks the plane.
 */
export class ZarrSlideSource implements SlideTileSource {
  private host: SlideSourceHost | null = null
  /** Set only for a multi-channel store: NVSlide takes this path when present. */
  readonly fetchTileSamples?: SlideTileSource['fetchTileSamples']

  private constructor(
    readonly manifest: NVSlideManifest,
    /**
     * The grey channel's default window (omero when usable, else the 2-98%
     * sampled range); null for RGB and multi-channel, whose windows are in
     * `manifest.channelInfo`. NVSlide does not read it: apply it with
     * `slide.setChannel(0, window)`.
     */
    readonly window: NVSlideWindow | null,
    private readonly arrays: zarr.Array<zarr.DataType, zarr.Readable>[],
    private readonly select: Select,
    private readonly rgb: boolean,
    /** Positions of y, x and (RGB) c among the selection's sliced dims. */
    private readonly pos: readonly [number, number, number],
    /** The channel fetchTileBytes reads (unused for RGB). */
    private readonly channel: number,
    /** Per store channel; null passes samples through. */
    private readonly quantize: (Quantize | null)[],
  ) {
    if (manifest.channelInfo)
      this.fetchTileSamples = this.tileSamples.bind(this)
  }

  /** Stream a store by URL (its root group). */
  static async fromUrl(
    url: string,
    options: ZarrSlideUrlOptions = {},
  ): Promise<ZarrSlideSource> {
    const fetchImpl = options.fetch ?? ((r: Request) => fetch(r))
    let source: ZarrSlideSource | null = null
    const store = omeZarrFetchStore(url, async (request) => {
      // Chromium's HTTP cache served truncated 206 bodies to concurrent
      // identical Range reads of a v3 shard (plan-tile punch list #10).
      const chunk = !METADATA_KEY.test(new URL(request.url).pathname)
      // While opening, the open signal cancels metadata and data-range reads.
      const signal =
        !source && options.signal
          ? AbortSignal.any([request.signal, options.signal])
          : request.signal
      const response = await fetchImpl(
        new Request(request, {
          signal,
          ...(chunk ? { cache: 'no-store' } : {}),
        }),
      )
      // A HEAD (zarrita's shard-index probe) states the whole file's length.
      if (request.method !== 'HEAD')
        source?.host?.addWireBytes(
          Number(response.headers.get('content-length')) || 0,
        )
      return response
    })
    const name = url
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .replace(/^.*\//, '')
    options.signal?.throwIfAborted()
    source = await ZarrSlideSource.fromStore(store, { id: name, ...options })
    options.signal?.throwIfAborted()
    return source
  }

  /** Any zarrita store, e.g. a `Map` or a FileSystemStore. */
  static async fromStore(
    store: zarr.Readable,
    options: ZarrSlideOptions = {},
  ): Promise<ZarrSlideSource> {
    const src = await openOmeZarr(store)
    const { info, levels, indices, order, axes } = src
    const shape = levels[0].shape
    const dtype = levels[0].dtype
    // Throws on int64, bool and strings, which no sample path reads.
    omeZarrNiftiDatatype(dtype)
    const ys = indices.spatial[order.y]
    const xs = indices.spatial[order.x]
    const zs = order.z < 0 ? -1 : indices.spatial[order.z]
    const pick = (what: string, dim: number, value?: number): number => {
      const count = dim < 0 ? 1 : shape[dim]
      if (value === undefined && count > 1)
        throw new Error(
          `OME-Zarr slide: ${what} has ${count} planes; pick one with the '${what}' option`,
        )
      checkOmeZarrIndex(what, value ?? 0, count)
      return value ?? 0
    }
    const t = pick('t', indices.time, options.t)
    // Pyramids keep every timepoint; a level that drops some cannot show t.
    for (const [i, lv] of levels.entries())
      if (indices.time >= 0 && t >= lv.shape[indices.time])
        throw new Error(
          `OME-Zarr slide: level ${i} has ${lv.shape[indices.time]} timepoints; t ${t} is out of range`,
        )
    const z = pick('z', zs, options.z)
    // A pyramid may downsample (and shift) z too: each level reads the plane
    // nearest the chosen plane's position, by the declared scale/translation
    // (OME-Zarr: position = index * scale + translation). Without a z scale,
    // by depth ratio.
    const zAxis = (lv: (typeof levels)[number]) => {
      const d = info.datasets[lv.datasetIndex]
      return { s: d?.scale?.[zs], t: d?.translation?.[zs] ?? 0 }
    }
    const z0 = zs < 0 ? null : zAxis(levels[0])
    const zByLevel = levels.map((lv) => {
      if (zs < 0 || !z0) return 0
      const { s, t } = zAxis(lv)
      const index =
        s && z0.s
          ? Math.round((z * z0.s + z0.t - t) / s)
          : Math.floor(((z + 0.5) * lv.shape[zs]) / shape[zs])
      return Math.min(lv.shape[zs] - 1, Math.max(0, index))
    })
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
      const count = indices.channel < 0 ? 1 : lv.shape[indices.channel]
      // Multi-channel mode reads every channel at every level.
      const need = rgb ? 3 : multi ? src.channelCount : channel + 1
      if (count < need)
        throw new Error(
          `OME-Zarr slide: level ${i} has ${count} channels; ${rgb ? 'RGB needs 3' : multi ? `all ${need} are shown` : `channel ${channel} is out of range`}`,
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
      tileCount += Math.ceil(w / tw) * Math.ceil(h / th)
      if (tileCount > MAX_TILES)
        throw new Error(`OME-Zarr slide: more than ${MAX_TILES} tiles`)
    }
    const fixed = (dim: number, c: number | zarr.Slice, level: number) =>
      dim === indices.time
        ? t
        : dim === indices.channel
          ? c
          : dim === zs
            ? zByLevel[level]
            : null
    const select: Select = (y, x, level, c) =>
      shape.map((_, dim) =>
        dim === ys ? y : dim === xs ? x : fixed(dim, c, level),
      )
    const sliced = [ys, xs, rgb ? indices.channel : -1]
    const kept = sliced.filter((d) => d >= 0).sort((a, b) => a - b)
    const pos = sliced.map((d) => kept.indexOf(d)) as [number, number, number]
    const bitsStored = rgb || dtype === 'uint8' ? 8 : 16
    // Quantization and default window of channel c, in stored sample units.
    const quantized = dtype !== 'uint8' && dtype !== 'uint16'
    const display = async (c: number) => {
      const raw = info.channels[c]?.window
      // A placeholder omero block (0..1 on integer data) is not usable.
      const omero = raw && omeroWindowUsable(raw, dtype) ? raw : null
      const omeroRange =
        omero &&
        omero.min !== null &&
        omero.max !== null &&
        omero.max > omero.min
          ? [omero.min, omero.max]
          : null
      // [p2, p98, min, max]: read unless omero states the window and range.
      const sample =
        !omero || (quantized && !omeroRange)
          ? await dataRange(
              src,
              (y, x, level) => select(y, x, level, c),
              ys,
              xs,
            )
          : null
      let quantize: Quantize | null = null
      let noData = false
      if (quantized) {
        let [lo, hi] = omeroRange ?? sample?.slice(2) ?? []
        // A flat or empty sample says nothing of the rest: centre a window on
        // it (one step per unit, or half its magnitude for a flat float) so
        // values outside it stay distinct.
        if (!(hi > lo)) {
          noData = !Number.isFinite(lo)
          const mid = noData ? 0 : lo
          const half =
            !noData && dtype.startsWith('float')
              ? Math.max(Math.abs(mid) / 2, 1)
              : 32767.5
          ;[lo, hi] = [mid - half, mid + half]
        }
        const k = Number.isFinite(hi - lo) ? 1 : 0.5
        const span = hi * k - lo * k
        quantize = { k, lo: lo * k, span, scale: 65535 / span }
      }
      const toStored = (v: number) =>
        quantize ? ((v * quantize.k - quantize.lo) / quantize.span) * 65535 : v
      // Without a usable omero window: the 2-98% range of the sample, as for
      // volumes (calMinMax).
      const [calMin, calMax] =
        omero && !noData
          ? [toStored(omero.start), toStored(omero.end)]
          : sample
            ? [toStored(sample[0]), toStored(sample[1])]
            : [0, 2 ** bitsStored - 1]
      // Degenerate (constant or all-NaN data): setChannel would refuse it.
      const window: NVSlideWindow =
        calMax > calMin
          ? { calMin, calMax }
          : { calMin: 0, calMax: 2 ** bitsStored - 1 }
      return { quantize, window }
    }
    const shown = rgb
      ? []
      : multi
        ? Array.from({ length: src.channelCount }, (_, c) => c)
        : [channel]
    // ponytail: every channel's range is read on open, inactive ones too, so
    // showing one later has its window. One channel at a time keeps open at
    // a few chunk reads in flight whatever the channel count.
    const displays: Awaited<ReturnType<typeof display>>[] = []
    for (const c of shown) displays.push(await display(c))
    const quantize: (Quantize | null)[] = []
    for (const [i, c] of shown.entries()) quantize[c] = displays[i].quantize
    const window = rgb || multi ? null : displays[0].window
    // Only a store that marks some channel inactive has chosen; one marking
    // none (no flags, or every channel active) gets the capped default.
    const chosen = info.channels.some((c) => !c.active)
    const visible = chosen ? active : active.slice(0, MAX_DEFAULT_VISIBLE)
    const channelInfo: NVSlideChannelInfo[] | undefined = multi
      ? displays.map(({ window, quantize: q }, c) => {
          const omero = info.channels[c]
          return {
            name: omeZarrChannelName(src, c),
            ...(omero?.color ? { rgb: omero.color } : {}),
            window,
            active: visible.includes(c),
            // Inverse of grayInto's quantization.
            ...(q
              ? {
                  storedToValue: {
                    scale: q.span / (65535 * q.k),
                    offset: q.lo / q.k,
                  },
                }
              : {}),
          }
        })
      : undefined
    const width0 = shape[xs]
    const manifestLevels = src.arrays.map(
      (arr, index): NVSlideLevelManifest => {
        if (arr.dtype !== dtype)
          throw new Error(
            `OME-Zarr slide: level ${index} dtype ${arr.dtype} differs from ${dtype}`,
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
          ...(rgb
            ? { codec: 'raw-rgba' }
            : { codec: 'raw-gray', photometric: 'MONOCHROME2', bitsStored }),
        }
      },
    )
    const scale = info.datasets[levels[0].datasetIndex].scale
    const mm = (dim: number) => {
      const unit = axes[dim].unit
      return unit && scale ? omeLengthToMicrons(scale[dim], unit) / 1000 : 0
    }
    const pixelSpacingMM = [mm(xs), mm(ys)] as const
    const id = options.id ?? info.name ?? 'zarr'
    return new ZarrSlideSource(
      {
        id,
        name: `${id} (OME-Zarr)`,
        format: 'ome-zarr',
        width: width0,
        height: shape[ys],
        tileSize: manifestLevels[0].tileWidth,
        dtype: bitsStored === 8 ? 'uint8' : 'uint16',
        channels: rgb ? 'rgba' : 'gray',
        displayYAxis: 'down',
        levels: manifestLevels,
        ...(pixelSpacingMM[0] > 0 && pixelSpacingMM[1] > 0
          ? { pixelSpacingMM }
          : {}),
        ...(channelInfo ? { channelInfo } : {}),
      },
      window,
      src.arrays,
      select,
      rgb,
      pos,
      channel,
      quantize,
    )
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  // ponytail: decodes on the main thread; the chunk worker pool is built for
  // 3D bricks. Route tiles through workers if decode shows in frame times.
  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const c = this.rgb ? zarr.slice(0, 3) : this.channel
    const { data, stride } = await this.read(level, tile, c, label, signal)
    const [sy, sx, sc] = this.pos.map((p) => stride[p] ?? 0)
    const { width: w, height: h } = tile
    if (this.rgb) return rgba(data, sy, sx, sc, w, h)
    const q = this.quantize[this.channel]
    if (!q && sx === 1 && sy === w)
      return asBytes(data as Uint8Array | Uint16Array)
    const out =
      level.bitsStored === 8 ? new Uint8Array(w * h) : new Uint16Array(w * h)
    grayInto(out, 0, data, sy, sx, w, h, q)
    return asBytes(out)
  }

  /** Planar samples of `channels`, one zarr read each. */
  // ponytail: a chunk spanning c decodes once per visible channel; read one
  // c slice and split it if such stores show up.
  private async tileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples> {
    const { width: w, height: h } = tile
    const n = w * h * channels.length
    const out = level.bitsStored === 8 ? new Uint8Array(n) : new Uint16Array(n)
    const label = `${level.index}/${tile.x}/${tile.y}`
    await Promise.all(
      channels.map(async (c, plane) => {
        const { data, stride } = await this.read(
          level,
          tile,
          c,
          `${label} c${c}`,
          signal,
        )
        const [sy, sx] = this.pos.map((p) => stride[p] ?? 0)
        grayInto(out, plane * w * h, data, sy, sx, w, h, this.quantize[c])
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

  private async read(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    c: number | zarr.Slice,
    label: string,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayLike<number>; stride: number[] }> {
    const x0 = tile.x * (level.tileWidth ?? 0)
    const y0 = tile.y * (level.tileHeight ?? 0)
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      const sel = this.select(
        zarr.slice(y0, y0 + tile.height),
        zarr.slice(x0, x0 + tile.width),
        level.index,
        c,
      )
      const { data, stride } = await zarr.get(this.arrays[level.index], sel, {
        signal,
      })
      signal?.throwIfAborted()
      this.host?.updateRangeEvent(label, 'hit')
      return { data: data as ArrayLike<number>, stride }
    } catch (error) {
      // zarrita shares a shard-index read, so an abort may be another tile's.
      const aborted =
        signal?.aborted || (error as { name?: unknown })?.name === 'AbortError'
      this.host?.updateRangeEvent(label, aborted ? 'aborted' : 'failed')
      throw error
    }
  }
}

// The selection keeps the sliced dims in declared order: [y, x] or [x, y],
// RGB with c among them. Strides are fixed per tile, so each loop is one case.
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

/** One grey plane into `out` from sample `o0`, quantized when `q` is set. */
function grayInto(
  out: Uint8Array | Uint16Array,
  o0: number,
  data: ArrayLike<number>,
  sy: number,
  sx: number,
  w: number,
  h: number,
  q: Quantize | null,
): void {
  if (q) {
    // Clamp: a Uint16Array store wraps out-of-range values; NaN stores 0.
    // Multiply per pixel; divide only when a subnormal span overflows scale.
    const { k, lo, span, scale } = q
    if (Number.isFinite(scale)) {
      for (let y = 0, o = o0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
          out[o] = Math.min(
            65535,
            Math.max(0, (data[i] * k - lo) * scale + 0.5),
          )
    } else {
      for (let y = 0, o = o0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
          out[o] = Math.min(
            65535,
            Math.max(0, ((data[i] * k - lo) / span) * 65535 + 0.5),
          )
    }
  } else if (sx === 1 && sy === w) {
    out.set(data, o0)
  } else {
    for (let y = 0, o = o0; y < h; y++)
      for (let x = 0, i = y * sy; x < w; x++, i += sx, o++) out[o] = data[i]
  }
}

function asBytes(a: Uint8Array | Uint16Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}

// The sample grid of the coarsest level (levelSample.ts) at one channel.
function dataRange(
  src: OmeZarrSource,
  select: (
    y: zarr.Slice,
    x: zarr.Slice,
    level: number,
  ) => (number | zarr.Slice | null)[],
  ys: number,
  xs: number,
): Promise<[number, number, number, number]> {
  const last = src.arrays.length - 1
  const coarse = src.arrays[last]
  return sampleLevel(
    coarse.shape[xs],
    coarse.shape[ys],
    coarse.chunks[xs],
    coarse.chunks[ys],
    async (y, x) => {
      const { data } = await zarr.get(
        coarse,
        select(zarr.slice(...y), zarr.slice(...x), last),
      )
      return data as ArrayLike<number>
    },
  )
}
