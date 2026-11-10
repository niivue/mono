import { describe, expect, test } from 'bun:test'
import { syncGutters } from '@/slide/tileGutter'

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

function uploadAll(order: [number, number][]): Map<string, Tex> {
  const textures = new Map<string, Tex>()
  for (const [col, row] of order) {
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
    syncGutters(
      0,
      col,
      row,
      tex,
      (key) => textures.get(key),
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
})
