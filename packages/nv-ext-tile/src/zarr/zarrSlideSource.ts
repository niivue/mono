import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  NVSlideWindow,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { omeLengthToMicrons } from '@niivue/niivue'
import * as zarr from 'zarrita'
import { checkOmeZarrIndex, omeroWindowUsable } from './omeZarr'
import {
  type OmeZarrSource,
  omeZarrFetchStore,
  omeZarrNiftiDatatype,
  openOmeZarr,
} from './omeZarrLoader'

export interface ZarrSlideOptions {
  /** Manifest id; defaults to the store name. */
  id?: string
  /**
   * Channel to show in grey. Default: an RGB store (3 uint8 channels) shows
   * in colour, any other the first omero-active channel.
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
// Zarr metadata stays HTTP-cacheable; chunk reads do not (see fromUrl).
const METADATA_KEY = /(zarr\.json|\.zarray|\.zattrs|\.zgroup)$/

// Stored = (v * k - lo) / span * 65535, with k = 1/2 when hi - lo overflows;
// dividing before scaling keeps a subnormal span finite.
type Quantize = { k: number; lo: number; span: number }

/**
 * NVSlide tile source for a 2D OME-Zarr image (0.4 / Zarr v2 and 0.5 / v3):
 * each multiscale dataset is a level and each y/x chunk (the inner chunk of a
 * shard) a tile, at one fixed t, c and z. Three uint8 channels show as RGB,
 * fluorescence included (pass `channel` for one; the milestone-14 channel API
 * will tell them apart); otherwise one channel's samples go to NVSlide as `raw-gray`, windowed like
 * DICOM MONOCHROME. uint8/uint16 pass through; other dtypes are quantized to
 * uint16 over the omero min..max, else an approximate data range sampled from
 * the coarsest level.
 * A store with z or t > 1 is refused unless {@link ZarrSlideOptions} picks
 * the plane. NVSlide does not read a window from a source: apply
 * {@link window} with `slide.setWindow`.
 */
export class ZarrSlideSource implements SlideTileSource {
  private host: SlideSourceHost | null = null

  private constructor(
    readonly manifest: NVSlideManifest,
    /**
     * Default monochrome window (omero when usable, else the uint16 data
     * range), or null for RGB. Interim: milestone 14 may replace
     * `NVSlide.setWindow` with per-channel display; `raw-gray` stays valid.
     */
    readonly window: NVSlideWindow | null,
    private readonly arrays: zarr.Array<zarr.DataType, zarr.Readable>[],
    private readonly select: (
      y: zarr.Slice,
      x: zarr.Slice,
      level: number,
    ) => (number | zarr.Slice | null)[],
    private readonly rgb: boolean,
    /** Positions of y, x and (RGB) c among the selection's sliced dims. */
    private readonly pos: readonly [number, number, number],
    private readonly quantize: Quantize | null,
  ) {}

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
    const active = info.channels.findIndex((c) => c.active)
    const channel = options.channel ?? Math.max(0, active)
    checkOmeZarrIndex('channel', channel, src.channelCount)
    // As for t: a coarser level may drop channels the finest level has.
    for (const [i, lv] of levels.entries()) {
      const count = indices.channel < 0 ? 1 : lv.shape[indices.channel]
      if (rgb ? count < 3 : channel >= count)
        throw new Error(
          `OME-Zarr slide: level ${i} has ${count} channels; ${rgb ? 'RGB needs 3' : `channel ${channel} is out of range`}`,
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
    const select = (y: zarr.Slice, x: zarr.Slice, level: number) =>
      shape.map((_, dim) =>
        dim === ys
          ? y
          : dim === xs
            ? x
            : fixed(dim, rgb ? zarr.slice(0, 3) : channel, level),
      )
    const sliced = [ys, xs, rgb ? indices.channel : -1]
    const kept = sliced.filter((d) => d >= 0).sort((a, b) => a - b)
    const pos = sliced.map((d) => kept.indexOf(d)) as [number, number, number]
    const raw = info.channels[channel]?.window
    // A placeholder omero block (0..1 on integer data) is not usable.
    const omero = raw && omeroWindowUsable(raw, dtype) ? raw : null
    let quantize: Quantize | null = null
    let noData = false
    if (!rgb && dtype !== 'uint8' && dtype !== 'uint16') {
      let [lo, hi] =
        omero &&
        omero.min !== null &&
        omero.max !== null &&
        omero.max > omero.min
          ? [omero.min, omero.max]
          : await dataRange(src, select, ys, xs)
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
      quantize = { k, lo: lo * k, span: hi * k - lo * k }
    }
    const bitsStored = rgb || dtype === 'uint8' ? 8 : 16
    const toStored = (v: number) =>
      quantize ? ((v * quantize.k - quantize.lo) / quantize.span) * 65535 : v
    // uint16 without a window: the sampled data range, so 12-bit data is
    // not near black. ponytail: milestone 14 may bring a 2-98% auto window.
    const [calMin, calMax] =
      omero && !noData
        ? [toStored(omero.start), toStored(omero.end)]
        : dtype === 'uint16'
          ? await dataRange(src, select, ys, xs)
          : [0, 2 ** bitsStored - 1]
    // Degenerate (constant or all-NaN data): setWindow would refuse it.
    const window = rgb
      ? null
      : calMax > calMin
        ? { calMin, calMax }
        : { calMin: 0, calMax: 2 ** bitsStored - 1 }
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
      },
      window,
      src.arrays,
      select,
      rgb,
      pos,
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
    const arr = this.arrays[level.index]
    const tw = level.tileWidth ?? 0
    const th = level.tileHeight ?? 0
    const x0 = tile.x * tw
    const y0 = tile.y * th
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      const sel = this.select(
        zarr.slice(y0, y0 + tile.height),
        zarr.slice(x0, x0 + tile.width),
        level.index,
      )
      const { data, stride } = await zarr.get(arr, sel, { signal })
      signal?.throwIfAborted()
      this.host?.updateRangeEvent(label, 'hit')
      return this.toBytes(
        data as ArrayLike<number>,
        stride,
        tile.width,
        tile.height,
      )
    } catch (error) {
      // zarrita shares a shard-index read, so an abort may be another tile's.
      const aborted =
        signal?.aborted || (error as { name?: unknown })?.name === 'AbortError'
      this.host?.updateRangeEvent(label, aborted ? 'aborted' : 'failed')
      throw error
    }
  }

