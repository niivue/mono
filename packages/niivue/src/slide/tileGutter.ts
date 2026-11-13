// Backend-neutral planning of the 1-texel tile gutter shared by the slide
// renderers (gl/ and wgpu/ slide.ts, slidePlaneRender.ts).
//
// Each tile is its own texture, so bilinear filtering cannot see the
// neighbouring tile: clamp-to-edge leaves a one-source-texel seam at every
// tile border when magnified. A tile is therefore uploaded into a texture 2
// texels larger per axis whose border holds the adjacent texels of its 8
// neighbours (a clamped copy of its own edge while a neighbour is absent), and
// the renderers sample only the interior. The border copies run on the GPU
// from the neighbours' textures, so no decoded CPU bytes are kept: an upload
// fills its own border (8 copies) and refreshes the slots of resident
// neighbours that now read from it (at most 16), so borders converge as tiles
// stream and a frame without uploads does no gutter work. Under nearest
// filtering the shaders clamp to the edge texels, so uploads skip the copies
// and the first linear frame after refills every resident border once.

import { log } from '@/logger'
import type {
  NVSlideLevelManifest,
  NVSlideTileManifest,
  NVSlideVisibleTile,
} from './NVSlide'
import { slideTileKey, type TileTextureCache } from './tileTextureCache'

/** Interior size of a tile texture (the bitmap size). */
export interface GutterTile {
  width: number
  height: number
}

/** Edge-mask bits: the grid neighbour on that side is also the placed neighbour. */
export const EDGE_LEFT = 1
export const EDGE_RIGHT = 2
export const EDGE_TOP = 4
export const EDGE_BOTTOM = 8
export const EDGE_ALL = 15

/** The key producer of a slide (NVSlide.tileKey). */
interface GutterSlide {
  tileKey(level: NVSlideLevelManifest, tile: { x: number; y: number }): string
  /**
   * EDGE_* bits: the grid neighbour on that side is also the placed neighbour
   * (slidePlacement). Absent: all set.
   */
  tileEdges?(level: NVSlideLevelManifest, col: number, row: number): number
}

/**
 * Where a tile goes: its cache key (`slideTileKey`), grid position, level and
 * slide, whose `tileKey` names the neighbours.
 */
export interface GutterAt {
  slide: GutterSlide
  key: string
  level: NVSlideLevelManifest
  col: number
  row: number
}

/** The texture-cache key of a grid cell `col`, `row`. */
export type GutterKeyAt = (col: number, row: number) => string

/** Neighbour keys of a tile at `at`, from its slide's key producer. */
const gutterKeyAt =
  ({ slide, level }: Pick<GutterAt, 'slide' | 'level'>): GutterKeyAt =>
  (x, y) =>
    slideTileKey(slide, slide.tileKey(level, { x, y }))

/** Edge bits of grid cell `col`, `row` (GutterSlide.tileEdges). */
export type GutterEdgesAt = (col: number, row: number) => number

/** Edge bits of the tiles at `at`; undefined (all set) for a grid slide. */
export function gutterEdgesAt({
  slide,
  level,
}: Pick<GutterAt, 'slide' | 'level'>): GutterEdgesAt | undefined {
  const { tileEdges } = slide
  return tileEdges && ((x, y) => tileEdges.call(slide, level, x, y))
}

// Edge bits of the neighbour at offset (sx, sy); a diagonal needs both sides.
const edgeBits = (sx: number, sy: number): number =>
  (sx < 0 ? EDGE_LEFT : sx > 0 ? EDGE_RIGHT : 0) |
  (sy < 0 ? EDGE_TOP : sy > 0 ? EDGE_BOTTOM : 0)

// Per manifest tile, so a steady view builds no key or object per frame. The
// level check catches a level object replaced around shared tiles.
const tileAts = new WeakMap<NVSlideTileManifest, GutterAt>()

/** Where visible tile `item` of the 2D view goes. */
export function visibleTileAt(item: NVSlideVisibleTile): GutterAt {
  let at = tileAts.get(item.tile)
  if (!at || at.level !== item.level || at.slide !== item.slide) {
    at = {
      slide: item.slide,
      key: slideTileKey(item.slide, item.key),
      level: item.level,
      col: item.tile.x,
      row: item.tile.y,
    }
    tileAts.set(item.tile, at)
  }
  return at
}

/**
 * Copy `width` x `height` texels from (srcX, srcY) of a padded source texture
 * to (x, y) of the padded destination.
 */
