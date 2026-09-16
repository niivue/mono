import { describe, expect, test } from 'bun:test'
import {
  bytesPerSourceVoxel,
  chunkIndicesForResidentBudget,
  estimateChunkedBytes,
  formatBytes,
  residentBytesForChunkDesc,
} from './chunkBudget'
import type { ChunkPlan, Vec3i, VolumeChunkDesc } from './chunking'
import { chunkVolume } from './chunking'

function testChunk(texDims: Vec3i): VolumeChunkDesc {
  return {
    voxelOrigin: [0, 0, 0],
    voxelDims: texDims,
    haloLow: [0, 0, 0],
    haloHigh: [0, 0, 0],
    texDims,
    texOrigin: [0, 0, 0],
    gridIndex: [0, 0, 0],
  }
}

function testPlan(chunks: VolumeChunkDesc[]): ChunkPlan {
  return {
    gridDims: [chunks.length, 1, 1],
    stride: [1, 1, 1],
    chunks,
    volumeDims: [chunks.length, 1, 1],
    deviceLimit: 100,
    haloSize: [0, 0, 0],
  }
}

describe('bytesPerSourceVoxel', () => {
  test('returns correct bpv for known NIfTI datatypes', () => {
    expect(bytesPerSourceVoxel(2)).toBe(1) // UINT8
    expect(bytesPerSourceVoxel(4)).toBe(2) // INT16
    expect(bytesPerSourceVoxel(8)).toBe(4) // INT32
    expect(bytesPerSourceVoxel(16)).toBe(4) // FLOAT32
    expect(bytesPerSourceVoxel(512)).toBe(2) // UINT16
    expect(bytesPerSourceVoxel(768)).toBe(4) // UINT32
    expect(bytesPerSourceVoxel(2304)).toBe(4) // RGBA32
    expect(bytesPerSourceVoxel(32)).toBe(8) // COMPLEX64
    expect(bytesPerSourceVoxel(128)).toBe(3) // RGB24
  })

  test('returns 0 for unsupported datatype codes', () => {
    expect(bytesPerSourceVoxel(0)).toBe(0)
    expect(bytesPerSourceVoxel(999)).toBe(0)
  })
})

describe('estimateChunkedBytes', () => {
  test('single chunk volume — bytes match the volume dimensions', () => {
    const plan = chunkVolume([100, 100, 100], 2048)
    const b = estimateChunkedBytes(plan, 2) // UINT16
    const voxels = 100 * 100 * 100
    expect(b.scalarBytes).toBe(voxels * 2)
    expect(b.rgbaBytes).toBe(voxels * 4)
    expect(b.gradientBytes).toBe(voxels * 4)
    expect(b.totalBytes).toBe(voxels * (2 + 4 + 4))
    expect(b.chunkCount).toBe(1)
  })

  test('chunked volume includes halo overhead', () => {
    // 4096^3 with limit 2048 → 27 chunks each 2047^3 (boundary chunks have
    // halo only on inner faces, central chunks 2048^3 — but stride=2046
    // means interior chunks have voxelDims < stride. We just check total
    // is larger than raw and chunk count is right.
    const plan = chunkVolume([4096, 4096, 4096], 2048)
    const b = estimateChunkedBytes(plan, 1) // UINT8
    expect(b.chunkCount).toBe(27)
    // Raw RGBA bytes for 4096^3 = 256 GiB. Chunked is slightly more.
    const rawRgba = 4096 * 4096 * 4096 * 4
    expect(b.rgbaBytes).toBeGreaterThan(rawRgba)
    // Halo is small relative to chunk size — overhead should be < 1%
    expect(b.rgbaBytes).toBeLessThan(rawRgba * 1.01)
  })

  test('total is the sum of scalar + rgba + gradient', () => {
    const plan = chunkVolume([512, 512, 256], 2048)
    const b = estimateChunkedBytes(plan, 4) // FLOAT32
    expect(b.totalBytes).toBe(b.scalarBytes + b.rgbaBytes + b.gradientBytes)
  })
})

describe('formatBytes', () => {
  test('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2 * 1024)).toBe('2.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GiB')
  })
})

