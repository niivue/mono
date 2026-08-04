import { describe, expect, test } from 'bun:test'
import { computeDescriptiveStats } from './descriptives'

describe('computeDescriptiveStats', () => {
  test('countsEveryVoxelWithoutAMask', () => {
    const stats = computeDescriptiveStats([1, 2, 3, 4], 1)
    expect(stats.nVox).toBe(4)
    expect(stats.mean).toBeCloseTo(2.5)
    // Sample standard deviation (n-1), not the population one.
    expect(stats.stdev).toBeCloseTo(Math.sqrt(5 / 3))
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(4)
  })

  test('countsOnlyMaskedVoxels', () => {
    const stats = computeDescriptiveStats([1, 2, 3, 4], 1, [0, 1, 1, 0])
    expect(stats.nVox).toBe(2)
    expect(stats.mean).toBeCloseTo(2.5)
    expect(stats.min).toBe(2)
    expect(stats.max).toBe(3)
  })

  test('excludesNonFiniteVoxels', () => {
    const stats = computeDescriptiveStats(
      [1, Number.NaN, 3, Number.POSITIVE_INFINITY],
      1,
    )
    expect(stats.nVox).toBe(2)
    expect(stats.mean).toBeCloseTo(2)
  })

  test('reportsNonZeroStatisticsSeparately', () => {
    const stats = computeDescriptiveStats([0, 0, 2, 4], 1)
    expect(stats.nVox).toBe(4)
    expect(stats.mean).toBeCloseTo(1.5)
    expect(stats.nVoxNot0).toBe(2)
    expect(stats.meanNot0).toBeCloseTo(3)
    expect(stats.minNot0).toBe(2)
    expect(stats.maxNot0).toBe(4)
  })

  test('scalesVolumeByVoxelSize', () => {
    const stats = computeDescriptiveStats([1, 1, 1], 2000)
    expect(stats.volumeMM3).toBeCloseTo(6000)
    expect(stats.volumeML).toBeCloseTo(6)
  })

  test('returnsZeroesWhenNothingIsCounted', () => {
    const stats = computeDescriptiveStats([1, 2, 3], 1, [0, 0, 0])
    expect(stats.nVox).toBe(0)
    expect(stats.mean).toBe(0)
    expect(stats.stdev).toBe(0)
    expect(stats.min).toBe(0)
    expect(stats.max).toBe(0)
    expect(stats.volumeMM3).toBe(0)
  })

  test('reportsZeroDeviationForASingleVoxel', () => {
    const stats = computeDescriptiveStats([7], 1)
    expect(stats.nVox).toBe(1)
    expect(stats.mean).toBe(7)
    expect(stats.stdev).toBe(0)
  })

  test('staysAccurateForValuesWithALargeOffset', () => {
    // The naive sum-of-squares formula cancels catastrophically here; the
    // two-pass computation must still recover a deviation of 1.
    const stats = computeDescriptiveStats([1e9 - 1, 1e9, 1e9 + 1], 1)
    expect(stats.mean).toBeCloseTo(1e9)
    expect(stats.stdev).toBeCloseTo(1)
  })
})
