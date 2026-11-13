// Placed-tile engine (contracts section 7): a level whose storage tiles are
// drawn as cropped pieces at irregular origins (vendor joints, overlaps). A CSR
// bucket grid over the placed extent answers rect and point queries; the
// walks mirror tilesForLevel / slidePlaneTiles for pieces.

import { log } from '@/logger'
import type {
  NVSlide,
  NVSlideLevelManifest,
  NVSlideLevelPlacement,
  NVSlideManifest,
  NVSlidePlacedPiece,
  NVSlideScreen,
  NVSlideTileManifest,
  NVSlideViewport,
  NVSlideVisibleTile,
} from './NVSlide'
// slideLod imports this module: use its values inside functions only.
import {
  centredBlock,
  clamp,
  levelTileHeight,
  levelTileWidth,
  MAX_VISIBLE_TILES,
  tileSpan,
} from './slideLod'
import type { SlidePlaneTile, Vec3 } from './slidePlane'
import { MAX_SLIDE_GRID } from './slideSource'
import {
  EDGE_ALL,
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
} from './tileGutter'

// A crop within this of the tile edge shows the edge texel, so its gutter is sampled.
const EDGE_TEXEL = 0.5
// Rounding slack: 2^-k scaled producers are exact, others may be off by ulps.
const EPS = 1e-3

export interface PlacementIndex {
  level: NVSlideLevelManifest
  placement: NVSlideLevelPlacement
  /** Base px per placed level px. */
  dsX: number
  dsY: number
  /** `level` with the placed extent and the cell grid: tileSpan over cells. */
  cells: NVSlideLevelManifest
  cellWidth: number
  cellHeight: number
  /** CSR: pieces of cell c are cellPieces[cellStart[c] .. cellStart[c+1]). */
  cellStart: Uint32Array
  cellPieces: Uint32Array
  /** De-duplication: piece i was visited by the current query when stamp[i] === frame. */
  stamp: Uint32Array
  frame: number
  /** Per storage tile (row-major), EDGE_* bits. */
  edges: Uint8Array
}

function invalid(level: NVSlideLevelManifest, why: string): null {
  log.warn(`Slide level ${level.index} placement ${why}; drawn as a grid`)
  return null
}

const touches = (
  p: NVSlidePlacedPiece,
  tile: NVSlideTileManifest,
  ux: number,
  uy: number,
): boolean =>
  ux < 0
    ? p.sx <= EDGE_TEXEL
    : ux > 0
      ? p.sx + p.sw >= tile.width - EDGE_TEXEL
      : uy < 0
        ? p.sy <= EDGE_TEXEL
        : p.sy + p.sh >= tile.height - EDGE_TEXEL

// Cells covering [lo, hi), clamped: pieces may sit up to 1 px outside the extent.
const firstCell = (lo: number, size: number, n: number): number =>
  clamp(Math.floor(lo / size), 0, n - 1)
const lastCell = (hi: number, size: number, n: number): number =>
  clamp(Math.ceil(hi / size) - 1, 0, n - 1)

const SIDES = [
  [EDGE_LEFT, -1, 0],
  [EDGE_RIGHT, 1, 0],
  [EDGE_TOP, 0, -1],
  [EDGE_BOTTOM, 0, 1],
] as const

/**
 * The placed-piece index of `level`, or null without placement (silently) or
 * with an invalid one (one warning; callers draw the grid). Never throws.
 */
