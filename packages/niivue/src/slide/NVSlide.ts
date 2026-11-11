import { colormapKey, lookupColorMap, lutrgba8 } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import { channelColormapsFor } from '@/volume/channelColormaps'
export type NVSlideTileCodec =
  | 'raw-rgba'
  | 'raw-gray'
  | 'image/jpeg'
  | 'image/jp2'
  | 'image/jls'

/**
 * Samples a tile decoder (or {@link SlideTileSource.fetchTileSamples}) may return
 * instead of a bitmap. NVSlide renders them through its {@link NVSlide.channels}
 * and keeps them, so a channel change re-renders cached tiles without re-decoding (D16).
 */
export interface NVSlideTileSamples {
  /** `planes` planes of `width * height` samples, one after another. */
  samples: Uint8Array | Uint16Array
  width: number
  height: number
  /** The codestream's precision; the level's DICOM `bitsStored` wins when set. */
  bitsStored: number
  /** Sample planes, one per channel fetched (default 1). */
  planes?: number
}

/** Display window over stored sample values, shared by every tile and level. */
export interface NVSlideWindow {
  calMin: number
  calMax: number
}

/**
 * One displayed slide channel. Field names match VolumeUpdate, so volumes and
 * slides read alike. A non-finite calMin or calMax means the stored range's
 * end (0 or 2^bitsStored - 1), as a volume's means its default window.
 */
export interface NVChannel {
  name: string
  /** A NiiVue colormap name ('gray', 'red', ...). */
  colormap: string
  calMin: number
  calMax: number
  visible: boolean
}

/** How visible channels combine: per-component maximum, or saturating sum. */
export type NVSlideChannelBlend = 'max' | 'additive'

/** A source's description of one sample channel (e.g. an OME-Zarr omero channel). */
export interface NVSlideChannelInfo {
  name: string
  /** Stated colour, 0-255; snapped to the nearest channel colormap. */
  rgb?: readonly [number, number, number]
  /** A usable display window; omitted, the channel shows its stored range. */
  window?: NVSlideWindow
  /** Inactive channels start hidden and are not fetched. */
  active: boolean
  /** A quantized channel's map to data units: value = stored * scale + offset. */
  storedToValue?: { scale: number; offset: number }
}

/** One channel's value under a slide point ({@link NVSlide.sampleAt}). */
export interface NVSlideSample {
  /** Index into {@link NVSlide.channels}. */
  channel: number
  name: string
  /** Data units via `storedToValue`, else `stored`; null when missing. */
  value: number | null
  /** The cached sample as decoded, before window and MONOCHROME1 inversion; RGB bitmaps before ICC. */
  stored: number | null
  /** The pyramid level `index` that served it; set for `hidden`. */
  level: number | null
  /** Level 0 and not quantized. Lossy codecs are not tracked. */
  exact: boolean
  missing?: 'outside' | 'hole' | 'uncached' | 'hidden'
  /** Quantized and stored at 0 or 65535 (NaN is stored as 0): `value` is a bound. */
  clipped?: true
}

/** A slide's focal plane `z` and time point `t`. Only {z: 0, t: 0} exists yet. */
export interface NVSlidePlaneIndex {
  z: number
  t: number
}

/**
 * Decodes one tile's encoded bytes into an ImageBitmap. The built-in registry
 * handles `raw-rgba`, `raw-gray` and `image/jpeg`; `image/jp2` (JPEG 2000) has no browser
 * decoder, so a consumer must register one (e.g. @niivue/dcm2niix createFrameDecoder) via
 * {@link NVSlide.registerTileDecoder} — keeping the heavy codec out of the core.
 */
export type SlideTileDecoder = (
  bytes: Uint8Array,
  ctx: {
    width: number
    height: number
    /** What a codec may need beyond the bytes (e.g. `photometric`). */
    level: NVSlideLevelManifest
    /** Aborts when the tile is no longer wanted. */
    signal?: AbortSignal
  },
) => Promise<ImageBitmap | NVSlideTileSamples>
export type NVSlideYAxis = 'down' | 'up'
export type NVSlideLevelChoice = 'auto' | number
export type NVSlideColor = [number, number, number, number]

export interface NVSlideTileFragment {
  offset: number
  length: number
}

export interface NVSlideTileManifest {
  x: number
  y: number
  width: number
  height: number
  frame?: number
  offset?: number
  length?: number
  fragments?: NVSlideTileFragment[]
  /** The tile's own file, when a level spans several (a DICOM concatenation). */
  fileUrl?: string
}

export interface NVSlideLevelManifest {
  index: number
  width: number
  height: number
  downsample: number
  tileWidth?: number
  tileHeight?: number
  columns: number
  rows: number
  fileUrl?: string
  codec?: NVSlideTileCodec
  /** DICOM transfer syntax of the level's frames, when the source is DICOM. */
  transferSyntaxUid?: string
  /** DICOM PhotometricInterpretation, e.g. 'YBR_FULL_422'; passed to the tile decoder. */
  photometric?: string
  /** DICOM BitsStored (0028,0101); sets the default monochrome window. */
  bitsStored?: number
  /**
   * DICOM-WSI only: NumberOfFrames, NumberOfOpticalPaths (0048,0302) and
   * TotalPixelMatrixFocalPlanes (0048,0303), copied from the tags (unset when
   * absent). {@link assertSingleSlidePlane} checks them against the tile grid.
   */
  frames?: number
  opticalPaths?: number
  focalPlanes?: number
  /**
   * DICOM TILED_SPARSE: frames are placed by their per-frame position, so the
   * frame count says nothing about paths or planes; the producer states both.
   */
  sparse?: true
  /**
   * Row-major, `columns * rows`; `null` is a hole (no tile: nothing is drawn).
   * A sparse level may instead list only its present tiles, which NVSlide places
   * by `x`, `y` when it opens the slide.
   */
  tiles: Array<NVSlideTileManifest | null>
}

/**
 * A slide's ICC profile, kept for colour management. NVSlide does not apply it
 * yet, so slide colour is not colour-managed.
 */
export interface NVSlideIccProfile {
  /** Resolved like a level's `fileUrl`, or absolute (e.g. DICOMweb bulk data). */
  url: string
  /** Byte range of the profile within `url`; absent when `url` is just the profile. */
  offset?: number
  length?: number
  /** DICOM ColorSpace (0028,2002), e.g. 'SRGB', when stated. */
  colorSpace?: string
}

/** A slide's colour lookup table: `size`^3 RGBA8 entries, red fastest, mapping its RGB to sRGB. */
export interface NVSlideColorLut {
  size: number
  data: Uint8Array
}

/**
 * Bakes an ICC profile into an {@link NVSlideColorLut}, or resolves null for a
 * profile it cannot use. Registered with {@link NVSlide.registerIccTransform}
 * (e.g. @niivue/dcm2niix's LittleCMS), so the core ships no colour engine.
 */
export type SlideIccTransform = (
  profile: Uint8Array,
  signal: AbortSignal,
) => Promise<NVSlideColorLut | null>

export interface NVSlideManifest {
  id: string
  name: string
  format?: string
  width: number
  height: number
  displayYAxis?: NVSlideYAxis
  tileSize?: number
  dtype: string
  channels: string
  bytesPerPixel?: number
  byteLength?: number
  dataUrl?: string
  order?: string
  levels: NVSlideLevelManifest[]
  /**
   * Physical size of one base (level-0) pixel in millimetres, as [x, y] (column,
   * row). For DICOM-WSI this comes from PixelSpacing (0028,0030). Undefined when
   * the source carries no physical scale; a measurement UI then falls back to
   * pixels. `screenToSlide` returns base-pixel coordinates, so distance in mm =
   * base-pixel distance x this spacing.
   */
  pixelSpacingMM?: readonly [number, number]
  /** DICOM-WSI: the optical path's ICC profile, (0048,0105) > (0028,2000). */
  iccProfile?: NVSlideIccProfile
  /**
   * The sample channels a {@link SlideTileSource.fetchTileSamples} source
   * serves. Absent: one grey channel for a monochrome slide, else red, green
   * and blue, added.
   */
  channelInfo?: NVSlideChannelInfo[]
}

export interface NVSlideViewport {
  centerX: number
  centerY: number
  scale: number
}

export interface NVSlideSpatialTransform {
  /**
   * Column-major 4x4 transform from slide pixel coordinates into the base
   * image/world space. The initial renderer uses standalone slide viewports;
   * this is the registration hook for mapped slides.
   */
  pixelToWorld?: readonly number[]
  /**
   * Optional inverse of pixelToWorld. Callers can provide it to avoid repeated
   * inversion when registering a slide against a base volume.
   */
  worldToPixel?: readonly number[]
}

export interface NVSlideOptions {
  id?: string
  name?: string
  manifestUrl?: string
  opacity?: number
  visible?: boolean
  viewport?: NVSlideViewport
  levelChoice?: NVSlideLevelChoice
  maxCacheBytes?: number
  /** Max simultaneous tile fetch+decode operations (default 12). */
  maxConcurrentLoads?: number
  maxScale?: number
  /** 'auto' picks the finest level with at least this many device pixels
   * per tile pixel (default 0.75). Raise it to fetch fewer, coarser tiles. */
  targetScreenPixelsPerTilePixel?: number
  showTileGrid?: boolean
  backgroundColor?: NVSlideColor
  placeholderColor?: NVSlideColor
  gridColor?: NVSlideColor
  spatialTransform?: NVSlideSpatialTransform
  /** Pluggable tile source. Defaults to a byte-range manifest source; DZI / TIFF
   * adapters supply their own. See {@link SlideTileSource}. */
  source?: SlideTileSource
  /** Apply the slide's ICC profile when one is known and a transform is registered (default true). */
  colorManagement?: boolean
}

export interface NVSlideScreen {
  widthCss: number
  heightCss: number
  devicePixelRatio?: number
}

export interface NVSlideVisibleTile {
  slide: NVSlide
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  key: string
  screenX: number
  screenY: number
  screenWidth: number
  screenHeight: number
  flipY: boolean
}

