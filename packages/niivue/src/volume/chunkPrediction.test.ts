import { describe, expect, test } from 'bun:test'
import {
  type ChunkPlan,
  chunkVolume,
  chunkVolumeMultiLOD,
  type Vec3i,
} from './chunking'
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

describe('ChunkTravelPredictor on a grid plan', () => {
  test('matches the pre-octree predictions exactly', () => {
    const plan = grid8()
    const box = (x0: number, y0: number, z: number): number[] => {
      const out: number[] = []
      for (let y = y0; y < y0 + 2; y++) {
        for (let x = x0; x < x0 + 2; x++) out.push(at(plan, x, y, z))
      }
      return out
    }
    // Pan, idle, scrub, turn, empty frame, jump: captured before the octree path.
    const frames = [
      box(0, 0, 0),
      box(1, 0, 0),
      box(2, 1, 0),
      box(2, 1, 0),
      box(3, 2, 1),
      box(3, 2, 2),
      box(2, 2, 3),
      box(1, 1, 3),
      box(1, 1, 3),
      [],
      box(0, 0, 3),
      box(6, 6, 7),
      box(5, 6, 7),
      box(4, 5, 6),
    ]
    const p = new ChunkTravelPredictor()
    expect(frames.map((f) => [...p.predict(plan, f, 6)])).toEqual([
      [],
      [3, 4, 11, 12],
      [28, 29, 36, 37],
      [],
      [230, 231, 238, 239],
      [284, 285, 292, 293],
      [409, 410, 417, 418],
      [256, 264],
      [],
      [],
      [],
      [],
      [500, 508],
      [354, 355, 362, 363],
    ])
  })
})

