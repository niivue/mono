import { expect, it } from 'bun:test'
import { largestBidirectional } from './segBidirectional'

// A cross of segment 1 on slice 1 of a 9x9x2 grid (1 mm voxels): the major
// is the horizontal bar, the minor the vertical one. Segment 2's longer
// diagonal on slice 0 must not count.
it('largest bidirectional: farthest pair, then widest perpendicular chord', () => {
  const img = new Uint8Array(9 * 9 * 2)
  for (let i = 0; i < 9; i++) img[i + 9 * i] = 2
  for (let x = 0; x < 9; x++) img[81 + x + 9 * 4] = 1
  for (let y = 2; y <= 6; y++) img[81 + 4 + 9 * y] = 1
  const ends = largestBidirectional(img, [9, 9, 2], (v) => v, 1, 2)
  expect(ends).toEqual([
    [0, 4, 1],
    [8, 4, 1],
    [4, 2, 1],
    [4, 6, 1],
  ])
  expect(largestBidirectional(img, [9, 9, 2], (v) => v, 3, 2)).toBeUndefined()
})

// A volume origin off a multiple of the slice step keeps the endpoints on
// their voxel-centre plane.
it('largest bidirectional: slabs follow the volume origin', () => {
  const img = new Uint8Array(8).fill(1)
  const ends = largestBidirectional(
    img,
    [2, 2, 2],
    ([x, y, z]) => [x, y, 1 + 2 * z],
    1,
    2,
  )
  for (const p of ends ?? []) expect([1, 3]).toContain(p[2])
  expect(ends).toBeDefined()
})

// A slice step thinner than the pixels must not bin the major by it: the L's
// short diameter is one pixel, not zero.
it('largest bidirectional: binned by the in-plane step', () => {
  const img = new Uint8Array(4)
  img[0] = img[1] = img[2] = 1
  const ends = largestBidirectional(
    img,
    [2, 2, 1],
    ([x, y, z]) => [x, y, z * 0.1],
    1,
    2,
  )
  const [, , c, d] = ends ?? []
  expect(c && d && Math.hypot(c[0] - d[0], c[1] - d[1])).toBe(1)
})

// Review of #863: on an oblique anisotropic grid (spacing 1,1,5; 20 degree
// tilt about y) projecting surface voxels onto the world plane put the major
// endpoints outside the segment (nearest voxels (8,2,1), (8,12,1): label 0).
it('largest bidirectional keeps every endpoint inside an oblique segment', () => {
  const n = 15
  const img = new Uint8Array(n * n * 3)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if ((x - 7) ** 2 + (y - 7) ** 2 <= 25) img[x + n * (y + n)] = 1
  const c = Math.cos(Math.PI / 9)
  const s = Math.sin(Math.PI / 9)
  const vox2mm = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => [c * x - 5 * s * z, y, s * x + 5 * c * z]
  const ends = largestBidirectional(img, [n, n, 3], vox2mm, 1, 2)
  expect(ends).toBeDefined()
  for (const [x, y, z] of ends ?? []) {
    const [i, j, k] = [c * x + s * z, y, (-s * x + c * z) / 5].map(
      Math.round,
    ) as [number, number, number]
    expect(img[i + n * (j + n * k)]).toBe(1)
  }
})
