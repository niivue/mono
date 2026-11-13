// Backend-neutral half of the fuse pass (#159), shared by the slide renderers
// (gl/ and wgpu/ tileFuse.ts). A scalar tile keeps its samples on the CPU and
// one RGBA8 texture on the GPU, the only thing drawn. When the tile arrives, or
// a channel's window, colormap or visibility or the blend changes, the fuse
// pass renders into that texture: one quad per visible channel, raw sample ->
// window -> colormap row, combined by MAX or a saturating sum, exactly as
// fuseSamples does on the CPU. Raw layers stay in a small LRU pool so a W/L
// drag re-fuses without re-uploading.

import { colormapKey, lutrgba8 } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import type {
  NVChannel,
  NVSlide,
  NVSlideCachedTile,
  NVSlideChannelBlend,
  NVSlideChannelInfo,
  NVSlideSampleArray,
  NVSlideTileSamples,
  NVSlideWindow,
} from './NVSlide'
import { type GutterAt, gutterTextureBytes } from './tileGutter'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  type TileTextureCache,
} from './tileTextureCache'

/** GPU budget for raw layers, carved out of the tile texture budget. */
export const DEFAULT_RAW_POOL_BYTES = 32 * 1024 * 1024

/** A renderer's tile texture budget: what its raw pool leaves of 128 MiB. */
export const tileTextureBudget = (maxRawPoolBytes = DEFAULT_RAW_POOL_BYTES) =>
  Math.max(0, DEFAULT_TILE_TEXTURE_BYTES - maxRawPoolBytes)

/** `maxRawPoolBytes` clamped to [0, 64 MiB] so tile textures keep >= 64 MiB. */
export const rawPoolBytes = (maxRawPoolBytes = DEFAULT_RAW_POOL_BYTES) =>
  Math.min(Math.max(0, maxRawPoolBytes), DEFAULT_TILE_TEXTURE_BYTES / 2)

/** The tile texture and raw pool bytes a renderer states to its slides. */
export interface SlideRendererBudget {
  tileBytes: number
  rawPoolBytes: number
}

/**
 * A renderer's budget, registered on the slides it draws
 * (NVSlide.setRendererBudget) and removed from those it stops drawing and on
 * destroy, so a dead renderer leaves no budget behind and holds no slide.
 * Each of n slides gets 1/n of it, as their tiles in view share one texture
 * cache; a slide of label and intensity channels half that, as its tiles take
 * two textures each (fuseTarget).
 */
export class SlideBudgetRegistration {
  private readonly _slides = new Set<NVSlide>()
  private _shares = 1
  // New objects per share count: setRendererBudget skips the one it holds.
  private _budget: SlideRendererBudget
  private _mixedBudget: SlideRendererBudget

  constructor(
    private readonly _renderer: object,
    private readonly _rawPoolBytes: number,
  ) {
    this._budget = this._share(1)
    this._mixedBudget = this._share(2)
  }

  private _share(n: number): SlideRendererBudget {
    return {
      tileBytes: DEFAULT_TILE_TEXTURE_BYTES / n,
      rawPoolBytes: this._rawPoolBytes / n,
    }
  }

  /** Register on `slides`, unregister from the rest. */
  sync(slides: readonly NVSlide[]): void {
    for (const slide of this._slides)
      if (!slides.includes(slide)) {
        slide.setRendererBudget(this._renderer, null)
        this._slides.delete(slide)
      }
    const n = Math.max(1, slides.length)
    if (n !== this._shares) {
      this._shares = n
      this._budget = this._share(n)
      this._mixedBudget = this._share(2 * n)
    }
    for (const slide of slides) {
      const info = slide.manifest.channelInfo
      const mixed =
        info?.some((c) => c.kind === 'label') &&
        info.some((c) => c.kind !== 'label')
      slide.setRendererBudget(
        this._renderer,
        mixed ? this._mixedBudget : this._budget,
      )
      this._slides.add(slide)
    }
  }

  clear(): void {
    this.sync([])
  }
}

