import { describe, expect, test } from 'bun:test'
import {
  type ChunkPlan,
  chunkAtVoxel,
  chunkSampleTransform,
  chunksCrossingSlice,
  chunkVolume,
  chunkVolumeGrid,
  identityChunkSampleTransform,
  needsChunking,
  type Vec3i,
} from './chunking'

function eq(a: Vec3i, b: Vec3i): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function totalDataVoxels(plan: ChunkPlan): number {
  let n = 0
  for (const c of plan.chunks) {
    n += c.voxelDims[0] * c.voxelDims[1] * c.voxelDims[2]
  }
  return n
}

function expectChunkInvariants(plan: ChunkPlan): void {
  for (const c of plan.chunks) {
    for (let a = 0; a < 3; a++) {
      expect(c.voxelDims[a]).toBeGreaterThanOrEqual(1)
      expect(c.texDims[a]).toBe(c.voxelDims[a] + c.haloLow[a] + c.haloHigh[a])
      expect(c.texOrigin[a]).toBe(c.voxelOrigin[a] - c.haloLow[a])
      expect(c.texDims[a]).toBeLessThanOrEqual(plan.deviceLimit)
      expect(c.voxelOrigin[a]).toBeGreaterThanOrEqual(0)
      expect(c.voxelOrigin[a] + c.voxelDims[a]).toBeLessThanOrEqual(
        plan.volumeDims[a],
      )
    }
  }
}

describe('needsChunking', () => {
  test('returns false when all axes within limit', () => {
    expect(needsChunking([512, 512, 256], 2048)).toBe(false)
  })

  test('returns false at exactly the limit', () => {
    expect(needsChunking([2048, 2048, 2048], 2048)).toBe(false)
  })

  test('returns true when any axis exceeds the limit', () => {
    expect(needsChunking([2049, 512, 512], 2048)).toBe(true)
    expect(needsChunking([512, 2049, 512], 2048)).toBe(true)
    expect(needsChunking([512, 512, 2049], 2048)).toBe(true)
  })
})

describe('chunkVolume — single-chunk cases', () => {
  test('sub-limit volume yields one chunk with no halo', () => {
    const plan = chunkVolume([100, 200, 300], 2048)
    expect(plan.gridDims).toEqual([1, 1, 1])
    expect(plan.chunks).toHaveLength(1)
    const c = plan.chunks[0]
    expect(c.voxelOrigin).toEqual([0, 0, 0])
    expect(c.voxelDims).toEqual([100, 200, 300])
    expect(c.haloLow).toEqual([0, 0, 0])
    expect(c.haloHigh).toEqual([0, 0, 0])
    expect(c.texDims).toEqual([100, 200, 300])
    expect(c.texOrigin).toEqual([0, 0, 0])
    expect(c.gridIndex).toEqual([0, 0, 0])
  })

  test('exactly at the limit still yields a single chunk', () => {
    const plan = chunkVolume([2048, 2048, 2048], 2048)
    expect(plan.gridDims).toEqual([1, 1, 1])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].haloLow).toEqual([0, 0, 0])
    expect(plan.chunks[0].haloHigh).toEqual([0, 0, 0])
    expectChunkInvariants(plan)
  })

  test('1-voxel volume', () => {
    const plan = chunkVolume([1, 1, 1], 2048)
    expect(plan.gridDims).toEqual([1, 1, 1])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].voxelDims).toEqual([1, 1, 1])
    expectChunkInvariants(plan)
  })
})