export interface NVSlideVisibleTiles {
  level: NVSlideLevelManifest | null
  tiles: NVSlideVisibleTile[]
  /**
   * Already-cached tiles from COARSER levels covering the same viewport,
   * ordered coarsest first. A renderer paints these in array order UNDER
   * `tiles` and skips the placeholder quad for any target tile that is still
   * loading, so zooming in refines the image in place instead of blanking it.
   * Empty whenever every target tile is cached. See {@link NVSlide.visibleTiles}.
   */
  fallback: NVSlideVisibleTile[]
  /**
   * Set when `level` is coarser than the level asked for (pinned or auto),
   * because the requested level's visible tiles exceed the tile cache
   * (`maxCacheBytes`) or the visible-tile cap. Hosts can show this to the user.
   */
  requestedLevel?: NVSlideLevelManifest
  /**
   * Set when even `level` does not fit: `tiles` holds only the block nearest
   * the view centre that the cache can keep, so the view settles instead of
   * reloading tiles forever. Hosts can ask the user to zoom in.
   */
  capped?: boolean
}

export interface NVSlideScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export type NVSlideRangeStatus =
  | 'pending'
  | 'hit'
  | 'fallback'
  | 'failed'
  | 'aborted'

export interface NVSlideRangeEvent {
  label: string
  status: NVSlideRangeStatus
}

export interface NVSlideStats {
  requested: number
  completed: number
  rangeHits: number
  fullFileFallbacks: number
  failures: number
  /**
   * Loads NVSlide abandoned on purpose (the view moved on, or the slide was
   * disposed). Never a failure: nothing was wrong with the tile or the source.
   */
  aborted: number
  wireBytes: number
  decodedBytes: number
  cacheHits: number
  cacheBytes: number
  lastRequests: NVSlideRangeEvent[]
}

type TileBitmap = {
  bitmap: ImageBitmap
  bytes: number
  level: NVSlideLevelManifest
  /** Kept for sample tiles, so a channel change re-renders them. */
  samples?: NVSlideTileSamples
  /** The channel each sample plane holds; absent, plane p is channel p. */
  channels?: readonly number[]
}
type SampleTile = TileBitmap & { samples: NVSlideTileSamples }

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024
const DEFAULT_TARGET_SCREEN_PIXELS_PER_TILE_PIXEL = 0.75
const DEFAULT_RANGE_LOG_LENGTH = 24
// Cap simultaneous fetch+decode work. Without it a zoom/pan burst fires one
// concurrent fetch AND createImageBitmap per uncached visible tile (hundreds at
// once on a gigapixel slide), spiking network sockets, decode threads, and
// GPU-backed bitmap allocations in the browser's GPU process.
const DEFAULT_MAX_CONCURRENT_TILE_LOADS = 12
// Failed-tile retries due within one tick share a timer and a change event.
const RETRY_TICK = 250 // ms

/**
 * Coerce the caller's tile concurrency cap to a finite positive integer.
 *
 * A bare Math.max(1, x) lets Infinity and NaN through, and both remove the
 * cap rather than raise it: every capacity test is `_activeLoads >= cap`, which
 * is false for either value, so no tile is ever queued and every request goes
 * straight to _runLoad. Flooring to a whole number also keeps the effective cap
 * equal to the number asked for — 2.5 would otherwise admit a third load.
 */
function clampTileLoadCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_TILE_LOADS
  return Math.max(1, Math.floor(value) || 1)
}
// Safety valve for pathological manifests (e.g. a missing tileSize defaulting
// to 1px tiles): never enumerate more visible tiles than this per frame. A
// sane pyramid level never exceeds a few hundred on screen.
const MAX_VISIBLE_TILES = 4096

function freshStats(): NVSlideStats {
  return {
    requested: 0,
    completed: 0,
    rangeHits: 0,
    fullFileFallbacks: 0,
    failures: 0,
    aborted: 0,
    wireBytes: 0,
    decodedBytes: 0,
    cacheHits: 0,
    cacheBytes: 0,
    lastRequests: [],
  }
}

/** Monochrome samples to RGBA8 through `window`; MONOCHROME1 inverts after windowing. */
// One table per window: setChannel re-windows every cached tile with the same one.
let lastLut: { key: string; lut: Uint8Array } | null = null

function windowLut(
  size: number,
  { calMin, calMax }: NVSlideWindow,
  invert: boolean,
): Uint8Array {
  const key = `${size},${calMin},${calMax},${invert}`
  if (lastLut?.key === key) return lastLut.lut
  const lut = new Uint8Array(size)
  const width = calMax - calMin
  for (let v = 0; v < size; v++) {
    // Multiply before dividing, so a midpoint like 127.5 is exact and rounds up.
    const g = Math.round(clamp(((v - calMin) * 255) / width, 0, 255))
    lut[v] = invert ? 255 - g : g
  }
  lastLut = { key, lut }
  return lut
}

export function windowSamples(
  samples: Uint8Array | Uint16Array,
  window: NVSlideWindow,
  invert: boolean,
): Uint8ClampedArray<ArrayBuffer> {
  // One lookup per pixel: the table holds every possible sample value.
  const lut = windowLut(
    samples instanceof Uint8Array ? 256 : 65536,
    window,
    invert,
  )
  const out = new Uint8ClampedArray(samples.length * 4)
  for (let i = 0, o = 0; i < samples.length; i++, o += 4) {
    const g = lut[samples[i]]
    out[o] = g
    out[o + 1] = g
    out[o + 2] = g
    out[o + 3] = 255
  }
  return out
}

/** One channel's table: sample value to RGB (4 bytes each, the 4th unused), window then colormap. */
function channelLut(
  size: number,
  window: NVSlideWindow,
  invert: boolean,
  colormap: string,
): Uint8Array {
  const grey = windowLut(size, window, invert)
  const rgba = lutrgba8(colormap)
  const lut = new Uint8Array(size * 4)
  for (let v = 0, o = 0; v < size; v++, o += 4) {
    const g = grey[v] * 4
    lut[o] = rgba[g]
    lut[o + 1] = rgba[g + 1]
    lut[o + 2] = rgba[g + 2]
  }
  return lut
}

/**
 * Planar samples to opaque RGBA8: each listed plane through its channel table
 * ({@link channelLut}), combined by per-component max or saturating sum.
 */
export function compositeSamples(
  samples: Uint8Array | Uint16Array,
  pixels: number,
  layers: ReadonlyArray<{ plane: number; lut: Uint8Array }>,
  additive: boolean,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels * 4)
  if (layers.length === 0) for (let o = 3; o < out.length; o += 4) out[o] = 255
  // The first layer writes, later ones combine: one loop per case, no per-pixel branch on blend.
  layers.forEach(({ plane, lut }, k) => {
    const base = plane * pixels
    if (k === 0) {
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const j = samples[base + i] * 4
        out[o] = lut[j]
        out[o + 1] = lut[j + 1]
        out[o + 2] = lut[j + 2]
        out[o + 3] = 255
      }
    } else if (additive) {
      // Uint8ClampedArray saturates the sum at 255.
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const j = samples[base + i] * 4
        out[o] += lut[j]
        out[o + 1] += lut[j + 1]
        out[o + 2] += lut[j + 2]
      }
    } else {
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const j = samples[base + i] * 4
        out[o] = Math.max(out[o], lut[j])
        out[o + 1] = Math.max(out[o + 1], lut[j + 1])
        out[o + 2] = Math.max(out[o + 2], lut[j + 2])
      }
    }
  })
  return out
}

// raw-gray tiles are samples whatever the (optional, DICOM) photometric says.
const isMonochrome = (level: NVSlideLevelManifest): boolean =>
  level.codec === 'raw-gray' ||
  (level.photometric?.startsWith('MONOCHROME') ?? false)

/** RGB samples (no channelInfo, not monochrome) only make sense added. */
export const isRgbSlide = (manifest: NVSlideManifest): boolean =>
  !manifest.channelInfo && !manifest.levels.some(isMonochrome)

const usableWindow = (w?: NVSlideWindow): w is NVSlideWindow =>
  !!w &&
  Number.isFinite(w.calMin) &&
  Number.isFinite(w.calMax) &&
  w.calMax > w.calMin

/** The channels a slide opens with: its manifest's `channelInfo`, else grey or RGB. */
export function defaultSlideChannels(manifest: NVSlideManifest): NVChannel[] {
  const info = manifest.channelInfo
  if (info) {
    const colormaps = channelColormapsFor(info.map((c) => c.rgb))
    return info.map((c, i) => ({
      name: c.name,
      colormap: colormaps[i] as string,
      calMin: usableWindow(c.window) ? c.window.calMin : Number.NaN,
      calMax: usableWindow(c.window) ? c.window.calMax : Number.NaN,
      visible: c.active,
    }))
  }
  const names = manifest.levels.some(isMonochrome)
    ? ['gray']
    : ['red', 'green', 'blue']
  return names.map((name) => ({
    name,
    colormap: name,
    calMin: Number.NaN,
    calMax: Number.NaN,
    visible: true,
  }))
}

/** A CPU-backed 2D context to read pixels from; null without OffscreenCanvas. */
function readbackContext(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  // Skip a GPU-backed canvas and its readback.
  const ctx = new OffscreenCanvas(width, height).getContext('2d', {
    willReadFrequently: true,
  })
  // A reused context: a translucent pixel must not blend with the last one.
  if (ctx) ctx.globalCompositeOperation = 'copy'
  return ctx
}