/** Options of `SlideRenderer` and `SlideRendererGPU.create`. */
export interface SlideRendererOptions {
  /**
   * GPU bytes for raw channel layers of scalar tiles (default 32 MiB), carved
   * out of the 128 MiB tile texture budget. 0 keeps raw layers on the CPU
   * only: every W/L change then re-uploads them. Clamped to [0, 64 MiB].
   */
  maxRawPoolBytes?: number
}

/** Raw layer texture formats: R8UI, R16UI, R16I, R32F. */
export type RawFormat = 'u8' | 'u16' | 'i16' | 'f32'

export function rawFormat(samples: NVSlideSampleArray): RawFormat {
  if (samples instanceof Uint8Array) return 'u8'
  if (samples instanceof Uint16Array) return 'u16'
  return samples instanceof Int16Array ? 'i16' : 'f32'
}

/** One visible channel of a tile: its sample plane, window and colormap. */
export interface FuseLayer {
  plane: number
  calMin: number
  calMax: number
  colormap: string
}

/**
 * Label colours of one channel as packed 0xAABBGGRR (little-endian RGBA8
 * bytes, the layout every WebGL2/WebGPU platform uploads), alpha folded into
 * RGB. IDs at or past `size` take `labelColor`.
 */
export interface LabelTable {
  colors: Uint32Array
  size: number
  /** Texture width; colors.length is width * rows. */
  width: number
}

/** One visible label channel of a tile: integer IDs through its table, never windowed. */
export interface FuseLabelLayer {
  plane: number
  table: LabelTable
  /** The highlighted ID (others dim by LABEL_DIM / 256), or null. */
  selected: number | null
}

export interface FusePlan {
  layers: FuseLayer[]
  labels: readonly FuseLabelLayer[]
  additive: boolean
  /** MONOCHROME1: the windowed level is inverted before the colormap. */
  invert: boolean
}

/** A cached scalar tile. */
export type FuseTile = NVSlideCachedTile & {
  readonly samples: NVSlideTileSamples
}

export const isFuseTile = (tile: NVSlideCachedTile): tile is FuseTile =>
  tile.samples !== undefined

/**
 * The stored range a non-finite bound stands for: 0 .. 2^bits - 1 unsigned,
 * -2^(bits-1) .. 2^(bits-1) - 1 for int16, 0 .. 1 for float32 (no stored range).
 */
function storedRange(s: NVSlideSampleArray, bits: number): [number, number] {
  if (s instanceof Float32Array) return [0, 1]
  if (s instanceof Int16Array) {
    const half = 2 ** (Math.min(bits, 16) - 1)
    return [-half, half - 1]
  }
  return [0, 2 ** bits - 1]
}

/** A channel's window with non-finite bounds resolved to the stored range. */
export function resolveWindow(
  { calMin, calMax }: NVSlideWindow,
  [lo0, hi0]: [number, number],
): NVSlideWindow {
  // A stored-range end never crosses the bound set (calMin 5000 on u8 is black, not inverted).
  const lo = Number.isFinite(calMin)
    ? calMin
    : Number.isFinite(calMax)
      ? Math.min(lo0, calMax - 1)
      : lo0
  return {
    calMin: lo,
    calMax: Number.isFinite(calMax) ? calMax : Math.max(hi0, lo + 1),
  }
}

/** Non-highlighted IDs of a highlighted label channel: colour * 77 >> 8 (0.3x). */
export const LABEL_DIM = 77

/**
 * The default colour of label `id` as 0xFFBBGGRR: a lowbias32 hash, each byte
 * mapped to 64..255 so no label reads as background. The shaders (gl|wgpu
 * tileFuse.ts) compute the same in uint arithmetic.
 */
export function labelColor(id: number): number {
  let h = id >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  const byte = (shift: number) => 64 + ((((h >>> shift) & 255) * 3) >>> 2)
  return (0xff000000 | (byte(16) << 16) | (byte(8) << 8) | byte(0)) >>> 0
}