describe('chunkVolume — multi-chunk cases', () => {
  test('slightly-over-limit axis yields 2 chunks on that axis', () => {
    const plan = chunkVolume([2050, 100, 100], 2048)
    expect(plan.gridDims).toEqual([2, 1, 1])
    expect(plan.chunks).toHaveLength(2)
    expect(plan.stride[0]).toBe(2046)
    expect(plan.stride[1]).toBe(100)
    expect(plan.stride[2]).toBe(100)
    expectChunkInvariants(plan)

    const [a, b] = plan.chunks
    expect(a.voxelOrigin).toEqual([0, 0, 0])
    expect(a.voxelDims).toEqual([2046, 100, 100])
    expect(a.haloLow).toEqual([0, 0, 0])
    expect(a.haloHigh).toEqual([1, 0, 0])
    expect(a.texDims).toEqual([2047, 100, 100])

    expect(b.voxelOrigin).toEqual([2046, 0, 0])
    expect(b.voxelDims).toEqual([4, 100, 100])
    expect(b.haloLow).toEqual([1, 0, 0])
    expect(b.haloHigh).toEqual([0, 0, 0])
    expect(b.texDims).toEqual([5, 100, 100])
    expect(b.texOrigin).toEqual([2045, 0, 0])
  })

  test('cubic 4096 with limit 2048 yields 3×3×3 grid (stride 2046)', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    expect(plan.gridDims).toEqual([3, 3, 3])
    expect(plan.stride).toEqual([2046, 2046, 2046])
    expect(plan.chunks).toHaveLength(27)
    expectChunkInvariants(plan)
    // First chunk: no low halo, has high halo
    expect(plan.chunks[0].haloLow).toEqual([0, 0, 0])
    expect(plan.chunks[0].haloHigh).toEqual([1, 1, 1])
    expect(plan.chunks[0].texDims).toEqual([2047, 2047, 2047])
    // Last chunk: has low halo, no high halo
    const last = plan.chunks[26]
    expect(last.haloLow).toEqual([1, 1, 1])
    expect(last.haloHigh).toEqual([0, 0, 0])
    expect(last.gridIndex).toEqual([2, 2, 2])
  })

  test('anisotropic volume — only oversized axis splits', () => {
    const plan = chunkVolume([8000, 512, 256], 2048)
    expect(plan.gridDims[0]).toBeGreaterThan(1)
    expect(plan.gridDims[1]).toBe(1)
    expect(plan.gridDims[2]).toBe(1)
    // ceil(8000 / 2046) = 4
    expect(plan.gridDims[0]).toBe(4)
    expectChunkInvariants(plan)

    // Single-chunk axes use 0 halo, multi-chunk axis uses 1 halo on interior faces
    for (const c of plan.chunks) {
      expect(c.haloLow[1]).toBe(0)
      expect(c.haloHigh[1]).toBe(0)
      expect(c.haloLow[2]).toBe(0)
      expect(c.haloHigh[2]).toBe(0)
    }
    // First on x: no low halo. Last on x: no high halo.
    expect(plan.chunks[0].haloLow[0]).toBe(0)
    expect(plan.chunks[plan.chunks.length - 1].haloHigh[0]).toBe(0)
  })

  test('chunks tile the volume exactly — no gaps, no duplicates', () => {
    const dims: Vec3i = [4096, 4096, 4096]
    const plan = chunkVolume(dims, 2048)
    const total = dims[0] * dims[1] * dims[2]
    expect(totalDataVoxels(plan)).toBe(total)
  })

  test('chunks are stored in row-major (z, y, x) order', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    for (let cz = 0; cz < plan.gridDims[2]; cz++) {
      for (let cy = 0; cy < plan.gridDims[1]; cy++) {
        for (let cx = 0; cx < plan.gridDims[0]; cx++) {
          const idx = (cz * plan.gridDims[1] + cy) * plan.gridDims[0] + cx
          expect(eq(plan.chunks[idx].gridIndex, [cx, cy, cz])).toBe(true)
        }
      }
    }
  })

  test('successive chunk origins differ by exactly stride on interior boundaries', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    const last = plan.gridDims[0] - 1
    for (let cz = 0; cz < plan.gridDims[2]; cz++) {
      for (let cy = 0; cy < plan.gridDims[1]; cy++) {
        for (let cx = 0; cx < last; cx++) {
          const a =
            plan.chunks[(cz * plan.gridDims[1] + cy) * plan.gridDims[0] + cx]
          const b =
            plan.chunks[
              (cz * plan.gridDims[1] + cy) * plan.gridDims[0] + cx + 1
            ]
          expect(b.voxelOrigin[0] - a.voxelOrigin[0]).toBe(plan.stride[0])
        }
      }
    }
  })
})