/** A bitmap region's decoded RGBA. */
function readPixels(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  ctx.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

/** A grey bitmap's red channel as 8-bit samples; closes the bitmap. */
function greySamples(bitmap: ImageBitmap): NVSlideTileSamples {
  const { width, height } = bitmap
  try {
    const ctx = readbackContext(width, height)
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    const rgba = readPixels(ctx, bitmap, 0, 0, width, height)
    const samples = new Uint8Array(width * height)
    for (let i = 0; i < samples.length; i++) samples[i] = rgba[i * 4] as number
    return { samples, width, height, bitsStored: 8 }
  } finally {
    bitmap.close()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function copyUint8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function copyClamped(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const copy = new Uint8ClampedArray(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(length)
  let ptr = 0
  for (const part of parts) {
    out.set(part, ptr)
    ptr += part.byteLength
  }
  return out
}

let iccTransform: SlideIccTransform | null = null

// Tile-codec registry. Built-ins cover the browser-native paths; additional
// codecs (e.g. image/jp2 via @niivue/dcm2niix) are registered by the
// consumer with NVSlide.registerTileDecoder, so the core ships no heavy codec.
const tileDecoders = new Map<string, SlideTileDecoder>([
  [
    'image/jpeg',
    // No browser colour conversion: a slide's profile is the source's
    // (NVSlide.colorLut), not an APP2 segment inside a tile.
    (bytes) =>
      createImageBitmap(new Blob([copyUint8(bytes)], { type: 'image/jpeg' }), {
        colorSpaceConversion: 'none',
      }),
  ],
  [
    'raw-rgba',
    (bytes, { width, height }) => {
      const expected = width * height * 4
      if (bytes.byteLength !== expected) {
        throw new Error(
          `Expected ${expected} RGBA bytes, received ${bytes.byteLength}`,
        )
      }
      return createImageBitmap(new ImageData(copyClamped(bytes), width, height))
    },
  ],
  [
    'raw-gray',
    // Monochrome samples in platform byte order: 8-bit when the level's
    // bitsStored is 8 or less, else 16-bit (the default). Windowed by NVSlide
    // like decoded DICOM monochrome tiles.
    async (bytes, { width, height, level }) => {
      const bitsStored = level.bitsStored ?? 16
      if (bitsStored > 16) {
        throw new Error(
          `raw-gray supports bitsStored up to 16, received ${bitsStored}`,
        )
      }
      const wide = bitsStored > 8
      if (bytes.byteLength !== width * height * (wide ? 2 : 1)) {
        throw new Error(
          `Expected ${width}x${height} ${wide ? 16 : 8}-bit samples, received ${bytes.byteLength} bytes`,
        )
      }
      const own = copyUint8(bytes)
      const samples = wide ? new Uint16Array(own.buffer) : own
      return { samples, width, height, bitsStored }
    },
  ],
])

class NVSlideTileCache {
  private readonly entries = new Map<string, TileBitmap>()
  bytes = 0

  constructor(readonly maxBytes: number) {}

  get(key: string): TileBitmap | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: TileBitmap): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.bitmap.close()
      this.bytes -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    this.evict()
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.bitmap.close()
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  /** Like get, without refreshing LRU order. */
  peek(key: string): TileBitmap | undefined {
    return this.entries.get(key)
  }

  *sampleEntries(): Generator<[string, SampleTile]> {
    for (const pair of this.entries)
      if (pair[1].samples) yield pair as [string, SampleTile]
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.bitmap.close()
    }
    this.entries.clear()
    this.bytes = 0
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey !== 'string') return
      const entry = this.entries.get(firstKey)
      if (!entry) return
      entry.bitmap.close()
      this.entries.delete(firstKey)
      this.bytes -= entry.bytes
    }
  }
}

/**
 * Telemetry + URL hooks a {@link SlideTileSource} uses. NVSlide implements this
 * so a source can resolve relative URLs and record wire bytes / range-request
 * status into the slide's stats + recent-request log without owning them.
 */
export interface SlideSourceHost {
  resolveUrl(url: string): string
  addWireBytes(bytes: number): void
  rangeHit(): void
  rangeFallback(): void
  pushRangeEvent(event: NVSlideRangeEvent): void
  updateRangeEvent(label: string, status: NVSlideRangeStatus): void
}

/**
 * A pluggable slide source: owns the pyramid manifest and fetches the bytes for
 * one tile in its level's `codec`: compressed (e.g. `image/jpeg`) or raw samples
 * (`raw-rgba` or `raw-gray`, as TIFF and Zarr return). NVSlide owns decoding, caching, stats
 * and the viewport; a source varies by FORMAT. {@link ManifestRangeSource} (the
 * default) addresses tiles as byte ranges in a per-level file (dicom-wsi-range-v1
 * and the synthetic pyramid); `DziSource` (per-tile URLs) and
 * `TiffSlideSource` in `@niivue/nv-ext-tile/tiff` (geotiff) implement the same contract.
 */
