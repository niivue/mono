import { lookupColorMap } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import {
  checkChannelInfo,
  defaultSlideChannels,
  isMonochrome,
  isRgbSlide,
  readbackContext,
  readPixels,
  toValue,
  usableWindow,
} from './slideChannels'
import { DEFAULT_RAW_POOL_BYTES, type SlideRendererBudget } from './slideFuse'
import {
  clamp,
  fallbackTiles,
  levelTileHeight,
  levelTileWidth,
  MAX_VISIBLE_TILES,
  selectLevel,
  tileAt,
  tileCapacity,
  tileSpan,
  tilesForLevel,
} from './slideLod'
import {
  assertSingleSlidePlane,
  cropSamples,
  decodeTileBitmap,
  isAbortError,
  ManifestRangeSource,
  placeListedTiles,
  type SlideTileSource,
  tileDecoders,
} from './slideSource'
import { composeThumbnail } from './slideThumbnail'
import { NVSlideTileCache, type TileBitmap } from './tileLru'
import { DEFAULT_TILE_TEXTURE_BYTES } from './tileTextureCache'

export type NVSlideTileCodec =
  | 'raw-rgba'
  | 'raw-gray'
  | 'image/jpeg'
  | 'image/jp2'
  | 'image/jls'

/** Sample types a tile may hold: unsigned 8 or 16 bit, int16, float32. */
export type NVSlideSampleArray =
  | Uint8Array
  | Uint16Array
  | Int16Array
  | Float32Array

/**
 * Samples a tile decoder (or {@link SlideTileSource.fetchTileSamples}) may return
 * instead of a bitmap. NVSlide keeps them and the renderers fuse them on the GPU
 * through its {@link NVSlide.channels}, so a channel change re-renders cached
 * tiles without re-decoding (D16, #159).
 */
export interface NVSlideTileSamples {
  /** `planes` planes of `width * height` samples, one after another. */
  samples: NVSlideSampleArray
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
  /** A NiiVue colormap name; wins over `rgb`. */
  colormap?: string
  /** A usable display window; omitted, the channel shows its stored range. */
  window?: NVSlideWindow
  /** Inactive channels start hidden and are not fetched. */
  active: boolean
  /** 'label': samples are integer IDs, never quantized or windowed, read back exactly. */
  kind?: 'intensity' | 'label'
  /**
   * Map to data units: value = stored * scale + offset. `quantized` (default
   * true): readout is not exact and is clipped at the stored range ends.
   * false: an exact rescale (DICOM Rescale), exact at level 0.
   */
  storedToValue?: { scale: number; offset: number; quantized?: boolean }
  /** Data unit of `value`, e.g. 'HU'. */
  unit?: string
  /** Label colours by ID; absent, a deterministic default per ID. */
  labelColors?: ReadonlyArray<{
    id: number
    rgba: readonly [number, number, number, number]
  }>
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
  /** Level 0 and not quantized (`storedToValue.quantized`). Lossy codecs are not tracked. */
  exact: boolean
  missing?: 'outside' | 'hole' | 'uncached' | 'hidden'
  /** Quantized and stored at a stored range end (0 or 65535; int16 -32768 or 32767; NaN is stored as 0): `value` is a bound. */
  clipped?: true
}

/** A slide's focal plane `z` and time point `t`. Only {z: 0, t: 0} exists yet. */
export interface NVSlidePlaneIndex {
  z: number
  t: number
}

/** A source's focal planes and time points (`SlidePlaneCapable`). */
export interface NVSlidePlaneAxes {
  /** Focal planes in level-0 terms; the source maps z per level. */
  z: number
  t: number
  /** Physical z per plane (DICOM ZOffset rank order, OME physical z). */
  zPositionsUm?: readonly number[]
  tSeconds?: readonly number[]
}

/**
 * One placed piece of a storage tile: a crop in tile pixels drawn at an origin
 * in placed level pixels, unscaled. Fractions allowed.
 */
export interface NVSlidePlacedPiece {
  /** Row-major slot in `level.tiles` (the storage grid); fetch and cache key unchanged. */
  tile: number
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
}

/** Irregular tile placement of one level (vendor joints, overlaps, offsets). */
export interface NVSlideLevelPlacement {
  /** Placed extent in level pixels; may be fractional. */
  width: number
  height: number
  pieces: NVSlidePlacedPiece[]
}

/** Who wants a tile load; rank 0 (readout) is served first. */
export type NVSlideRequestClass =
  | 'readout'
  | 'view'
  | 'plane3d'
  | 'thumbnail'
  | 'prefetch'