describe('chunkVolume — halo variants', () => {
  test('halo [0,0,0] tiles edge-to-edge with no overlap', () => {
    const plan = chunkVolume([4096, 100, 100], 2048, [0, 0, 0])
    expect(plan.stride[0]).toBe(2048)
    expect(plan.gridDims).toEqual([2, 1, 1])
    for (const c of plan.chunks) {
      expect(c.haloLow).toEqual([0, 0, 0])
      expect(c.haloHigh).toEqual([0, 0, 0])
      expect(c.texDims[0]).toBeLessThanOrEqual(plan.deviceLimit)
    }
    expectChunkInvariants(plan)
  })

  test('halo of 2 carves stride accordingly', () => {
    const plan = chunkVolume([5000, 100, 100], 2048, [2, 2, 2])
    expect(plan.stride[0]).toBe(2044)
    // Interior chunks should have halo 2 on both faces; tex dim must fit limit
    for (const c of plan.chunks) {
      expect(c.texDims[0]).toBeLessThanOrEqual(2048)
    }
    expectChunkInvariants(plan)
  })

  test('wildly oversized axis — ceil math does not overflow', () => {
    const plan = chunkVolume([100000, 10, 10], 2048)
    // ceil(100000 / 2046) = 49
    expect(plan.gridDims).toEqual([49, 1, 1])
    expect(plan.chunks).toHaveLength(49)
    expectChunkInvariants(plan)
    // Total data voxels must equal the volume size exactly
    expect(totalDataVoxels(plan)).toBe(100000 * 10 * 10)
    // Last chunk on x has the remainder, not stride
    const last = plan.chunks[48]
    expect(last.voxelOrigin[0]).toBe(48 * 2046)
    expect(last.voxelDims[0]).toBe(100000 - 48 * 2046)
    expect(last.haloHigh[0]).toBe(0)
  })

  test('very thin volume (axis length 1)', () => {
    const plan = chunkVolume([1024, 1, 1], 2048)
    expect(plan.gridDims).toEqual([1, 1, 1])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].voxelDims).toEqual([1024, 1, 1])
    expectChunkInvariants(plan)
  })

  test('very thin axis combined with oversized axis', () => {
    const plan = chunkVolume([5000, 1, 1], 2048)
    expect(plan.gridDims[0]).toBeGreaterThan(1)
    expect(plan.gridDims[1]).toBe(1)
    expect(plan.gridDims[2]).toBe(1)
    expectChunkInvariants(plan)
    expect(totalDataVoxels(plan)).toBe(5000)
  })

  test('asymmetric per-axis halo', () => {
    const plan = chunkVolume([4096, 4096, 100], 2048, [1, 2, 0])
    expect(plan.stride[0]).toBe(2046)
    expect(plan.stride[1]).toBe(2044)
    expect(plan.stride[2]).toBe(100)
    expectChunkInvariants(plan)
    for (const c of plan.chunks) {
      // z-axis is single-chunk, must have zero halo
      expect(c.haloLow[2]).toBe(0)
      expect(c.haloHigh[2]).toBe(0)
    }
  })
})

describe('chunkVolumeGrid', () => {
  test('forces a 3x3x3 grid for a sub-limit volume', () => {
    const plan = chunkVolumeGrid([240, 90, 150], [3, 3, 3], 256, [3, 3, 3])
    expect(plan.gridDims).toEqual([3, 3, 3])
    expect(plan.stride).toEqual([80, 30, 50])
    expect(plan.chunks).toHaveLength(27)
    expectChunkInvariants(plan)
    expect(totalDataVoxels(plan)).toBe(240 * 90 * 150)
  })

  test('rejects explicit grids that would exceed the device limit', () => {
    expect(() =>
      chunkVolumeGrid([900, 90, 150], [3, 3, 3], 256, [3, 3, 3]),
    ).toThrow(/exceeds deviceLimit/)
  })
})

describe('chunkVolume — input validation', () => {
  test('throws when deviceLimit < 1', () => {
    expect(() => chunkVolume([10, 10, 10], 0)).toThrow()
    expect(() => chunkVolume([10, 10, 10], -5)).toThrow()
  })

  test('throws when volumeDims[a] < 1', () => {
    expect(() => chunkVolume([0, 10, 10], 2048)).toThrow()
    expect(() => chunkVolume([10, 0, 10], 2048)).toThrow()
    expect(() => chunkVolume([10, 10, 0], 2048)).toThrow()
  })

  test('throws when haloSize[a] < 0', () => {
    expect(() => chunkVolume([10, 10, 10], 2048, [-1, 0, 0])).toThrow()
  })

  test('throws when deviceLimit too small for halo', () => {
    // limit must be >= 2*halo + 1
    expect(() => chunkVolume([100, 100, 100], 2, [1, 1, 1])).toThrow()
    expect(() => chunkVolume([100, 100, 100], 3, [1, 1, 1])).not.toThrow()
  })
})