export interface SlideTileSource {
  readonly manifest: NVSlideManifest
  /** Adopted by an NVSlide before any fetch; wires up telemetry + URL resolution. */
  bind(host: SlideSourceHost): void
  /**
   * Fetch one tile's bytes in `level.codec` (compressed or raw samples); NVSlide
   * decodes them per that codec.
   *
   * `signal` fires when NVSlide no longer wants the tile -- the view moved on,
   * or the slide was disposed. A source that reads over the network should
   * pass it to `fetch()` so the read is abandoned on the wire rather than
   * discarded on arrival, and reject with an `AbortError`. Optional: a source
   * that ignores it stays correct, only wasteful, and NVSlide drops whatever
   * it resolves after the abort.
   */
  fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  /**
   * Decoded samples for one tile, one plane per entry of `channels` (indices
   * into {@link NVSlide.channels}, in that order): the visible ones, possibly
   * none (return `planes: 0`). When present NVSlide calls it instead of
   * `fetchTileBytes` and composites the planes itself. Such a source states
   * its channels in `manifest.channelInfo`; without it NVSlide assumes RGB
   * and asks for 3 planes. Optional.
   */
  fetchTileSamples?(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples>
  /** The slide's ICC profile bytes, or null when it has none. Optional. */
  fetchIccProfile?(signal?: AbortSignal): Promise<Uint8Array | null>
}

function isAbortError(err: unknown): boolean {
  // Structural check: fetch() aborts reject with a DOMException named
  // 'AbortError', which is not an Error instance in every runtime.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Default source: a byte-range manifest (dicom-wsi-range-v1 / synthetic pyramid).
 * Each tile is one or more byte fragments addressed into a per-level file (or the
 * manifest `dataUrl`), fetched with an HTTP Range request (206) and a full-file
 * fallback for servers without range support.
 */
export class ManifestRangeSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null

  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  private requireHost(): SlideSourceHost {
    if (!this.host) {
      throw new Error('ManifestRangeSource is not bound to an NVSlide host')
    }
    return this.host
  }

  private tileSourceUrl(level: NVSlideLevelManifest): string {
    const host = this.requireHost()
    if (level.fileUrl) return host.resolveUrl(level.fileUrl)
    if (this.manifest.dataUrl) return host.resolveUrl(this.manifest.dataUrl)
    throw new Error(`No byte source for slide L${level.index}`)
  }

  private tileFragments(tile: NVSlideTileManifest): NVSlideTileFragment[] {
    if (typeof tile.offset === 'number' && typeof tile.length === 'number') {
      return [{ offset: tile.offset, length: tile.length }]
    }
    if (tile.fragments && tile.fragments.length > 0) return tile.fragments
    throw new Error(`Tile ${tile.x}/${tile.y} has no byte ranges`)
  }

  private async fetchFragment(
    sourceUrl: string,
    fragment: NVSlideTileFragment,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const host = this.requireHost()
    const start = fragment.offset
    const end = fragment.offset + fragment.length - 1
    const rangeLabel = `${label} ${start}-${end}`
    host.pushRangeEvent({ label: rangeLabel, status: 'pending' })
    let response: Response
    let wireBytes: Uint8Array
    try {
      response = await fetch(sourceUrl, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      })
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`)
      }
      wireBytes = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      // The 'pending' entry must not outlive the request: a rejected fetch
      // (the load's signal firing, a network failure, an HTTP error) would
      // otherwise leave a stale 'pending' row in stats.lastRequests forever
      // (_runLoad's catch updates the TILE label, not this fragment's).
      host.updateRangeEvent(
        rangeLabel,
        signal?.aborted || isAbortError(error) ? 'aborted' : 'failed',
      )
      throw error
    }
    host.addWireBytes(wireBytes.byteLength)
    if (response.status === 206) {
      host.rangeHit()
      host.updateRangeEvent(rangeLabel, 'hit')
      if (wireBytes.byteLength !== fragment.length) {
        throw new Error(
          `Expected ${fragment.length} bytes, received ${wireBytes.byteLength}`,
        )
      }
      return wireBytes
    }
    host.rangeFallback()
    host.updateRangeEvent(rangeLabel, 'fallback')
    return wireBytes.slice(start, end + 1)
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const sourceUrl = tile.fileUrl
      ? this.requireHost().resolveUrl(tile.fileUrl)
      : this.tileSourceUrl(level)
    const fragments = this.tileFragments(tile)
    const parts = await Promise.all(
      fragments.map((fragment) =>
        this.fetchFragment(sourceUrl, fragment, label, signal),
      ),
    )
    return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts)
  }

  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const icc = this.manifest.iccProfile
    if (!icc) return null
    const url = this.requireHost().resolveUrl(icc.url)
    const { offset, length } = icc
    if ((offset === undefined) !== (length === undefined))
      throw new Error('ICC profile states only one of offset and length')
    // 64 MB: far beyond a scanner profile (Leica's is 13 MB), as dcm2niix caps it.
    if (length !== undefined && length > 64 * 1024 * 1024)
      throw new Error(`ICC profile of ${length} bytes`)
    if (offset !== undefined && length !== undefined)
      return this.fetchFragment(url, { offset, length }, 'icc', signal)
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`ICC profile HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

/**
 * Refuse a DICOM-WSI manifest whose levels are not known to hold a single optical
 * path and focal plane: their frames would otherwise be laid out as one tile grid,
 * putting tiles from other channels or depths in the wrong places. Other formats
 * (DZI, TIFF, synthetic) have no such dimensions.
 *
 * A TILED_FULL level's frames cover the grid once per path and plane, so the frame
 * count confirms the tags and, when one is absent, proves it is 1 only if the
 * frames equal the grid. With no frame count (NumberOfFrames is Type 1, but a
 * server may still omit it), tags stating one of each are taken as given.
 */
export function assertSingleSlidePlane(manifest: NVSlideManifest): void {
  if (!manifest.format?.startsWith('dicom-wsi')) return
  for (const level of manifest.levels) {
    if (level.sparse) {
      if (level.opticalPaths === 1 && level.focalPlanes === 1) continue
      throw new Error(
        `Slide level ${level.index} is sparse but does not state one optical path and one focal plane`,
      )
    }
    const { frames } = level
    if (
      frames === undefined &&
      level.opticalPaths === 1 &&
      level.focalPlanes === 1
    )
      continue
    const grid = level.columns * level.rows
    const paths = level.opticalPaths ?? (frames === grid ? 1 : undefined)
    const planes = level.focalPlanes ?? (frames === grid ? 1 : undefined)
    const known =
      paths !== undefined &&
      planes !== undefined &&
      frames === grid * paths * planes
    if (known && paths === 1 && planes === 1) continue
    const what = known
      ? `holds ${paths} optical paths and ${planes} focal planes; only one of each is supported`
      : 'has optical paths or focal planes that are unknown or disagree with its frame count'
    throw new Error(`Slide level ${level.index} ${what}`)
  }
}

// The same bound as nv-ext-tile's DICOM-WSI index: the largest real level
// grid is 379k tiles, so a hosted manifest past this is broken or hostile.
export const MAX_SLIDE_GRID = 1 << 22

export function assertSlideGrid(tiles: number, levelIndex: number): void {
  if (tiles > MAX_SLIDE_GRID)
    throw new Error(
      `Slide level ${levelIndex} has ${tiles} tiles, over the ${MAX_SLIDE_GRID} a level may hold`,
    )
}

/**
 * A level that lists only its present tiles, or is sparse, becomes the dense
 * row-major grid with null holes, placed by each tile's x/y (a listing's order
 * is not trusted). Off-grid tiles and second tiles for a cell are dropped.
 * Returns a new level; the caller's manifest is not changed.
 */
function placeListedTiles(level: NVSlideLevelManifest): NVSlideLevelManifest {
  const n = level.columns * level.rows
  assertSlideGrid(n, level.index)
  if (!level.sparse && level.tiles.length === n) return level
  const grid: Array<NVSlideTileManifest | null> = new Array(n).fill(null)
  for (const tile of level.tiles) {
    if (!tile) continue
    const { x, y } = tile
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue
    if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) continue
    grid[y * level.columns + x] ??= tile
  }
  return { ...level, tiles: grid }
}

/** The top-left `width` x `height` of each plane of a padded sample frame. */
function cropSamples(
  frame: NVSlideTileSamples,
  width: number,
  height: number,
): NVSlideTileSamples {
  const w = Math.min(frame.width, width)
  const h = Math.min(frame.height, height)
  const planes = frame.planes ?? 1
  const samples =
    frame.samples instanceof Uint16Array
      ? new Uint16Array(w * h * planes)
      : new Uint8Array(w * h * planes)
  for (let p = 0; p < planes; p++)
    for (let y = 0; y < h; y++) {
      const from = (p * frame.height + y) * frame.width
      samples.set(frame.samples.subarray(from, from + w), (p * h + y) * w)
    }
  return { ...frame, samples, width: w, height: h }
}

export class NVSlide extends EventTarget {
  readonly id: string
  readonly name: string
  readonly manifest: NVSlideManifest
  readonly manifestUrl: string
  readonly stats: NVSlideStats
  opacity: number
  visible: boolean
  viewport: NVSlideViewport
  levelChoice: NVSlideLevelChoice
  maxScale: number
  targetScreenPixelsPerTilePixel: number
  showTileGrid: boolean
  backgroundColor: NVSlideColor
  placeholderColor: NVSlideColor
  gridColor: NVSlideColor
  spatialTransform: NVSlideSpatialTransform | null
  private readonly _rangeLogLength = DEFAULT_RANGE_LOG_LENGTH
  private readonly _cache: NVSlideTileCache
  private readonly _pending = new Set<string>()
  // A failed tile waits before it is requested again (1 s, doubling to 30 s):
  // every render re-requests missing tiles, so a persistent failure (HTTP
  // error, bad frame) would otherwise be fetched in a tight loop.
  private readonly _failed = new Map<
    string,
    { retryAt: number; delay: number }
  >()
  private readonly _retryTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >()
  private readonly _source: SlideTileSource
  private readonly _maxConcurrentLoads: number
  private _activeLoads = 0
  private readonly _loadQueue: Array<{
    level: NVSlideLevelManifest
    tile: NVSlideTileManifest
    key: string
  }> = []
  // Tile keys the CURRENT view still wants. Rebuilt by every
  // requestVisibleTiles call; requestTile adds to it. Queued loads whose key
  // has left this set are dropped at dequeue time instead of fetched — without
  // this, zooming/panning piles stale tiles into the queue and fresh visible
  // tiles crawl behind the backlog.
  private readonly _wanted = new Set<string>()
  // One controller per in-flight load, keyed by tile key. Aborted when the
  // tile leaves the working set or the slide is disposed, so the source can
  // abandon the read on the wire instead of NVSlide discarding it on arrival.
  private readonly _inflight = new Map<string, AbortController>()
  // Keys whose CURRENT load was started by requestVisibleTiles (the 2D
  // viewport working-set path). _abortUnwantedLoads only aborts these: a load
  // begun via requestTile() serves a consumer the 2D viewport knows nothing
  // about (slide-plane coarsest-level priming, the wand color reference), so
  // a pan/zoom must not cancel it -- it completes and populates the cache.
  // dispose() still aborts every in-flight load regardless of origin.
  private readonly _viewportKeys = new Set<string>()
  private _budgetWarned = '' // last budget outcome logged by visibleTiles
  private _lastVisible: NVSlideVisibleTiles | null = null
  private _channels: readonly NVChannel[]
  private _channelBlend: NVSlideChannelBlend = 'max'
  private readonly _rgb: boolean
  // Channel tables for the current channel state, shared by every tile it renders.
  private readonly _luts = new Map<string, Uint8Array>()
  private _windowGen = 0
  private _rewindowing = false
  private _colorManagement: boolean
  private _colorLut: NVSlideColorLut | null = null
  private readonly _colorAbort = new AbortController()
  // One 1x1 readback context, reused by sampleAt on hover.
  private _pixelReader?: OffscreenCanvasRenderingContext2D | null

  constructor(manifest: NVSlideManifest, options: NVSlideOptions = {}) {
    super()
    assertSingleSlidePlane(manifest)
    const levels = manifest.levels.map(placeListedTiles)
    this.manifest = levels.every((l, i) => l === manifest.levels[i])
      ? manifest
      : { ...manifest, levels }
    this.manifestUrl = options.manifestUrl ?? ''
    this.id = options.id ?? manifest.id
    this.name = options.name ?? manifest.name
    this.opacity = options.opacity ?? 1
    this.visible = options.visible ?? true
    this.viewport = options.viewport ?? {
      centerX: manifest.width / 2,
      centerY: manifest.height / 2,
      scale: 1,
    }
    this.levelChoice = options.levelChoice ?? 'auto'
    this.maxScale = options.maxScale ?? 16
    this.targetScreenPixelsPerTilePixel =
      options.targetScreenPixelsPerTilePixel ??
      DEFAULT_TARGET_SCREEN_PIXELS_PER_TILE_PIXEL
    this.showTileGrid = options.showTileGrid ?? false
    this.backgroundColor = options.backgroundColor ?? [0.027, 0.063, 0.051, 1]
    this.placeholderColor = options.placeholderColor ?? [0.067, 0.098, 0.09, 1]
    this.gridColor = options.gridColor ?? [0.455, 0.831, 0.812, 0.24]
    this.spatialTransform = options.spatialTransform ?? null
    this.stats = freshStats()
    this._cache = new NVSlideTileCache(
      options.maxCacheBytes ?? DEFAULT_CACHE_BYTES,
    )
    this._maxConcurrentLoads = clampTileLoadCap(
      options.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_TILE_LOADS,
    )
    this._colorManagement = options.colorManagement ?? true
    this._channels = defaultSlideChannels(this.manifest)
    this._rgb = isRgbSlide(this.manifest)
    this._source = options.source ?? new ManifestRangeSource(manifest)
    this._source.bind({
      resolveUrl: (url) => this.resolveUrl(url),
      addWireBytes: (n) => {
        this.stats.wireBytes += n
      },
      rangeHit: () => {
        this.stats.rangeHits++
      },
      rangeFallback: () => {
        this.stats.fullFileFallbacks++
      },
      pushRangeEvent: (event) => this.pushRangeEvent(event),
      updateRangeEvent: (label, status) => this.updateRangeEvent(label, status),
    })
    void this._loadColorLut()
  }

  /** The slide's sRGB lookup table, once its ICC profile is baked; null without one. */
  get colorLut(): NVSlideColorLut | null {
    return this._colorLut
  }

  /** The table renderers apply: {@link colorLut} while colour management is on, else null. */
  get displayColorLut(): NVSlideColorLut | null {
    return this._colorManagement ? this._colorLut : null
  }

  /** Whether renderers apply {@link colorLut}. Toggling only redraws: tiles are kept as decoded. */
  get colorManagement(): boolean {
    return this._colorManagement
  }

  set colorManagement(on: boolean) {
    if (on === this._colorManagement) return
    this._colorManagement = on
    this.dispatchEvent(new Event('change'))
  }

  private async _loadColorLut(): Promise<void> {
    const transform = iccTransform
    // DICOM ColorSpace SRGB means the profile is the display space already;
    // a grey slide's display mapping is its window, whatever profile it carries.
    if (
      !transform ||
      !this._source.fetchIccProfile ||
      this._source.fetchTileSamples ||
      this.manifest.iccProfile?.colorSpace?.toUpperCase() === 'SRGB' ||
      this.manifest.levels.some(isMonochrome)
    )
      return
    const signal = this._colorAbort.signal
    try {
      const profile = await this._source.fetchIccProfile(signal)
      const lut = profile && (await transform(profile, signal))
      if (!lut || signal.aborted) return
      // Renderers upload it as an RGBA8 3D texture: anything else fails there,
      // and 129^3 (8.6 MB, dcm2niix's ceiling) is far beyond any table's need.
      if (
        !(lut.data instanceof Uint8Array) ||
        !Number.isInteger(lut.size) ||
        lut.size < 2 ||
        lut.size > 129 ||
        lut.data.length !== lut.size ** 3 * 4
      )
        throw new Error(`colour table of size ${lut.size} is not size^3 RGBA8`)
      this._colorLut = lut
      this.dispatchEvent(new Event('change'))
    } catch (err) {
      if (!signal.aborted && !isAbortError(err))
        log.warn(`NVSlide ${this.id}: ICC profile not applied`, err)
    }
  }

  /** Build a slide from any tile source (DICOM-WSI/DZI/TIFF adapter). */
  static fromSource(
    source: SlideTileSource,
    options: NVSlideOptions = {},
  ): NVSlide {
    return new NVSlide(source.manifest, { ...options, source })
  }

  static async fromManifestUrl(
    manifestUrl: string,
    options: NVSlideOptions = {},
  ): Promise<NVSlide> {
    const controller = new AbortController()
    const response = await fetch(manifestUrl, { signal: controller.signal })
    if (!response.ok) {
      // A server may explain a refusal as JSON `{ error }`; keep its reason, but
      // never let an error body that does not finish hold back the status.
      const isJson = response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('json')
      let timer: ReturnType<typeof setTimeout> | undefined
      const body = isJson
        ? ((await Promise.race([
            response.json().catch(() => null),
            new Promise((resolve) => {
              timer = setTimeout(resolve, 1000, null)
            }),
          ])) as { error?: unknown } | null)
        : null
      clearTimeout(timer)
      controller.abort() // releases a body read still pending, or never started
      const reason = typeof body?.error === 'string' ? `: ${body.error}` : ''
      throw new Error(`Slide manifest HTTP ${response.status}${reason}`)
    }
    const manifest = (await response.json()) as NVSlideManifest
    return new NVSlide(manifest, { ...options, manifestUrl })
  }

  get pendingCount(): number {
    return this._pending.size
  }

  get cacheBytes(): number {
    return this._cache.bytes
  }

  /** The displayed channels, one per source sample plane (see {@link NVChannel}). */
  get channels(): readonly Readonly<NVChannel>[] {
    // Copies: a readback cannot change the slide behind setChannel's checks.
    return this._channels.map((ch) => ({ ...ch }))
  }

  /**
   * Update channel `c`. Cached sample tiles re-render from their kept planes;
   * showing a channel they were fetched without refetches them. Tiles a decoder
   * returned as bitmaps (JPEG, RGBA) are drawn as decoded.
   */
  setChannel(c: number, update: Partial<NVChannel>): void {
    const old = this._channels[c]
    if (!old) throw new RangeError(`NVSlide has no channel ${c}`)
    const u = { ...old, ...update }
    // Only the known fields: an extra key would be kept and saved.
    const next: NVChannel = {
      // An explicit undefined keeps the field; only the bounds reset (below).
      name: u.name ?? old.name,
      colormap: u.colormap ?? old.colormap,
      calMin: u.calMin,
      calMax: u.calMax,
      visible: u.visible ?? old.visible,
    }
    // An omitted (undefined) bound is the default, as a non-finite one is.
    next.calMin ??= Number.NaN
    next.calMax ??= Number.NaN
    if (
      Number.isFinite(next.calMin) &&
      Number.isFinite(next.calMax) &&
      next.calMax <= next.calMin
    )
      throw new RangeError(
        `NVSlide channel ${c} needs calMin < calMax, got ${next.calMin}, ${next.calMax}`,
      )
    if (!lookupColorMap(next.colormap))
      throw new RangeError(`Unknown colormap "${next.colormap}"`)
    const channels = [...this._channels]
    channels[c] = next
    this._channels = channels
    if (next.visible && !old.visible && this._source.fetchTileSamples)
      this._refetchWithout(c)
    this._rerender()
  }

  /** How visible channels combine; always 'additive' on an RGB slide. */
  get channelBlend(): NVSlideChannelBlend {
    return this._rgb ? 'additive' : this._channelBlend
  }

  /** Set {@link channelBlend}; ignored on an RGB slide. */
  setChannelBlend(blend: NVSlideChannelBlend): void {
    if (blend !== 'max' && blend !== 'additive')
      throw new RangeError(`Unknown channel blend "${blend}"`)
    if (this._rgb || blend === this._channelBlend) return
    this._channelBlend = blend
    this._rerender()
  }

  /** The focal plane and time point shown; only {z: 0, t: 0} so far. */
  get planeIndex(): NVSlidePlaneIndex {
    return { z: 0, t: 0 }
  }

  /** Throws unless `plane` is {z: 0, t: 0}: slides hold one plane until focal stacks land. */
  setPlaneIndex(plane: NVSlidePlaneIndex): void {
    if (plane.z !== 0 || plane.t !== 0)
      throw new RangeError(
        `NVSlide has only plane {z: 0, t: 0}, got {z: ${plane.z}, t: ${plane.t}}`,
      )
  }

  private _visibleChannels(): number[] {
    return this._channels.flatMap((ch, i) => (ch.visible ? [i] : []))
  }

  // ponytail: dropped tiles blank until refetched; refresh in place if the flash bothers.
  // Loads in flight check the channels when they land (_runLoad).
  private _refetchWithout(c: number): void {
    const dropped = new Set<string>()
    for (const [key, entry] of [...this._cache.sampleEntries()])
      if (!entry.channels?.includes(c)) {
        this._cache.delete(key)
        dropped.add(key)
      }
    this.stats.cacheBytes = this._cache.bytes
    // The view re-requests its own tiles; nothing re-requests the coarsest
    // level that setSlidePlane primed (the 3D plane's fallback), so do it here.
    const coarsest = this.manifest.levels.at(-1)
    for (const tile of coarsest?.tiles ?? [])
      if (coarsest && tile && dropped.has(this.tileKey(coarsest, tile)))
        this.loadTile(coarsest, tile)
  }

  private _rerender(): void {
    this._luts.clear()
    this._windowGen++
    void this._rewindowCached()
    this._emitChange()
  }

  // One pass at a time, one tile per step (each awaits createImageBitmap, so
  // input runs between tiles), newest first: the LRU keeps the tiles drawn
  // last, the visible ones, at its end. A window set mid-pass restarts it, so
  // a W/L drag re-windows each tile once for the latest window, not per call.
  private async _rewindowCached(): Promise<void> {
    if (this._rewindowing) return
    this._rewindowing = true
    try {
      let gen = -1
      while (gen !== this._windowGen) {
        gen = this._windowGen
        const entries = [...this._cache.sampleEntries()].reverse()
        for (const [key, entry] of entries) {
          if (gen !== this._windowGen) break
          if (this._cache.peek(key) !== entry) continue // evicted meanwhile
          let bitmap: ImageBitmap
          try {
            bitmap = await this.windowedBitmap(
              entry.samples,
              entry.level,
              entry.channels,
            )
          } catch (err) {
            log.warn(`NVSlide ${this.id}: re-window failed`, err)
            continue
          }
          // Superseded by a later window, or evicted/disposed meanwhile.
          if (gen !== this._windowGen || this._cache.peek(key) !== entry) {
            bitmap.close()
            continue
          }
          entry.bitmap.close()
          entry.bitmap = bitmap
          this._emitChange()
        }
      }
    } finally {
      this._rewindowing = false
    }
  }

  private windowedBitmap(
    s: NVSlideTileSamples,
    level: NVSlideLevelManifest,
    held?: readonly number[],
  ): Promise<ImageBitmap> {
    const max = 2 ** (level.bitsStored ?? s.bitsStored) - 1
    const invert = level.photometric === 'MONOCHROME1'
    const pixels = s.width * s.height
    const shown: Array<{ plane: number; ch: NVChannel }> = []
    for (let plane = 0; plane < (s.planes ?? 1); plane++) {
      const ch = this._channels[held ? (held[plane] as number) : plane]
      if (ch?.visible) shown.push({ plane, ch })
    }
    // A stored-range end never crosses the bound set (calMin 5000 on u8 is black, not inverted).
    const window = ({ calMin, calMax }: NVChannel): NVSlideWindow => {
      const lo = Number.isFinite(calMin)
        ? calMin
        : Number.isFinite(calMax)
          ? Math.min(0, calMax - 1)
          : 0
      return {
        calMin: lo,
        calMax: Number.isFinite(calMax) ? calMax : Math.max(max, lo + 1),
      }
    }
    const one = shown[0]
    // One grey channel (any monochrome slide by default): the grey-only loop.
    const rgba =
      shown.length === 1 && one && one.ch.colormap === 'gray'
        ? windowSamples(
            s.samples.subarray(one.plane * pixels, (one.plane + 1) * pixels),
            window(one.ch),
            invert,
          )
        : compositeSamples(
            s.samples,
            pixels,
            shown.map(({ plane, ch }) => ({
              plane,
              lut: this._channelLut(
                s.samples instanceof Uint8Array ? 256 : 65536,
                window(ch),
                invert,
                ch.colormap,
              ),
            })),
            this.channelBlend === 'additive',
          )
    return createImageBitmap(new ImageData(rgba, s.width, s.height))
  }

  // Re-render if the channels changed while this one rendered.
  private async _renderCurrent(
    samples: NVSlideTileSamples,
    level: NVSlideLevelManifest,
    held?: readonly number[],
  ): Promise<ImageBitmap> {
    for (;;) {
      const gen = this._windowGen
      const bitmap = await this.windowedBitmap(samples, level, held)
      if (gen === this._windowGen) return bitmap
      bitmap.close()
    }
  }

  private _channelLut(
    size: number,
    window: NVSlideWindow,
    invert: boolean,
    colormap: string,
  ): Uint8Array {
    const key = `${size},${window.calMin},${window.calMax},${invert},${colormapKey(colormap)}`
    let lut = this._luts.get(key)
    if (!lut) {
      lut = channelLut(size, window, invert, colormap)
      this._luts.set(key, lut)
    }
    return lut
  }

  setViewport(viewport: NVSlideViewport): void {
    this.viewport = { ...viewport }
    this._emitChange()
  }

  setLevelChoice(levelChoice: NVSlideLevelChoice): void {
    this.levelChoice = levelChoice
    this._emitChange()
  }

  setSpatialTransform(transform: NVSlideSpatialTransform | null): void {
    this.spatialTransform = transform
    this._emitChange()
  }

  setTileGridVisible(visible: boolean): void {
    this.showTileGrid = visible
    this._emitChange()
  }

  isYAxisUp(): boolean {
    return this.manifest.displayYAxis === 'up'
  }

  fitScaleFor(screen: NVSlideScreen, padding = 0.94): number {
    return (
      Math.min(
        screen.widthCss / this.manifest.width,
        screen.heightCss / this.manifest.height,
      ) * padding
    )
  }

  fitToScreen(screen: NVSlideScreen, padding = 0.94): void {
    this.viewport = {
      centerX: this.manifest.width / 2,
      centerY: this.manifest.height / 2,
      scale: this.fitScaleFor(screen, padding),
    }
    this._emitChange()
  }

  clampViewport(screen: NVSlideScreen): void {
    const minScale = this.fitScaleFor(screen) * 0.35
    this.viewport.scale = clamp(this.viewport.scale, minScale, this.maxScale)
    const halfWidth = screen.widthCss / (2 * this.viewport.scale)
    const halfHeight = screen.heightCss / (2 * this.viewport.scale)
    const padX = Math.max(this.manifest.width * 0.08, halfWidth * 0.25)
    const padY = Math.max(this.manifest.height * 0.08, halfHeight * 0.25)
    // When the view is wider than the padded slide on an axis the range
    // inverts; centre on the slide rather than pinning to the low bound.
    const clampAxis = (value: number, min: number, max: number) =>
      min > max ? (min + max) / 2 : clamp(value, min, max)
    this.viewport.centerX = clampAxis(
      this.viewport.centerX,
      -padX + halfWidth,
      this.manifest.width + padX - halfWidth,
    )
    this.viewport.centerY = clampAxis(
      this.viewport.centerY,
      -padY + halfHeight,
      this.manifest.height + padY - halfHeight,
    )
  }

  panByScreenDelta(dxCss: number, dyCss: number, screen: NVSlideScreen): void {
    this.viewport.centerX -= dxCss / this.viewport.scale
    this.viewport.centerY +=
      (this.isYAxisUp() ? 1 : -1) * (dyCss / this.viewport.scale)
    this.clampViewport(screen)
    this._emitChange()
  }

  screenToSlide(
    xCss: number,
    yCss: number,
    screen: NVSlideScreen,
  ): { x: number; y: number } {
    const left =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const top =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const y = this.isYAxisUp()
      ? this.viewport.centerY -
        (yCss - screen.heightCss / 2) / this.viewport.scale
      : top + yCss / this.viewport.scale
    return {
      x: left + xCss / this.viewport.scale,
      y,
    }
  }

  /**
   * Inverse of {@link screenToSlide}: map a slide base-pixel coordinate back to
   * canvas CSS pixels. Used to anchor screen-space overlays (e.g. a UIKit ruler
   * whose endpoints are stored in slide coordinates so they track the tissue
   * through pan/zoom) to the live viewport.
   */
  slideToScreen(
    sx: number,
    sy: number,
    screen: NVSlideScreen,
  ): { xCss: number; yCss: number } {
    const left =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const top =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const xCss = (sx - left) * this.viewport.scale
    const yCss = this.isYAxisUp()
      ? screen.heightCss / 2 -
        (sy - this.viewport.centerY) * this.viewport.scale
      : (sy - top) * this.viewport.scale
    return { xCss, yCss }
  }

  zoomBy(
    factor: number,
    anchorXCss: number,
    anchorYCss: number,
    screen: NVSlideScreen,
  ): void {
    const before = this.screenToSlide(anchorXCss, anchorYCss, screen)
    this.viewport.scale *= factor
    this.clampViewport(screen)
    const left = before.x - anchorXCss / this.viewport.scale
    const top = before.y - anchorYCss / this.viewport.scale
    this.viewport.centerX = left + screen.widthCss / (2 * this.viewport.scale)
    this.viewport.centerY = this.isYAxisUp()
      ? before.y + (anchorYCss - screen.heightCss / 2) / this.viewport.scale
      : top + screen.heightCss / (2 * this.viewport.scale)
    this.clampViewport(screen)
    this._emitChange()
  }

  /**
   * The pinned level, or for 'auto' the finest level giving at least
   * `targetScreenPixelsPerTilePixel` device pixels per tile pixel. Pass the
   * `screen` drawn: `viewport.scale` is CSS pixels per slide pixel, so without
   * its devicePixelRatio a 2x display gets half the detail it can show.
   */
  selectLevel(screen?: NVSlideScreen): NVSlideLevelManifest | null {
    if (typeof this.levelChoice === 'number') {
      return (
        this.manifest.levels.find(
          (level) => level.index === this.levelChoice,
        ) ?? null
      )
    }
    const devicePixelsPerSlidePixel =
      this.viewport.scale * (screen?.devicePixelRatio ?? 1)
    for (const level of this.manifest.levels) {
      if (
        devicePixelsPerSlidePixel * level.downsample >=
        this.targetScreenPixelsPerTilePixel
      ) {
        return level
      }
    }
    return this.manifest.levels[this.manifest.levels.length - 1] ?? null
  }

  sourceLabelForLevel(level: NVSlideLevelManifest): string {
    return level.fileUrl ?? this.manifest.dataUrl ?? this.manifestUrl
  }

  screenRectForSlide(screen: NVSlideScreen): NVSlideScreenRect {
    const dpr = screen.devicePixelRatio ?? 1
    const screenScale = this.viewport.scale * dpr
    const viewLeft =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const viewTop =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const viewBottom =
      this.viewport.centerY + screen.heightCss / (2 * this.viewport.scale)
    return {
      x: -viewLeft * screenScale,
      y: this.isYAxisUp()
        ? (viewBottom - this.manifest.height) * screenScale
        : -viewTop * screenScale,
      width: this.manifest.width * screenScale,
      height: this.manifest.height * screenScale,
    }
  }

  /**
   * The tiles covering the viewport at the auto-selected (or pinned) level,
   * plus a `fallback` layer of already-cached tiles from COARSER levels that
   * the renderer paints underneath them.
   *
   * The fallback layer is what keeps a zoom from flashing empty: the tiles for
   * a newly selected level arrive over hundreds of milliseconds, and until they
   * do their screen rects have nothing to draw but a flat placeholder. Rather
   * than discard the resolution already on screen, this hands the renderer the
   * cached coarser tiles covering the same viewport, ordered COARSEST FIRST so
   * painting them in array order lets each finer level overpaint the one below
   * and the target level land on top. The layer is built only when at least one
   * target tile is still missing, so a settled view pays nothing for it.
   */
  visibleTiles(screen: NVSlideScreen): NVSlideVisibleTiles {
    const requested = this.selectLevel(screen)
    if (!requested) return { level: null, tiles: [], fallback: [] }
    // A level whose visible tiles cannot all stay decoded thrashes: each load
    // evicts a visible tile, which is requested again. Show the finest coarser
    // level that fits (e.g. a pinned L0 viewed whole). Counted from the tile
    // span, so rejected levels cost no tile objects.
    const levels = this.manifest.levels
    let level = requested
    for (
      let pos = levels.indexOf(level) + 1;
      pos < levels.length && !this.fitsCache(level, screen);
      pos++
    )
      level = levels[pos] as NVSlideLevelManifest
    // Warn once per change of outcome; this runs every frame.
    const capacity = this.tileCapacity(level)
    const fits = this.tileSpan(level, screen).count <= capacity
    const budget =
      level === requested && fits ? '' : `${requested.index}>${level.index}`
    if (budget && budget !== this._budgetWarned)
      log.warn(
        `NVSlide ${this.id}: L${requested.index} needs ${this.tileSpan(requested, screen).count} tiles in view, more than the tile cache (maxCacheBytes) or the ${MAX_VISIBLE_TILES}-tile cap holds; ${fits ? `showing L${level.index}` : `even L${level.index} does not fit, so only the ${capacity} tiles nearest the centre load`}. Zoom in or raise maxCacheBytes.`,
      )
    this._budgetWarned = budget
    const tiles = this.tilesForLevel(level, screen, capacity)
    return {
      level,
      tiles,
      fallback: this.fallbackTiles(level, tiles, screen),
      requestedLevel: level === requested ? undefined : requested,
      capped: !fits || undefined,
    }
  }

  private fitsCache(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
  ): boolean {
    return this.tileSpan(level, screen).count <= this.tileCapacity(level)
  }

  // Tiles of `level` that can stay decoded at once. A quarter of the cache
  // stays free for the coarse fallback layer and for requestTile() users (the
  // wand, the 3D slide plane).
  private tileCapacity(level: NVSlideLevelManifest): number {
    // Full tiles, not clipped edge extents: an upper bound, since a padded
    // edge frame is held whole until decodeTileBitmap crops it.
    // Sample tiles also keep their samples (1 or 2 bytes each), one plane per
    // fetched channel. Without bitsStored, JPEG 2000 and JPEG-LS may decode 16-bit samples.
    const bits = level.bitsStored ?? (level.codec === 'image/jpeg' ? 8 : 16)
    const planes = this._source.fetchTileSamples
      ? this._visibleChannels().length
      : isMonochrome(level)
        ? 1
        : 0
    const sampleBytes = planes * (bits > 8 ? 2 : 1)
    const tileBytes =
      this.levelTileWidth(level) *
      this.levelTileHeight(level) *
      (4 + sampleBytes)
    return Math.min(
      MAX_VISIBLE_TILES,
      Math.floor((0.75 * this._cache.maxBytes) / tileBytes),
    )
  }

  /**
   * Cached tiles from every level coarser than `target` that covers the
   * viewport, coarsest first. Empty when every target tile is already cached
   * (the steady state) or when `target` is the coarsest level.
   */
  private fallbackTiles(
    target: NVSlideLevelManifest,
    tiles: readonly NVSlideVisibleTile[],
    screen: NVSlideScreen,
  ): NVSlideVisibleTile[] {
    let missing = false
    for (const item of tiles) {
      if (!this._cache.has(item.key)) {
        missing = true
        break
      }
    }
    if (!missing) return []
    const levels = this.manifest.levels
    // Position in the array, not `level.index`: `selectLevel` walks the array
    // finest-to-coarsest and a manifest may number its levels however it likes.
    const targetPos = levels.indexOf(target)
    if (targetPos < 0) return []
    const out: NVSlideVisibleTile[] = []
    for (let pos = levels.length - 1; pos > targetPos; pos--) {
      const coarse = levels[pos]
      if (!coarse) continue
      for (const item of this.tilesForLevel(coarse, screen)) {
        // Only what is ALREADY decoded: the fallback layer never issues a
        // fetch, so it cannot compete with the target level for the load slots
        // that will actually retire it.
        if (this._cache.has(item.key)) out.push(item)
      }
    }
    return out
  }

  /** The tile columns/rows of one level covering the viewport, and the view geometry. */
  private tileSpan(level: NVSlideLevelManifest, screen: NVSlideScreen) {
    const viewLeft =
      this.viewport.centerX - screen.widthCss / (2 * this.viewport.scale)
    const viewTop =
      this.viewport.centerY - screen.heightCss / (2 * this.viewport.scale)
    const viewRight =
      this.viewport.centerX + screen.widthCss / (2 * this.viewport.scale)
    const viewBottom =
      this.viewport.centerY + screen.heightCss / (2 * this.viewport.scale)
    // Map level pixels <-> base pixels by each level's ACTUAL per-axis scale
    // (base / level dims), not the nominal `downsample`. When a pyramid level's
    // dimensions are not an exact `base / 2^L` (rounding), `level.width *
    // downsample != base width`, so a downsample-based mapping places the level's
    // tiles over a slightly different base extent than the true [0, base] the
    // drawing overlay (screenToSlide/slideToCss) uses — and the offset changes at
    // each LOD boundary, so annotations appear to jump when zooming across a
    // level. Using the exact scale makes every level cover exactly [0, base], so
    // tiles register with each other and with slide-space drawings across zoom.
    // It is also what lets a coarse fallback tile sit exactly under the target
    // tiles it stands in for.
    const dsX =
      level.width > 0 ? this.manifest.width / level.width : level.downsample
    const dsY =
      level.height > 0 ? this.manifest.height / level.height : level.downsample
    const levelLeft = Math.floor(viewLeft / dsX)
    const levelTop = Math.floor(viewTop / dsY)
    const levelRight = Math.ceil(viewRight / dsX)
    const levelBottom = Math.ceil(viewBottom / dsY)
    const tileWidth = this.levelTileWidth(level)
    const tileHeight = this.levelTileHeight(level)
    const firstX = clamp(
      Math.floor(levelLeft / tileWidth),
      0,
      level.columns - 1,
    )
    const firstY = clamp(Math.floor(levelTop / tileHeight), 0, level.rows - 1)
    const lastX = clamp(
      Math.floor((levelRight - 1) / tileWidth),
      0,
      level.columns - 1,
    )
    const lastY = clamp(
      Math.floor((levelBottom - 1) / tileHeight),
      0,
      level.rows - 1,
    )
    const count = (lastX - firstX + 1) * (lastY - firstY + 1)
    return {
      ...{ firstX, lastX, firstY, lastY, count },
      ...{ dsX, dsY, tileWidth, tileHeight, viewLeft, viewTop, viewBottom },
    }
  }

  /**
   * The tiles of one pyramid level covering the current viewport, or when more
   * than `limit` do, the centred block of at most `limit` shaped like the view.
   */
  private tilesForLevel(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
    limit = MAX_VISIBLE_TILES,
  ): NVSlideVisibleTile[] {
    const dpr = screen.devicePixelRatio ?? 1
    const span = this.tileSpan(level, screen)
    let { firstX, lastX, firstY, lastY } = span
    if (span.count > limit) {
      const spanW = lastX - firstX + 1
      const spanH = lastY - firstY + 1
      // w <= limit keeps w * h <= limit when the span is a single row (#666).
      const w = clamp(
        Math.floor(Math.sqrt((limit * spanW) / spanH)),
        1,
        Math.min(spanW, limit),
      )
      const h = clamp(Math.floor(limit / w), 1, spanH)
      firstX += Math.floor((spanW - w) / 2)
      firstY += Math.floor((spanH - h) / 2)
      lastX = firstX + w - 1
      lastY = firstY + h - 1
    }
    const { dsX, dsY } = span
    const { tileWidth, tileHeight, viewLeft, viewTop, viewBottom } = span
    const screenScale = this.viewport.scale * dpr
    const tiles: NVSlideVisibleTile[] = []
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const tile = this.tileAt(level, x, y)
        if (!tile) continue
        const baseX = tile.x * tileWidth * dsX
        const baseY = tile.y * tileHeight * dsY
        const baseWidth = tile.width * dsX
        const baseHeight = tile.height * dsY
        const screenY = this.isYAxisUp()
          ? (viewBottom - (baseY + baseHeight)) * screenScale
          : (baseY - viewTop) * screenScale
        tiles.push({
          slide: this,
          level,
          tile,
          key: this.tileKey(level, tile),
          screenX: (baseX - viewLeft) * screenScale,
          screenY,
          screenWidth: baseWidth * screenScale,
          screenHeight: baseHeight * screenScale,
          flipY: this.isYAxisUp(),
        })
      }
    }
    return tiles
  }