// WebGL2's guaranteed MAX_TEXTURE_SIZE: the table texture fits any device.
const LABEL_TABLE_WIDTH = 2048
/** Largest stated label ID + 1 a table holds (16 MiB); larger IDs keep the hash colour. */
export const MAX_LABEL_TABLE_IDS = LABEL_TABLE_WIDTH * LABEL_TABLE_WIDTH
type LabelColors = NonNullable<NVSlideChannelInfo['labelColors']>
const NO_COLORS: LabelColors = []
/**
 * Free the entries of `tables` (and their textures) no label channel of
 * `slides` uses (tables are memoised per labelColors).
 */
export function pruneLabelTables<T>(
  tables: Map<LabelTable, T>,
  slides: readonly NVSlide[],
  free: (texture: T) => void,
): void {
  const used = new Set<LabelTable>()
  for (const slide of slides)
    for (const c of slide.manifest.channelInfo ?? [])
      if (c.kind === 'label') used.add(labelTable(c.labelColors))
  for (const [table, texture] of tables)
    if (!used.has(table)) {
      free(texture)
      tables.delete(table)
    }
}

const labelTables = new WeakMap<LabelColors, LabelTable>()

/**
 * The table of `labelColors`: dense to the largest stated ID (ID 0 black
 * unless stated), defaults filled in. Memoized by array identity.
 * IDs that are not integers in [0, MAX_LABEL_TABLE_IDS) are skipped with a
 * warning (manifest data: one bad entry must not take the slide down).
 * ponytail: dense, 4 B per ID up to the largest override (<= 16 MiB);
 * go sparse (sorted IDs, binary search) if sources state huge sparse IDs.
 */
export function labelTable(labelColors: LabelColors = NO_COLORS): LabelTable {
  let table = labelTables.get(labelColors)
  if (!table) {
    const valid = labelColors.filter(
      ({ id }) => Number.isInteger(id) && id >= 0 && id < MAX_LABEL_TABLE_IDS,
    )
    if (valid.length < labelColors.length)
      log.warn(
        `${labelColors.length - valid.length} labelColors IDs outside [0, ${MAX_LABEL_TABLE_IDS}) skipped; they keep the default colour`,
      )
    const size = 1 + valid.reduce((m, c) => Math.max(m, c.id), 0)
    const width = Math.min(size, LABEL_TABLE_WIDTH)
    const colors = new Uint32Array(width * Math.ceil(size / width))
    for (let id = 1; id < size; id++) colors[id] = labelColor(id)
    for (const {
      id,
      rgba: [r, g, b, a],
    } of valid) {
      const k = (c: number) => Math.round((c * a) / 255)
      colors[id] = (0xff000000 | (k(b) << 16) | (k(g) << 8) | k(r)) >>> 0
    }
    table = { colors, size, width }
    labelTables.set(labelColors, table)
  }
  return table
}

const NO_LABELS: FuseLabelLayer[] = []

/**
 * The visible channels of `tile` under the slide's channel state. Channels of
 * kind 'label' in `info` go to `labels`, `selected` (NVSlide.selectedLabel)
 * highlighting one ID of one of them.
 */
export function fusePlan(
  channels: readonly NVChannel[],
  blend: NVSlideChannelBlend,
  { samples: s, channels: held, level }: FuseTile,
  info?: readonly NVSlideChannelInfo[],
  selected?: { channel: number; id: number } | null,
): FusePlan {
  const range = storedRange(s.samples, level.bitsStored ?? s.bitsStored)
  const layers: FuseLayer[] = []
  // Shared empty until a label channel shows: intensity-only plans allocate nothing more.
  let labels: FuseLabelLayer[] = NO_LABELS
  for (let plane = 0; plane < (s.planes ?? 1); plane++) {
    const c = held ? (held[plane] as number) : plane
    const ch = channels[c]
    if (!ch?.visible) continue
    const ci = info?.[c]
    if (ci?.kind === 'label') {
      if (labels === NO_LABELS) labels = []
      labels.push({
        plane,
        table: labelTable(ci.labelColors),
        selected: selected?.channel === c ? selected.id : null,
      })
    } else
      layers.push({ plane, colormap: ch.colormap, ...resolveWindow(ch, range) })
  }
  return {
    layers,
    labels,
    additive: blend === 'additive',
    invert: level.photometric === 'MONOCHROME1',
  }
}