export function buildPlacementIndex(
  manifest: NVSlideManifest,
  level: NVSlideLevelManifest,
): PlacementIndex | null {
  const placement = level.placement
  if (!placement) return null
  const { pieces, width, height } = placement
  if (pieces.length > MAX_SLIDE_GRID)
    return invalid(level, `has over ${MAX_SLIDE_GRID} pieces`)
  const cellWidth = levelTileWidth(manifest, level)
  const cellHeight = levelTileHeight(manifest, level)
  const cellColumns = Math.ceil(width / cellWidth)
  const cellRows = Math.ceil(height / cellHeight)
  if (!(cellColumns * cellRows <= MAX_SLIDE_GRID && width > 0 && height > 0))
    return invalid(level, `extent ${width} x ${height} is invalid`)
  for (const p of pieces) {
    const tile = level.tiles[p.tile]
    // Positive form: NaN fails.
    if (
      !(
        tile &&
        p.sx >= 0 &&
        p.sy >= 0 &&
        p.sw >= 0 &&
        p.sh >= 0 &&
        p.sx + p.sw <= tile.width + EPS &&
        p.sy + p.sh <= tile.height + EPS
      )
    )
      return invalid(level, `piece of tile ${p.tile} is outside the grid`)
    if (
      !(
        p.dx >= -1 &&
        p.dy >= -1 &&
        p.dx + p.sw <= width + 1 &&
        p.dy + p.sh <= height + 1
      )
    )
      return invalid(level, `piece of tile ${p.tile} is outside the extent`)
  }
  const cellStart = new Uint32Array(cellColumns * cellRows + 1)
  let cellPieces = new Uint32Array(0)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i] as NVSlidePlacedPiece
      const x0 = firstCell(p.dx, cellWidth, cellColumns)
      const x1 = lastCell(p.dx + p.sw, cellWidth, cellColumns)
      const y0 = firstCell(p.dy, cellHeight, cellRows)
      const y1 = lastCell(p.dy + p.sh, cellHeight, cellRows)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const c = y * cellColumns + x
          // Pass 0 counts into c + 1; pass 1 fills from the prefix sums.
          if (pass) cellPieces[cellStart[c]++] = i
          else cellStart[c + 1]++
        }
    }
    if (!pass) {
      for (let c = 1; c < cellStart.length; c++)
        cellStart[c] += cellStart[c - 1] as number
      cellPieces = new Uint32Array(cellStart[cellStart.length - 1] as number)
    } else {
      // Filling advanced each start to the next cell's: shift back.
      cellStart.copyWithin(1, 0, cellStart.length - 1)
      cellStart[0] = 0
    }
  }
  const index: PlacementIndex = {
    level,
    placement,
    dsX: manifest.width / width,
    dsY: manifest.height / height,
    cells: { ...level, width, height, columns: cellColumns, rows: cellRows },
    cellWidth,
    cellHeight,
    cellStart,
    cellPieces,
    stamp: new Uint32Array(pieces.length),
    frame: 0,
    edges: new Uint8Array(level.columns * level.rows),
  }
  buildEdges(index)
  return index
}
// Low nibble: a piece touches that side; high nibble: one of them has no
// abutting piece in the grid neighbour. Bit = touched and all abut.
function buildEdges(index: PlacementIndex): void {
  const { level, edges, cellWidth: tw, cellHeight: th } = index
  const { pieces } = index.placement
  for (const p of pieces) {
    const tile = level.tiles[p.tile] as NVSlideTileManifest
    const ox = p.dx - p.sx
    const oy = p.dy - p.sy
    for (const [bit, ux, uy] of SIDES) {
      const col = tile.x + ux
      const row = tile.y + uy
      if (col < 0 || row < 0 || col >= level.columns || row >= level.rows)
        continue
      if (!touches(p, tile, ux, uy)) continue
      const n = row * level.columns + col
      const nx = ox + ux * tw
      const ny = oy + uy * th
      let abuts = false
      const line = ux ? (ux > 0 ? nx : ox) : uy > 0 ? ny : oy
      const [x0, x1] = ux ? [line - 1, line + 1] : [p.dx, p.dx + p.sw]
      const [y0, y1] = uy ? [line - 1, line + 1] : [p.dy, p.dy + p.sh]
      visitPieces(index, x0, y0, x1, y1, (q) => {
        abuts ||=
          q.tile === n &&
          Math.abs(q.dx - q.sx - nx) < EPS &&
          Math.abs(q.dy - q.sy - ny) < EPS &&
          touches(q, level.tiles[n] as NVSlideTileManifest, -ux, -uy)
      })
      edges[p.tile] |= abuts ? bit : bit | (bit << 4)
    }
  }
  for (let t = 0; t < edges.length; t++) {
    const e = edges[t] as number
    edges[t] = e & ~(e >> 4) & EDGE_ALL
  }
}

/**
 * Call `visit` once for each piece intersecting the half-open placed-level
 * rect [x0, x1) x [y0, y1). Queries share one stamp: do not nest them.
 */
