import { describe, expect, test } from 'bun:test'
import { chunkVolume } from './chunking'
import { chunksInFrustum, unionChunkSets } from './ChunkVisibility'

/** Column-major 4x4 identity. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major 4x4 with a translation — gl-matrix stores it in m[12..14]. */
function translate(tx: number, ty: number, tz: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]
}

/** A 4-chunk-along-x plan: chunk i covers x in [i*0.25, (i+1)*0.25]. */
function fourChunkPlan() {
  // 8 voxels, device limit 2, no halo => stride 2, gridDims[0] = 4.
  return chunkVolume([8, 1, 1], 2, [0, 0, 0])
}

describe('chunksInFrustum', () => {
  test('identity MVP keeps every chunk (unit cube fills the frustum)', () => {
    const plan = fourChunkPlan()
    expect(chunksInFrustum(plan, IDENTITY, true)).toEqual([0, 1, 2, 3])
  })

  test('translating the volume fully off-screen culls every chunk', () => {
    const plan = fourChunkPlan()
    // Push x far past the right clip plane: clip.x in [+10, +11], all > w.
    expect(chunksInFrustum(plan, translate(10, 0, 0), true)).toEqual([])
  })

  test('a partial translation culls only the chunks left of the frustum', () => {
    const plan = fourChunkPlan()
    // Shift x by -1: chunk i now spans clip.x in [i*0.25 - 1, (i+1)*0.25 - 1].
    // The left plane is clip.x >= -w = -1. Chunk 0 spans [-1, -0.75] — its
    // far corner touches -1, so it is NOT fully outside and survives.
    const visible = chunksInFrustum(plan, translate(-1.3, 0, 0), true)
    // Shift -1.3: chunk 0 spans [-1.3, -1.05] (all < -1 => culled),
    // chunk 1 spans [-1.05, -0.8] (straddles -1 => visible).
    expect(visible).toEqual([1, 2, 3])
  })

  test('single-chunk volume is reported visible under identity', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    expect(plan.chunks.length).toBe(1)
    expect(chunksInFrustum(plan, IDENTITY, true)).toEqual([0])
  })

  test('chunk behind the camera (w <= 0) is conservatively kept', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    // A projective MVP whose w row makes w negative across the cube.
    const mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]
    expect(chunksInFrustum(plan, mvp, true)).toEqual([0])
  })

  test('near-plane convention differs between backends', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    // Map z in [0,1] to clip.z in [-2,-1] (w stays 1): fully behind the
    // WebGPU near plane (z >= 0) but the z = -1 corner sits exactly on the
    // WebGL2 near plane (z >= -w), so WebGL2 keeps the chunk.
    const mvp = translate(0, 0, -2)
    expect(chunksInFrustum(plan, mvp, true)).toEqual([]) // WebGPU: culled
    expect(chunksInFrustum(plan, mvp, false)).toEqual([0]) // WebGL2: kept
  })
})

describe('unionChunkSets', () => {
  test('merges and sorts overlapping per-tile lists', () => {
    expect(unionChunkSets([[3, 1], [1, 2], [5]])).toEqual([1, 2, 3, 5])
  })

  test('empty input yields an empty set', () => {
    expect(unionChunkSets([])).toEqual([])
    expect(unionChunkSets([[], []])).toEqual([])
  })
})