describe('chunkAtVoxel', () => {
  test('returns the single chunk for sub-limit volumes', () => {
    const plan = chunkVolume([100, 100, 100], 2048)
    const c = chunkAtVoxel(plan, [50, 50, 50])
    expect(c).toBe(plan.chunks[0])
  })

  test('returns the correct chunk for multi-chunk volumes', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    // origin
    expect(chunkAtVoxel(plan, [0, 0, 0])?.gridIndex).toEqual([0, 0, 0])
    // first chunk last-included voxel on x (stride=2046)
    expect(chunkAtVoxel(plan, [2045, 0, 0])?.gridIndex).toEqual([0, 0, 0])
    // next chunk first voxel on x
    expect(chunkAtVoxel(plan, [2046, 0, 0])?.gridIndex).toEqual([1, 0, 0])
    // last voxel of the volume
    expect(chunkAtVoxel(plan, [4095, 4095, 4095])?.gridIndex).toEqual([2, 2, 2])
  })

  test('returns null for out-of-bounds coords', () => {
    const plan = chunkVolume([100, 100, 100], 2048)
    expect(chunkAtVoxel(plan, [-1, 0, 0])).toBeNull()
    expect(chunkAtVoxel(plan, [0, -1, 0])).toBeNull()
    expect(chunkAtVoxel(plan, [0, 0, -1])).toBeNull()
    expect(chunkAtVoxel(plan, [100, 0, 0])).toBeNull()
    expect(chunkAtVoxel(plan, [0, 100, 0])).toBeNull()
    expect(chunkAtVoxel(plan, [0, 0, 100])).toBeNull()
  })

  test('every data voxel maps to exactly one chunk that contains it', () => {
    const plan = chunkVolume([300, 300, 300], 128)
    // Sample a sparse grid of voxels rather than all 27M
    const step = 17
    for (let z = 0; z < 300; z += step) {
      for (let y = 0; y < 300; y += step) {
        for (let x = 0; x < 300; x += step) {
          const c = chunkAtVoxel(plan, [x, y, z])
          expect(c).not.toBeNull()
          if (!c) continue
          for (let a = 0; a < 3; a++) {
            const v = [x, y, z][a]
            expect(v).toBeGreaterThanOrEqual(c.voxelOrigin[a])
            expect(v).toBeLessThan(c.voxelOrigin[a] + c.voxelDims[a])
          }
        }
      }
    }
  })
})

describe('chunksCrossingSlice', () => {
  test('single-chunk volume returns the one chunk on every axis', () => {
    const plan = chunkVolume([100, 100, 100], 2048)
    for (let axis = 0; axis < 3; axis++) {
      for (const frac of [0, 0.5, 1]) {
        expect(chunksCrossingSlice(plan, axis, frac)).toEqual([0])
      }
    }
  })

  test('returns the full in-plane chunk layer for the slice axis', () => {
    // 3x3x3 grid, stride 2046
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    // A slice near origin on x lands in chunk layer 0 on x.
    const layer0 = chunksCrossingSlice(plan, 0, 0.01)
    expect(layer0).toHaveLength(9)
    for (const i of layer0) {
      expect(plan.chunks[i].gridIndex[0]).toBe(0)
    }
    // A slice at the far end on x lands in the last x layer (2).
    const layer2 = chunksCrossingSlice(plan, 0, 1)
    expect(layer2).toHaveLength(9)
    for (const i of layer2) {
      expect(plan.chunks[i].gridIndex[0]).toBe(2)
    }
  })

  test('selects the correct layer on each of the three axes', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    for (let axis = 0; axis < 3; axis++) {
      const mid = chunksCrossingSlice(plan, axis, 0.5)
      expect(mid).toHaveLength(9)
      // mid frac -> voxel 2048 -> floor(2048/2046) = layer 1
      for (const i of mid) {
        expect(plan.chunks[i].gridIndex[axis]).toBe(1)
      }
    }
  })

  test('clamps fractions at and beyond the [0,1] boundary', () => {
    const plan = chunkVolume([4096, 100, 100], 2048)
    // gridDims on x is 2
    expect(chunksCrossingSlice(plan, 0, -1)).toEqual(
      chunksCrossingSlice(plan, 0, 0),
    )
    const hi = chunksCrossingSlice(plan, 0, 2)
    expect(hi).toEqual(chunksCrossingSlice(plan, 0, 1))
    // frac 1 must not overflow to a non-existent layer
    for (const i of hi) {
      expect(plan.chunks[i].gridIndex[0]).toBe(plan.gridDims[0] - 1)
    }
  })

  test('returned indices are valid and in plan.chunks order', () => {
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    const out = chunksCrossingSlice(plan, 1, 0.5)
    for (let k = 1; k < out.length; k++) {
      expect(out[k]).toBeGreaterThan(out[k - 1])
    }
    for (const i of out) {
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(plan.chunks.length)
    }
  })
})

