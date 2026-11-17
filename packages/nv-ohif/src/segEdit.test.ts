import { expect, test } from 'bun:test'
import { constrainEdit } from './segEdit'

test('constrainEdit keeps locked segments and paints threshold voxels only in range', () => {
  // Voxel 0: paint over locked 2; 1: paint in range; 2: paint out of range;
  // 3: erase (threshold never blocks erasing); 4: unchanged.
  const shadow = Uint8Array.of(2, 0, 0, 1, 1)
  const bitmap = Uint8Array.of(3, 3, 3, 0, 1)
  const intensity = [100, 100, 900, 900, 0]
  const kept = constrainEdit(
    shadow,
    bitmap,
    new Set([2]),
    (i) => intensity[i] as number,
    [50, 600],
  )
  expect(Array.from(bitmap)).toEqual([2, 3, 0, 0, 1])
  expect(kept).toEqual([1, 3])
})