  /** The tiles the last draw asked for (null before the first), to save a second walk. */
  get lastVisibleTiles(): NVSlideVisibleTiles | null {
    return this._lastVisible
  }

  requestVisibleTiles(screen: NVSlideScreen): NVSlideVisibleTiles {
    const visible = this.visibleTiles(screen)
    this._lastVisible = visible
    if (!this.visible || !visible.level) return visible
    this._wanted.clear()
    for (const item of visible.tiles) {
      this._wanted.add(item.key)
      if (this._cache.has(item.key) || this._pending.has(item.key)) continue
      this.loadTile(item.level, item.tile, true)
    }
    this._abortUnwantedLoads()
    return visible
  }

  /**
   * Begin loading one tile (no-op if already cached or in flight). For renderers
   * whose working set is driven by something other than the 2D viewport — e.g.
   * the 3D slide-plane render, where visibility comes from world geometry.
   */
  requestTile(level: NVSlideLevelManifest, tile: NVSlideTileManifest): void {
    const key = this.tileKey(level, tile)
    this._wanted.add(key)
    if (this._cache.has(key)) return
    if (this._pending.has(key)) {
      // An explicit requestTile() for a tile the viewport already started
      // means a second consumer wants it: de-classify it so a later viewport
      // working-set change cannot abort it out from under that consumer.
      this._viewportKeys.delete(key)
      return
    }
    this.loadTile(level, tile)
  }

