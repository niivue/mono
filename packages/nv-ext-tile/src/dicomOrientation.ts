// DICOM-WSI ImageOrientationSlide (0048,0102): the displayed frame is the
// Reference Slide Orientation (label edge up, PS3.3 C.8.12.2.1) turned so the
// label is on the left, the usual landscape view. Slide +X then points up and
// +Y left, so 0\-1\0\-1\0\0, which every scanner in the corpus writes for its
// pyramid, is the identity and such slides show as stored.
import type {
  NVSlideLevelPlacement,
  NVSlideTileManifest,
  NVSlideTileOrientation,
} from '@niivue/niivue'
import { type SlideIndexLevel, tileMap } from './dicomIndex'

// Cosines are DS text: allow rounding, not obliquity.
const TOLERANCE = 1e-3

type Grid = Pick<
  SlideIndexLevel,
  'width' | 'height' | 'tileWidth' | 'tileHeight' | 'columns' | 'rows'
>

/**
 * The tile orientation for ImageOrientationSlide `cosines`: undefined when
 * absent or the identity; null when oblique, which the caller warns and shows
 * as stored (never snapped to a right angle).
 */
export function slideOrientation(
  cosines: readonly number[] | undefined,
): NVSlideTileOrientation | null | undefined {
  if (!cosines) return undefined
  const [rx = 0, ry = 0, rz = 0, cx = 0, cy = 0, cz = 0] = cosines
  // Displayed (u, v) = (-slide Y, -slide X).
  const [ru, rv, cu, cv] = [-ry, -rx, -cy, -cx]
  const near = (a: number, b: number) => Math.abs(a - b) < TOLERANCE
  const axis = (a: number, b: number, z: number) =>
    near(z, 0) &&
    ((near(Math.abs(a), 1) && near(b, 0)) ||
      (near(a, 0) && near(Math.abs(b), 1)))
  if (!(axis(ru, rv, rz) && axis(cu, cv, cz) && near(ru * cu + rv * cv, 0)))
    return null
  // Transposed: stored columns run down the display, stored rows across it.
  const transpose = !near(rv, 0)
  const o = transpose
    ? { transpose, flipX: cu < 0, flipY: rv < 0 }
    : { transpose, flipX: ru < 0, flipY: cv < 0 }
  return o.transpose || o.flipX || o.flipY ? o : undefined
}

/** `level`'s grid as displayed under `o`. */
export function orientGrid<G extends Grid>(
  level: G,
  o: NVSlideTileOrientation | undefined,
): Grid {
  if (!o?.transpose) return level
  return {
    width: level.height,
    height: level.width,
    tileWidth: level.tileHeight,
    tileHeight: level.tileWidth,
    columns: level.rows,
    rows: level.columns,
  }
}

/**
 * Each level's {@link tileMap}, laid out over the displayed grid: entry
 * y * columns + x is the frame slot of displayed tile (x, y).
 */
export function levelMaps(slide: {
  imageOrientationSlide?: number[]
  levels: (Grid & Parameters<typeof tileMap>[0])[]
}): Int32Array[] {
  const o = slideOrientation(slide.imageOrientationSlide) ?? undefined
  return slide.levels.map((level) => {
    const map = tileMap(level)
    if (!o) return map
    const g = orientGrid(level, o)
    const out = new Int32Array(map.length)
    for (let y = 0; y < g.rows; y++)
      for (let x = 0; x < g.columns; x++) {
        const u = o.flipX ? g.columns - 1 - x : x
        const v = o.flipY ? g.rows - 1 - y : y
        out[y * g.columns + x] = map[
          o.transpose ? u * level.columns + v : v * level.columns + u
        ] as number
      }
    return out
  })
}

/** Displayed tile (x, y)'s extent: a flipped axis keeps the stored padding, which then leads. */
export function tileExtent(
  g: Grid,
  o: NVSlideTileOrientation | undefined,
  x: number,
  y: number,
): { width: number; height: number } {
  return {
    width: o?.flipX
      ? g.tileWidth
      : Math.min(g.tileWidth, g.width - x * g.tileWidth),
    height: o?.flipY
      ? g.tileHeight
      : Math.min(g.tileHeight, g.height - y * g.tileHeight),
  }
}

/**
 * Placement for a flipped level: the leading padding of the first column/row
 * is cropped and every tile shifts back by it. Undefined without a flip (the
 * displayed grid is regular).
 */
export function flipPlacement(
  g: Grid,
  o: NVSlideTileOrientation | undefined,
  tiles: readonly (NVSlideTileManifest | null)[],
): NVSlideLevelPlacement | undefined {
  if (!o?.flipX && !o?.flipY) return undefined
  const padX = o.flipX ? g.columns * g.tileWidth - g.width : 0
  const padY = o.flipY ? g.rows * g.tileHeight - g.height : 0
  const pieces = []
  for (const [tile, t] of tiles.entries()) {
    if (!t) continue
    const sx = t.x === 0 ? padX : 0
    const sy = t.y === 0 ? padY : 0
    pieces.push({
      tile,
      sx,
      sy,
      sw: t.width - sx,
      sh: t.height - sy,
      dx: t.x * g.tileWidth - padX + sx,
      dy: t.y * g.tileHeight - padY + sy,
    })
  }
  return { width: g.width, height: g.height, pieces }
}
