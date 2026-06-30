import type { NVSlide, NVSlideLevelManifest } from './NVSlide'

// Geometry for rendering an NVSlide as a flat plane in a volume's 3D world space.
// Each slide tile is mapped from base (level-0) pixel coordinates to world mm via
// a `pixelToWorld` transform, yielding a quad the 3D renderer can draw (textured
// with that tile's bitmap from NVSlide's cache) and depth-composite with a volume.
// This leverages NVSlide's level selection, tile model, and tile cache; only the
// 2D->3D placement is new.

export type Vec3 = [number, number, number]

export interface SlidePlaneTile {
  /** Cache key matching NVSlide.tileKey: `L<index>/<x>/<y>`. */
  key: string
  /** Tile grid column / row in its level. */
  col: number
  row: number
  /** World-mm quad corners: top-left, top-right, bottom-left, bottom-right
   * (in base-pixel order before transform). */
  corners: [Vec3, Vec3, Vec3, Vec3]
}

// Apply a column-major 4x4 transform to a slide-pixel point (z = 0 plane).
function apply(m: readonly number[], px: number, py: number): Vec3 {
  return [
    m[0] * px + m[4] * py + m[12],
    m[1] * px + m[5] * py + m[13],
    m[2] * px + m[6] * py + m[14],
  ]
}

/**
 * Map every tile of `level` to a world-space quad via `pixelToWorld` (column-major
 * 4x4, slide base pixels -> world mm). Mirrors NVSlide.visibleTiles' base-pixel
 * math (tile.x * tileWidth * downsample), so a tile's plane position lines up with
 * its 2D position. The renderer draws each quad with the tile's cached bitmap.
 */
export function slidePlaneTiles(
  level: NVSlideLevelManifest,
  tileWidth: number,
  tileHeight: number,
  pixelToWorld: readonly number[],
): SlidePlaneTile[] {
  const out: SlidePlaneTile[] = []
  for (const tile of level.tiles) {
    const baseX = tile.x * tileWidth * level.downsample
    const baseY = tile.y * tileHeight * level.downsample
    const baseW = tile.width * level.downsample
    const baseH = tile.height * level.downsample
    out.push({
      key: `L${level.index}/${tile.x}/${tile.y}`,
      col: tile.x,
      row: tile.y,
      corners: [
        apply(pixelToWorld, baseX, baseY),
        apply(pixelToWorld, baseX + baseW, baseY),
        apply(pixelToWorld, baseX, baseY + baseH),
        apply(pixelToWorld, baseX + baseW, baseY + baseH),
      ],
    })
  }
  return out
}

/**
 * A slide registered into a volume's 3D world space, ready for the renderer to
 * draw as a textured plane. `tiles` are the world-mm quads (from
 * `slidePlaneTiles`); the renderer pulls each tile's bitmap from `slide`'s cache
 * (`cachedTileBitmap`) by its `key`, so streaming and level selection stay in NVSlide.
 */
export interface SlidePlaneState {
  slide: NVSlide
  level: NVSlideLevelManifest
  tiles: SlidePlaneTile[]
}

export interface AxialPlaneOptions {
  /** World mm extents the slide should span. */
  xmin: number
  xmax: number
  ymin: number
  ymax: number
  /** World mm depth (slice position) of the plane. */
  z: number
  /** Flip the slide Y so its top maps to ymax (image rows go top->down). */
  flipY?: boolean
}

/**
 * Build a `pixelToWorld` (column-major 4x4) that lays a `width` x `height` slide
 * onto an axis-aligned plane spanning [xmin,xmax] x [ymin,ymax] at depth z — e.g.
 * an axial plane centred in an MNI152 volume. Maps base pixel (0,0)->(xmin, yTop)
 * and (width,height)->(xmax, yBottom).
 */
export function axialPlaneTransform(
  width: number,
  height: number,
  opts: AxialPlaneOptions,
): number[] {
  const sx = (opts.xmax - opts.xmin) / Math.max(1, width)
  const flip = opts.flipY ?? true
  // flipY: row 0 (top) -> ymax, row height -> ymin.
  const sy =
    (flip ? -(opts.ymax - opts.ymin) : opts.ymax - opts.ymin) /
    Math.max(1, height)
  const ty = flip ? opts.ymax : opts.ymin
  // Column-major: columns = X', Y', Z', translation.
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, opts.xmin, ty, opts.z, 1]
}
