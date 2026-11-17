import { expect, test } from 'bun:test'
import { constrainEdit, penSizeFor, rasIntensity } from './segEdit'

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

test('threshold intensity reads the frame shown now, not the first one', () => {
  const img = Float32Array.of(100, 0)
  const v = {
    img,
    dimsRAS: [3, 2, 1, 1],
    img2RASstep: [1, 2, 2],
    img2RASstart: [0, 0, 0],
    hdr: { scl_slope: 1, scl_inter: 0 },
  }
  const at = rasIntensity(v as never)
  img.set([0, 100])
  expect(at?.(1)).toBe(100)
})

test('rasIntensity maps a flipped axis and applies the scaling', () => {
  const v = {
    img: Int16Array.of(1, 2, 3),
    dimsRAS: [3, 3, 1, 1],
    img2RASstep: [-1, 3, 3],
    img2RASstart: [2, 0, 0],
    hdr: { scl_slope: 2, scl_inter: 1 },
  }
  const at = rasIntensity(v as never)
  expect([0, 1, 2].map((i) => at?.(i))).toEqual([7, 5, 3])
})

test('the brush diameter uses the spacing in the drawn plane', () => {
  // Sagittal: y and z in plane; the 0.5 mm x spacing is through-plane.
  expect(penSizeFor(5, [1, 0.5, 2, 2], 2)).toBe(5)
  expect(penSizeFor(5, [1, 0.5, 2, 2], 0)).toBe(20)
})