export interface GutterCopy {
  x: number
  y: number
  srcX: number
  srcY: number
  width: number
  height: number
}

const NEIGHBOURS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

// Bitmaps that could not be scaled: retrying every frame would fail again.
const unscalable = new WeakSet<ImageBitmap>()

/**
 * `bitmap`, scaled down per axis when its padded texture would exceed
 * `maxTexture` (the renderers stretch the interior over the tile's quad).
 * Null when it needs scaling and there is no 2D context: the renderers then
 * draw the tile's placeholder, never a blank tile, and the frame goes on.
 */
export function fitGutterSource(
  bitmap: ImageBitmap,
  maxTexture: number,
): ImageBitmap | OffscreenCanvas | null {
  const width = Math.min(bitmap.width, maxTexture - 2)
  const height = Math.min(bitmap.height, maxTexture - 2)
  if (width === bitmap.width && height === bitmap.height) return bitmap
  if (unscalable.has(bitmap)) return null
  // Safari before 16.4 has WebGL2 but no OffscreenCanvas.
  const canvas =
    typeof OffscreenCanvas === 'undefined'
      ? null
      : new OffscreenCanvas(width, height)
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) {
    unscalable.add(bitmap)
    log.warn('No 2D context to scale an oversize slide tile')
    return null
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

/** GPU bytes of a w x h tile texture with its gutter. */
export function gutterTextureBytes(width: number, height: number): number {
  return (width + 2) * (height + 2) * 4
}

// [destination, source, length] along one axis, in padded texels: from the
// adjacent edge of a neighbour of `neighbourSize`, else a clamped own edge.
function gutterAxis(
  d: number,
  size: number,
  neighbourSize: number | undefined,
): [number, number, number] {
  if (d < 0) return [0, neighbourSize ?? 1, 1]
  if (d > 0) return [size + 1, neighbourSize === undefined ? size : 1, 1]
  return [1, 1, size]
}

/**
 * Fill border slot (dx, dy) of `tile` (at `col`, `row`) from the nearest
 * resident source: for an edge the neighbour, for a corner the diagonal, then
 * the edge neighbour beside it (clamped along the other axis, as at the slide
 * edge), else the tile's own edge. With `only`, copies only when that is the
 * source or was skipped for the source used. A neighbour whose shared edge differs in length (a decoded tile
 * smaller than its grid cell) is skipped, so no copy reads past its edge.
 */
function fillSlot<T extends GutterTile>(
  keyAt: GutterKeyAt,
  col: number,
  row: number,
  tile: T,
  dx: number,
  dy: number,
  neighbour: (key: string) => T | undefined,
  copy: (src: T | null, dst: T, c: GutterCopy) => void,
  edges: number,
  only?: T,
): void {
  const sources = dx && dy ? [dx, dy, dx, 0, 0, dy, 0, 0] : [dx, dy, 0, 0]
  // Sources after `only` (even one skipped for its size) now feed the slot.
  let pending = only
  for (let i = 0; i < sources.length; i += 2) {
    const sx = sources[i] as number
    const sy = sources[i + 1] as number
    // Not the placed neighbour (an overlap seam): fall back toward the own edge.
    const bits = edgeBits(sx, sy)
    if ((edges & bits) !== bits) continue
    const src = sx || sy ? neighbour(keyAt(col + sx, row + sy)) : tile
    if (!src) continue
    if (src === pending) pending = undefined
    if (
      (sx && !sy && src.height !== tile.height) ||
      (sy && !sx && src.width !== tile.width)
    )
      continue
    if (pending) return
    const [x, srcX, width] = gutterAxis(
      dx,
      tile.width,
      sx ? src.width : undefined,
    )
    const [y, srcY, height] = gutterAxis(
      dy,
      tile.height,
      sy ? src.height : undefined,
    )
    copy(src === tile ? null : src, tile, { x, y, srcX, srcY, width, height })
    return
  }
}

/** Looks a tile texture up by its cache key, without marking it used. */
function slideNeighbour<T>(
  cache: TileTextureCache<T>,
): (key: string) => T | undefined {
  return (key) => cache.peek(key)
}

/**
 * Fill the 8 border slots of `tile` (grid cell `col`, `row`; `keyAt` names
 * cells) from its resident neighbours. `neighbour` looks a key up; `copy`
 * records one copy into `dst`, where a null `src` means `dst`'s own edge.
 * `edgesAt` (gutterEdgesAt) clamps sides whose grid neighbour is not placed
 * next to the tile.
 */
export function fillGutter<T extends GutterTile>(
  keyAt: GutterKeyAt,
  col: number,
  row: number,
  tile: T,
  neighbour: (key: string) => T | undefined,
  copy: (src: T | null, dst: T, c: GutterCopy) => void,
  edgesAt?: GutterEdgesAt,
): void {
  const edges = edgesAt ? edgesAt(col, row) : EDGE_ALL
  for (const [dx, dy] of NEIGHBOURS)
    fillSlot(keyAt, col, row, tile, dx, dy, neighbour, copy, edges)
}

/**
 * Fill the gutter of `tile` (just uploaded and already returned by
 * `neighbour`) and refresh the slots of resident neighbours that now read
 * from it. Arguments as for `fillGutter`.
 */
export function syncGutters<T extends GutterTile>(
  keyAt: GutterKeyAt,
  col: number,
  row: number,
  tile: T,
  neighbour: (key: string) => T | undefined,
  copy: (src: T | null, dst: T, c: GutterCopy) => void,
  edgesAt?: GutterEdgesAt,
): void {
  fillGutter(keyAt, col, row, tile, neighbour, copy, edgesAt)
  for (const [ox, oy] of NEIGHBOURS) {
    const n = neighbour(keyAt(col + ox, row + oy))
    if (!n) continue
    const edges = edgesAt ? edgesAt(col + ox, row + oy) : EDGE_ALL
    // Slots of n that can read this tile, at offset (-ox, -oy) from n.
    for (const [dx, dy] of NEIGHBOURS)
      if ((dx === -ox && (dy === -oy || oy === 0)) || (ox === 0 && dy === -oy))
        fillSlot(
          keyAt,
          col + ox,
          row + oy,
          n,
          dx,
          dy,
          neighbour,
          copy,
          edges,
          tile,
        )
  }
}

/**
 * A slide tile texture of backend texture type `Tex`: `width` x `height`
 * interior plus a 1-texel gutter, at tile `col`, `row` of level `level`.
 */
export type TileTexture<Tex> = {
  texture: Tex
  width: number
  height: number
  slide: GutterSlide
  level: NVSlideLevelManifest
  col: number
  row: number
  /** A fused scalar tile: the slide's displayGeneration it was fused for. */
  fused?: number
  /** Draw with nearest filtering (a fused tile of label channels only). */
  nearest?: boolean
  /**
   * A fused tile's label channels when it also shows intensity channels: no
   * gutter, read nearest and combined with `texture` as the channel blend.
   */
  labels?: Tex
}

/** One gutter copy into `dst`; a null `src` is `dst`'s own edge. */
export type GutterCopyOf<Tex> = [
  src: TileTexture<Tex> | null,
  dst: TileTexture<Tex>,
  c: GutterCopy,
]

/** The gutter bookkeeping both backends share; a subclass runs the copies. */
export abstract class TileGutterBase<Tex> {
  // An upload skipped its gutter copies since the last resync.
  private _stale = false

  protected abstract _copy(copies: GutterCopyOf<Tex>[]): void

  /**
   * Fill the gutters of `tiles` (already in `cache`) and refresh the resident
   * neighbours' slots that read from them; with `sync` false, defer to `resync`.
   */
  sync(
    tiles: readonly TileTexture<Tex>[],
    cache: TileTextureCache<TileTexture<Tex>>,
    sync = true,
  ): void {
    if (!sync) {
      this._stale ||= tiles.length > 0
      return
    }
    const copies: GutterCopyOf<Tex>[] = []
    for (const t of tiles)
      syncGutters(
        gutterKeyAt(t),
        t.col,
        t.row,
        t,
        slideNeighbour(cache),
        (...c) => copies.push(c),
        gutterEdgesAt(t),
      )
    if (copies.length) this._copy(copies)
  }

  /** Refill every resident tile's gutter if an upload skipped its own. */
  resync(cache: TileTextureCache<TileTexture<Tex>>): void {
    if (!this._stale) return
    this._stale = false
    const copies: GutterCopyOf<Tex>[] = []
    for (const t of cache.values())
      fillGutter(
        gutterKeyAt(t),
        t.col,
        t.row,
        t,
        slideNeighbour(cache),
        (...c) => copies.push(c),
        gutterEdgesAt(t),
      )
    this._copy(copies)
  }

  destroy(): void {
    this._stale = false
  }
}