  cachedTileBitmap(key: string): ImageBitmap | null {
    const entry = this._cache.get(key)
    if (!entry) return null
    this.stats.cacheHits++
    return entry.bitmap
  }

  /**
   * Per-channel samples at base (level-0) pixel `x`, `y`, from the finest
   * resident tile, or level `index` `opts.level`. Cache only: it never fetches
   * and leaves the LRU order and `stats.cacheHits` alone, so hover can call it.
   * One record per channel, in channel order.
   */
  sampleAt(
    x: number,
    y: number,
    opts: { level?: number } = {},
  ): NVSlideSample[] {
    const { width, height } = this.manifest
    if (!(x >= 0 && y >= 0 && x < width && y < height))
      return this._missingSamples('outside')
    let reason: 'hole' | 'uncached' = 'hole'
    for (const level of this.manifest.levels) {
      if (opts.level !== undefined && level.index !== opts.level) continue
      const hit = this._tileUnder(level, x, y)
      if (!hit) continue
      reason = 'uncached'
      const entry = this._cache.peek(this.tileKey(level, hit.tile))
      // A decoded frame smaller than its tile is cached as is.
      const decoded = entry?.samples ?? entry?.bitmap
      if (entry && decoded && hit.px < decoded.width && hit.py < decoded.height)
        return this._residentSamples(entry, hit.px, hit.py)
    }
    return this._missingSamples(reason)
  }

