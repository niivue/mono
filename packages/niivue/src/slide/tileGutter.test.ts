import { describe, expect, test } from 'bun:test'
import {
  fillGutter,
  fitGutterSource,
  type GutterCopy,
  syncGutters,
} from '@/slide/tileGutter'

// A CPU stand-in for a padded tile texture: one value per texel.
interface Tex {
  width: number
  height: number
  texels: Float32Array
}

// A 3x2 tile grid of 4x3 tiles whose last column is 2 wide: a 10x6 image
// whose texel (x, y) holds 100 * y + x.
const COLS = [4, 4, 2]
const ROWS = [3, 3]
const value = (x: number, y: number): number => 100 * y + x

function copyTexels(src: Tex | null, dst: Tex, c: GutterCopy): void {
  const from = src ?? dst
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      dst.texels[(c.y + y) * (dst.width + 2) + c.x + x] = from.texels[
        (c.srcY + y) * (from.width + 2) + c.srcX + x
      ] as number
}

// Uploads tiles in `order`; the first `synced` (all by default) sync gutters.
function uploadAll(
  order: [number, number][],
  textures = new Map<string, Tex>(),
  synced = order.length,
): Map<string, Tex> {
  for (const [i, [col, row]] of order.entries()) {
    const width = COLS[col] as number
    const height = ROWS[row] as number
    const tex: Tex = {
      width,
      height,
      texels: new Float32Array((width + 2) * (height + 2)),
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        tex.texels[(y + 1) * (width + 2) + x + 1] = value(
          4 * col + x,
          3 * row + y,
        )
    textures.set(`L0/${col}/${row}`, tex)
    if (i < synced)
      syncGutters(0, col, row, tex, (key) => textures.get(key), copyTexels)
  }
  return textures
}

// Every padded texel must hold the image texel it stands for, clamped at the
// image edge: what one big texture with clamp-to-edge would sample.
function expectSeamless(textures: Map<string, Tex>): void {
  for (const [key, tex] of textures) {
    const [col, row] = key.split('/').slice(1).map(Number) as [number, number]
    for (let y = 0; y < tex.height + 2; y++)
      for (let x = 0; x < tex.width + 2; x++) {
        const ix = Math.min(Math.max(4 * col + x - 1, 0), 9)
        const iy = Math.min(Math.max(3 * row + y - 1, 0), 5)
        expect([key, x, y, tex.texels[y * (tex.width + 2) + x]]).toEqual([
          key,
          x,
          y,
          value(ix, iy),
        ])
      }
  }
}

const GRID: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [1, 1],
  [2, 1],
]