describe('resident chunk budget helpers', () => {
  test('computes persistent RGBA plus gradient bytes from texture dims', () => {
    expect(residentBytesForChunkDesc(testChunk([10, 20, 30]))).toBe(
      10 * 20 * 30 * 8,
    )
  })

  test('an unlit chunk costs only its RGBA bytes (placeholder gradient)', () => {
    // Unlit chunks skip the gradient pass and keep a 1x1x1 placeholder, so
    // hasGradient=false costs 4 bytes/voxel; hasGradient=true (the default,
    // asserted just below) keeps the full 8.
    expect(residentBytesForChunkDesc(testChunk([10, 20, 30]), false)).toBe(
      10 * 20 * 30 * 4,
    )
    expect(residentBytesForChunkDesc(testChunk([10, 20, 30]), true)).toBe(
      10 * 20 * 30 * 8,
    )
  })

  test('unlit pricing admits twice the volume under the same budget', () => {
    const plan = testPlan([
      testChunk([10, 10, 10]), // lit 8000 B, unlit 4000 B
      testChunk([10, 10, 10]),
      testChunk([10, 10, 10]),
      testChunk([10, 10, 10]),
    ])
    const budget = 2 * 10 * 10 * 10 * 8 // exactly two lit chunks
    expect(chunkIndicesForResidentBudget(plan, [0, 1, 2, 3], budget)).toEqual([
      0, 1,
    ])
    expect(
      chunkIndicesForResidentBudget(plan, [0, 1, 2, 3], budget, false),
    ).toEqual([0, 1, 2, 3])
  })

  test('prices lit-resident chunks at 8 bytes when lighting is toggled off', () => {
    // A chunk uploaded lit keeps its 8-byte gradient footprint until it
    // re-streams. If lighting is toggled off while such chunks are resident,
    // the current lighting state (unlit → 4 bytes) under-prices them and the
    // scan would admit more than the manager actually holds. The per-index
    // callback restores the truth: resident-lit chunks cost 8, everything else
    // falls back to the current (unlit) lighting state.
    const plan = testPlan([
      testChunk([10, 10, 10]), // resident LIT   → 8000 B
      testChunk([10, 10, 10]), // resident LIT   → 8000 B
      testChunk([10, 10, 10]), // not resident   → unlit 4000 B
      testChunk([10, 10, 10]), // not resident   → unlit 4000 B
    ])
    // Indices 0 and 1 are resident and were uploaded lit; 2 and 3 are not
    // resident yet (undefined → fall back to the current unlit state).
    const residentLit = new Map<number, boolean>([
      [0, true],
      [1, true],
    ])
    const hasGradientForIndex = (ci: number) => residentLit.get(ci)
    // Budget holds two lit chunks exactly (16000 B). Priced honestly, the two
    // resident-lit chunks fill it and nothing else is admitted.
    const budget = 2 * 10 * 10 * 10 * 8
    const picked = chunkIndicesForResidentBudget(
      plan,
      [0, 1, 2, 3],
      budget,
      false, // current lighting: unlit
      hasGradientForIndex,
    )
    expect(picked).toEqual([0, 1])
    // The returned set's real byte total (resident-lit at 8, rest at unlit 4)
    // must not exceed the budget the residency manager accounts against.
    const realBytes = picked.reduce(
      (sum, i) =>
        sum +
        residentBytesForChunkDesc(plan.chunks[i], residentLit.get(i) ?? false),
      0,
    )
    expect(realBytes).toBe(16000)
    expect(realBytes).toBeLessThanOrEqual(budget)
    // Without per-index pricing the scan would price all four at the unlit 4000
    // B and wrongly admit the whole set, over-committing the resident bytes.
    expect(
      chunkIndicesForResidentBudget(plan, [0, 1, 2, 3], budget, false),
    ).toEqual([0, 1, 2, 3])
  })

  test('selects ordered chunks by actual resident bytes', () => {
    const plan = testPlan([
      testChunk([10, 10, 10]),
      testChunk([8, 8, 8]),
      testChunk([1, 1, 1]),
      testChunk([1, 1, 1]),
    ])

    expect(chunkIndicesForResidentBudget(plan, [0, 1, 2, 3], 8016)).toEqual([
      0, 2, 3,
    ])
  })

  test('always returns the first valid chunk under a tiny budget', () => {
    const plan = testPlan([testChunk([10, 10, 10]), testChunk([1, 1, 1])])

    expect(chunkIndicesForResidentBudget(plan, [99, 1, 0], 1)).toEqual([1])
  })

  test('returns an empty working set when no ordered indices are valid', () => {
    const plan = testPlan([testChunk([10, 10, 10])])

    expect(chunkIndicesForResidentBudget(plan, [5, 6], 1000)).toEqual([])
  })

  test('returns an empty working set for an empty order', () => {
    const plan = testPlan([testChunk([4, 4, 4])])
    expect(chunkIndicesForResidentBudget(plan, [], 1_000_000)).toEqual([])
  })

  test('admits the whole ordered set when it fits the budget', () => {
    const plan = testPlan([
      testChunk([4, 4, 4]),
      testChunk([4, 4, 4]),
      testChunk([4, 4, 4]),
    ])
    const total = 3 * 4 * 4 * 4 * 8
    expect(chunkIndicesForResidentBudget(plan, [0, 1, 2], total)).toEqual([
      0, 1, 2,
    ])
    expect(chunkIndicesForResidentBudget(plan, [0, 1, 2], total * 2)).toEqual([
      0, 1, 2,
    ])
  })

  test('never exceeds the budget the residency manager accounts against', () => {
    // The cap and ChunkResidencyManager.bytesOf must agree, or a working set can
    // ask the manager to keep more than it may hold — its same-frame guard then
    // refuses to evict. Uneven bricks are exactly where a plan-average cap failed.
    const chunks = [
      testChunk([10, 10, 10]), // 8000 B
      testChunk([9, 9, 9]), //    5832 B
      testChunk([2, 2, 2]), //      64 B
      testChunk([2, 2, 2]), //      64 B
    ]
    const plan = testPlan(chunks)
    const budget = 8200
    const picked = chunkIndicesForResidentBudget(plan, [0, 1, 2, 3], budget)
    const bytes = picked.reduce(
      (sum, i) => sum + residentBytesForChunkDesc(chunks[i]),
      0,
    )
    expect(bytes).toBeLessThanOrEqual(budget)
    // Centre-first: the head of the order is never traded away for the tail.
    expect(picked[0]).toBe(0)
  })
})