  /**
   * {@link sampleAt} at level `index` `opts.level` (default 0), fetching its
   * covering tile first when it is not resident. Hidden channels are not
   * fetched and stay `missing: 'hidden'`. `signal` stops the wait, not the load;
   * a failed load resolves `uncached`.
   */
  async loadSampleAt(
    x: number,
    y: number,
    opts: { level?: number; signal?: AbortSignal } = {},
  ): Promise<NVSlideSample[]> {
    const index = opts.level ?? 0
    const resident = this.sampleAt(x, y, { level: index })
    const level = this.manifest.levels.find((l) => l.index === index)
    const hit = level && this._tileUnder(level, x, y)
    if (resident[0]?.missing !== 'uncached' || !level || !hit) return resident
    const key = this.tileKey(level, hit.tile)
    const { signal } = opts
    this.requestTile(level, hit.tile)
    // Not pending after requestTile: cached, or held back after a failure.
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        if (signal?.aborted) reject(signal.reason)
        else if (this._cache.has(key) || !this._pending.has(key)) resolve()
        else return
        this.removeEventListener('change', settle)
        signal?.removeEventListener('abort', settle)
      }
      this.addEventListener('change', settle)
      signal?.addEventListener('abort', settle)
      settle()
    })
    return this.sampleAt(x, y, { level: index })
  }

  // The tile of `level` under base pixel x, y and the pixel in it; null for a hole.
  private _tileUnder(level: NVSlideLevelManifest, x: number, y: number) {
    const lx = Math.floor((x * level.width) / this.manifest.width)
    const ly = Math.floor((y * level.height) / this.manifest.height)
    const tw = this.levelTileWidth(level)
    const th = this.levelTileHeight(level)
    const tile = this.tileAt(level, Math.floor(lx / tw), Math.floor(ly / th))
    return tile && { tile, px: lx - tile.x * tw, py: ly - tile.y * th }
  }

  // Reads only {samples, channels, level} for sample tiles (#159 drops their
  // bitmap); a bitmap-only tile (RGB, JPEG) is read back one pixel.
  private _residentSamples(
    entry: TileBitmap,
    px: number,
    py: number,
  ): NVSlideSample[] {
    const { samples: s, channels: held } = entry
    const level = entry.level.index
    if (!s) this._pixelReader ??= readbackContext(1, 1)
    const reader = s ? null : this._pixelReader
    if (!s && !reader) return this._missingSamples('uncached')
    const rgba = reader && readPixels(reader, entry.bitmap, px, py, 1, 1)
    const offset = s ? py * s.width + px : 0
    const info = this.manifest.channelInfo
    return this._channels.map(({ name }, channel) => {
      const plane = held ? held.indexOf(channel) : channel
      if (plane < 0) return this._missingSample(channel, 'hidden', level)
      const stored = (
        s ? s.samples[plane * s.width * s.height + offset] : rgba?.[plane]
      ) as number
      const map = info?.[channel]?.storedToValue
      const sample: NVSlideSample = {
        channel,
        name,
        value: map ? stored * map.scale + map.offset : stored,
        stored,
        level,
        exact: level === 0 && !map,
      }
      if (map && (stored === 0 || stored === 65535)) sample.clipped = true
      return sample
    })
  }

  private _missingSample(
    channel: number,
    missing: NonNullable<NVSlideSample['missing']>,
    level: number | null = null,
  ): NVSlideSample {
    const { name } = this._channels[channel] as NVChannel
    return {
      channel,
      name,
      value: null,
      stored: null,
      level,
      exact: false,
      missing,
    }
  }

  private _missingSamples(
    missing: NonNullable<NVSlideSample['missing']>,
  ): NVSlideSample[] {
    return this._channels.map((_, c) => this._missingSample(c, missing))
  }

  clearCache(): void {
    this._cache.clear()
    this.stats.cacheBytes = 0
    this._emitChange()
  }

  dispose(): void {
    this._colorAbort.abort()
    this._luts.clear()
    this._loadQueue.length = 0
    this._wanted.clear()
    this._viewportKeys.clear()
    for (const controller of this._inflight.values()) controller.abort()
    this._inflight.clear()
    this._pending.clear()
    for (const timer of this._retryTimers.values()) clearTimeout(timer)
    this._retryTimers.clear()
    this._failed.clear()
    // Last: its change event finds nothing pending, so waiting loadSampleAt calls settle.
    this.clearCache()
  }

  private levelTileWidth(level: NVSlideLevelManifest): number {
    return level.tileWidth ?? this.manifest.tileSize ?? 1
  }

  private levelTileHeight(level: NVSlideLevelManifest): number {
    return level.tileHeight ?? this.manifest.tileSize ?? 1
  }

  private tileAt(
    level: NVSlideLevelManifest,
    x: number,
    y: number,
  ): NVSlideTileManifest | null {
    if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) return null
    return level.tiles[y * level.columns + x] ?? null
  }

  /** The cache key {@link cachedTileBitmap} takes for a tile of a level. */
  tileKey(level: NVSlideLevelManifest, tile: NVSlideTileManifest): string {
    return `L${level.index}/${tile.x}/${tile.y}`
  }

  private resolveUrl(url: string): string {
    const base =
      this.manifestUrl ||
      (typeof window !== 'undefined'
        ? window.location.href
        : 'http://localhost/')
    return new URL(url, base).toString()
  }

  /**
   * Register a tile decoder for a codec (e.g. `image/jp2` via @niivue/dcm2niix).
   * Lets a consumer add codecs the browser can't decode natively without
   * bundling them into the core. Overrides any existing decoder for that codec.
   */
  static registerTileDecoder(codec: string, decoder: SlideTileDecoder): void {
    tileDecoders.set(codec, decoder)
  }

  /**
   * Register the ICC transform that bakes slide profiles into sRGB lookup tables
   * (null removes it). Only slides created afterwards apply their profile, so
   * register before opening slides.
   */
  static registerIccTransform(transform: SlideIccTransform | null): void {
    iccTransform = transform
  }

  /** The registered ICC transform, or null. */
  static iccTransform(): SlideIccTransform | null {
    return iccTransform
  }

  /** The decoder registered for a codec, or undefined. */
  static tileDecoder(codec: string): SlideTileDecoder | undefined {
    return tileDecoders.get(codec)
  }

  private async decodeTileBitmap(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    tileBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ImageBitmap | NVSlideTileSamples> {
    const codec = level.codec ?? 'raw-rgba'
    const decoder = tileDecoders.get(codec)
    if (!decoder) {
      throw new Error(
        `No decoder for tile codec "${codec}". ` +
          'Register one with NVSlide.registerTileDecoder() ' +
          '(e.g. @niivue/dcm2niix createFrameDecoder for image/jp2).',
      )
    }
    let decoded = await decoder(tileBytes, {
      width: tile.width,
      height: tile.height,
      level,
      signal,
    })
    // A decoder that returns only a bitmap (the browser's JPEG) still windows:
    // a monochrome tile's grey level comes back as 8-bit samples.
    // Without a 2D OffscreenCanvas (Safari < 16.4) such a tile shows unwindowed.
    if (
      isMonochrome(level) &&
      !('samples' in decoded) &&
      typeof OffscreenCanvas !== 'undefined'
    )
      decoded = greySamples(decoded)
    // Formats that store whole tiles (DICOM) pad edge frames, and every frame of
    // a level smaller than one tile, at the right and bottom. Padding is not
    // slide: crop it, or the level's image shrinks into one corner.
    if (decoded.width <= tile.width && decoded.height <= tile.height)
      return decoded
    if ('samples' in decoded)
      return cropSamples(decoded, tile.width, tile.height)
    const bitmap = decoded
    try {
      return await createImageBitmap(
        bitmap,
        0,
        0,
        Math.min(bitmap.width, tile.width),
        Math.min(bitmap.height, tile.height),
      )
    } finally {
      bitmap.close()
    }
  }

  private loadTile(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    fromViewport = false,
  ): void {
    const key = this.tileKey(level, tile)
    if (this._cache.has(key) || this._pending.has(key)) return
    if ((this._failed.get(key)?.retryAt ?? 0) > performance.now()) return
    if (fromViewport) this._viewportKeys.add(key)
    else this._viewportKeys.delete(key)
    this._pending.add(key)
    this.stats.requested++
    this._emitChange()
    if (this._activeLoads >= this._maxConcurrentLoads) {
      this._loadQueue.push({ level, tile, key })
      return
    }
    void this._runLoad(level, tile, key)
  }

  private async _runLoad(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    key: string,
  ): Promise<void> {
    this._activeLoads++
    const label = `${key}${typeof tile.frame === 'number' ? ` f${tile.frame}` : ''}`
    const controller = new AbortController()
    const { signal } = controller
    this._inflight.set(key, controller)
    try {
      let bitmap: ImageBitmap
      let samples: NVSlideTileSamples | undefined
      let held: number[] | undefined
      if (this._source.fetchTileSamples) {
        for (;;) {
          const channels = this._visibleChannels()
          held = channels
          // Nothing shown: an empty tile, without asking the source.
          samples = channels.length
            ? await this._source.fetchTileSamples(level, tile, channels, signal)
            : {
                samples: new Uint8Array(0),
                width: tile.width,
                height: tile.height,
                bitsStored: 8,
                planes: 0,
              }
          signal.throwIfAborted()
          if ((samples.planes ?? 1) !== channels.length)
            throw new Error(
              `Expected ${channels.length} sample planes, received ${samples.planes ?? 1}`,
            )
          if (samples.width > tile.width || samples.height > tile.height)
            samples = cropSamples(samples, tile.width, tile.height)
          bitmap = await this._renderCurrent(samples, level, channels)
          // A channel shown while this loaded: load again, never cache a tile without it.
          if (this._visibleChannels().every((c) => channels.includes(c))) break
          bitmap.close()
        }
      } else {
        const tileBytes = await this._source.fetchTileBytes(
          level,
          tile,
          label,
          signal,
        )
        // A source that cannot stop a read in progress may still resolve after
        // the abort; the tile is no longer wanted either way.
        signal.throwIfAborted()
        const decoded = await this.decodeTileBitmap(
          level,
          tile,
          tileBytes,
          signal,
        )
        if ('samples' in decoded) {
          samples = decoded
          bitmap = await this._renderCurrent(samples, level)
        } else bitmap = decoded
      }
      if (signal.aborted) {
        // Disposed (or dropped) while decoding. Caching now would leave a
        // bitmap in a cache that was already cleared, with nobody to close it.
        bitmap.close()
        signal.throwIfAborted()
      }
      // Account the cache in DECODED bytes (RGBA), not encoded/wire bytes: the
      // cached resource is the ImageBitmap (often GPU-backed), which is 10-20x
      // the JPEG size — encoded accounting silently blew maxCacheBytes.
      const decodedBytes =
        bitmap.width * bitmap.height * 4 + (samples?.samples.byteLength ?? 0)
      this.stats.decodedBytes += decodedBytes
      this._cache.set(key, {
        bitmap,
        bytes: decodedBytes,
        samples,
        level,
        channels: held,
      })
      this.stats.cacheBytes = this._cache.bytes
      this.stats.completed++
      this._failed.delete(key)
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        // An abort is not a failure: nothing was wrong with the tile. It is
        // not logged, and clearing `pending` below lets it re-request later.
        this.stats.aborted++
        this.updateRangeEvent(label, 'aborted')
      } else {
        this.stats.failures++
        this.updateRangeEvent(label, 'failed')
        console.error(`Failed to load slide tile ${this.id}/${key}`, err)
        const delay = Math.min(
          30_000,
          (this._failed.get(key)?.delay ?? 500) * 2,
        )
        const retryAt = performance.now() + delay
        this._failed.set(key, { retryAt, delay })
        // The slot ends at or after every retryAt in it, so its tiles are due;
        // +1 ms: a timer may fire up to 1 ms early, before the gate in loadTile.
        const slot = Math.ceil(retryAt / RETRY_TICK) * RETRY_TICK
        if (!this._retryTimers.has(slot))
          this._retryTimers.set(
            slot,
            setTimeout(
              () => {
                this._retryTimers.delete(slot)
                this._emitChange() // the view re-requests tiles still wanted
              },
              slot - performance.now() + 1,
            ),
          )
      }
    } finally {
      this._activeLoads--
      if (this._inflight.get(key) === controller) this._inflight.delete(key)
      this._viewportKeys.delete(key)
      this._pending.delete(key)
      this._emitChange()
      this._drainLoadQueue()
    }
  }

  /**
   * Abandon in-flight loads the current view no longer wants. The queued
   * counterpart is `_drainLoadQueue`, which drops such tiles at dequeue time;
   * this covers the ones that had already started. The load's own `finally`
   * clears `pending`, so the tile re-requests if it scrolls back into view.
   *
   * Only VIEWPORT-initiated loads (`_viewportKeys`) are eligible: a load
   * started by `requestTile()` belongs to another consumer (e.g. the 3D
   * slide-plane), so a 2D pan/zoom leaves it to complete and cache.
   */
  private _abortUnwantedLoads(): void {
    for (const [key, controller] of this._inflight) {
      if (this._wanted.has(key) || !this._viewportKeys.has(key)) continue
      this._inflight.delete(key)
      controller.abort()
    }
  }

  private _drainLoadQueue(): void {
    while (this._activeLoads < this._maxConcurrentLoads) {
      // Newest-first (LIFO): the most recently requested tiles are the ones
      // the current view is showing placeholders for.
      const next = this._loadQueue.pop()
      if (!next) return
      // Cached by a racing path: skip without fetching, whoever queued it.
      // Otherwise drop only VIEWPORT-origin tiles that left the working set
      // (view moved on) -- the queued counterpart of `_abortUnwantedLoads`. A
      // tile queued via `requestTile()` belongs to another consumer (3D
      // slide-plane, wand, setSlidePlane priming), so a 2D pan/zoom that
      // rebuilds `_wanted` must not cancel it. Clearing `pending` lets a
      // dropped tile re-request if it scrolls back into view.
      const droppedFromViewport =
        this._viewportKeys.has(next.key) && !this._wanted.has(next.key)
      if (this._cache.has(next.key) || droppedFromViewport) {
        this._viewportKeys.delete(next.key)
        this._pending.delete(next.key)
        continue
      }
      void this._runLoad(next.level, next.tile, next.key)
    }
  }

  private pushRangeEvent(event: NVSlideRangeEvent): void {
    this.stats.lastRequests.push(event)
    while (this.stats.lastRequests.length > this._rangeLogLength) {
      this.stats.lastRequests.shift()
    }
  }

  private updateRangeEvent(label: string, status: NVSlideRangeStatus): void {
    const existing = this.stats.lastRequests.findLast(
      (event) => event.label === label,
    )
    if (existing) {
      existing.status = status
    } else {
      this.pushRangeEvent({ label, status })
    }
  }

  private _emitChange(): void {
    this.dispatchEvent(new Event('change'))
  }
}
