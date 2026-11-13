import { describe, expect, test } from 'bun:test'
import { decodedTierBudgetBytes } from './decodedChunkCache'

describe('decodedTierBudgetBytes', () => {
  test('shadows the resident set plus a tail', () => {
    // uint8 source: an unlit resident chunk is 4 bytes/voxel on the GPU, 1 on the CPU.
    expect(decodedTierBudgetBytes(800, 1)).toBe(300)
    // float32 source: the GPU footprint, so the tier is the budget plus the tail.
    expect(decodedTierBudgetBytes(800, 4)).toBe(1200)
  })

  test('holds more than the unlit resident set of a uint8 volume (#203)', () => {
    const gpu = 256 * 1024 * 1024
    const residentVoxels = gpu / 4
    expect(decodedTierBudgetBytes(gpu, 1)).toBeGreaterThan(residentVoxels)
  })

  test('never exceeds the ceiling', () => {
    expect(decodedTierBudgetBytes(8_000_000_000, 4, 1000)).toBe(1000)
  })

  test('is zero for a degenerate budget or datatype', () => {
    expect(decodedTierBudgetBytes(0, 2)).toBe(0)
    expect(decodedTierBudgetBytes(1000, 0)).toBe(0)
    expect(decodedTierBudgetBytes(Number.NaN, 2)).toBe(0)
  })
})
