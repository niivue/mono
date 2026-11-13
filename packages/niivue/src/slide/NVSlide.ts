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
import { REQUEST_RANK, type TileLoad, TileLoadQueue } from './slideLoadQueue'
import {
  clamp,
  fallbackTiles,
  levelTileHeight,
  levelTileWidth,
  MAX_VISIBLE_TILES,
  type NVSlideCapacityLimit,
  selectLevel,
  type TileSpan,
  tileAt,
  tileCapacity,
  tileSpan,
  tilesForLevel,
} from './slideLod'
import {
  buildPlacementIndex,
  type PlacementIndex,
  pieceAt,
  placedSpan,
  placedTiles,
} from './slidePlacement'
import {
  assertSingleSlidePlane,
  cropSamples,
  decodeTileBitmap,
  isAbortError,
  MAX_WHOLE_FILE,
  ManifestRangeSource,
  placeListedTiles,
  readCapped,
  type SlidePlaneCapable,
  type SlideTileSource,
  tileDecoders,
} from './slideSource'
import { composeThumbnail } from './slideThumbnail'
import { EDGE_ALL } from './tileGutter'
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
  /**
   * Replaces this owner's wanted set. `focus` (base px) orders its loads
   * centre-out. A tile's `key`, when given, must be its {@link NVSlide.tileKey}.
   */
  want(
    tiles: Iterable<{
      level: NVSlideLevelManifest
      tile: NVSlideTileManifest
      key?: string
    }>,
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
  /**
   * Why the view is capacity-limited (with `requestedLevel` or `capped`): the
   * tile cache (`maxCacheBytes`), the renderers' tile texture budget, or the
   * visible-tile cap.
   */
  limitedBy?: NVSlideCapacityLimit
}

/** `levelchange` event detail: the 2D view's level changed. */
export interface NVSlideLevelChangeDetail {
  level: NVSlideLevelManifest
  /** The level asked for, when capacity forced a coarser one. */
  requestedLevel?: NVSlideLevelManifest
  limitedBy?: NVSlideCapacityLimit
}