/**
 * Planar samples to opaque RGBA8 through `plan`: the CPU reference of the GPU
 * fuse (thumbnails, the wand). Level = round(clamp((v - calMin) * 255 /
 * (calMax - calMin), 0, 255)), the shaders' floor(x + 0.5) with ties up.
 */
export function fuseSamples(
  samples: NVSlideSampleArray,
  pixels: number,
  plan: FusePlan,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels * 4)
  for (let o = 3; o < out.length; o += 4) out[o] = 255
  for (const { plane, calMin, calMax, colormap } of plan.layers) {
    // MONOCHROME1 inverts the level before the colormap: the row reversed.
    const rgba = lutrgba8(colormap, plan.invert)
    const width = calMax - calMin
    const base = plane * pixels
    // Multiply before dividing, so a midpoint like 127.5 is exact and rounds
    // up; NaN (a float sample) falls through to 0. A window near the float64
    // max would overflow that: halve and divide first instead.
    const half = calMax / 2 - calMin / 2
    const level: (v: number) => number =
      Math.abs(calMin) < 1e305 && Number.isFinite(width)
        ? (v) => ((v - calMin) * 255) / width
        : (v) => ((v / 2 - calMin / 2) / half) * 255
    const at = (i: number): number => {
      const x = level(samples[base + i] as number)
      return (x > 0 ? (x < 255 ? Math.round(x) : 255) : 0) * 4
    }
    // One loop per blend, no per-pixel branch on it.
    if (plan.additive) {
      // Uint8ClampedArray saturates the sum at 255.
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const j = at(i)
        out[o] += rgba[j] as number
        out[o + 1] += rgba[j + 1] as number
        out[o + 2] += rgba[j + 2] as number
      }
    } else {
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const j = at(i)
        out[o] = Math.max(out[o] as number, rgba[j] as number)
        out[o + 1] = Math.max(out[o + 1] as number, rgba[j + 1] as number)
        out[o + 2] = Math.max(out[o + 2] as number, rgba[j + 2] as number)
      }
    }
  }
  for (const l of plan.labels) {
    const { colors } = l.table
    const base = l.plane * pixels
    const [sel, other, size] = labelUniforms(l)
    // Packed 0xBBGGRR, the highlight applied: (byte * m) >> 8, m 256 or LABEL_DIM.
    const at = (i: number): number => {
      const id = labelId(samples[base + i] as number)
      const c = id < size ? (colors[id] as number) : labelColor(id)
      const m = id === sel ? 256 : other
      return (
        (((c & 255) * m) >>> 8) |
        (((((c >>> 8) & 255) * m) >>> 8) << 8) |
        (((((c >>> 16) & 255) * m) >>> 8) << 16)
      )
    }
    if (plan.additive) {
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const c = at(i)
        out[o] += c & 255
        out[o + 1] += (c >>> 8) & 255
        out[o + 2] += c >>> 16
      }
    } else {
      for (let i = 0, o = 0; i < pixels; i++, o += 4) {
        const c = at(i)
        out[o] = Math.max(out[o] as number, c & 255)
        out[o + 1] = Math.max(out[o + 1] as number, (c >>> 8) & 255)
        out[o + 2] = Math.max(out[o + 2] as number, c >>> 16)
      }
    }
  }
  return out
}

/** A sample as a label ID, as the shaders: truncated; NaN and <= 0 are 0. */
const labelId = (v: number): number => (v > 0 ? v >>> 0 : 0)

/**
 * A label layer's shader uniforms (and fuseSamples'): the selected ID, the
 * colour scale in 256ths of every other ID (256 without a selection), the
 * table size and width.
 */
export const labelUniforms = ({
  table,
  selected,
}: FuseLabelLayer): [number, number, number, number] => [
  selected === null ? 0 : labelId(selected),
  selected === null ? 256 : LABEL_DIM,
  table.size,
  table.width,
]

