import { describe, expect, test } from 'bun:test'
import { type ChunkPlan, chunkVolume } from './chunking'
import { ChunkTravelPredictor, translateChunkSet } from './chunkPrediction'

/** An 8x8x8 grid of 64-voxel chunks: 512 chunks, one per grid cell. */
function grid8(): ChunkPlan {
  const plan = chunkVolume([512, 512, 512], 64, [0, 0, 0])
  expect(plan.gridDims).toEqual([8, 8, 8])
  return plan
}

/** Chunk index from a grid position, matching the plan's row-major order. */
function at(plan: ChunkPlan, x: number, y: number, z: number): number {
  const [gx, gy] = plan.gridDims
  return (z * gy + y) * gx + x
}

/** The chunks of one z slab, in row-major order. */
function slab(plan: ChunkPlan, z: number): number[] {
  const [gx, gy] = plan.gridDims
  const out: number[] = []
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) out.push(at(plan, x, y, z))
  }
  return out
}

/** The z of every predicted chunk. */
function slabsOf(plan: ChunkPlan, indices: readonly number[]): number[] {
  return indices.map((ci) => plan.chunks[ci].gridIndex[2])
}

describe('translateChunkSet', () => {
  test('shifts a slab along the step', () => {
    const plan = grid8()
    expect([...translateChunkSet(plan, slab(plan, 1), [0, 0, 1], 64)]).toEqual(
      slab(plan, 2),
    )
  })

  test('drops chunks that would leave the grid', () => {
    const plan = grid8()
    expect(translateChunkSet(plan, slab(plan, 7), [0, 0, 1], 64)).toEqual([])
  })

  test('omits chunks the caller already asked for', () => {
    const plan = grid8()
    const twoSlabs = [...slab(plan, 0), ...slab(plan, 1)]
    // Slab 1 is already in the set, so only slab 2 is new.
    expect([...translateChunkSet(plan, twoSlabs, [0, 0, 1], 512)]).toEqual(
      slab(plan, 2),
    )
  })

  test('caps the result and keeps the caller order', () => {
    const plan = grid8()
    expect([...translateChunkSet(plan, slab(plan, 0), [0, 0, 1], 3)]).toEqual([
      at(plan, 0, 0, 1),
      at(plan, 1, 0, 1),
      at(plan, 2, 0, 1),
    ])
  })
})

describe('ChunkTravelPredictor', () => {
  test('predicts nothing from a single frame', () => {
    const plan = grid8()
    expect(new ChunkTravelPredictor().predict(plan, slab(plan, 0), 4)).toEqual(
      [],
    )
  })

  test('predicts nothing while the view is settled', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    for (let i = 0; i < 5; i++) {
      expect(p.predict(plan, slab(plan, 1), 4)).toEqual([])
    }
  })

  test('follows a slice scrub into the slabs ahead', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 4)
    p.predict(plan, slab(plan, 1), 4)
    const ahead = p.predict(plan, slab(plan, 2), 4)
    expect(ahead.length).toBe(4)
    // Ahead of the scrub, never behind it or on the slab being drawn.
    for (const z of slabsOf(plan, ahead)) expect(z).toBeGreaterThan(2)
  })

  test('follows a reversed scrub back the other way', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    for (const z of [0, 1, 2, 3, 4, 5]) p.predict(plan, slab(plan, z), 4)
    // Turn around: the smoothed velocity takes a frame or two to follow.
    let ahead: readonly number[] = []
    for (const z of [4, 3, 2]) ahead = p.predict(plan, slab(plan, z), 4)
    expect(ahead.length).toBe(4)
    for (const z of slabsOf(plan, ahead)) expect(z).toBeLessThan(2)
  })

  test('predicts nothing across a jump', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 4)
    // A dataset switch or a crosshair teleport, not travel.
    expect(p.predict(plan, slab(plan, 7), 4)).toEqual([])
    // And the jump is not carried forward as velocity.
    expect(p.predict(plan, slab(plan, 7), 4)).toEqual([])
  })

  test('holds its velocity across a frame with no working set', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 4)
    p.predict(plan, slab(plan, 1), 4)
    expect(p.predict(plan, [], 4)).toEqual([])
    expect(p.predict(plan, slab(plan, 2), 4).length).toBe(4)
  })

  test('follows a scrub that steps, then idles, then steps', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    // A wheel scrub: one step lands in a frame, the next comes many frames
    // later. The idle frames must not decay the travel away.
    p.predict(plan, slab(plan, 0), 4)
    p.predict(plan, slab(plan, 1), 4)
    for (let i = 0; i < 30; i++) {
      expect(p.predict(plan, slab(plan, 1), 4)).toEqual([])
    }
    const ahead = p.predict(plan, slab(plan, 2), 4)
    expect(ahead.length).toBe(4)
    for (const z of slabsOf(plan, ahead)) expect(z).toBeGreaterThan(2)
  })

  test('reset forgets the travel', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 4)
    p.predict(plan, slab(plan, 1), 4)
    p.reset()
    expect(p.predict(plan, slab(plan, 2), 4)).toEqual([])
  })

  test('honours the cap', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 2)
    p.predict(plan, slab(plan, 1), 2)
    expect(p.predict(plan, slab(plan, 2), 2).length).toBe(2)
  })

  test('predicts nothing when asked for nothing', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    p.predict(plan, slab(plan, 0), 4)
    expect(p.predict(plan, slab(plan, 1), 0)).toEqual([])
  })

  test('follows a pan across the plane', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    // A 2-column by 8-row window sliding along +x, one column per frame.
    const window = (x0: number): number[] => {
      const out: number[] = []
      for (let y = 0; y < 8; y++) {
        for (let x = x0; x < x0 + 2; x++) out.push(at(plan, x, y, 0))
      }
      return out
    }
    p.predict(plan, window(0), 4)
    p.predict(plan, window(1), 4)
    const ahead = p.predict(plan, window(2), 4)
    expect(ahead.length).toBe(4)
    for (const ci of ahead) {
      expect(plan.chunks[ci].gridIndex[0]).toBeGreaterThan(3)
      expect(plan.chunks[ci].gridIndex[2]).toBe(0)
    }
  })

  test('ignores indices that are not in the plan', () => {
    const plan = grid8()
    const p = new ChunkTravelPredictor()
    expect(p.predict(plan, [99999], 4)).toEqual([])
  })
})
