import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { log } from '@/logger'
import {
  NVSlide,
  type NVSlideLevelManifest,
  type NVSlideManifest,
  type NVSlidePlacedPiece,
  type NVSlideTileManifest,
} from '@/slide/NVSlide'
import {
  buildPlacementIndex,
  countPieces,
  type PlacementIndex,
  pieceAt,
  placedPlaneTiles,
  placedTiles,
  visitPieces,
  visitPiecesInOrder,
} from '@/slide/slidePlacement'
import { MAX_SLIDE_GRID } from '@/slide/slideSource'
import {
  EDGE_ALL,
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
} from '@/slide/tileGutter'

// A storage level of `width` x `height` px in `tile` px tiles (edge tiles clipped).
function storageLevel(
  width: number,
  height: number,
  tile: number,
  downsample = 1,
): NVSlideLevelManifest {
  const columns = Math.ceil(width / tile)
  const rows = Math.ceil(height / tile)
  const tiles: NVSlideTileManifest[] = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++)
      tiles.push({
        x,
        y,
        width: Math.min(tile, width - x * tile),
        height: Math.min(tile, height - y * tile),
      })
  return {
    ...{ index: 0, width, height, downsample, columns, rows },
    ...{ tileWidth: tile, tileHeight: tile, tiles },
  }
}

const manifestOf = (
  level: NVSlideLevelManifest,
  width: number,
  height: number,
): NVSlideManifest => ({
  ...{ id: 'placed', name: 'placed', width, height },
  ...{ dtype: 'uint8', channels: 'encoded-rgb', levels: [level] },
})

interface AxisPiece {
  t: number
  s: number
  w: number
  d: number
}

// One axis of the synthetic producer (our reading of the Ventana spec): frames
// of `frame` px, `overlapLeft(c)` level-0 px shared by frames c-1 and c, split
// at the seam midpoint; frames between overlap seams merge into one run. At
// scale `f` (2^-k, unstitched lower levels) runs are split at `tile` boundaries.
function axisPieces(
  frames: number,
  frame: number,
  tile: number,
  overlapLeft: (c: number) => number,
  f: number,
): { pieces: AxisPiece[]; extent: number } {
  const pieces: AxisPiece[] = []
  let origin = 0 // placed level-0 origin of frame c
  let runStart = 0
  let runOrigin = 0
  for (let c = 0; c < frames; c++) {
    if (c) origin += frame - overlapLeft(c)
    if (c && overlapLeft(c)) {
      runStart = frame * c + overlapLeft(c) / 2
      runOrigin = origin + overlapLeft(c) / 2
    }
    const right = c + 1 < frames ? overlapLeft(c + 1) : 0
    if (c + 1 < frames && !right) continue
    const S = runStart * f
    const E = (frame * (c + 1) - right / 2) * f
    for (let t = Math.floor(S / tile); t * tile < E; t++) {
      const lo = Math.max(S, t * tile)
      const hi = Math.min(E, (t + 1) * tile)
      pieces.push({
        t,
        s: lo - t * tile,
        w: hi - lo,
        d: runOrigin * f + lo - S,
      })
    }
  }
  return { pieces, extent: (origin + frame) * f }
}

interface Layout {
  frame: number
  tile: number
  cols: number
  rows: number
  storageCols: number
  storageRows: number
  overlapX: (c: number) => number
  k?: number
}

function produce(o: Layout) {
  const f = 2 ** -(o.k ?? 0)
  const x = axisPieces(o.cols, o.frame, o.tile, o.overlapX, f)
  const y = axisPieces(o.rows, o.frame, o.tile, () => 0, f)
  const level = storageLevel(
    o.storageCols * o.frame * f,
    o.storageRows * o.frame * f,
    o.tile,
    1 / f,
  )
  const pieces: NVSlidePlacedPiece[] = []
  for (const py of y.pieces)
    for (const px of x.pieces)
      pieces.push({
        tile: py.t * level.columns + px.t,
        ...{ sx: px.s, sy: py.s, sw: px.w, sh: py.w, dx: px.d, dy: py.d },
      })
  level.placement = { width: x.extent, height: y.extent, pieces }
  return level
}

const VENTANA: Layout = {
  ...{ frame: 1024, tile: 1024, cols: 23, rows: 21 },
  ...{ storageCols: 24, storageRows: 21 },
  overlapX: (c) => (c % 4 === 0 ? 24 : 0),
}