/** ceil(log2 |x|): -Infinity for 0. */
const exponent = (x: number): number => Math.ceil(Math.log2(Math.abs(x)))

/**
 * A layer's fuse-shader uniforms: calMin as a float32 head and its remainder,
 * calMax - calMin, LUT row, invert, and the scale s they are all multiplied by.
 * The shaders compute (v * s - head - rest) / width. s is a power of two that
 * brings the width near 1, so a window neither overflows nor underflows float32
 * and every ratio stays exact; a head/rest split, as rounding calMin to float32
 * alone shifts a narrow window at large values (float32 ulp at 1e8 is 8).
 * Windows past what s can scale take the two branches below.
 */
export function fuseUniforms(
  { calMin, calMax }: FuseLayer,
  row: number,
  invert: boolean,
): [number, number, number, number, number, number] {
  const width = calMax - calMin
  const inv = invert ? 1 : 0
  // Ideal k: width * s near 1, |calMin * s| at most 2^126.
  const ideal = Math.max(exponent(width), exponent(calMin) - 126)
  if (ideal > 126) {
    // s would leave float32 normals (-1e75..1e75): the window normalised,
    // level = (v * s / W - calMin / width) * 255 with W = width * s, capped
    // where float32 samples move it by under 2^-80. Halved so width cannot
    // overflow float64; calMin / width clamped as the level then saturates.
    const half = calMax / 2 - calMin / 2
    const w = Math.min(2 ** 90, half * 2 ** -125)
    const start = Math.min(1e6, Math.max(-1e6, calMin / 2 / half)) * w
    const head = Math.fround(start)
    return [head, w, row, inv, start - head, 2 ** -126]
  }
  const s = 2 ** -Math.max(-126, ideal)
  if (ideal < -126 && width < 2 ** -149) {
    // Under float32 spacing (-1e-200..1e-200): at most one float32 p in the
    // window, so a step. v below p is 0, above 255, and p gets its level
    // through rest, against a width far under p's neighbours' 2^-23 * s.
    const p =
      [Math.fround(calMin), Math.fround(calMax)].find(
        (x) => x >= calMin && x <= calMax,
      ) ?? Math.fround(calMax)
    const level = Math.min(
      255,
      Math.max(0, Math.round(((p - calMin) * 255) / width)),
    )
    return [p * s, 2 ** -100, row, inv, (-level * 2 ** -100) / 255, s]
  }
  const head = Math.fround(calMin * s)
  return [head, width * s, row, inv, calMin * s - head, s]
}

/** Colormap rows of a renderer's 256-wide RGBA8 LUT texture, added on first use. */
export class FuseLutRows {
  private readonly _rows = new Map<string, number>()
  /** `rows` x 256 RGBA8; re-upload when `version` changes. */
  data = new Uint8Array(0)
  version = 0

  get rows(): number {
    return this._rows.size
  }

  // Rows are never freed: a renderer sees a handful of colormaps.
  row(colormap: string): number {
    const key = colormapKey(colormap)
    let row = this._rows.get(key)
    if (row === undefined) {
      row = this._rows.size
      this._rows.set(key, row)
      const data = new Uint8Array((row + 1) * 1024)
      data.set(this.data)
      data.set(lutrgba8(colormap), row * 1024)
      this.data = data
      this.version++
    }
    return row
  }
}

/** One tile texture to fuse from `tile`. */
export interface FuseJob<T> {
  target: T
  /** The tile's `slideTileKey`. */
  key: string
  tile: FuseTile
  plan: FusePlan
}

/**
 * The tile texture for scalar tile `at` of `slide`, made by `create` and kept in
 * `cache` on first use; queued in `jobs` when new or its channels changed. A
 * tile showing label and intensity channels gets a second texture for the
 * labels (`create`'s `labels`), drawn nearest over the linear intensity; a
 * change between that and one texture remakes the entry. Null when the padded
 * tile exceeds `maxTexture` (samples are not scaled to fit as bitmaps are,
 * fitGutterSource) or the frame's texture budget: the tile is not drawn.
 */
