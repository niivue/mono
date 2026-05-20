import { describe, expect, test } from 'bun:test'
import {
  bytesPerSourceVoxel,
  estimateChunkedBytes,
  formatBytes,
} from './chunkBudget'
import { chunkVolume } from './chunking'

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