/** `tileerror` event detail: a tile load failed and backs off. */
export interface NVSlideTileErrorDetail {
  key: string
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  error: unknown
  /** Owners still wanting the tile re-request it after this delay. */
  retryInMs: number
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
// The thumbnail owner wants at most this many tiles, nearest the level centre.
const THUMBNAIL_TILES = 64
// Coarse coverage: at most this many tiles of one coarser level.
const COVER_TILES = 16
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

type WantedTile = { level: NVSlideLevelManifest; tile: NVSlideTileManifest }

// One request owner's wanted tiles by key; `spare` is reused so want() does
// not allocate.
interface OwnerState {
  kind: NVSlideRequestClass
  rank: number
  keys: Map<string, WantedTile>
  spare: Map<string, WantedTile>
  focus?: { x: number; y: number }
  released: boolean
}

// Bits of the visible channels below 32.
function shownMask(channels: readonly NVChannel[]): number {
  let mask = 0
  for (let c = 0; c < Math.min(32, channels.length); c++)
    if (channels[c]?.visible) mask |= 1 << c
  return mask
}

function heldMask(held: readonly number[]): number {
  let mask = 0
  for (const c of held) if (c < 32) mask |= 1 << c
  return mask
}

// A quantized sample at its stored range's end is a bound; float has none.
function atStoredEnd(stored: number, samples?: NVSlideSampleArray): boolean {
  if (samples instanceof Int16Array)
    return stored === -32768 || stored === 32767
  if (samples instanceof Float32Array) return false
  return stored === 0 || stored === 65535
}

const thumbnailMemo = new WeakMap<
  NVSlideLevelManifest,
  { level: NVSlideLevelManifest; tile: NVSlideTileManifest }[]
>()

// The level's present tiles nearest its centre, at most THUMBNAIL_TILES.
function thumbnailTiles(level: NVSlideLevelManifest) {
  let list = thumbnailMemo.get(level)
  if (!list) {
    const cx = (level.columns - 1) / 2
    const cy = (level.rows - 1) / 2
    const d = (t: NVSlideTileManifest) => (t.x - cx) ** 2 + (t.y - cy) ** 2
    list = level.tiles
      .filter((t): t is NVSlideTileManifest => !!t)
      .sort((a, b) => d(a) - d(b))
      .slice(0, THUMBNAIL_TILES)
      .map((tile) => ({ level, tile }))
    thumbnailMemo.set(level, list)
  }
  return list
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
  readonly manifestUrl: string
  readonly stats: NVSlideStats
  viewport: NVSlideViewport
  maxScale: number
  spatialTransform: NVSlideSpatialTransform | null
  private _opacity!: number
  private _visible!: boolean
  private _levelChoice!: NVSlideLevelChoice
  private _targetScreenPixelsPerTilePixel!: number
  private _showTileGrid!: boolean
  private _backgroundColor!: NVSlideColor
  private _placeholderColor!: NVSlideColor
  private _gridColor!: NVSlideColor
  private readonly _rangeLogLength = DEFAULT_RANGE_LOG_LENGTH
  private readonly _cache: NVSlideTileCache
  // A failed tile waits before it is requested again (1 s, doubling to 30 s):
  // owners re-want missing tiles every frame, so a persistent failure (HTTP
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
  // Queued and in-flight loads by tile key, each shared by the owners that
  // want it and cancelled when the last leaves (contracts section 4).
  private readonly _loads = new Map<string, TileLoad>()
  private readonly _loadQueue = new TileLoadQueue()
  // How many owners want each key, resident or not: bounded by their caps.
  private readonly _wanted = new Map<string, number>()
  private readonly _owners = new Set<OwnerState>()
  private readonly _viewOwner: NVSlideRequestOwner
  // The 2D view's coarse coverage, at prefetch rank (ENG-03).
  private readonly _coverOwner: NVSlideRequestOwner
  private readonly _thumbOwners = new Map<string, NVSlideRequestOwner>()
  // Visible channels as bits; a slide of over 32 channels lists them instead.
  private _shownMask = 0
  private _shownWide: number[] | null = null
  private _disposed = false
  private _budgetWarned = '' // last budget outcome logged by visibleTiles
  private _lastVisible: NVSlideVisibleTiles | null = null
  private readonly _placements = new WeakMap<
    NVSlideLevelManifest,
    PlacementIndex | null
  >()
  private _shownLevel: NVSlideLevelManifest | null = null
  private _manifest: NVSlideManifest
  private _planeIndex: NVSlidePlaneIndex
  private _planeReq = 0
  private _planeAbort: AbortController | null = null
  private _holdOwner: NVSlideRequestOwner | null = null
  // The auto level last chosen: LOD hysteresis holds it near a boundary.
  private _lodLevel: NVSlideLevelManifest | null = null
  private readonly _spans = new WeakMap<
    NVSlideLevelManifest,
    {
      centerX: number
      centerY: number
      scale: number
      widthCss: number
      heightCss: number
      dpr: number | undefined
      span: TileSpan
    }
  >()
  private _visibleMemo: {
    span: TileSpan
    level: NVSlideLevelManifest
    capacity: number
    tiles: NVSlideVisibleTile[]
    version: number
    fallback: NVSlideVisibleTile[]
    requested: NVSlideLevelManifest
    visible: NVSlideVisibleTiles
  } | null = null
  private _channels: readonly NVChannel[]
  private _channelBlend: NVSlideChannelBlend = 'max'
  private _selectedLabel: { channel: number; id: number } | null = null
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
    this._manifest =
      !channelInfo && levels.every((l, i) => l === manifest.levels[i])
        ? manifest
        : { ...manifest, levels, ...(channelInfo && { channelInfo }) }
    const plane = manifest.levels[0]?.plane
    this._planeIndex = { z: plane?.z ?? 0, t: plane?.t ?? 0 }
    this.manifestUrl = options.manifestUrl ?? ''
    this.id = options.id ?? manifest.id
    this.name = options.name ?? manifest.name
    this._opacity = options.opacity ?? 1
    this._visible = options.visible ?? true
    this.viewport = options.viewport ?? {
      centerX: manifest.width / 2,
      centerY: manifest.height / 2,
      scale: 1,
    }
    this._levelChoice = options.levelChoice ?? 'auto'
    this.maxScale = options.maxScale ?? 16
    this._targetScreenPixelsPerTilePixel =
      options.targetScreenPixelsPerTilePixel ??
      DEFAULT_TARGET_SCREEN_PIXELS_PER_TILE_PIXEL
    this._showTileGrid = options.showTileGrid ?? false
    this._backgroundColor = options.backgroundColor ??
      manifest.backgroundColor ?? [0.027, 0.063, 0.051, 1]
    this._placeholderColor = options.placeholderColor ?? [0.067, 0.098, 0.09, 1]
    this._gridColor = options.gridColor ?? [0.455, 0.831, 0.812, 0.24]
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
    this._setShown(this._channels)
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
    this._viewOwner = this.createRequestOwner('view')
    this._coverOwner = this.createRequestOwner('prefetch')
    void this._loadColorLut()
  }

  /** Draw opacity, 0-1. Setting it emits 'change'. */
  get opacity(): number {
    return this._opacity
  }

  set opacity(value: number) {
    if (value === this._opacity) return
    this._opacity = value
    this._emitChange()
  }

  /** Hidden: nothing is drawn or fetched for the view. Setting it emits 'change'. */
  get visible(): boolean {
    return this._visible
  }

  set visible(value: boolean) {
    if (value === this._visible) return
    this._visible = value
    this._emitChange()
  }

  /** `auto`, or a pinned level `index`. Setting it emits 'change'. */
  get levelChoice(): NVSlideLevelChoice {
    return this._levelChoice
  }

  set levelChoice(value: NVSlideLevelChoice) {
    if (value === this._levelChoice) return
    this._levelChoice = value
    this._emitChange()
  }

  /** 'auto' picks the finest level with at least this many device px per level px. Setting it emits 'change'. */
  get targetScreenPixelsPerTilePixel(): number {
    return this._targetScreenPixelsPerTilePixel
  }

  set targetScreenPixelsPerTilePixel(value: number) {
    if (value === this._targetScreenPixelsPerTilePixel) return
    this._targetScreenPixelsPerTilePixel = value
    this._emitChange()
  }

  /** Outline each tile. Setting it emits 'change'. */
  get showTileGrid(): boolean {
    return this._showTileGrid
  }

  set showTileGrid(value: boolean) {
    if (value === this._showTileGrid) return
    this._showTileGrid = value
    this._emitChange()
  }

