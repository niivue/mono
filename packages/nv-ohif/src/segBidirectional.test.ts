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

// Only in-plane edges enter the O(n^2) search: a 5x5x3 block has 16 edge
// voxels per slice, while a 6-neighbour surface would add the 9 interior
// voxels of each end slice.
it('largest bidirectional: through-plane faces are not edges', () => {
  const img = new Uint8Array(5 * 5 * 3).fill(1)
  let calls = 0
  const vox2mm = (v: [number, number, number]) => {
    calls++
    return v
  }
  largestBidirectional(img, [5, 5, 3], vox2mm, 1, 2)
  expect(calls).toBe(4 + 16 * 3)
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
