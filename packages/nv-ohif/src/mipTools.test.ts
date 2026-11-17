import { expect, test } from 'bun:test'
import { brightestAlongRay, viewAxis } from './mipTools'

test('the brightest voxel along the view axis, either side of the pick', () => {
  // 4x4x4, 2 mm voxels, origin at -4 mm; bright voxel at [3, 1, 2].
  const img = new Float32Array(64)
  img[3 + 4 * (1 + 4 * 2)] = 9
  img[0 + 4 * (1 + 4 * 2)] = 5
  const affine = [
    [2, 0, 0, -4],
    [0, 2, 0, -4],
    [0, 0, 2, -4],
    [0, 0, 0, 1],
  ]
  const vol = {
    img,
    hdr: { dims: [3, 4, 4, 4], pixDims: [1, 2, 2, 2], affine },
  }
  // Sagittal camera (azimuth 270) looks along x: a pick at x=-4 finds x=2.
  expect(viewAxis(270, 0).map((v) => Math.round(v) + 0)).toEqual([1, 0, 0])
  expect(brightestAlongRay(vol, [-4, -2, 0], viewAxis(270, 0))).toEqual([
    2, -2, 0,
  ])
})
