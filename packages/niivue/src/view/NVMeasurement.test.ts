import { describe, expect, it } from 'bun:test'
import {
  formatDistance,
  rulerLengthLabel,
  rulerTickLabels,
} from './NVMeasurement'

describe('rulerTickLabels', () => {
  it('numbers every major (fifth) unit', () => {
    const labels = rulerTickLabels(0, 0, 240, 0, 12)
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

  it('keeps the length clear of the numbers whichever way it was drawn', () => {
    for (const [sx, ex] of [
      [0, 100],
      [100, 0],
    ]) {
      // Numbers below a horizontal ruler; the length sits above, bottom-anchored.
      expect(rulerTickLabels(sx, 50, ex, 50, 12)[0].y).toBeGreaterThan(50)
      const at = rulerLengthLabel(sx, 50, ex, 50)
      expect(at.y).toBeLessThan(50)
      expect([at.anchorX, at.anchorY]).toEqual([0.5, 1])
    }
    // Vertical: numbers right, the length to the left, right-anchored.
    for (const [sy, ey] of [
      [0, 100],
      [100, 0],
    ]) {
      expect(rulerTickLabels(50, sy, 50, ey, 12)[0].x).toBeGreaterThan(50)
      const at = rulerLengthLabel(50, sy, 50, ey)
      expect(at.x).toBeLessThan(50)
      expect(at.anchorX).toBe(1)
    }
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

describe('formatDistance', () => {
  it('suffixes the scene unit', () => {
    expect(formatDistance(1234, true, 'um')).toBe('1234 um')
    expect(formatDistance(4.5, true)).toBe('4.50 mm')
    expect(formatDistance(4.5, false, 'um')).toBe('4.50')
  })
})

describe('ruler tick thinning', () => {
  it('a long ruler steps 1/2/5 so majors stay on round values', () => {
    // 500 units: 200-tick cap gives raw step 2.5, rounded to 5, not 3.
    const nums = rulerTickLabels(0, 0, 5000, 0, 500, 6, 1).map((t) => t.str)
    // Labels sit on every fifth drawn tick: 25, 50, ...
    expect(nums[0]).toBe('25')
    expect(nums.every((n) => Number(n) % 25 === 0)).toBe(true)
  })
})
