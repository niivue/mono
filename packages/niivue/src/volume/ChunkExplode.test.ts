import { describe, expect, test } from 'bun:test'
import {
  chunkExplodedMatRAS,
  chunkExplodeOffsetFrac,
  pickExplodedVoxel,
} from './ChunkExplode'
import { chunkVolume } from './chunking'

const IDENTITY_RAS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('ChunkExplode', () => {
  test('keeps compact chunks at scale 1', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 0, {
        enabled: true,
        scale: [1, 1, 1],
      }),
    ).toEqual([0, 0, 0])
  })

  test('offsets chunks around the grid center', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 0, {
        enabled: true,
        scale: [1.5, 1, 1],
      }),
    ).toEqual([-0.125, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 1, {
        enabled: true,
        scale: [1.5, 1, 1],
      }),
    ).toEqual([0.125, 0, 0])
  })

  test('translates matRAS in voxel space without changing scale', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    const mat = chunkExplodedMatRAS(plan, 1, IDENTITY_RAS, {
      enabled: true,
      scale: [1.5, 1, 1],
    })
    expect(Array.from(mat)).toEqual([
      1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ])
  })
})

describe('pickExplodedVoxel', () => {
  // 4 chunks along x (voxels [0,2),[2,4),[4,6),[6,8)); identity matRAS so mm =
  // voxel + explode shift. Scale 2 spreads the blocks to disjoint exploded x
  // ranges: chunk0 [-3,-1], chunk1 [1,3], chunk2 [5,7], chunk3 [9,11]; y,z [0,1].
  const plan = () => chunkVolume([8, 1, 1], 2, [0, 0, 0])
  const explode = {
    enabled: true,
    scale: [2, 2, 2] as [number, number, number],
  }

  test('returns null when explode is disabled', () => {
    expect(
      pickExplodedVoxel(
        plan(),
        IDENTITY_RAS,
        undefined,
        [6, 0.5, 5],
        [0, 0, -1],
      ),
    ).toBeNull()
  })

  test('a ray through a block picks that block', () => {
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [6, 0.5, 5],
      [0, 0, -1],
    )
    expect(hit?.chunkIndex).toBe(2)
    // recovered voxel lies in chunk 2's data region (x in [4,5])
    expect(hit?.voxel[0]).toBeGreaterThanOrEqual(4)
    expect(hit?.voxel[0]).toBeLessThanOrEqual(5)
  })

  test('picks a negative-x block (block 0)', () => {
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [-2, 0.5, 5],
      [0, 0, -1],
    )
    expect(hit?.chunkIndex).toBe(0)
    expect(hit?.voxel[0]).toBeGreaterThanOrEqual(0)
    expect(hit?.voxel[0]).toBeLessThanOrEqual(1)
  })

  test('a ray in the gap between blocks hits nothing', () => {
    // x = 0 is between block 0 ([-3,-1]) and block 1 ([1,3]).
    expect(
      pickExplodedVoxel(plan(), IDENTITY_RAS, explode, [0, 0.5, 5], [0, 0, -1]),
    ).toBeNull()
  })

  test('picks the nearest block along the ray', () => {
    // Aim down -x at y,z inside every block's slab; should hit the highest-x
    // block first (block 3, exploded x [9,11]).
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [20, 0.5, 0.5],
      [-1, 0, 0],
    )
    expect(hit?.chunkIndex).toBe(3)
  })
})
