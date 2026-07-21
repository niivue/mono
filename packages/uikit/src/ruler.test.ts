import { describe, expect, it } from 'bun:test'
import { buildRuler } from './ruler'

describe('buildRuler', () => {
  it('returns nothing for a zero-length ruler', () => {
    const g = buildRuler({ a: [10, 10], b: [10, 10], length: 0 })
    expect(g.lines).toHaveLength(0)
    expect(g.text).toHaveLength(0)
  })

  it('emits an arrowed baseline (5 segments) plus ticks and one label', () => {
    const g = buildRuler({ a: [0, 0], b: [100, 0], length: 4, units: 'mm' })
    // Both-ends ARROW = shaft + 2 barbs per end = 5 segments, then 4 ticks.
    expect(g.lines.length).toBe(5 + 4)
    // Exactly one label (no tick numbers by default), reading "4.0 mm".
    expect(g.text).toHaveLength(1)
    expect(g.text[0]?.str).toBe('4.0 mm')
    expect(g.text[0]?.align).toBe(0.5)
  })

  it('omits ticks when showTicks is false', () => {
    const g = buildRuler({
      a: [0, 0],
      b: [100, 0],
      length: 4,
      showTicks: false,
    })
    expect(g.lines.length).toBe(5) // baseline only
  })

  it('adds a number at every major (fifth) tick when asked', () => {
    const g = buildRuler({
      a: [0, 0],
      b: [100, 0],
      length: 12,
      showTickNumbers: true,
    })
    // Majors at 5 and 10 -> two tick-number labels + the length label.
    const numbers = g.text.filter((t) => t.str === '5' || t.str === '10')
    expect(numbers).toHaveLength(2)
    expect(g.text).toHaveLength(3)
  })

  it('caps the tick count for an enormous measurement', () => {
    const g = buildRuler({ a: [0, 0], b: [1000, 0], length: 5000 })
    const ticks = g.lines.length - 5 // minus the 5 baseline segments
    expect(ticks).toBeLessThanOrEqual(200)
    expect(ticks).toBeGreaterThan(0)
  })

  it('keeps the label upright for a right-to-left ruler (readability guard)', () => {
    // b is to the left of a: raw angle ~ pi. The label must be flipped upright.
    const g = buildRuler({ a: [100, 0], b: [0, 0], length: 4 })
    const label = g.text[0]
    if (!label) throw new Error('no label')
    // Flipped angle ~ 0 (2*pi), never near pi (which would be upside down).
    const a = (label.rotation ?? 0) % (2 * Math.PI)
    expect(Math.abs(Math.cos(a))).toBeCloseTo(1)
    expect(Math.cos(a)).toBeGreaterThan(0)
    // Lift sign flips so the label stays on the same physical side.
    expect(label.liftPx).toBeLessThan(0)
  })
})