export function visitPieces(
  index: PlacementIndex,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (piece: NVSlidePlacedPiece, i: number) => void,
): void {
  const { cells, cellWidth, cellHeight, cellStart, cellPieces, stamp } = index
  const { pieces } = index.placement
  // ponytail: wraps after 2^32 queries; the reset keeps stale stamps from matching.
  let frame = (index.frame + 1) >>> 0
  if (!frame) {
    stamp.fill(0)
    frame = 1
  }
  index.frame = frame
  const cx0 = firstCell(x0, cellWidth, cells.columns)
  const cx1 = lastCell(x1, cellWidth, cells.columns)
  const cy0 = firstCell(y0, cellHeight, cells.rows)
  const cy1 = lastCell(y1, cellHeight, cells.rows)
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * cells.columns + cx
      const end = cellStart[c + 1] as number
      for (let k = cellStart[c] as number; k < end; k++) {
        const i = cellPieces[k] as number
        if (stamp[i] === frame) continue
        stamp[i] = frame
        const p = pieces[i] as NVSlidePlacedPiece
        if (p.dx < x1 && p.dx + p.sw > x0 && p.dy < y1 && p.dy + p.sh > y0)
          visit(p, i)
      }
    }
}

const ordered: number[] = []
let keptStamp = new Uint32Array(0)
let keptWalk = 0

/**
 * As visitPieces, in manifest order: draw collectors stack overlapping pieces
 * as `pieceAt` and the thumbnail do (last wins), whatever the viewport.
 */
export function visitPiecesInOrder(
  index: PlacementIndex,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (piece: NVSlidePlacedPiece) => void,
): void {
  ordered.length = 0
  visitPieces(index, x0, y0, x1, y1, (_p, i) => ordered.push(i))
  ordered.sort((a, b) => a - b)
  const { pieces } = index.placement
  for (const i of ordered) visit(pieces[i] as NVSlidePlacedPiece)
}

/** Pieces intersecting the placed-level rect (see visitPieces). */
export function countPieces(
  index: PlacementIndex,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let count = 0
  visitPieces(index, x0, y0, x1, y1, () => count++)
  return count
}

/**
 * The piece covering placed-level point x, y, its tile and the tile-local
 * pixel (as NVSlide._tileUnder); null over a gap. The last listed piece wins
 * where pieces overlap.
 */
export function pieceAt(
  index: PlacementIndex,
  x: number,
  y: number,
): {
  piece: NVSlidePlacedPiece
  tile: NVSlideTileManifest
  px: number
  py: number
} | null {
  const { cells, cellWidth, cellHeight, cellStart, cellPieces } = index
  const cx = Math.floor(x / cellWidth)
  const cy = Math.floor(y / cellHeight)
  if (cx < 0 || cy < 0 || cx >= cells.columns || cy >= cells.rows) return null
  const c = cy * cells.columns + cx
  let hit: NVSlidePlacedPiece | null = null
  for (let k = cellStart[c] as number; k < (cellStart[c + 1] as number); k++) {
    const p = index.placement.pieces[cellPieces[k] as number]
    if (p && p.dx <= x && x < p.dx + p.sw && p.dy <= y && y < p.dy + p.sh)
      hit = p
  }
  if (!hit) return null
  return {
    piece: hit,
    tile: index.level.tiles[hit.tile] as NVSlideTileManifest,
    px: Math.floor(hit.sx + x - hit.dx),
    py: Math.floor(hit.sy + y - hit.dy),
  }
}

/**
 * The view in placed level px and tileSpan over the index's cells. `count` is
 * the cells in view, O(1) like the grid's tile count: about the tile textures
 * the view needs, since a cell holds about one storage tile of pixels.
 * countPieces gives the exact piece count.
 */
export function placedSpan(
  manifest: NVSlideManifest,
  viewport: NVSlideViewport,
  index: PlacementIndex,
  screen: NVSlideScreen,
) {
  const span = tileSpan(manifest, viewport, index.cells, screen)
  const x0 = span.viewLeft / span.dsX
  const y0 = span.viewTop / span.dsY
  const x1 = x0 + screen.widthCss / (viewport.scale * span.dsX)
  const y1 = span.viewBottom / span.dsY
  return { span, x0, y0, x1, y1, count: span.count }
}