const indexOf = (
  level: NVSlideLevelManifest,
  manifest = manifestOf(
    level,
    level.placement?.width ?? 0,
    level.placement?.height ?? 0,
  ),
): PlacementIndex => {
  const index = buildPlacementIndex(manifest, level)
  expect(index).not.toBeNull()
  return index as PlacementIndex
}

const pick = (p: NVSlidePlacedPiece) => [p.sx, p.sw, p.dx]

afterEach(() => {
  ;(log.warn as { mockRestore?: () => void }).mockRestore?.()
})

describe('buildPlacementIndex', () => {
  test('PL1: no placement is null, silently', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const level = storageLevel(64, 64, 16)
    expect(buildPlacementIndex(manifestOf(level, 64, 64), level)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  test('F23: invalid placements warn once and fall back (null)', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const base = produce({ ...VENTANA, k: 6 })
    const placement = base.placement as NonNullable<typeof base.placement>
    const piece = placement.pieces[0] as NVSlidePlacedPiece
    const cases: NVSlidePlacedPiece[][] = [
      [{ ...piece, tile: base.tiles.length }],
      [{ ...piece, tile: -1 }],
      [{ ...piece, sw: (base.tiles[0]?.width ?? 0) + 1 }],
      [{ ...piece, sx: Number.NaN }],
      [{ ...piece, dx: placement.width - piece.sw + 1.01 }],
      [{ ...piece, dy: -1.01 }],
    ]
    for (const pieces of cases) {
      warn.mockClear()
      const level = { ...base, placement: { ...placement, pieces } }
      expect(buildPlacementIndex(manifestOf(level, 1, 1), level)).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    }
    // 1 px outside the extent is still valid.
    const edge = { ...piece, dx: placement.width - piece.sw + 1 }
    const ok = { ...base, placement: { ...placement, pieces: [edge] } }
    warn.mockClear()
    expect(buildPlacementIndex(manifestOf(ok, 1, 1), ok)).not.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    // Too many pieces: rejected before any allocation.
    const many = { length: MAX_SLIDE_GRID + 1 } as NVSlidePlacedPiece[]
    const big = { ...base, placement: { ...placement, pieces: many } }
    expect(buildPlacementIndex(manifestOf(big, 1, 1), big)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('placed pieces', () => {
  test('PL2: a 4 px overlap at seam 1|2 gives width 44, x 14 = frame 2 col 2', () => {
    const level = produce({
      ...{ frame: 16, tile: 16, cols: 3, rows: 1, storageCols: 3 },
      ...{ storageRows: 1, overlapX: (c: number) => (c === 1 ? 4 : 0) },
    })
    expect(level.placement?.width).toBe(44)
    expect(level.placement?.pieces.map((p) => [p.tile, ...pick(p)])).toEqual([
      [0, 0, 14, 0],
      [1, 2, 14, 14],
      [2, 0, 16, 28],
    ])
    const index = indexOf(level)
    for (let x = 0; x < 14; x++)
      expect(pieceAt(index, x + 0.5, 3)).toMatchObject({
        tile: { x: 0 },
        px: x,
        py: 3,
      })
    expect(pieceAt(index, 14, 0)).toMatchObject({ tile: { x: 1 }, px: 2 })
    expect(pieceAt(index, 44, 0)).toBeNull()
  })

  test('PL3: a seam inside a tile walks as 2 entries with one key; 1.5 px overlap crops 0.75', () => {
    const level = produce({
      ...{ frame: 8, tile: 16, cols: 4, rows: 2, storageCols: 4 },
      ...{ storageRows: 2, overlapX: (c: number) => (c === 1 ? 1.5 : 0) },
    })
    const placement = level.placement as NonNullable<typeof level.placement>
    expect(placement.width).toBe(30.5)
    const slide = new NVSlide(
      manifestOf(level, placement.width, placement.height),
    )
    slide.viewport = { centerX: 15.25, centerY: 8, scale: 2 }
    const index = indexOf(level)
    const tiles = placedTiles(slide, index, { widthCss: 61, heightCss: 32 })
    expect(tiles.map((t) => [t.key, t.src, t.screenX, t.screenWidth])).toEqual([
      [
        slide.tileKey(level, { x: 0, y: 0 }),
        { x: 0, y: 0, w: 7.25, h: 16 },
        0,
        14.5,
      ],
      [
        slide.tileKey(level, { x: 0, y: 0 }),
        { x: 8.75, y: 0, w: 7.25, h: 16 },
        14.5,
        14.5,
      ],
      [
        slide.tileKey(level, { x: 1, y: 0 }),
        { x: 0, y: 0, w: 16, h: 16 },
        29,
        32,
      ],
    ])
    // The crop is the half overlap on both sides of the seam.
    expect(8 - 7.25).toBe(0.75)
    expect(tiles[1]?.src?.x).toBe(8 + 0.75)
  })

  test('the walk honours limit with the centred block', () => {
    const level = produce({
      ...{ frame: 16, tile: 16, cols: 20, rows: 20, storageCols: 20 },
      ...{ storageRows: 20, overlapX: () => 0 },
    })
    const slide = new NVSlide(manifestOf(level, 320, 320))
    slide.viewport = { centerX: 160, centerY: 160, scale: 1 }
    const screen = { widthCss: 320, heightCss: 320 }
    const index = indexOf(level)
    expect(placedTiles(slide, index, screen)).toHaveLength(400)
    const near = placedTiles(slide, index, screen, 4)
    expect(near.map((t) => [t.tile.x, t.tile.y])).toEqual([
      [9, 9],
      [10, 9],
      [9, 10],
      [10, 10],
    ])
    // flipY mirrors screenY as the grid walk does.
    const upSlide = new NVSlide({
      ...manifestOf(level, 320, 320),
      displayYAxis: 'up',
    })
    upSlide.viewport = slide.viewport
    const up = placedTiles(upSlide, index, screen, 4)
    expect(up[0]?.flipY).toBe(true)
    // Tile (9,9) spans base y 144-160; viewBottom 320.
    expect(up[0]?.screenY).toBe(320 - 160)
  })

  test('3D: one quad per piece through pixelToWorld, src set', () => {
    const level = produce({ ...VENTANA, k: 3 })
    const manifest = manifestOf(level, 23432, 21504)
    const index = indexOf(level, manifest)
    const slide = new NVSlide(manifest)
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 11, 1]
    const quads = placedPlaneTiles(slide, index, m)
    expect(quads).toHaveLength(index.placement.pieces.length)
    const q = quads[1]
    // Piece 2 of tile (0,0) at L3: dx 510.5, sw 509, base = level px * 8.
    expect(q?.src).toEqual({ x: 513.5, y: 0, w: 509, h: 1024 })
    expect(q?.corners[0]).toEqual([5 + 2 * 510.5 * 8, 7, 11])
    expect(q?.corners[3]).toEqual([5 + 2 * 1019.5 * 8, 7 + 3 * 1024 * 8, 11])
    expect(q?.key).toBe(slide.tileKey(level, { x: 0, y: 0 }))
  })

  test('PL8: rect queries over 10k random pieces match brute force', () => {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const level = storageLevel(64 * 100, 64 * 100, 64)
    const width = 6400
    const pieces: NVSlidePlacedPiece[] = []
    for (let i = 0; i < 10000; i++) {
      const sw = rand() * 64
      const sh = rand() * 64
      const sx = rand() * (64 - sw)
      const sy = rand() * (64 - sh)
      pieces.push({
        tile: Math.floor(rand() * level.tiles.length),
        ...{ sx, sy, sw, sh },
        dx: -1 + rand() * (width + 2 - sw),
        dy: -1 + rand() * (width + 2 - sh),
      })
    }
    level.placement = { width, height: width, pieces }
    const index = indexOf(level)
    for (let q = 0; q < 200; q++) {
      const x0 = -100 + rand() * (width + 200)
      const y0 = -100 + rand() * (width + 200)
      const x1 = x0 + rand() * (q % 10 ? 300 : 3000)
      const y1 = y0 + rand() * (q % 10 ? 300 : 3000)
      const got: NVSlidePlacedPiece[] = []
      visitPieces(index, x0, y0, x1, y1, (p) => got.push(p))
      const want = pieces.filter(
        (p) => p.dx < x1 && p.dx + p.sw > x0 && p.dy < y1 && p.dy + p.sh > y0,
      )
      expect(new Set(got).size).toBe(got.length)
      expect(new Set(got)).toEqual(new Set(want))
      expect(countPieces(index, x0, y0, x1, y1)).toBe(want.length)
    }
  })
})

describe('Ventana vectors', () => {
  test('V8: L3 pieces of storage tiles (0,r) and (1,r)', () => {
    const level = produce({ ...VENTANA, k: 3 })
    const pieces = level.placement?.pieces ?? []
    const row = 1
    const ofTile = (x: number) =>
      pieces.filter((p) => p.tile === row * level.columns + x).map(pick)
    expect(ofTile(0)).toEqual([
      [0, 510.5, 0],
      [513.5, 509, 510.5],
    ])
    expect(ofTile(1)[0]).toEqual([1.5, 509, 1019.5])
    expect(1019.5).toBe((8192 - 48) / 8 + 1.5)
  })

  test('V10/PL5: placed extent per level, column 23 never placed, no duplicated strip', () => {
    for (let k = 0; k <= 7; k++) {
      const f = 2 ** -k
      const level = produce({ ...VENTANA, k })
      const index = indexOf(level)
      const { width, height, pieces } = index.placement
      expect([width, height]).toEqual([23432 * f, 21504 * f])
      let area = 0
      for (const p of pieces) {
        const tile = level.tiles[p.tile] as NVSlideTileManifest
        // Storage x of the piece stays left of column 23.
        expect(tile.x * 1024 + p.sx + p.sw).toBeLessThanOrEqual(23 * 1024 * f)
        area += p.sw * p.sh
        // No two pieces overlap in placed space.
        visitPieces(index, p.dx, p.dy, p.dx + p.sw, p.dy + p.sh, (q) => {
          if (q === p) return
          const ox = Math.min(p.dx + p.sw, q.dx + q.sw) - Math.max(p.dx, q.dx)
          const oy = Math.min(p.dy + p.sh, q.dy + q.sh) - Math.max(p.dy, q.dy)
          expect(Math.min(ox, oy)).toBeLessThanOrEqual(1e-9)
        })
      }
      // Non-overlapping pieces whose area equals the extent tile it exactly.
      expect(area).toBeCloseTo(width * height, 3)
    }
    const l0 = produce(VENTANA)
    expect(l0.placement?.pieces.some((p) => p.tile % 24 === 23)).toBe(false)
  })
})

describe('edge mask', () => {
  test('grid-abutting neighbours set the bit; slide border and gaps clear it', () => {
    const level = produce({
      ...{ frame: 16, tile: 16, cols: 3, rows: 3, storageCols: 3 },
      ...{ storageRows: 3, overlapX: () => 0 },
    })
    const { edges } = indexOf(level)
    expect(edges[4]).toBe(EDGE_ALL)
    expect(edges[0]).toBe(EDGE_RIGHT | EDGE_BOTTOM)
    expect(edges[8]).toBe(EDGE_LEFT | EDGE_TOP)
  })

  test('Ventana L0: overlap seams and the unplaced column clear the bit', () => {
    const level = produce(VENTANA)
    const { edges } = indexOf(level)
    const at = (c: number, r: number) => edges[r * 24 + c] as number
    expect(at(3, 9) & EDGE_RIGHT).toBe(0)
    expect(at(4, 9) & EDGE_LEFT).toBe(0)
    expect(at(4, 9) & EDGE_RIGHT).toBe(EDGE_RIGHT)
    expect(at(5, 9)).toBe(EDGE_ALL)
    expect(at(22, 9) & EDGE_RIGHT).toBe(0)
    expect(at(23, 9)).toBe(0)
  })

  test('an overlap under 1 texel touches both edges but still clears the bit', () => {
    const level = produce({
      ...{ frame: 16, tile: 16, cols: 2, rows: 1, storageCols: 2 },
      ...{ storageRows: 1, overlapX: (c: number) => (c === 1 ? 0.8 : 0) },
    })
    const round = (v: number) => Math.round(v * 1e9) / 1e9
    expect(level.placement?.pieces.map((p) => pick(p).map(round))).toEqual([
      [0, 15.6, 0],
      [0.4, 15.6, 15.6],
    ])
    const { edges } = indexOf(level)
    expect(edges[0]).toBe(0)
    expect(edges[1]).toBe(0)
  })
})

describe('overlapping pieces', () => {
  test('draw in manifest order whatever the viewport, as readout stacks them', () => {
    const level = storageLevel(32, 16, 16)
    level.placement = {
      width: 32,
      height: 16,
      pieces: [
        { tile: 0, sx: 0, sy: 0, sw: 8, sh: 16, dx: 16, dy: 0 },
        { tile: 1, sx: 0, sy: 0, sw: 16, sh: 16, dx: 8, dy: 0 },
      ],
    }
    const index = buildPlacementIndex(
      manifestOf(level, 32, 16),
      level,
    ) as PlacementIndex
    const order = (x0: number, x1: number) => {
      const out: number[] = []
      visitPiecesInOrder(index, x0, 0, x1, 16, (p) => out.push(p.tile))
      return out
    }
    expect(order(0, 32)).toEqual([0, 1])
    expect(order(16, 24)).toEqual([0, 1])
    // The last drawn piece is the one readout picks.
    expect(pieceAt(index, 20, 8)?.piece.tile).toBe(1)
  })
})
