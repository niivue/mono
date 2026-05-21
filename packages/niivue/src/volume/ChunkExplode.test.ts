import { describe, expect, test } from 'bun:test'
import { chunkExplodedMatRAS, chunkExplodeOffsetFrac } from './ChunkExplode'
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
