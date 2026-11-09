import { describe, expect, test } from 'bun:test'
import { computeConnectedLabel } from './connectedLabel'

// Independent oracle: raster-order flood fill. Components are numbered by
// their first voxel in raster order, matching translate_labels.
function floodLabel(bw: Uint32Array, d: number[], conn: number): Uint32Array {
  const [nx, ny, nz] = d
  const offsets: number[][] = []
  for (let z = -1; z <= 1; z++)
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const n = Math.abs(x) + Math.abs(y) + Math.abs(z)
        if (n > 0 && (conn === 26 || (conn === 18 && n <= 2) || n === 1))
          offsets.push([x, y, z])
      }
  const out = new Uint32Array(bw.length)
  let label = 0
  for (let start = 0; start < bw.length; start++) {
    if (!bw[start] || out[start]) continue
    out[start] = ++label
    const stack = [start]
    while (stack.length) {
      const v = stack.pop() as number
      const x = v % nx
      const y = Math.floor(v / nx) % ny
      const z = Math.floor(v / (nx * ny))
      for (const [ox, oy, oz] of offsets) {
        const a = x + ox
        const b = y + oy
        const c = z + oz
        if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue
        const j = a + b * nx + c * nx * ny
        if (bw[j] === bw[start] && !out[j]) {
          out[j] = label
          stack.push(j)
        }
      }
    }
  }
  return out
}

// Largest component per original class; ties go to the highest component index.
function largestPerClass(bw: Uint32Array, ls: Uint32Array): Uint32Array {
  const size = new Map<number, number>()
  for (const l of ls) if (l) size.set(l, (size.get(l) ?? 0) + 1)
  const best = new Map<number, number>()
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]
    if (!l) continue
    const b = best.get(bw[i])
    const sl = size.get(l) as number
    const sb = b === undefined ? -1 : (size.get(b) as number)
    if (sl > sb || (sl === sb && l > (b as number))) best.set(bw[i], l)
  }
  const winners = new Set(best.values())
  return ls.map((l, i) => (winners.has(l) ? bw[i] : 0))
}

function rng(seed: number) {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0
    return (s >>> 8) / 16777216
  }
}

function makeVolume(d: number[], density: number, classes: number, seed = 1) {
  const r = rng(seed)
  const img = new Uint8Array(d[0] * d[1] * d[2])
  for (let i = 0; i < img.length; i++)
    if (r() < density) img[i] = 1 + Math.floor(r() * classes)
  return img
}

function check(
  img: ArrayLike<number>,
  d: number[],
  conn: number,
  binarize: boolean,
  largest: boolean,
) {
  const out = computeConnectedLabel({
    img,
    datatypeCode: 2,
    dims: [3, ...d],
    conn,
    binarize,
    onlyLargestClusterPerClass: largest,
  })
  const bw = Uint32Array.from(img, (v) => (binarize ? (v ? 1 : 0) : v))
  const ls = floodLabel(bw, d, conn)
  const want = largest ? largestPerClass(bw, ls) : ls
  let max = 0
  for (const v of want) max = Math.max(max, v)
  expect(out.calMax).toBe(max)
  expect(Array.from(out.img as Uint8Array)).toEqual(Array.from(want))
  return out
}

describe('computeConnectedLabel', () => {
  for (const conn of [6, 18, 26])
    for (const binarize of [false, true])
      for (const largest of [false, true])
        test(`conn ${conn} binarize ${binarize} largest ${largest}`, () => {
          const shapes = [
            [9, 7, 5],
            [1, 13, 11],
            [16, 1, 3],
          ]
          for (const [k, d] of shapes.entries())
            for (const density of [0.15, 0.45, 0.8])
              check(
                makeVolume(d, density, 3, k + 7),
                d,
                conn,
                binarize,
                largest,
              )
        })

  test('empty and full foreground', () => {
    const d = [5, 4, 3]
    for (const largest of [false, true]) {
      const empty = check(new Uint8Array(60), d, 26, false, largest)
      expect(empty.calMax).toBe(0)
      const full = check(new Uint8Array(60).fill(4), d, 6, false, largest)
      expect(full.calMax).toBe(largest ? 4 : 1)
    }
  })

  test('touching classes stay separate; equal-size tie keeps last component', () => {
    // Two 2-voxel class-1 blobs (tie) and a class-2 bar touching the first.
    const img = new Uint8Array([1, 1, 2, 2, 0, 1, 1, 0])
    const out = check(img, [8, 1, 1], 6, false, true)
    expect(Array.from(out.img as Uint8Array)).toEqual([0, 0, 2, 2, 0, 1, 1, 0])
  })

  test('output datatype follows label count', () => {
    // 6-connected 3D checkerboard: every foreground voxel is its own component.
    const checker = (d: number[]) => {
      const img = new Uint8Array(d[0] * d[1] * d[2])
      for (let z = 0; z < d[2]; z++)
        for (let y = 0; y < d[1]; y++)
          for (let x = 0; x < d[0]; x++)
            img[x + y * d[0] + z * d[0] * d[1]] = (x + y + z) % 2 ? 0 : 1
      return computeConnectedLabel({
        img,
        datatypeCode: 2,
        dims: [3, ...d],
        conn: 6,
      })
    }
    expect(checker([16, 16, 1])).toMatchObject({ datatypeCode: 2, calMax: 128 })
    expect(checker([32, 32, 2])).toMatchObject({
      datatypeCode: 512,
      bitsPerVoxel: 16,
    })
    const big = checker([64, 64, 32])
    expect(big).toMatchObject({ datatypeCode: 16, calMax: 65536 })
  })

  test('largest-per-class keeps class values above 255 (and 2^16)', () => {
    for (const [v, dt] of [
      [300, 512],
      [70000, 16],
    ]) {
      const img = new Uint32Array([v, 0, v, v, 0, 5])
      const out = computeConnectedLabel({
        img,
        datatypeCode: 768,
        dims: [3, 6, 1, 1],
        conn: 6,
        onlyLargestClusterPerClass: true,
      })
      expect(out.datatypeCode).toBe(dt)
      expect(out.calMax).toBe(v)
      expect(Array.from(out.img as Float32Array)).toEqual([0, 0, v, v, 0, 5])
    }
  })
})