/**
 * The pieces of a placed level covering the viewport, as tilesForLevel does
 * for the grid: one entry per piece (a tile with two pieces repeats its key),
 * `src` its crop. Over `limit`, the centred cell block nearest the view
 * centre, capped at `limit` entries.
 */
export function placedTiles(
  slide: NVSlide,
  index: PlacementIndex,
  screen: NVSlideScreen,
  limit = MAX_VISIBLE_TILES,
): NVSlideVisibleTile[] {
  const { level, cellWidth, cellHeight } = index
  const dpr = screen.devicePixelRatio ?? 1
  const { span, count, ...view } = placedSpan(
    slide.manifest,
    slide.viewport,
    index,
    screen,
  )
  let { x0, y0, x1, y1 } = view
  if (count > limit) {
    // The grid's centred block of `limit` cells.
    const { firstX, lastX, firstY, lastY } = centredBlock(span, limit)
    x0 = Math.max(x0, firstX * cellWidth)
    y0 = Math.max(y0, firstY * cellHeight)
    x1 = Math.min(x1, (lastX + 1) * cellWidth)
    y1 = Math.min(y1, (lastY + 1) * cellHeight)
  }
  const { dsX, dsY, viewLeft, viewTop, viewBottom } = span
  const screenScale = slide.viewport.scale * dpr
  const flipY = slide.isYAxisUp()
  const tiles: NVSlideVisibleTile[] = []
  // `limit` caps tiles (textures), not pieces: an iScan level holds thousands
  // of few-px frames per tile. Past it, new tiles drop in manifest order.
  // A tile is kept when its stamp is this walk's (no per-walk allocation).
  if (keptStamp.length < level.tiles.length)
    keptStamp = new Uint32Array(level.tiles.length)
  const walk = ++keptWalk
  let kept = 0
  visitPiecesInOrder(index, x0, y0, x1, y1, (p) => {
    if (keptStamp[p.tile] !== walk) {
      if (kept >= limit) return
      keptStamp[p.tile] = walk
      kept++
    }
    const tile = level.tiles[p.tile] as NVSlideTileManifest
    const baseX = p.dx * dsX
    const baseY = p.dy * dsY
    const baseHeight = p.sh * dsY
    tiles.push({
      slide,
      level,
      tile,
      key: slide.tileKey(level, tile),
      screenX: (baseX - viewLeft) * screenScale,
      screenY: flipY
        ? (viewBottom - (baseY + baseHeight)) * screenScale
        : (baseY - viewTop) * screenScale,
      screenWidth: p.sw * dsX * screenScale,
      screenHeight: baseHeight * screenScale,
      flipY,
      src: { x: p.sx, y: p.sy, w: p.sw, h: p.sh },
    })
  })
  return tiles
}

/**
 * Every piece of a placed level as a world-space quad via `pixelToWorld`
 * (column-major 4x4, base px -> mm), as slidePlaneTiles does for the grid.
 */
export function placedPlaneTiles(
  slide: NVSlide,
  index: PlacementIndex,
  pixelToWorld: readonly number[],
): SlidePlaneTile[] {
  const { level, placement } = index
  // From the slide, as placedTiles (tileSpan) does.
  const dsX = slide.manifest.width / placement.width
  const dsY = slide.manifest.height / placement.height
  const m = pixelToWorld
  const apply = (px: number, py: number): Vec3 => [
    (m[0] as number) * px + (m[4] as number) * py + (m[12] as number),
    (m[1] as number) * px + (m[5] as number) * py + (m[13] as number),
    (m[2] as number) * px + (m[6] as number) * py + (m[14] as number),
  ]
  return index.placement.pieces.map((p) => {
    const tile = level.tiles[p.tile] as NVSlideTileManifest
    const x0 = p.dx * dsX
    const y0 = p.dy * dsY
    const x1 = (p.dx + p.sw) * dsX
    const y1 = (p.dy + p.sh) * dsY
    return {
      key: slide.tileKey(level, tile),
      level,
      tile,
      col: tile.x,
      row: tile.y,
      width: tile.width,
      height: tile.height,
      src: { x: p.sx, y: p.sy, w: p.sw, h: p.sh },
      corners: [apply(x0, y0), apply(x1, y0), apply(x0, y1), apply(x1, y1)],
    }
  })
}
