// Backend-neutral parts of drawing a slide, shared by the WebGL2 and WebGPU
// slide renderers (gl/slide.ts, wgpu/slide.ts).

import { timeChunkPhase } from '@/volume/chunkTiming'
import type {
  NVSlide,
  NVSlideCachedTile,
  NVSlideScreen,
  NVSlideVisibleTile,
} from './NVSlide'
import { type FuseTile, isFuseTile, tileTextureBudget } from './slideFuse'
import {
  cornerQuad,
  type SlidePlaneTile,
  slideExtentCorners,
} from './slidePlane'
import { type GutterAt, visibleTileAt } from './tileGutter'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  slideTileKey,
  type TileTextureCache,
} from './tileTextureCache'

/**
 * Tile texture bytes to evict to before a frame. While the frame fuses scalar
 * tiles or the raw pool holds layers, the pool's whole share is reserved, so
 * textures plus pool stay within 128 MiB even as the frame fills the pool;
 * RGB-only frames keep the whole budget.
 */
export const frameTextureBudget = (
  fuses: boolean,
  poolBytes: number,
  maxRawPoolBytes: number,
): number =>
  fuses || poolBytes > 0
    ? tileTextureBudget(maxRawPoolBytes)
    : DEFAULT_TILE_TEXTURE_BYTES

/**
 * One frame of 2D slide drawing, backend-neutral: `build` walks the slides
 * (requesting their visible tiles), and the renderer then uploads every entry
 * of `uploads`, flushes its fuses, and only then draws each slide in
 * `slides`: its background, then quads `[slideStart[i], slideEnd[i])`, the
 * coarser fallback levels first (coarsest first, painted UNDER the target
 * level while its tiles are still arriving, so the previous resolution stays
 * on screen), then the target tiles. Uploading before any draw lets an upload
 * refresh resident neighbours' gutters before those are drawn. Arrays are
 * reused frame to frame.
 */
export class SlideFramePlan {
  /** Slides drawn (visible, opacity > 0), in paint order. */
  readonly slides: NVSlide[] = []
  readonly slideStart: number[] = []
  readonly slideEnd: number[] = []
  /** Distinct cached tiles of the frame, one per (slide, key). */
  readonly uploads: NVSlideVisibleTile[] = []
  readonly uploadCached: NVSlideCachedTile[] = []
  readonly uploadAt: GutterAt[] = []
  /** Quads in paint order; `quadUpload` indexes `uploads`, -1 when uncached. */
  readonly quads: NVSlideVisibleTile[] = []
  readonly quadUpload: number[] = []
  readonly quadFallback: boolean[] = []
  /** Whether any upload is scalar (fused through the raw pool). */
  fuses = false
  // Key -> uploads index, per slide (keys repeat across slides).
  private readonly _seen = new Map<string, number>()

  build(slides: readonly NVSlide[], screen: NVSlideScreen): void {
    for (const a of [this.slides, this.slideStart, this.slideEnd]) a.length = 0
    this.uploads.length = this.uploadCached.length = this.uploadAt.length = 0
    this.quads.length = this.quadUpload.length = this.quadFallback.length = 0
    this.fuses = false
    for (const slide of slides) {
      if (!slide.visible || slide.opacity <= 0) continue
      this._seen.clear()
      this.slides.push(slide)
      this.slideStart.push(this.quads.length)
      const visible = slide.requestVisibleTiles(screen)
      // Only cached fallback tiles are drawn.
      for (const tile of visible.fallback) this._add(slide, tile, true, false)
      // A target tile without data draws a flat placeholder only when nothing
      // coarser is behind it, or it would hide the fallback standing in for it.
      const placeholders = visible.fallback.length === 0
      for (const tile of visible.tiles)
        this._add(slide, tile, false, placeholders)
      this.slideEnd.push(this.quads.length)
    }
  }

  private _add(
    slide: NVSlide,
    tile: NVSlideVisibleTile,
    isFallback: boolean,
    placeholder: boolean,
  ): void {
    let upload = this._seen.get(tile.key)
    if (upload === undefined) {
      const cached = slide.cachedTile(tile.key)
      if (!cached && !placeholder) return
      upload = -1
      if (cached) {
        upload = this.uploads.length
        this.uploads.push(tile)
        this.uploadCached.push(cached)
        this.uploadAt.push(visibleTileAt(tile))
        if (isFuseTile(cached)) this.fuses = true
      }
      this._seen.set(tile.key, upload)
    } else if (upload < 0 && !placeholder) return
    this.quads.push(tile)
    this.quadUpload.push(upload)
    this.quadFallback.push(isFallback)
  }
}