/** One consumer's set of wanted tiles; cancelling it never cancels a read another owner wants. */
export interface NVSlideRequestOwner {
  readonly kind: NVSlideRequestClass
  /** Replaces this owner's wanted set. `focus` (base px) orders its loads centre-out. */
  want(
    tiles: Iterable<{ level: NVSlideLevelManifest; tile: NVSlideTileManifest }>,
    focus?: { x: number; y: number },
  ): void
  /** Idempotent. */
  release(): void
}

/** Credit for a slide; rendered as text, `url` only when http(s). */
export interface NVSlideAttribution {
  title?: string
  url?: string
  license?: string
  credit?: string
  citation?: string
  modified?: string
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
  /** raw-gray signed or float samples; absent, unsigned per bitsStored (u8 when <= 8, else u16). */
  sampleType?: 'i16' | 'f32'
  /** The plane a `SlidePlaneCapable` source's prepared level reads; absent {z: 0, t: 0}. */
  plane?: NVSlidePlaneIndex
  /**
   * Irregular placement. width/height/columns/rows stay the storage grid;
   * placed level pixels map to base by manifest.width / placement.width.
   */
  placement?: NVSlideLevelPlacement
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
  /** Default {@link NVSlideOptions.backgroundColor}, shown in holes (DICOM-WSI: (0048,0015)). */
  backgroundColor?: NVSlideColor
  /**
   * The sample channels a {@link SlideTileSource.fetchTileSamples} source
   * serves. Absent: one grey channel for a monochrome slide, else red, green
   * and blue, added.
   */
  channelInfo?: NVSlideChannelInfo[]
  attribution?: NVSlideAttribution
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
  /**
   * dispose() also disposes `source` (default true). Ownership passes when the
   * constructor returns; a constructor that throws leaves it with the caller.
   */
  ownsSource?: boolean
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
  /** Crop in tile pixels (placement); absent, the whole tile. */
  src?: { x: number; y: number; w: number; h: number }
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

/**
 * A cached tile ({@link NVSlide.cachedTile}): a decoded `bitmap` (RGB, JPEG),
 * drawn as is, or scalar `samples`, which the renderers fuse through the
 * slide's channels on the GPU (#159).
 */
export interface NVSlideCachedTile {
  readonly bitmap?: ImageBitmap
  readonly samples?: NVSlideTileSamples
  /** The channel each sample plane holds; absent, plane p is channel p. */
  readonly channels?: readonly number[]
  readonly level: NVSlideLevelManifest
}

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024
// What capacity assumes before any renderer registers its budget.
const DEFAULT_RENDERER_BUDGET: SlideRendererBudget = {
  tileBytes: DEFAULT_TILE_TEXTURE_BYTES,
  rawPoolBytes: DEFAULT_RAW_POOL_BYTES,
}
const MiB = 1024 * 1024
const DEFAULT_THUMBNAIL_PX = 1024
// Thumbnails kept: the minimap's and the wand's, which ask for different levels.
const MAX_THUMBNAILS = 2
let tileSerial = 0
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

// A quantized sample at its stored range's end is a bound; float has none.
function atStoredEnd(stored: number, samples?: NVSlideSampleArray): boolean {
  if (samples instanceof Int16Array)
    return stored === -32768 || stored === 32767
  if (samples instanceof Float32Array) return false
  return stored === 0 || stored === 65535
}

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

let iccTransform: SlideIccTransform | null = null

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
  private readonly _ownsSource: boolean
  private readonly _rendererBudgets = new Map<object, SlideRendererBudget>()
  private _budget = DEFAULT_RENDERER_BUDGET
  // Channels whose window the user set: a source's later window leaves them.
  private readonly _userWindows = new Set<number>()
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
  private _disposed = false
  private _budgetWarned = '' // last budget outcome logged by visibleTiles
  private _lastVisible: NVSlideVisibleTiles | null = null
  private _channels: readonly NVChannel[]
  private _channelBlend: NVSlideChannelBlend = 'max'
  private readonly _rgb: boolean
  private _displayGen = 0
  private readonly _thumbs = new Map<
    string,
    { gen: number; ids: number[]; bitmap: ImageBitmap }
  >()
  private _colorManagement: boolean
  private _colorLut: NVSlideColorLut | null = null
  private readonly _colorAbort = new AbortController()
  // One 1x1 readback context, reused by sampleAt on hover.
  private _pixelReader?: OffscreenCanvasRenderingContext2D | null