  // The selection keeps the sliced dims in declared order: [y, x] or [x, y],
  // RGB with c among them. Strides are fixed per tile, so each loop is one case.
  private toBytes(
    data: ArrayLike<number>,
    stride: number[],
    w: number,
    h: number,
  ): Uint8Array {
    const [sy, sx, sc] = this.pos.map((p) => stride[p] ?? 0)
    if (this.rgb) {
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
    const q = this.quantize
    if (!q && sx === 1 && sy === w)
      return asBytes(data as Uint8Array | Uint16Array)
    const out =
      q || data instanceof Uint16Array
        ? new Uint16Array(w * h)
        : new Uint8Array(w * h)
    if (q) {
      // Clamp: a Uint16Array store wraps out-of-range values; NaN stores 0.
      for (let y = 0, o = 0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
          out[o] = Math.min(
            65535,
            Math.max(0, ((data[i] * q.k - q.lo) / q.span) * 65535 + 0.5),
          )
    } else {
      for (let y = 0, o = 0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++) out[o] = data[i]
    }
    return asBytes(out)
  }
}

function asBytes(a: Uint8Array | Uint16Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}

// An approximate data range: a RANGE_GRID x RANGE_GRID grid of chunks spread
// over the coarsest level, at most RANGE_SPAN square from the middle of each,
// so open reads at most RANGE_GRID^2 chunks whatever the store's size. Values
// outside the sample clamp; a valid omero window is preferred over this.
const RANGE_GRID = 4
const RANGE_READS = 4
const RANGE_SPAN = 1024

async function dataRange(
  src: OmeZarrSource,
  select: (
    y: zarr.Slice,
    x: zarr.Slice,
    level: number,
  ) => (number | zarr.Slice | null)[],
  ys: number,
  xs: number,
): Promise<[number, number]> {
  const last = src.arrays.length - 1
  const coarse = src.arrays[last]
  const spread = (dim: number) => {
    const [n, c] = [coarse.shape[dim], coarse.chunks[dim]]
    const count = Math.ceil(n / c)
    const starts = new Set<number>()
    for (let i = 0; i < RANGE_GRID; i++)
      starts.add(
        Math.max(0, Math.round((i * (count - 1)) / (RANGE_GRID - 1))) * c,
      )
    return [...starts].map((a) => {
      const len = Math.min(c, n - a)
      const k = Math.min(len, RANGE_SPAN)
      const b = a + Math.floor((len - k) / 2)
      return zarr.slice(b, b + k)
    })
  }
  const cells = spread(ys).flatMap((y) => spread(xs).map((x) => [y, x]))
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  // A few reads at a time: fewer remote round trips, but each result is
  // scanned and dropped as it lands, and a failure stops new reads.
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < cells.length) {
      const [y, x] = cells[next++]
      try {
        const { data } = await zarr.get(coarse, select(y, x, last))
        for (const v of data as ArrayLike<number> & Iterable<number>) {
          if (!Number.isFinite(v)) continue
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  // Reject on the first failure; reads already started (at most 3) finish
  // unawaited, and a stalled one cannot hold the open.
  await Promise.all(Array.from({ length: RANGE_READS }, worker))
  return [lo, hi]
}
