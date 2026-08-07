import { describe, expect, it } from 'bun:test'
import { rulerSegments, rulerTickLabels } from './NVMeasurement'

// A plain baseline (1 segment) plus two long perpendicular end caps.
const BASELINE_SEGS = 3

describe('rulerSegments', () => {
  it('returns nothing for a zero-length ruler', () => {
    expect(rulerSegments(10, 10, 10, 10, 4)).toHaveLength(0)
  })

  it('emits a baseline + end caps plus one tick per unit', () => {
    const segs = rulerSegments(0, 0, 100, 0, 4)
    // 1 baseline + 2 end caps + 4 ticks (marks 1..4).
    expect(segs).toHaveLength(BASELINE_SEGS + 4)
  })

  it('omits ticks when the unit length is zero (baseline + end caps only)', () => {
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

describe('rulerTickLabels', () => {
  it('numbers every major (fifth) unit', () => {
    const labels = rulerTickLabels(0, 0, 100, 0, 12)
    // Majors at 5 and 10.
    expect(labels.map((l) => l.str)).toEqual(['5', '10'])
  })

  it('is empty when there is no major tick', () => {
    expect(rulerTickLabels(0, 0, 100, 0, 4)).toHaveLength(0)
  })

  it('is empty for a zero-length or unit-less ruler', () => {
    expect(rulerTickLabels(0, 0, 0, 0, 50)).toHaveLength(0)
    expect(rulerTickLabels(0, 0, 100, 0, 0)).toHaveLength(0)
  })

  it('offsets numbers to one side of the baseline (the edge)', () => {
    // Horizontal line -> perpendicular is vertical, so labels share one y sign.
    const labels = rulerTickLabels(0, 0, 100, 0, 12)
    expect(labels.every((l) => l.y === labels[0].y)).toBe(true)
    expect(labels[0].y).not.toBe(0)
  })

  it('thins numbers on a long ruler so they do not collide', () => {
    // 150 units over 200 px: every-fifth (30 numbers) would smear, so far fewer
    // are emitted, each still a multiple of 5.
    const labels = rulerTickLabels(0, 0, 200, 0, 150, 6, 12)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(30)
    for (const l of labels) expect(Number(l.str) % 5).toBe(0)
  })
})