describe('ChunkTravelPredictor on an octree plan', () => {
  const pyramid: Vec3i[] = [
    [1024, 1024, 64],
    [512, 512, 32],
    [256, 256, 16],
    [128, 128, 8],
  ]
  // Odd dims: ceil-halving leaves same-level bricks of unequal size.
  const ragged: Vec3i[] = [
    [1041, 1377, 64],
    [521, 689, 32],
    [261, 345, 16],
    [131, 173, 8],
  ]
  const octree = (cx = 512, levels = pyramid): ChunkPlan => {
    const plan = chunkVolumeMultiLOD(
      levels,
      { center: [cx, 512, 32], radius: 256 },
      2048,
      { cellEdge: 64 },
    )
    expect(plan.gridDims).toEqual([1, 1, 1])
    return plan
  }
  const centreX = (plan: ChunkPlan, ci: number): number =>
    plan.chunks[ci].voxelOrigin[0] + plan.chunks[ci].voxelDims[0] / 2
  /** A 2D slice view at z=32: bricks inside a 256-voxel window centred on x. */
  const window = (plan: ChunkPlan, x: number): number[] => {
    const out: number[] = []
    plan.chunks.forEach((c, i) => {
      const [ox, oy, oz] = c.voxelOrigin
      const [dx, dy, dz] = c.voxelDims
      if (32 < oz || 32 >= oz + dz) return
      if (ox >= x + 128 || ox + dx <= x - 128) return
      if (oy >= 640 || oy + dy <= 384) return
      out.push(i)
    })
    return out
  }

  for (const [name, levels] of [
    ['power-of-two', pyramid],
    ['ragged', ragged],
  ] as const) {
    for (const dir of [1, -1]) {
      test(`follows a ${dir > 0 ? '+x' : '-x'} pan, ${name} dims`, () => {
        const plan = octree(512, levels)
        const p = new ChunkTravelPredictor()
        let predicted = 0
        // Across the fine core into the coarse surround, ~one fine brick a frame.
        for (let k = 0; k < 8; k++) {
          const x = 512 + dir * (k * 64 - 128)
          const ws = window(plan, x)
          const ahead = p.predict(plan, ws, 16)
          predicted += ahead.length
          const lods = new Set(ws.map((ci) => plan.chunks[ci].sourceLevel))
          for (const ci of ahead) {
            expect(ws).not.toContain(ci)
            expect(lods.has(plan.chunks[ci].sourceLevel)).toBe(true)
            expect((centreX(plan, ci) - x) * dir).toBeGreaterThan(0)
          }
        }
        expect(predicted).toBeGreaterThan(0)
      })
    }
  }

  test('predicts nothing while settled or across a jump', () => {
    const plan = octree()
    const p = new ChunkTravelPredictor()
    for (let i = 0; i < 3; i++)
      expect(p.predict(plan, window(plan, 512), 16)).toEqual([])
    p.predict(plan, window(plan, 384), 16)
    p.predict(plan, window(plan, 448), 16)
    expect(p.predict(plan, window(plan, 900), 16)).toEqual([])
  })

  test('predicts nothing for a common grid too large for an exact key', () => {
    // The plan's own bricks, on a common grid past faceKey's exact range.
    const plan = octree()
    const huge = { ...plan, volumeDims: [1e6, 1e6, 1e6] as Vec3i }
    const p = new ChunkTravelPredictor()
    for (let k = 0; k < 6; k++)
      expect(p.predict(huge, window(plan, 384 + k * 64), 16)).toEqual([])
  })

  test('a refocus alone is not travel', () => {
    // A still, wide view (fine core and coarse surround) while only the
    // focus moves: the covering bricks, and so their centroid, change.
    const wide = (plan: ChunkPlan): number[] => {
      const out: number[] = []
      plan.chunks.forEach((c, i) => {
        const [ox, oy, oz] = c.voxelOrigin
        const [dx, dy, dz] = c.voxelDims
        if (32 < oz || 32 >= oz + dz) return
        if (ox >= 896 || ox + dx <= 128) return
        if (oy >= 896 || oy + dy <= 128) return
        out.push(i)
      })
      return out
    }
    const p = new ChunkTravelPredictor()
    let plan = octree(256)
    let predicted = 0
    for (let f = 256; f <= 768; f += 64) {
      const next = octree(f)
      p.replan(plan, next)
      plan = next
      predicted += p.predict(plan, wide(plan), 64).length
      predicted += p.predict(plan, wide(plan), 64).length
    }
    expect(predicted).toBe(0)
  })

  test('keeps the velocity across refocused plans, as the renderers swap them', () => {
    // A +x pan whose focus follows it, refocusing every other frame.
    const run = (
      swap: (p: ChunkTravelPredictor, a: ChunkPlan, b: ChunkPlan) => void,
    ) => {
      const p = new ChunkTravelPredictor()
      let plan = octree(384)
      let ahead = 0
      let behind = 0
      for (let x = 384; x <= 704; x += 32) {
        if (x % 64 === 0 && x !== 384) {
          const next = octree(x)
          swap(p, plan, next)
          plan = next
        }
        for (const ci of p.predict(plan, window(plan, x), 16))
          if (centreX(plan, ci) > x) ahead++
          else behind++
      }
      return { ahead, behind }
    }
    const kept = run((p, a, b) => p.replan(a, b))
    const reset = run((p) => p.reset())
    expect(kept.ahead).toBeGreaterThanOrEqual(reset.ahead)
    expect(kept.behind).toBeLessThanOrEqual(kept.ahead / 4)
  })

  test('replan resets for a plan on another common grid, or a grid plan', () => {
    const p = new ChunkTravelPredictor()
    const plan = octree()
    p.predict(plan, window(plan, 384), 16)
    p.predict(plan, window(plan, 448), 16)
    const other = { ...plan, volumeDims: [2048, 2048, 128] as Vec3i }
    p.replan(plan, other)
    expect(p.predict(other, window(plan, 512), 16)).toEqual([])
    p.predict(plan, window(plan, 384), 16)
    p.replan(plan, grid8())
    expect(p.predict(grid8(), slab(grid8(), 1), 16)).toEqual([])
  })

  test('indexes each new plan, not the first one it saw', () => {
    const p = new ChunkTravelPredictor()
    let predicted = 0
    // The focus moves with the view, so every frame brings a new plan.
    for (let x = 384; x < 700; x += 64) {
      const plan = octree(x)
      const ahead = p.predict(plan, window(plan, x), 16)
      predicted += ahead.length
      for (const ci of ahead) expect(centreX(plan, ci)).toBeGreaterThan(x)
    }
    expect(predicted).toBeGreaterThan(0)
  })
})