export function fuseTarget<
  T extends { fused?: number; nearest?: boolean; labels?: unknown },
>(
  jobs: FuseJob<T>[],
  cache: TileTextureCache<T>,
  at: GutterAt,
  slide: NVSlide,
  tile: FuseTile,
  maxTexture: number,
  create: (width: number, height: number, labels: boolean) => T,
): T | null {
  const { width, height } = tile.samples
  let target = cache.get(at.key, tile.samples)
  if (target?.fused === slide.displayGeneration) return target
  const plan = fusePlan(
    slide.channels,
    slide.channelBlend,
    tile,
    slide.manifest.channelInfo,
    slide.selectedLabel,
  )
  const mixed = plan.layers.length > 0 && plan.labels.length > 0
  if (!target || (target.labels !== undefined) !== mixed) {
    const bytes = gutterTextureBytes(width, height) * (mixed ? 2 : 1)
    // A wrong-shape or stale entry is replaced: free it first so reserve does not count it.
    cache.delete(at.key)
    // Over the size limit, or the frame's texture budget (ENG-11): not drawn.
    if (Math.max(width, height) + 2 > maxTexture || !cache.reserve(bytes))
      return null
    target = create(width, height, mixed)
    cache.set(at.key, target, bytes, tile.samples)
  }
  target.fused = slide.displayGeneration
  // Labels only: drawn nearest, so magnified edges blend no colour.
  target.nearest = plan.layers.length === 0 && plan.labels.length > 0
  jobs.push({ target, key: at.key, tile, plan })
  return target
}

// Shared, so a slide without labels allocates nothing per tile.
const NONE: readonly [] = []

const layerKey = (key: string, plane: number): string => `${key}#${plane}`

/**
 * Fuse `jobs` through the raw-layer `pool`. Tiles whose layers are all pooled go
 * first, so the uploads for the rest evict layers already used this pass, not
 * ones still needed (with more tiles in view than the pool holds, a fixed
 * order would miss on every tile). After each tile its layers may be evicted
 * (`draw` has submitted): the pool never holds more than its budget plus one tile.
 */
export function fuseTiles<T, R>(
  jobs: readonly FuseJob<T>[],
  pool: TileTextureCache<R>,
  upload: (samples: NVSlideTileSamples, plane: number) => R,
  draw: (
    job: FuseJob<T>,
    layers: readonly [FuseLayer, R][],
    labels: readonly [FuseLabelLayer, R][],
  ) => void,
): void {
  const pooled = ({ key, tile, plan }: FuseJob<T>): boolean => {
    const hit = (l: { plane: number }) =>
      pool.get(layerKey(key, l.plane), tile.samples) !== undefined
    return plan.layers.every(hit) && plan.labels.every(hit)
  }
  const hits: FuseJob<T>[] = []
  const misses: FuseJob<T>[] = []
  for (const job of jobs) (pooled(job) ? hits : misses).push(job)
  for (const job of [...hits, ...misses]) {
    const s = job.tile.samples
    const bytes = s.samples.byteLength / (s.planes ?? 1)
    const raw = (plane: number): R => {
      const key = layerKey(job.key, plane)
      let r = pool.get(key, s)
      if (r === undefined) {
        // Evict earlier tiles' layers first; this tile's own always upload
        // (ponytail: a pool smaller than one tile overshoots by that tile).
        pool.reserve(bytes)
        r = upload(s, plane)
        pool.set(key, r, bytes, s)
      }
      return r
    }
    draw(
      job,
      job.plan.layers.map((l): [FuseLayer, R] => [l, raw(l.plane)]),
      job.plan.labels.length
        ? job.plan.labels.map((l): [FuseLabelLayer, R] => [l, raw(l.plane)])
        : NONE,
    )
    // A new pool frame: every layer, this tile's too, is evictable now.
    pool.beginFrame()
    pool.evictToBudget()
  }
}