  /** Shown under the tiles and in holes. Setting it emits 'change'. */
  get backgroundColor(): NVSlideColor {
    return this._backgroundColor
  }

  set backgroundColor(value: NVSlideColor) {
    if (value === this._backgroundColor) return
    this._backgroundColor = value
    this._emitChange()
  }

  /** A loading tile with nothing coarser behind it. Setting it emits 'change'. */
  get placeholderColor(): NVSlideColor {
    return this._placeholderColor
  }

  set placeholderColor(value: NVSlideColor) {
    if (value === this._placeholderColor) return
    this._placeholderColor = value
    this._emitChange()
  }

  /** Tile grid outline colour. Setting it emits 'change'. */
  get gridColor(): NVSlideColor {
    return this._gridColor
  }

  set gridColor(value: NVSlideColor) {
    if (value === this._gridColor) return
    this._gridColor = value
    this._emitChange()
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
    // Untrusted: refused past the whole-file cap, Content-Length or not.
    const manifest = JSON.parse(
      new TextDecoder().decode(await readCapped(response, MAX_WHOLE_FILE)),
    ) as NVSlideManifest
    return new NVSlide(manifest, { ...options, manifestUrl })
  }

  /** Tile loads queued or in flight. */
  get pendingCount(): number {
    return this._loads.size
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
   * The channels uncopied, for the per-tile fuse: a W/L drag re-fuses every
   * tile each frame. setChannel replaces, never mutates, this array.
   * @internal
   */
  get liveChannels(): readonly Readonly<NVChannel>[] {
    return this._channels
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
    // A shown channel marks resident tiles without it stale: owners refetch
    // them on their next want while the old tiles keep drawing (ENG-09).
    this._setShown(channels)
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

  /** The highlighted label ID of a `kind: 'label'` channel, or null. */
  get selectedLabel(): { channel: number; id: number } | null {
    return this._selectedLabel
  }

  /**
   * Highlight label `id` of label channel `channel` (others dim), as a
   * volume's setSelectedID; null clears. Re-fuses, never refetches.
   */
  setSelectedLabel(channel: number, id: number | null): void {
    if (this.manifest.channelInfo?.[channel]?.kind !== 'label')
      throw new RangeError(`NVSlide channel ${channel} is not a label channel`)
    const next = id === null ? null : { channel, id }
    const old = this._selectedLabel
    if (old?.channel === next?.channel && old?.id === next?.id) return
    this._selectedLabel = next
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

  /** The committed plane's manifest. */
  get manifest(): NVSlideManifest {
    return this._manifest
  }

  /** The source's focal planes and time points; {z: 1, t: 1} for a fixed source. */
  get planes(): NVSlidePlaneAxes {
    return (this._source as Partial<SlidePlaneCapable>).planes ?? { z: 1, t: 1 }
  }

  /** The focal plane and time point shown. */
  get planeIndex(): NVSlidePlaneIndex {
    return { ...this._planeIndex }
  }

  /**
   * Show focal plane `p.z`, time point `p.t` (contracts section 2). Prepares
   * the plane's manifest, loads its visible tiles while the old plane stays
   * on screen, then switches whole in one frame (planes are never mixed).
   * Resolves true when committed, false when a newer call superseded it.
   * Rejects RangeError out of bounds or for a plane whose geometry or sample
   * mapping differs, AbortError when `opts.signal` aborts (also before the
   * call); the shown plane and its tiles are kept on any failure.
   * On commit, loads of other planes are aborted, other planes' thumbnails
   * closed and 'planechange' emitted; the viewport and channel state stay.
   */
  async setPlaneIndex(
    p: NVSlidePlaneIndex,
    opts: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const axes = this.planes
    if (
      !(Number.isInteger(p.z) && p.z >= 0 && p.z < axes.z) ||
      !(Number.isInteger(p.t) && p.t >= 0 && p.t < axes.t)
    )
      throw new RangeError(
        `NVSlide has planes z < ${axes.z}, t < ${axes.t}, got {z: ${p.z}, t: ${p.t}}`,
      )
    opts.signal?.throwIfAborted()
    const req = ++this._planeReq
    this._planeAbort?.abort()
    this._planeAbort = null
    this._holdOwner?.release()
    this._holdOwner = null
    if (p.z === this._planeIndex.z && p.t === this._planeIndex.t) return true
    const abort = new AbortController()
    this._planeAbort = abort
    const onAbort = () => abort.abort()
    opts.signal?.addEventListener('abort', onAbort)
    const current = () => req === this._planeReq && !this._disposed
    try {
      const source = this._source as Partial<SlidePlaneCapable>
      if (!source.preparePlane)
        throw new RangeError('NVSlide source cannot switch planes')
      const prepared = await source.preparePlane(p, abort.signal)
      if (!current()) return false
      const manifest = this._checkPlane(prepared)
      await this._holdFor(manifest, abort.signal)
      if (!current()) return false
      abort.signal.throwIfAborted()
      this._commitPlane(manifest, p)
      return true
    } catch (err) {
      if (!current()) return false
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      if (req === this._planeReq) {
        ;(this._holdOwner as NVSlideRequestOwner | null)?.release()
        this._holdOwner = null
        this._planeAbort = null
      }
    }
  }

  // A prepared plane, normalised as the constructor does, keeping the slide's
  // channelInfo (user and source-patched state). RangeError when its geometry
  // or sample mapping differs from the shown plane (F14).
  private _checkPlane(prepared: NVSlideManifest): NVSlideManifest {
    assertSingleSlidePlane(prepared)
    const cur = this._manifest
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b)
    const differs =
      prepared.width !== cur.width ||
      prepared.height !== cur.height ||
      !same(prepared.pixelSpacingMM, cur.pixelSpacingMM) ||
      (prepared.channelInfo?.length ?? 0) !== (cur.channelInfo?.length ?? 0) ||
      prepared.channelInfo?.some(
        (c, i) => !same(c.storedToValue, cur.channelInfo?.[i]?.storedToValue),
      ) ||
      prepared.levels.some((l, i) => {
        const o = cur.levels[i]
        return (
          o && (l.sampleType !== o.sampleType || l.bitsStored !== o.bitsStored)
        )
      })
    if (differs)
      throw new RangeError(
        'NVSlide plane differs in size, spacing, channels or sample mapping',
      )
    return {
      ...prepared,
      levels: prepared.levels.map(placeListedTiles),
      channelInfo: cur.channelInfo,
    }
  }

  // Hold (owner, Q6): load in `manifest` the tiles the view and the 3D plane
  // want now (same level position and x/y), and wait until each is resident
  // or failed, or the switch is superseded or aborted. Only the block nearest
  // each owner's focus that fits in the cache beside the shown tiles is held;
  // the rest loads after the commit.
  private async _holdFor(
    manifest: NVSlideManifest,
    signal: AbortSignal,
  ): Promise<void> {
    // By level index: owners may still hold a previous plane's levels when
    // switches follow each other without a frame between.
    const sameLevel = new Map(
      this._manifest.levels.map((l, i) => [l.index, manifest.levels[i]]),
    )
    const byKey = new Map<string, WantedTile & { dist: number }>()
    let shown = 0
    let focus: { x: number; y: number } | undefined
    for (const o of this._owners) {
      if (o.kind !== 'view' && o.kind !== 'plane3d') continue
      shown += o.keys.size
      focus ??= o.focus
      for (const { level, tile } of o.keys.values()) {
        const next = sameLevel.get(level.index)
        const t = next && tileAt(next, tile.x, tile.y)
        if (!t) continue
        const dist = o.focus
          ? this._focusDist(level, tile, o.focus)
          : Number.POSITIVE_INFINITY
        const key = this.tileKey(next, t)
        const had = byKey.get(key)
        if (!had || dist < had.dist)
          byKey.set(key, { level: next, tile: t, dist })
      }
    }
    const first = byKey.values().next().value
    if (!first) return
    // ponytail: one level's tile size bounds the room; levels share tile sizes.
    const capacity = this._capacity(first.level).tiles
    const room = Math.max(
      1,
      Math.min(capacity, Math.floor(capacity / 0.75) - shown),
    )
    const tiles = [...byKey.entries()]
      .sort((a, b) => a[1].dist - b[1].dist || 0)
      .slice(0, room)
      .map(([key, { level, tile }]) => ({ key, level, tile }))
    const hold = this.createRequestOwner('view')
    this._holdOwner = hold
    hold.want(tiles, focus)
    await new Promise<void>((resolve) => {
      const settle = () => {
        // get, not peek: the shown plane's tiles are touched every frame, so
        // held tiles stay most recent or they would be evicted first.
        for (const t of tiles) this._cache.get(t.key)
        if (
          !signal.aborted &&
          hold === this._holdOwner &&
          tiles.some((t) => {
            const entry = this._cache.peek(t.key)
            return this._loads.has(t.key) && (!entry || this._stale(entry))
          })
        )
          return
        this.removeEventListener('change', settle)
        signal.removeEventListener('abort', settle)
        resolve()
      }
      this.addEventListener('change', settle)
      signal.addEventListener('abort', settle)
      settle()
    })
  }

  private _commitPlane(manifest: NVSlideManifest, p: NVSlidePlaneIndex): void {
    this._manifest = manifest
    this._planeIndex = { z: p.z, t: p.t }
    // Same level index on the new plane: a switch must not undo the hysteresis.
    const lod = this._lodLevel
    this._lodLevel = lod
      ? (manifest.levels.find((l) => l.index === lod.index) ?? null)
      : null
    this._visibleMemo = null
    // Loads of other planes are no longer wanted by anyone (P3, P4).
    const prefix = `z${p.z}t${p.t}/`
    for (const load of [...this._loads.values()])
      if (!load.key.startsWith(prefix)) {
        load.owners.clear()
        this._cancel(load)
      }
    for (const { bitmap } of this._thumbs.values()) bitmap.close()
    this._thumbs.clear()
    for (const o of this._thumbOwners.values()) o.release()
    this._thumbOwners.clear()
    this.dispatchEvent(new Event('planechange'))
    this._emitChange()
  }

  private _visibleChannels(): number[] {
    return this._channels.flatMap((ch, i) => (ch.visible ? [i] : []))
  }

  private _setShown(channels: readonly NVChannel[]): void {
    this._shownMask = shownMask(channels)
    this._shownWide =
      channels.length > 32
        ? channels.flatMap((ch, i) => (ch.visible ? [i] : []))
        : null
  }

  // A resident tile fetched without a now-visible channel: refetch in place.
  private _stale(entry: TileBitmap): boolean {
    if (entry.mask === undefined) return false
    const held = entry.channels
    if (this._shownWide && held)
      return this._shownWide.some((c) => !held.includes(c))
    return (this._shownMask & ~entry.mask) !== 0
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
  }

  setSpatialTransform(transform: NVSlideSpatialTransform | null): void {
    this.spatialTransform = transform
    this._emitChange()
  }

  setTileGridVisible(visible: boolean): void {
    this.showTileGrid = visible
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
    return selectLevel(this, screen, this._lodLevel)
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
    const requested = selectLevel(this, screen, this._lodLevel)
    this._lodLevel = requested
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
    const { tiles: capacity, limitedBy } = this._capacity(level)
    const span = this.tileSpan(level, screen)
    const fits = span.count <= capacity
    // The walk is memoised on the view, level and capacity: a still frame
    // allocates no tiles. The fallback layer also on the cache's residency.
    const memo = this._visibleMemo
    const tiles =
      memo?.span === span && memo.level === level && memo.capacity === capacity
        ? memo.tiles
        : this.tilesForLevel(level, screen, capacity, span)
    const version = this._cache.version
    const fallback =
      memo?.tiles === tiles && memo.version === version
        ? memo.fallback
        : this.fallbackTiles(level, tiles, screen)
    const limited = level !== requested || !fits
    if (
      memo?.tiles === tiles &&
      memo.fallback === fallback &&
      memo.requested === requested
    )
      return memo.visible
    // Warn once per change of outcome; keyed by the budget too, so a budget
    // that flaps back between frames stays quiet.
    const budget = limited
      ? `${requested.index}>${level.index}@${this._budget.tileBytes}/${this._budget.rawPoolBytes}`
      : ''
    if (budget && budget !== this._budgetWarned)
      log.warn(
        `NVSlide ${this.id}: L${requested.index} needs ${this.tileSpan(requested, screen).count} tiles in view, more than the tile cache (maxCacheBytes), the renderers' tile texture budget (${(this._budget.tileBytes - this._budget.rawPoolBytes) / MiB} MiB for scalar slides, ${this._budget.tileBytes / MiB} for RGB) or the ${MAX_VISIBLE_TILES}-tile cap holds (limited by ${limitedBy}); ${fits ? `showing L${level.index}` : `even L${level.index} does not fit, so only the ${capacity} tiles nearest the centre load`}. Zoom in, or raise maxCacheBytes if the tile cache is the limit.`,
      )
    this._budgetWarned = budget
    const visible: NVSlideVisibleTiles = {
      level,
      tiles,
      fallback,
      requestedLevel: level === requested ? undefined : requested,
      capped: !fits || undefined,
      limitedBy: limited ? limitedBy : undefined,
    }
    this._visibleMemo = {
      span,
      level,
      capacity,
      tiles,
      version,
      fallback,
      requested,
      visible,
    }
    return visible
  }

  private fitsCache(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
  ): boolean {
    return this.tileSpan(level, screen).count <= this._capacity(level).tiles
  }

  private _capacity(level: NVSlideLevelManifest) {
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
   * Tiles of `level` the 3D plane may want: the cache's tile capacity less
   * what the 2D view wants, never under a third of it (contracts section 4).
   * @internal
   */
  planeCapacity(level: NVSlideLevelManifest): number {
    const cap = this._capacity(level).tiles
    return Math.max(Math.floor(cap / 3), cap - this._viewOwnerSize())
  }

  private _viewOwnerSize(): number {
    for (const o of this._owners) if (o.kind === 'view') return o.keys.size
    return 0
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
    return fallbackTiles(this, target, tiles, this._cache, (l) => {
      const span = this.tileSpan(l, screen)
      return span.count > MAX_VISIBLE_TILES
        ? null
        : this.tilesForLevel(l, screen, MAX_VISIBLE_TILES, span)
    })
  }

  // One span per level per view (ENG-04): visibleTiles, its capacity checks,
  // the walk, the fallback layer and coverage all ask for the same spans.
  private tileSpan(level: NVSlideLevelManifest, screen: NVSlideScreen) {
    const { centerX, centerY, scale } = this.viewport
    const { widthCss, heightCss, devicePixelRatio: dpr } = screen
    let memo = this._spans.get(level)
    if (
      !memo ||
      memo.centerX !== centerX ||
      memo.centerY !== centerY ||
      memo.scale !== scale ||
      memo.widthCss !== widthCss ||
      memo.heightCss !== heightCss ||
      memo.dpr !== dpr
    ) {
      memo = {
        centerX,
        centerY,
        scale,
        widthCss,
        heightCss,
        dpr,
        span: this._spanOf(level, screen),
      }
      this._spans.set(level, memo)
    }
    return memo.span
  }

  // Grid or placed (SRC-20), decided per level, before any per-tile loop.
  private _spanOf(level: NVSlideLevelManifest, screen: NVSlideScreen) {
    const ix = this._placement(level)
    return ix
      ? placedSpan(this.manifest, this.viewport, ix, screen).span
      : tileSpan(this.manifest, this.viewport, level, screen)
  }

  private tilesForLevel(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
    limit = MAX_VISIBLE_TILES,
    span = this.tileSpan(level, screen),
  ): NVSlideVisibleTile[] {
    const ix = this._placement(level)
    return ix
      ? placedTiles(this, ix, screen, limit)
      : tilesForLevel(this, level, screen, limit, span)
  }

  /**
   * The level's placement index (SRC-20), or null for a grid level or an
   * invalid placement (warned once; the level then draws as a grid).
   * @internal
   */
  placementIndex(level: NVSlideLevelManifest): PlacementIndex | null {
    return this._placement(level)
  }

  private _placement(level: NVSlideLevelManifest): PlacementIndex | null {
    if (!level.placement) return null
    let ix = this._placements.get(level)
    if (ix === undefined) {
      ix = buildPlacementIndex(this.manifest, level)
      this._placements.set(level, ix)
    }
    return ix
  }

  /**
   * Edge bits (tileGutter EDGE_*) of tile `col`, `row` whose grid neighbour is
   * also its placed neighbour, so its gutter may copy from it.
   * @internal Gutter plumbing.
   */
  tileEdges(level: NVSlideLevelManifest, col: number, row: number): number {
    const ix = this._placement(level)
    return ix ? (ix.edges[row * level.columns + col] as number) : EDGE_ALL
  }

  /** The tiles the last draw asked for (null before the first), to save a second walk. */
  get lastVisibleTiles(): NVSlideVisibleTiles | null {
    return this._lastVisible
  }

  requestVisibleTiles(screen: NVSlideScreen): NVSlideVisibleTiles {
    const visible = this.visibleTiles(screen)
    this._lastVisible = visible
    const { level } = visible
    if (!this.visible || !level) {
      this._viewOwner.want([])
      this._coverOwner.want([])
      return visible
    }
    // By index: a plane switch replaces the level objects, not the level.
    if (level.index !== this._shownLevel?.index) {
      this._shownLevel = level
      this.dispatchEvent(
        new CustomEvent<NVSlideLevelChangeDetail>('levelchange', {
          detail: {
            level,
            requestedLevel: visible.requestedLevel,
            limitedBy: visible.limitedBy,
          },
        }),
      )
    }
    const focus = { x: this.viewport.centerX, y: this.viewport.centerY }
    this._viewOwner.want(visible.tiles, focus)
    // Coverage only pays while the target takes more than one round of load
    // slots; a smaller target lands first anyway, so it would only add reads.
    let missing = 0
    for (const t of visible.tiles) if (!this._cache.has(t.key)) missing++
    this._coverOwner.want(
      missing > this._maxConcurrentLoads ? this._coverTiles(level, screen) : [],
      focus,
    )
    return visible
  }

  /**
   * Budgeted coarse coverage under `level` (ENG-03): the visible tiles of the
   * finest coarser level that needs at most COVER_TILES tiles and an eighth of
   * the cache, wanted at prefetch rank so they never delay the view's own.
   */
  private _coverTiles(
    level: NVSlideLevelManifest,
    screen: NVSlideScreen,
  ): NVSlideVisibleTile[] {
    const levels = this.manifest.levels
    for (let pos = levels.indexOf(level) + 1; pos < levels.length; pos++) {
      const coarse = levels[pos] as NVSlideLevelManifest
      const tileBytes =
        this.levelTileWidth(coarse) * this.levelTileHeight(coarse) * 4
      const limit = Math.min(
        COVER_TILES,
        Math.floor(this._cache.maxBytes / 8 / tileBytes),
      )
      if (this.tileSpan(coarse, screen).count <= limit)
        return this.tilesForLevel(coarse, screen, limit)
    }
    return []
  }

  /**
   * A new request owner (contracts section 4): it wants a set of tiles, each
   * load is shared by every owner wanting it, ordered by class rank then
   * distance to the owner's focus, and cancelled when its last owner leaves.
   * Release it when done; dispose releases every owner.
   */
  createRequestOwner(kind: NVSlideRequestClass): NVSlideRequestOwner {
    const o: OwnerState = {
      kind,
      rank: REQUEST_RANK[kind],
      keys: new Map(),
      spare: new Map(),
      released: false,
    }
    this._owners.add(o)
    return {
      kind,
      want: (tiles, focus) => {
        if (!o.released) this._want(o, tiles, focus)
      },
      release: () => {
        if (o.released) return
        this._want(o, [])
        o.released = true
        this._owners.delete(o)
      },
    }
  }

  // Replace owner `o`'s wanted set with `tiles`: start loads for keys that are
  // neither resident (and fresh) nor loading, and drop `o` from loads it no
  // longer wants, cancelling those nobody else wants.
  private _want(
    o: OwnerState,
    tiles: Iterable<{
      level: NVSlideLevelManifest
      tile: NVSlideTileManifest
      key?: string
    }>,
    focus?: { x: number; y: number },
  ): void {
    if (this._disposed) return
    const next = o.spare
    next.clear()
    const now = performance.now()
    const view = o.kind === 'view'
    let started = false
    for (const wanted of tiles) {
      const { level, tile } = wanted
      const key = wanted.key ?? this.tileKey(level, tile)
      if (next.has(key)) continue
      next.set(key, wanted)
      const fresh = !o.keys.has(key)
      if (fresh) this._wanted.set(key, (this._wanted.get(key) ?? 0) + 1)
      const entry = this._cache.peek(key)
      if (entry && !this._stale(entry)) {
        // The one place a load is avoided: counted once per owner and tile.
        if (fresh) this.stats.cacheHits++
        continue
      }
      let load = this._loads.get(key)
      // Aborted in flight but not settled yet: start afresh beside it.
      if (load?.controller?.signal.aborted) load = undefined
      if (!load) {
        if ((this._failed.get(key)?.retryAt ?? 0) > now) continue
        load = {
          key,
          level,
          tile,
          owners: new Set(),
          rank: o.rank,
          dist: Number.POSITIVE_INFINITY,
          seq: 0,
          viewOnly: view,
          qi: -1,
        }
        this._loads.set(key, load)
        this._loadQueue.push(load)
        this.stats.requested++
        started = true
      }
      if (!load.owners.has(o)) {
        load.owners.add(o)
        if (!view) load.viewOnly = false
      }
      if (o.rank <= load.rank) {
        // Nearest focus among the best-rank owners, each at its current focus.
        let dist = focus ? this._focusDist(level, tile, focus) : Infinity
        for (const w of load.owners) {
          const s = w as OwnerState
          if (s !== o && s.rank === o.rank && s.focus)
            dist = Math.min(dist, this._focusDist(level, tile, s.focus))
        }
        load.rank = o.rank
        load.dist = dist
      }
    }
    for (const key of o.keys.keys()) {
      if (next.has(key)) continue
      const n = (this._wanted.get(key) ?? 1) - 1
      if (n > 0) this._wanted.set(key, n)
      else this._wanted.delete(key)
      const load = this._loads.get(key)
      if (!load?.owners.delete(o)) continue
      if (load.owners.size === 0) this._cancel(load)
      else {
        // The best rank may have left: the rest order it, nearest focus first.
        load.rank = load.dist = Number.POSITIVE_INFINITY
        load.viewOnly = true
        for (const w of load.owners) {
          const s = w as OwnerState
          if (s.kind !== 'view') load.viewOnly = false
          if (s.rank < load.rank) load.rank = s.rank
        }
        for (const w of load.owners) {
          const s = w as OwnerState
          if (s.rank === load.rank && s.focus)
            load.dist = Math.min(
              load.dist,
              this._focusDist(load.level, load.tile, s.focus),
            )
        }
      }
    }
    o.spare = o.keys
    o.keys = next
    o.focus = focus
    if (started) {
      this._emitChange()
      this._drainLoadQueue()
    }
  }

  // Squared base-px distance from a tile's centre to `focus`.
  private _focusDist(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    focus: { x: number; y: number },
  ): number {
    const { width, height } = this.manifest
    const dx =
      ((tile.x + 0.5) * this.levelTileWidth(level) * width) / level.width -
      focus.x
    const dy =
      ((tile.y + 0.5) * this.levelTileHeight(level) * height) / level.height -
      focus.y
    return dx * dx + dy * dy
  }

  // Nobody wants `load` any more: drop it from the queue, or abort it in flight
  // (its _runLoad counts the abort and cleans up).
  private _cancel(load: TileLoad): void {
    if (load.controller) {
      load.controller.abort()
      return
    }
    this._loadQueue.remove(load)
    this._loads.delete(load.key)
    this.stats.aborted++
    this._settleIfIdle()
  }

  /**
   * A resident tile, bitmap or samples (see {@link NVSlideCachedTile});
   * refreshes its LRU place, so a drawn tile stays resident.
   * @internal Renderer plumbing.
   */
  cachedTile(key: string): NVSlideCachedTile | null {
    return this._cache.get(key) ?? null
  }

  /**
   * Level `level` (default the coarsest) composited on the CPU from its
   * resident tiles, rows as stored, scaled to fit `maxPx` a side, for a minimap
   * or a colour reference. Missing tiles are requested (thumbnail rank, at most
   * the 64 nearest the level centre) and left black. The same bitmap is
   * returned until a tile arrives or leaves or the channels change; the slide
   * closes it then and on dispose, so draw it at once. Null without
   * OffscreenCanvas or before any tile is resident.
   */
  thumbnailBitmap(
    level = this.manifest.levels.at(-1),
    maxPx = DEFAULT_THUMBNAIL_PX,
  ): ImageBitmap | null {
    if (!level || typeof OffscreenCanvas === 'undefined') return null
    const key = `${this.tileKey(level, { x: 0, y: 0 })}/${maxPx}`
    let owner = this._thumbOwners.get(key)
    if (!owner) {
      owner = this.createRequestOwner('thumbnail')
      this._thumbOwners.set(key, owner)
      for (const [old, o] of this._thumbOwners) {
        if (this._thumbOwners.size <= MAX_THUMBNAILS) break
        o.release()
        this._thumbOwners.delete(old)
      }
    }
    owner.want(thumbnailTiles(level), {
      x: this.manifest.width / 2,
      y: this.manifest.height / 2,
    })
    // get, not peek: a thumbnail drawn each frame keeps its tiles from eviction.
    const entries = level.tiles.map((tile) =>
      tile ? this._cache.get(this.tileKey(level, tile)) : undefined,
    )
    const ids = entries.map((e) => e?.id ?? 0)
    const memo = this._thumbs.get(key)
    if (
      memo?.gen === this._displayGen &&
      ids.every((id, i) => id === memo.ids[i])
    )
      return memo.bitmap
    if (!entries.some(Boolean)) return null
    const bitmap = composeThumbnail(
      // An invalid placement draws as the grid, as everywhere else.
      level.placement && !this._placement(level)
        ? { ...level, placement: undefined }
        : level,
      entries,
      maxPx,
      this.levelTileWidth(level),
      this.levelTileHeight(level),
      this._channels,
      this.channelBlend,
      this.manifest.channelInfo,
      this.selectedLabel,
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
   * fetched and stay `missing: 'hidden'`. `signal` stops the wait and cancels
   * the load unless another owner wants it; an abort or a failed load
   * resolves `uncached`, without a retry.
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
    // A one-shot readout owner: rank 0, no retry; released when settled.
    const owner = this.createRequestOwner('readout')
    if (!signal?.aborted) owner.want([{ level, tile: hit.tile }])
    await new Promise<void>((resolve) => {
      const settle = () => {
        const entry = this._cache.peek(key)
        // A stale resident tile is being refetched: wait for it too.
        if (
          !signal?.aborted &&
          this._loads.has(key) &&
          (!entry || this._stale(entry))
        )
          return
        resolve()
        this.removeEventListener('change', settle)
        signal?.removeEventListener('abort', settle)
      }
      this.addEventListener('change', settle)
      signal?.addEventListener('abort', settle)
      settle()
    })
    owner.release()
    return this.sampleAt(x, y, { level: index })
  }

  // The tile of `level` under base pixel x, y and the pixel in it; null for a hole.
  private _tileUnder(level: NVSlideLevelManifest, x: number, y: number) {
    const ix = this._placement(level)
    if (ix) return pieceAt(ix, x / ix.dsX, y / ix.dsY)
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
      // A label ID is exact as stored: never mapped, quantized or clipped.
      const label = info?.[channel]?.kind === 'label'
      const map = label ? undefined : info?.[channel]?.storedToValue
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
    // A pending plane switch: its preparation stops and the switch settles false.
    this._planeAbort?.abort()
    for (const { bitmap } of this._thumbs.values()) bitmap.close()
    this._thumbs.clear()
    for (const o of this._owners) o.released = true
    this._owners.clear()
    this._thumbOwners.clear()
    this._loadQueue.clear()
    for (const load of this._loads.values()) load.controller?.abort()
    this._loads.clear()
    this._wanted.clear()
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

  /**
   * The cache key {@link cachedTile} takes for a tile (or grid cell) of a
   * level: `z<z>t<t>/L<index>/<x>/<y>`. The only tile-key producer.
   */
  tileKey(level: NVSlideLevelManifest, tile: { x: number; y: number }): string {
    const p = level.plane
    return `z${p?.z ?? 0}t${p?.t ?? 0}/L${level.index}/${tile.x}/${tile.y}`
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

  private async _runLoad(load: TileLoad): Promise<void> {
    const { level, tile, key } = load
    this._activeLoads++
    // Plane-free, as a source labels its own range events (volumeSliceSource).
    const label = `L${level.index}/${tile.x}/${tile.y}${typeof tile.frame === 'number' ? ` f${tile.frame}` : ''}`
    const controller = new AbortController()
    load.controller = controller
    const { signal } = controller
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
      if (signal.aborted || this._disposed) {
        // Disposed or dropped while decoding: caching now would leave a bitmap
        // in a cache that was already cleared, with nobody to close it.
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
              mask: held && heldMask(held),
              id: ++tileSerial,
            },
      )
      this.stats.cacheBytes = this._cache.bytes
      this.stats.completed++
      this._failed.delete(key)
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        // An abort is not a failure: nothing was wrong with the tile.
        this.stats.aborted++
        this.updateRangeEvent(label, 'aborted')
      } else this._loadFailed(load, label, err)
    } finally {
      this._activeLoads--
      if (this._loads.get(key) === load) this._loads.delete(key)
      // dispose() already sent the last change (clearCache).
      if (!this._disposed) this._emitChange()
      this._drainLoadQueue()
      this._settleIfIdle()
    }
  }

  // Log a failed load, back it off (1 s doubling to 30 s) and tell listeners.
  // Retries due within one tick share a timer, whose change event makes
  // frame-driven owners re-want the tiles they still need.
  private _loadFailed(load: TileLoad, label: string, error: unknown): void {
    const { key, level, tile } = load
    this.stats.failures++
    this.updateRangeEvent(label, 'failed')
    console.error(`Failed to load slide tile ${this.id}/${key}`, error)
    const delay = Math.min(30_000, (this._failed.get(key)?.delay ?? 500) * 2)
    const retryAt = performance.now() + delay
    this._failed.set(key, { retryAt, delay })
    // The slot ends at or after every retryAt in it, so its tiles are due;
    // +1 ms: a timer may fire up to 1 ms early, before the gate in _want.
    const slot = Math.ceil(retryAt / RETRY_TICK) * RETRY_TICK
    if (!this._retryTimers.has(slot))
      this._retryTimers.set(
        slot,
        setTimeout(
          () => {
            this._retryTimers.delete(slot)
            this._emitChange()
          },
          slot - performance.now() + 1,
        ),
      )
    this.dispatchEvent(
      new CustomEvent<NVSlideTileErrorDetail>('tileerror', {
        detail: { key, level, tile, error, retryInMs: delay },
      }),
    )
  }

  private _drainLoadQueue(): void {
    while (this._activeLoads < this._maxConcurrentLoads && !this._disposed) {
      const load = this._loadQueue.next()
      if (!load) return
      void this._runLoad(load)
    }
  }

  // 'idle' once nothing is queued or loading (after something was).
  private _settleIfIdle(): void {
    if (this._loads.size === 0 && !this._disposed)
      this.dispatchEvent(new Event('idle'))
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