/**
 * The texture of each tile `cached[i]` (at `at[i]`; null when uncached) into
 * `out`, by `textureFor(i)`. Resident ones are marked used first, so an
 * upload's reserve never evicts a texture the frame draws (ENG-11).
 */
export function planTextures<T>(
  cache: TileTextureCache<T>,
  at: readonly GutterAt[],
  cached: readonly (NVSlideCachedTile | null)[],
  textureFor: (i: number) => T | null,
  out: (T | null)[],
): void {
  for (let i = 0; i < at.length; i++) {
    const c = cached[i]
    if (c) cache.touch((at[i] as GutterAt).key, c.samples ?? c.bitmap)
  }
  out.length = 0
  for (let i = 0; i < at.length; i++) out.push(cached[i] ? textureFor(i) : null)
}

/** What `tileTexture` needs of a backend's gutter (gl/, wgpu/ tileGutter.ts). */
export interface SlideTileGutter<T> {
  upload(
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<T>,
    sync?: boolean,
  ): T | null
  resync(cache: TileTextureCache<T>): void
}

/** What `tileTexture` needs of a backend's fuser (gl/, wgpu/ tileFuse.ts). */
export interface SlideTileFuser<T, G> {
  readonly poolBytes: number
  textureFor(
    gutter: G,
    cache: TileTextureCache<T>,
    at: GutterAt,
    slide: NVSlide,
    tile: FuseTile,
  ): T | null
  flush(gutter: G, cache: TileTextureCache<T>, sync: boolean): void
  retainLabelTables(slides: readonly NVSlide[]): void
}

/**
 * The texture of `cached` as tile `at`: fused (queued for the fuser's flush),
 * resident, or uploaded with its gutter synced unless `sync` is false (nearest
 * needs none; resync fills it). `timed` records the upload as the `upload`
 * chunk phase.
 */
export function tileTexture<T, G extends SlideTileGutter<T>>(
  fuser: SlideTileFuser<T, G>,
  gutter: G,
  cache: TileTextureCache<T>,
  at: GutterAt,
  slide: NVSlide,
  cached: NVSlideCachedTile,
  sync: boolean,
  timed: boolean,
): T | null {
  if (isFuseTile(cached))
    return fuser.textureFor(gutter, cache, at, slide, cached)
  const { bitmap } = cached
  if (!bitmap) return null
  // Keyed by the bitmap too: a refetched tile is a new bitmap (set() replaces).
  const existing = cache.get(at.key, bitmap)
  if (existing) return existing
  if (!timed) return gutter.upload(bitmap, at, cache, sync)
  // Timed as `upload` alongside the volume path's brick uploads: a slide tile
  // and a volume brick are two consumers of the same streamed source, and
  // both pay their texture cost on this thread.
  return timeChunkPhase(
    'upload',
    () => gutter.upload(bitmap, at, cache, sync),
    bitmap.width * bitmap.height * 4,
  )
}

/**
 * A 2D slide frame up to its first draw: prune label tables, plan the frame,
 * evict BEFORE beginFrame (so the previous frame's working set, still marked
 * with the current frame stamp, is exempt; see TileTextureCache), then upload
 * and fuse every planned tile into `out`. Nearest needs no gutter (the shader
 * clamps); resync fills it on the first linear frame.
 */
export function beginSlideFrame<T, G extends SlideTileGutter<T>>(
  plan: SlideFramePlan,
  slides: readonly NVSlide[],
  screen: NVSlideScreen,
  cache: TileTextureCache<T>,
  fuser: SlideTileFuser<T, G>,
  gutter: G,
  maxPoolBytes: number,
  nearest: boolean,
  out: (T | null)[],
): void {
  fuser.retainLabelTables(slides)
  plan.build(slides, screen)
  cache.evictToBudget(
    frameTextureBudget(plan.fuses, fuser.poolBytes, maxPoolBytes),
  )
  cache.beginFrame()
  if (!nearest) gutter.resync(cache)
  planTextures(
    cache,
    plan.uploadAt,
    plan.uploadCached,
    (i) =>
      tileTexture(
        fuser,
        gutter,
        cache,
        plan.uploadAt[i] as GutterAt,
        (plan.uploads[i] as NVSlideVisibleTile).slide,
        plan.uploadCached[i] as NVSlideCachedTile,
        !nearest,
        true,
      ),
    out,
  )
  fuser.flush(gutter, cache, !nearest)
}

