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