  constructor(manifest: NVSlideManifest, options: NVSlideOptions = {}) {
    super()
    assertSingleSlidePlane(manifest)
    const levels = manifest.levels.map(placeListedTiles)
    // channelInfo is copied: channelInfoChanged patches the slide's, not the source's.
    const channelInfo = manifest.channelInfo?.map((c) => ({ ...c }))
    this.manifest =
      !channelInfo && levels.every((l, i) => l === manifest.levels[i])
        ? manifest
        : { ...manifest, levels, ...(channelInfo && { channelInfo }) }
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
    this.backgroundColor = options.backgroundColor ??
      manifest.backgroundColor ?? [0.027, 0.063, 0.051, 1]
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
    checkChannelInfo(
      this.manifest,
      !!this._source.fetchTileSamples,
      !options.source,
    )
    this._ownsSource = options.ownsSource ?? true
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
      channelInfoChanged: (index, patch) =>
        this._channelInfoChanged(index, patch),
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
   * Update channel `c`. Renderers re-fuse cached sample tiles from their kept
   * planes on the next frame; showing a channel they were fetched without
   * refetches them. Tiles a decoder returned as bitmaps (JPEG, RGBA) are drawn
   * as decoded.
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
    if ('calMin' in update || 'calMax' in update) {
      if (Number.isFinite(next.calMin) || Number.isFinite(next.calMax))
        this._userWindows.add(c)
      else this._userWindows.delete(c)
    }
    if (next.visible && !old.visible && this._source.fetchTileSamples)
      this._refetchWithout(c)
    this._rerender()
  }