/**
 * Write the interior UV span of visible tile `tile` to `out` at `o` as
 * u0, v0 (screen top), u1, v1 (screen bottom): its crop (`src`, see cropUv),
 * flipped for a y-up slide, whose quads show the tile bottom row on top.
 */
export function writeTileUv(
  tile: NVSlideVisibleTile,
  out: { [i: number]: number },
  o: number,
): void {
  const { width, height } = tile.tile
  const src = tile.src
  out[o] = src ? src.x / width : 0
  out[o + 2] = src ? (src.x + src.w) / width : 1
  const top = src ? src.y / height : 0
  const bottom = src ? (src.y + src.h) / height : 1
  out[o + 1] = tile.flipY ? bottom : top
  out[o + 3] = tile.flipY ? top : bottom
}

/**
 * Write the clip-space corners x0, y0, x1, y1 of the screen rect (y down)
 * `x, y, w, h` on a `width` x `height` target to `out` at `o`; false (nothing
 * written) when the rect is empty or entirely off the target.
 */
export function writeRectNdc(
  x: number,
  y: number,
  w: number,
  h: number,
  width: number,
  height: number,
  out: { [i: number]: number },
  o: number,
): boolean {
  if (w <= 0 || h <= 0 || x + w < 0 || y + h < 0 || x > width || y > height)
    return false
  out[o] = (x / width) * 2 - 1
  out[o + 1] = 1 - (y / height) * 2
  out[o + 2] = ((x + w) / width) * 2 - 1
  out[o + 3] = 1 - ((y + h) / height) * 2
  return true
}

/**
 * Interior UV span [u0, v0, u1, v1] of a tile `width` x `height` drawn with
 * crop `src` (tile px, fractions allowed); [0, 0, 1, 1] without one.
 */
export function cropUv(
  { width, height }: { width: number; height: number },
  src?: NVSlideVisibleTile['src'],
): [number, number, number, number] {
  if (!src) return [0, 0, 1, 1]
  return [
    src.x / width,
    src.y / height,
    (src.x + src.w) / width,
    (src.y + src.h) / height,
  ]
}

/** Whether `a` and `b` hold the same plane tiles in the same order. */
export function sameTiles(
  a: readonly SlidePlaneTile[],
  b: readonly SlidePlaneTile[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Plane tile `tile`'s quad (its crop), inset for a `gutter`-sized texture. */
export const planeQuad = (
  tile: SlidePlaneTile,
  gutter?: { width: number; height: number },
): Float32Array<ArrayBuffer> =>
  cornerQuad(tile.corners, gutter, cropUv(tile, tile.src))

/**
 * The cache entry and gutter position of each plane tile of `slide` into
 * `cached` and `ats` (positions memoized per tile in `atOf`); true when any
 * tile fuses.
 */
export function gatherPlaneTiles(
  slide: NVSlide,
  tiles: readonly SlidePlaneTile[],
  atOf: WeakMap<SlidePlaneTile, GutterAt>,
  cached: (NVSlideCachedTile | null)[],
  ats: GutterAt[],
): boolean {
  cached.length = ats.length = 0
  let fuses = false
  for (const tile of tiles) {
    const c = slide.cachedTile(tile.key)
    if (c && isFuseTile(c)) fuses = true
    cached.push(c)
    let at = atOf.get(tile)
    if (!at) {
      at = { ...tile, slide, key: slideTileKey(slide, tile.key) }
      atOf.set(tile, at)
    }
    ats.push(at)
  }
  return fuses
}

// Interleaved [pos.xyz, uv.xy]: 5 floats a vertex, 20 a quad.
export const PLANE_QUAD_FLOATS = 20

/**
 * One vertex buffer's data for a plane tile set: the slide extent quad (with
 * `pixelToWorld`; zeros otherwise), then every tile. `insets` gets the size
 * each tile's UVs were inset for.
 */
export function planeVertices(
  tiles: readonly SlidePlaneTile[],
  slide: NVSlide,
  pixelToWorld: readonly number[] | undefined,
  insets: { width: number; height: number }[],
): Float32Array<ArrayBuffer> {
  const data = new Float32Array((tiles.length + 1) * PLANE_QUAD_FLOATS)
  if (pixelToWorld) {
    const { width, height } = slide.manifest
    data.set(cornerQuad(slideExtentCorners(pixelToWorld, width, height)))
  }
  insets.length = 0
  tiles.forEach((tile, i) => {
    data.set(planeQuad(tile, tile), (i + 1) * PLANE_QUAD_FLOATS)
    insets.push(tile)
  })
  return data
}