describe('syncGutters', () => {
  test('borders hold the neighbours texels, in any upload order', () => {
    expectSeamless(uploadAll(GRID))
    expectSeamless(uploadAll([...GRID].reverse()))
    // Centre-out, then a corner last: every tile meets late neighbours.
    expectSeamless(
      uploadAll([GRID[4], GRID[1], GRID[0], GRID[5], GRID[3], GRID[2]] as [
        number,
        number,
      ][]),
    )
  })

  test('fillGutter on every tile repairs uploads that skipped the sync', () => {
    // Half synced, half not (nearest), then the linear resync.
    const textures = uploadAll(GRID, new Map(), 3)
    for (const [key, tex] of textures) {
      const [col, row] = key.split('/').slice(1).map(Number) as [number, number]
      fillGutter(0, col, row, tex, (k) => textures.get(k), copyTexels)
    }
    expectSeamless(textures)
  })

  test('an absent neighbour leaves a clamped copy of the own edge', () => {
    const tex = uploadAll([[1, 0]]).get('L0/1/0') as Tex
    // Left border = own first column, top-left corner = own first texel.
    expect(tex.texels[1 * 6]).toBe(value(4, 0))
    expect(tex.texels[0]).toBe(value(4, 0))
    expect(tex.texels[6 + 5]).toBe(value(7, 0))
  })

  test('copies only the slots that read the new tile', () => {
    const textures = uploadAll(GRID.filter(([c, r]) => c !== 1 || r !== 0))
    const tex = { width: 4, height: 3, texels: new Float32Array(42) }
    textures.set('L0/1/0', tex)
    const copies: string[] = []
    syncGutters(
      0,
      1,
      0,
      tex,
      (key) => textures.get(key),
      (src, dst, c) =>
        copies.push(
          `${src === null ? 'self' : 'n'}>${dst === tex ? 'own' : 'n'} ${c.x},${c.y}`,
        ),
    )
    // 8 own slots; only the top edge is the tile's own (no row above), its
    // top corners clamp from the left and right neighbours.
    expect(copies.filter((c) => c.includes('>own'))).toHaveLength(8)
    expect(copies.filter((c) => c.startsWith('self'))).toHaveLength(1)
    // Pushes: left and right neighbours' facing edge and top corner (no
    // diagonal above), the three tiles below one slot each.
    expect(copies.filter((c) => c.includes('>n '))).toHaveLength(7)
  })

  test('a neighbour with a shorter shared edge is never read past its edge', () => {
    // A 2x3 tile above a 4x3 tile in the same column, plus a short 4x1 tile
    // to the right of the lower one: decoded tiles smaller than their cells.
    const tiles = new Map<string, { width: number; height: number }>([
      ['L0/0/0', { width: 2, height: 3 }],
      ['L0/0/1', { width: 4, height: 3 }],
      ['L0/1/1', { width: 4, height: 1 }],
    ])
    for (const [key, tile] of tiles) {
      const [col, row] = key.split('/').slice(1).map(Number) as [number, number]
      syncGutters(
        0,
        col,
        row,
        tile,
        (k) => tiles.get(k),
        (src, dst, c) => {
          const from = src ?? dst
          expect(c.srcX + c.width).toBeLessThanOrEqual(from.width + 2)
          expect(c.srcY + c.height).toBeLessThanOrEqual(from.height + 2)
          expect(c.x + c.width).toBeLessThanOrEqual(dst.width + 2)
          expect(c.y + c.height).toBeLessThanOrEqual(dst.height + 2)
        },
      )
    }
  })

  test('replacing a tile with a smaller one refreshes neighbours that skip it', () => {
    // Texels are numbered per tile, so a stale copy is visible.
    type T = { width: number; height: number; texels: Float32Array; id: number }
    const make = (width: number, height: number, id: number): T => {
      const t = {
        width,
        height,
        id,
        texels: new Float32Array((width + 2) * (height + 2)),
      }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          t.texels[(y + 1) * (width + 2) + x + 1] = id * 1000 + 10 * y + x
      return t
    }
    const tiles = new Map<string, T>()
    const upload = (key: string, col: number, row: number, t: T): void => {
      tiles.set(key, t)
      syncGutters(
        0,
        col,
        row,
        t,
        (k) => tiles.get(k),
        (src, dst, c) => {
          const from = src ?? dst
          for (let y = 0; y < c.height; y++)
            for (let x = 0; x < c.width; x++)
              dst.texels[(c.y + y) * (dst.width + 2) + c.x + x] = from.texels[
                (c.srcY + y) * (from.width + 2) + c.srcX + x
              ] as number
        },
      )
    }
    upload('L0/0/1', 0, 1, make(4, 3, 2))
    upload('L0/0/0', 0, 0, make(4, 3, 1))
    const below = tiles.get('L0/0/1') as T
    // Top border of the lower tile reads the upper tile's last row.
    expect(below.texels[1]).toBe(1000 + 20)
    upload('L0/0/0', 0, 0, make(2, 3, 3))
    // Now a clamped copy of its own first row, not the old upper tile.
    expect(Array.from(below.texels.subarray(0, 6))).toEqual([
      2000, 2000, 2001, 2002, 2003, 2003,
    ])
  })
})

describe('fitGutterSource', () => {
  test('scales a bitmap down so the padded texture fits the limit', () => {
    const drawn: number[][] = []
    let has2d = true
    let canvases = 0
    const original = globalThis.OffscreenCanvas
    globalThis.OffscreenCanvas = class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        canvases++
      }
      getContext() {
        return (
          has2d && {
            drawImage: (_b: unknown, ...args: number[]) => drawn.push(args),
          }
        )
      }
    } as unknown as typeof OffscreenCanvas
    try {
      const bitmap = { width: 8192, height: 100 } as ImageBitmap
      expect(fitGutterSource(bitmap, 8194)).toBe(bitmap)
      const fitted = fitGutterSource(bitmap, 8192)
      expect([fitted?.width, fitted?.height]).toEqual([8190, 100])
      expect(drawn).toEqual([[0, 0, 8190, 100]])
      // Never a blank tile: no 2D context is null (the placeholder draws),
      // and that bitmap is not retried every frame.
      has2d = false
      const unscalable = { width: 8192, height: 100 } as ImageBitmap
      expect(fitGutterSource(unscalable, 8192)).toBeNull()
      const tried = canvases
      expect(fitGutterSource(unscalable, 8192)).toBeNull()
      expect(canvases).toBe(tried)
    } finally {
      globalThis.OffscreenCanvas = original
    }
  })

  test('no OffscreenCanvas at all is null, not a throw', () => {
    const original = globalThis.OffscreenCanvas
    // @ts-expect-error: a browser without OffscreenCanvas
    delete globalThis.OffscreenCanvas
    try {
      const bitmap = { width: 8192, height: 100 } as ImageBitmap
      expect(fitGutterSource(bitmap, 8192)).toBeNull()
    } finally {
      globalThis.OffscreenCanvas = original
    }
  })
})