  // SlideSourceHost.channelInfoChanged: the slide's channelInfo copy takes the
  // patch; its window shows unless the user set one.
  private _channelInfoChanged(
    c: number,
    patch: Pick<Partial<NVSlideChannelInfo>, 'window' | 'storedToValue'>,
  ): void {
    const info = this.manifest.channelInfo
    const entry = info?.[c]
    const channel = this._channels[c]
    if (!info || !entry || !channel)
      throw new RangeError(`NVSlide has no channel ${c}`)
    info[c] = { ...entry, ...patch }
    const { window } = patch
    if (usableWindow(window) && !this._userWindows.has(c)) {
      const channels = [...this._channels]
      channels[c] = { ...channel, ...window }
      this._channels = channels
    }
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

  // Renderers compare displayGeneration with the one each fused texture was
  // made for, so a W/L drag re-fuses once per frame, not once per call.
  private _rerender(): void {
    this._displayGen++
    this._emitChange()
  }

  /** Bumped by every channel or blend change: a fused tile older than it is stale. */
  get displayGeneration(): number {
    return this._displayGen
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

  selectLevel(screen?: NVSlideScreen): NVSlideLevelManifest | null {
    return selectLevel(this, screen)
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
    // Keyed by the budget too, so a budget that flaps back between frames stays quiet.
    const budget =
      level === requested && fits
        ? ''
        : `${requested.index}>${level.index}@${this._budget.tileBytes}/${this._budget.rawPoolBytes}`
    if (budget && budget !== this._budgetWarned)
      log.warn(
        `NVSlide ${this.id}: L${requested.index} needs ${this.tileSpan(requested, screen).count} tiles in view, more than the tile cache (maxCacheBytes), the renderers' tile texture budget (${(this._budget.tileBytes - this._budget.rawPoolBytes) / MiB} MiB for scalar slides, ${this._budget.tileBytes / MiB} for RGB) or the ${MAX_VISIBLE_TILES}-tile cap holds; ${fits ? `showing L${level.index}` : `even L${level.index} does not fit, so only the ${capacity} tiles nearest the centre load`}. Zoom in, or raise maxCacheBytes if the tile cache is the limit.`,
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

  private tileCapacity(level: NVSlideLevelManifest): number {
    return tileCapacity(
      this.manifest,
      level,
      this._cache.maxBytes,
      this._source.fetchTileSamples
        ? this._visibleChannels().length
        : undefined,
      this._budget,
    )
  }

  /**
   * A renderer states the tile texture and raw pool bytes it draws this slide
   * with (null: it no longer does). Capacity and its warning use the smallest
   * registered, so a HUD calling visibleTiles agrees with the renderer;
   * unregistered, 128 MiB of tile textures with a 32 MiB raw pool.
   */
  setRendererBudget(
    renderer: object,
    budget: SlideRendererBudget | null,
  ): void {
    const map = this._rendererBudgets
    if (budget ? map.get(renderer) === budget : !map.has(renderer)) return
    if (budget) map.set(renderer, budget)
    else map.delete(renderer)
    // The smallest of each: RGB tiles get tileBytes, scalar tiles less the pool.
    let tileBytes = DEFAULT_RENDERER_BUDGET.tileBytes
    let scalarBytes = tileBytes - DEFAULT_RENDERER_BUDGET.rawPoolBytes
    if (map.size) {
      tileBytes = scalarBytes = Number.POSITIVE_INFINITY
      for (const b of map.values()) {
        tileBytes = Math.min(tileBytes, b.tileBytes)
        scalarBytes = Math.min(scalarBytes, b.tileBytes - b.rawPoolBytes)
      }
    }
    const old = this._budget
    if (
      old.tileBytes === tileBytes &&
      old.tileBytes - old.rawPoolBytes === scalarBytes
    )
      return
    this._budget = { tileBytes, rawPoolBytes: tileBytes - scalarBytes }
  }

  private fallbackTiles(
    target: NVSlideLevelManifest,
    tiles: readonly NVSlideVisibleTile[],
    screen: NVSlideScreen,
  ): NVSlideVisibleTile[] {
    return fallbackTiles(this, target, tiles, screen, this._cache)
  }

  private tileSpan(level: NVSlideLevelManifest, screen: NVSlideScreen) {
    return tileSpan(this.manifest, this.viewport, level, screen)
  }

  private tilesForLevel(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
    limit = MAX_VISIBLE_TILES,
  ): NVSlideVisibleTile[] {
    return tilesForLevel(this, level, screen, limit)
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

  /** A resident tile, bitmap or samples (see {@link NVSlideCachedTile}); refreshes its LRU place. */
  cachedTile(key: string): NVSlideCachedTile | null {
    const entry = this._cache.get(key)
    if (!entry) return null
    this.stats.cacheHits++
    return entry
  }

  /**
   * Level `level` (default the coarsest) composited on the CPU from its
   * resident tiles, rows as stored, scaled to fit `maxPx` a side, for a minimap
   * or a colour reference. Missing tiles are requested and left black. The
   * same bitmap is returned until a tile arrives or leaves or the channels
   * change; the slide closes it then and on dispose, so draw it at once. Null
   * without OffscreenCanvas or before any tile is resident.
   */
  thumbnailBitmap(
    level = this.manifest.levels.at(-1),
    maxPx = DEFAULT_THUMBNAIL_PX,
  ): ImageBitmap | null {
    if (!level || typeof OffscreenCanvas === 'undefined') return null
    // get, not peek: a thumbnail drawn each frame keeps its tiles from eviction.
    const entries = level.tiles.map((tile) => {
      if (!tile) return undefined
      const entry = this._cache.get(this.tileKey(level, tile))
      if (!entry) this.requestTile(level, tile)
      return entry
    })
    const ids = entries.map((e) => e?.id ?? 0)
    const key = `${level.index}/${maxPx}`
    const memo = this._thumbs.get(key)
    if (
      memo?.gen === this._displayGen &&
      ids.every((id, i) => id === memo.ids[i])
    )
      return memo.bitmap
    if (!entries.some(Boolean)) return null
    const bitmap = composeThumbnail(
      level,
      entries,
      maxPx,
      this.levelTileWidth(level),
      this.levelTileHeight(level),
      this._channels,
      this.channelBlend,
    )
    if (!bitmap) return null
    memo?.bitmap.close()
    this._thumbs.delete(key)
    this._thumbs.set(key, { gen: this._displayGen, ids, bitmap })
    for (const [old, { bitmap: b }] of this._thumbs) {
      if (this._thumbs.size <= MAX_THUMBNAILS) break
      b.close()
      this._thumbs.delete(old)
    }
    return bitmap
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
    let uncachedLevel: number | null = null
    for (const level of this.manifest.levels) {
      if (opts.level !== undefined && level.index !== opts.level) continue
      const hit = this._tileUnder(level, x, y)
      if (!hit) continue
      uncachedLevel ??= level.index
      const entry = this._cache.peek(this.tileKey(level, hit.tile))
      // A decoded frame smaller than its tile is cached as is.
      const decoded = entry?.samples ?? entry?.bitmap
      if (entry && decoded && hit.px < decoded.width && hit.py < decoded.height)
        return this._residentSamples(entry, hit.px, hit.py)
    }
    if (uncachedLevel === null) return this._missingSamples('hole')
    // Visibility decides 'hidden' before any tile is cached, too.
    return this._channels.map(({ visible }, c) =>
      visible
        ? this._missingSample(c, 'uncached')
        : this._missingSample(c, 'hidden', uncachedLevel),
    )
  }

  /**
   * {@link sampleAt} at level `index` `opts.level` (default 0), fetching its
   * covering tile first when it is not resident. Hidden channels are not
   * fetched and stay `missing: 'hidden'`. `signal` stops the wait, not the load;
   * an abort or a failed load resolves `uncached`.
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
    if (!resident.some((s) => s.missing === 'uncached') || !level || !hit)
      return resident
    const key = this.tileKey(level, hit.tile)
    const { signal } = opts
    this.requestTile(level, hit.tile)
    // Not pending after requestTile: cached, or held back after a failure.
    await new Promise<void>((resolve) => {
      const settle = () => {
        if (!signal?.aborted && this._pending.has(key) && !this._cache.has(key))
          return
        resolve()
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
    const { bitmap } = entry
    if (!s && !(reader && bitmap)) return this._missingSamples('uncached')
    const rgba = reader && bitmap && readPixels(reader, bitmap, px, py, 1, 1)
    const offset = s ? py * s.width + px : 0
    const planes = s ? (s.planes ?? 1) : 4
    const info = this.manifest.channelInfo
    return this._channels.map(({ name }, channel) => {
      const plane = held ? held.indexOf(channel) : channel
      // A tile can outlive a hide or predate a show: visibility decides 'hidden'.
      if (!this._channels[channel]?.visible)
        return this._missingSample(channel, 'hidden', level)
      // A bytes tile holds channel 0 alone (several channelInfo entries).
      if (plane < 0 || plane >= planes)
        return this._missingSample(channel, 'uncached', level)
      const stored = (
        s ? s.samples[plane * s.width * s.height + offset] : rgba?.[plane]
      ) as number
      const map = info?.[channel]?.storedToValue
      const quantized = !!map && map.quantized !== false
      const sample: NVSlideSample = {
        channel,
        name,
        value: toValue(stored, map),
        stored,
        level,
        exact: level === 0 && !quantized,
      }
      if (quantized && atStoredEnd(stored, s?.samples)) sample.clipped = true
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

  /**
   * Abort loads, release the source when owned ({@link NVSlideOptions.ownsSource}),
   * then clear the cache, which settles waiting loadSampleAt calls. Idempotent.
   */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._colorAbort.abort()
    for (const { bitmap } of this._thumbs.values()) bitmap.close()
    this._thumbs.clear()
    this._loadQueue.length = 0
    this._wanted.clear()
    this._viewportKeys.clear()
    for (const controller of this._inflight.values()) controller.abort()
    this._inflight.clear()
    this._pending.clear()
    for (const timer of this._retryTimers.values()) clearTimeout(timer)
    this._retryTimers.clear()
    this._failed.clear()
    this._rendererBudgets.clear()
    try {
      if (this._ownsSource) this._source.dispose?.()
    } finally {
      // Last: its change event finds nothing pending, so waiting loadSampleAt calls settle.
      this.clearCache()
    }
  }

  private levelTileWidth(level: NVSlideLevelManifest): number {
    return levelTileWidth(this.manifest, level)
  }

  private levelTileHeight(level: NVSlideLevelManifest): number {
    return levelTileHeight(this.manifest, level)
  }

  private tileAt(level: NVSlideLevelManifest, x: number, y: number) {
    return tileAt(level, x, y)
  }

  /** The cache key {@link cachedTile} takes for a tile of a level. */
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

  private loadTile(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    fromViewport = false,
  ): void {
    const key = this.tileKey(level, tile)
    if (this._disposed || this._cache.has(key) || this._pending.has(key)) return
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
      let bitmap: ImageBitmap | undefined
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
          // A channel shown while this loaded: load again, never cache a tile without it.
          if (this._visibleChannels().every((c) => channels.includes(c))) break
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
        const decoded = await decodeTileBitmap(level, tile, tileBytes, signal)
        if ('samples' in decoded) samples = decoded
        else bitmap = decoded
      }
      if (signal.aborted) {
        // Disposed (or dropped) while decoding. Caching now would leave a
        // bitmap in a cache that was already cleared, with nobody to close it.
        bitmap?.close()
        signal.throwIfAborted()
      }
      // Account the cache in DECODED bytes, not encoded/wire bytes: a bitmap
      // (often GPU-backed) is RGBA, 10-20x the JPEG size; a scalar tile keeps
      // only its samples (the renderers fuse them, #159).
      const decodedBytes = bitmap
        ? bitmap.width * bitmap.height * 4
        : (samples?.samples.byteLength ?? 0)
      this.stats.decodedBytes += decodedBytes
      this._cache.set(
        key,
        bitmap
          ? { bitmap, bytes: decodedBytes, level, id: ++tileSerial }
          : {
              samples,
              bytes: decodedBytes,
              level,
              channels: held,
              id: ++tileSerial,
            },
      )
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