describe('chunkSampleTransform', () => {
  test('single-chunk plan yields an identity-equivalent transform', () => {
    const plan = chunkVolume([100, 200, 300], 2048)
    const t = chunkSampleTransform(plan, 0)
    expect(t.subOrigin).toEqual([0, 0, 0])
    expect(t.subSize).toEqual([1, 1, 1])
    expect(t.dataOrigin).toEqual([0, 0, 0])
    expect(t.dataSize).toEqual([1, 1, 1])
    expect(t.volumeDims).toEqual([100, 200, 300])
  })

  test('multi-chunk plan — first chunk sub-cube and halo offsets', () => {
    // 4092 / 2046 = exactly 2 chunks on x
    const plan = chunkVolume([4092, 100, 100], 2048)
    // chunk 0: voxelOrigin 0, voxelDims 2046, haloLow 0, haloHigh 1, texDims 2047
    const t = chunkSampleTransform(plan, 0)
    expect(t.subOrigin[0]).toBe(0)
    expect(t.subSize[0]).toBeCloseTo(2046 / 4092, 10)
    expect(t.dataOrigin[0]).toBe(0)
    expect(t.dataSize[0]).toBeCloseTo(2046 / 2047, 10)
  })

  test('multi-chunk plan — last chunk has a non-zero low halo offset', () => {
    const plan = chunkVolume([4092, 100, 100], 2048)
    // chunk 1: voxelOrigin 2046, voxelDims 2046, haloLow 1, haloHigh 0
    const c = plan.chunks[1]
    const t = chunkSampleTransform(plan, 1)
    expect(t.subOrigin[0]).toBeCloseTo(2046 / 4092, 10)
    expect(t.subSize[0]).toBeCloseTo(c.voxelDims[0] / 4092, 10)
    expect(t.dataOrigin[0]).toBeCloseTo(1 / c.texDims[0], 10)
    expect(t.dataSize[0]).toBeCloseTo(c.voxelDims[0] / c.texDims[0], 10)
  })

  test('sub-cubes tile [0,1] without gaps along the chunked axis', () => {
    const plan = chunkVolume([4092, 100, 100], 2048)
    const t0 = chunkSampleTransform(plan, 0)
    const t1 = chunkSampleTransform(plan, 1)
    // chunk 1 data origin meets chunk 0 data end
    expect(t1.subOrigin[0]).toBeCloseTo(t0.subOrigin[0] + t0.subSize[0], 10)
    // and the last chunk reaches the far face
    expect(t1.subOrigin[0] + t1.subSize[0]).toBeCloseTo(1, 10)
  })

  test('mapping a point through the transform lands inside the data region', () => {
    const plan = chunkVolume([4092, 100, 100], 2048)
    const t = chunkSampleTransform(plan, 1)
    // p at the start of chunk 1 data -> local should equal dataOrigin
    const p = t.subOrigin[0]
    const local =
      ((p - t.subOrigin[0]) / t.subSize[0]) * t.dataSize[0] + t.dataOrigin[0]
    expect(local).toBeCloseTo(t.dataOrigin[0], 10)
  })

  test('halo-expanded draw footprint matches the texture extent', () => {
    const plan = chunkVolume([600, 10, 10], 256, [3, 0, 0])
    const c = plan.chunks[1]
    const t = chunkSampleTransform(plan, 1)
    const drawOrigin =
      t.subOrigin[0] - t.subSize[0] * (t.dataOrigin[0] / t.dataSize[0])
    const drawSize = t.subSize[0] / t.dataSize[0]

    expect(c.texOrigin[0]).toBe(c.voxelOrigin[0] - c.haloLow[0])
    expect(drawOrigin).toBeCloseTo(c.texOrigin[0] / plan.volumeDims[0], 10)
    expect(drawSize).toBeCloseTo(c.texDims[0] / plan.volumeDims[0], 10)
  })
})

describe('identityChunkSampleTransform', () => {
  test('returns all-identity values with the given volume dims', () => {
    const t = identityChunkSampleTransform([64, 128, 256])
    expect(t.subOrigin).toEqual([0, 0, 0])
    expect(t.subSize).toEqual([1, 1, 1])
    expect(t.dataOrigin).toEqual([0, 0, 0])
    expect(t.dataSize).toEqual([1, 1, 1])
    expect(t.volumeDims).toEqual([64, 128, 256])
  })

  test('matches chunkSampleTransform for a single-chunk plan', () => {
    const plan = chunkVolume([100, 200, 300], 2048)
    const a = chunkSampleTransform(plan, 0)
    const b = identityChunkSampleTransform([100, 200, 300])
    expect(a).toEqual(b)
  })
})
