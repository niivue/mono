// Backend-neutral half of the fuse pass (#159), shared by the slide renderers
// (gl/ and wgpu/ tileFuse.ts). A scalar tile keeps its samples on the CPU and
// one RGBA8 texture on the GPU, the only thing drawn. When the tile arrives, or
// a channel's window, colormap or visibility or the blend changes, the fuse
// pass renders into that texture: one quad per visible channel, raw sample ->
// window -> colormap row, combined by MAX or a saturating sum, exactly as
// fuseSamples does on the CPU. Raw layers stay in a small LRU pool so a W/L
// drag re-fuses without re-uploading.

import { colormapKey, lutrgba8 } from '@/cmap/NVCmaps'
import type {
  NVChannel,
  NVSlide,
  NVSlideCachedTile,
  NVSlideChannelBlend,
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

export interface FusePlan {
  layers: FuseLayer[]
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

/** The visible channels of `tile` under the slide's channel state. */
export function fusePlan(
  channels: readonly NVChannel[],
  blend: NVSlideChannelBlend,
  { samples: s, channels: held, level }: FuseTile,
): FusePlan {
  const range = storedRange(s.samples, level.bitsStored ?? s.bitsStored)
  const layers: FuseLayer[] = []
  for (let plane = 0; plane < (s.planes ?? 1); plane++) {
    const ch = channels[held ? (held[plane] as number) : plane]
    if (ch?.visible)
      layers.push({ plane, colormap: ch.colormap, ...resolveWindow(ch, range) })
  }
  return {
    layers,
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
    // up; NaN (a float sample) falls through to 0.
    const at = (i: number): number => {
      const x = (((samples[base + i] as number) - calMin) * 255) / width
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
  return out
}

/**
 * A layer's fuse-shader uniforms: calMin as a float32 head and its remainder,
 * calMax - calMin, LUT row, invert. Rounding calMin or calMax to float32 alone
 * shifts a narrow window at large values (float32 ulp at 1e8 is 8); the shaders
 * subtract head then remainder, and the width is taken in float64.
 */
export function fuseUniforms(
  { calMin, calMax }: FuseLayer,
  row: number,
  invert: boolean,
): [number, number, number, number, number] {
  const head = Math.fround(calMin)
  return [head, calMax - calMin, row, invert ? 1 : 0, calMin - head]
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
 * `cache` on first use; queued in `jobs` when new or its channels changed. Null
 * when the padded tile exceeds `maxTexture`: samples are not scaled to fit as
 * bitmaps are (fitGutterSource), so the tile draws as its placeholder.
 */
export function fuseTarget<T extends { fused?: number }>(
  jobs: FuseJob<T>[],
  cache: TileTextureCache<T>,
  at: GutterAt,
  slide: NVSlide,
  tile: FuseTile,
  maxTexture: number,
  create: (width: number, height: number) => T,
): T | null {
  const { width, height } = tile.samples
  let target = cache.get(at.key, tile.samples)
  if (!target) {
    if (Math.max(width, height) + 2 > maxTexture) return null
    target = create(width, height)
    cache.set(at.key, target, gutterTextureBytes(width, height), tile.samples)
  }
  if (target.fused !== slide.displayGeneration) {
    target.fused = slide.displayGeneration
    const plan = fusePlan(slide.channels, slide.channelBlend, tile)
    jobs.push({ target, key: at.key, tile, plan })
  }
  return target
}

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
  draw: (job: FuseJob<T>, layers: readonly [FuseLayer, R][]) => void,
): void {
  const pooled = (job: FuseJob<T>): boolean =>
    job.plan.layers.every(
      (l) =>
        pool.get(layerKey(job.key, l.plane), job.tile.samples) !== undefined,
    )
  const hits: FuseJob<T>[] = []
  const misses: FuseJob<T>[] = []
  for (const job of jobs) (pooled(job) ? hits : misses).push(job)
  for (const job of [...hits, ...misses]) {
    const s = job.tile.samples
    const bytes = s.samples.byteLength / (s.planes ?? 1)
    const layers = job.plan.layers.map((l): [FuseLayer, R] => {
      const key = layerKey(job.key, l.plane)
      let raw = pool.get(key, s)
      if (raw === undefined) {
        raw = upload(s, l.plane)
        pool.set(key, raw, bytes, s)
      }
      return [l, raw]
    })
    draw(job, layers)
    // A new pool frame: every layer, this tile's too, is evictable now.
    pool.beginFrame()
    pool.evictToBudget()
  }
}
