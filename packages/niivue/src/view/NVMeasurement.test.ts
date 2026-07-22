import { describe, expect, it } from 'bun:test'
import { rulerSegments } from './NVMeasurement'

// A both-ends arrowed baseline is 5 segments (shaft + 2 barbs per end).
const BASELINE_SEGS = 5

describe('rulerSegments', () => {
  it('returns nothing for a zero-length ruler', () => {
    expect(rulerSegments(10, 10, 10, 10, 4)).toHaveLength(0)
  })

  it('emits an arrowed baseline plus one tick per unit', () => {
    const segs = rulerSegments(0, 0, 100, 0, 4)
    // 5 baseline segments + 4 ticks (marks 1..4).
    expect(segs).toHaveLength(BASELINE_SEGS + 4)
  })

  it('omits ticks when the unit length is zero (baseline only)', () => {
    expect(rulerSegments(0, 0, 100, 0, 0)).toHaveLength(BASELINE_SEGS)
  })

  it('makes every fifth tick a major (twice as long)', () => {
    // Horizontal line 0..100 px, 10 units -> ticks every 10px. Tick i is a
    // vertical segment straddling the baseline; its half-length is tickLength
    // (6) for minors and 2x for majors (i % 5 === 0).
    const segs = rulerSegments(0, 0, 100, 0, 10)
    const ticks = segs.slice(BASELINE_SEGS)
    expect(ticks).toHaveLength(10)
    const halfHeight = (s: readonly number[]) => Math.abs(s[3] - s[1]) / 2
    // i = 5 is the 5th tick (index 4) -> major; i = 4 (index 3) -> minor.
    expect(halfHeight(ticks[4])).toBeCloseTo(12) // 6 * 2
    expect(halfHeight(ticks[3])).toBeCloseTo(6)
  })

  it('caps the tick count for an enormous measurement', () => {
    const segs = rulerSegments(0, 0, 1000, 0, 5000)
    const ticks = segs.length - BASELINE_SEGS
    expect(ticks).toBeLessThanOrEqual(200)
    expect(ticks).toBeGreaterThan(0)
  })
})
