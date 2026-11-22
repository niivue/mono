import { describe, expect, test } from 'bun:test'
import { clampVoxelBox, growVoxelBox } from './voxelBox'

describe('voxelBox', () => {
  test('grows to take in each voxel and its radius', () => {
    let box = growVoxelBox(null, 5, 5, 5, 1)
    box = growVoxelBox(box, 9, 2, 5, 0)
    expect(box).toEqual({ min: [4, 2, 4], max: [9, 6, 6] })
  })

  test('clamps to the grid as whole voxels', () => {
    expect(
      clampVoxelBox({ min: [-2, 1.4, 3], max: [4.2, 20, 3] }, [10, 10, 10]),
    ).toEqual({ min: [0, 1, 3], max: [5, 9, 3] })
  })

  test('is null when the box misses the grid', () => {
    expect(
      clampVoxelBox({ min: [12, 0, 0], max: [14, 2, 2] }, [10, 10, 10]),
    ).toBeNull()
  })
})
