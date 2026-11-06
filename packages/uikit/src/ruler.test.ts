import { describe, expect, it } from 'bun:test'
import { buildRuler } from './ruler'

describe('buildRuler', () => {
  it('returns nothing for a zero-length ruler', () => {
    const g = buildRuler({ a: [10, 10], b: [10, 10], length: 0 })
    expect(g.lines).toHaveLength(0)
    expect(g.text).toHaveLength(0)
  })

  it('emits a plain baseline plus end caps, ticks and one label', () => {
    const g = buildRuler({ a: [0, 0], b: [100, 0], length: 4, units: 'mm' })
    // 1 baseline segment, then 2 end caps, then 4 ticks.
    expect(g.lines.length).toBe(1 + 2 + 4)
    // Exactly one label (no tick numbers by default), reading "4.0 mm".
    expect(g.text).toHaveLength(1)
    expect(g.text[0]?.str).toBe('4.0 mm')
    expect(g.text[0]?.align).toBe(0.5)
    // Labels get a readability outline by default.
    expect(g.text[0]?.outlineWidthPx).toBe(2)
  })

  it('honors an explicit textOutlineWidthPx (0 disables the outline)', () => {
    const g = buildRuler({
      a: [0, 0],
      b: [100, 0],
      length: 4,
      textOutlineWidthPx: 0,
    })
    expect(g.text[0]?.outlineWidthPx).toBe(0)
  })

  it('omits ticks when showTicks is false', () => {
    const g = buildRuler({
      a: [0, 0],
      b: [100, 0],
      length: 4,
      showTicks: false,
    })
    expect(g.lines.length).toBe(1 + 2) // baseline + two end caps
  })

  it('omits end caps when showEndCaps is false', () => {
    const g = buildRuler({
      a: [0, 0],
      b: [100, 0],
      length: 4,
      showTicks: false,
      showEndCaps: false,
    })
    expect(g.lines.length).toBe(1) // baseline only
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

  it('thins graduation numbers on a long ruler so they do not collide', () => {
    // 100 units over 200 px with a big label size: numbering every fifth (20
    // numbers) would overlap, so far fewer are emitted, each still a multiple of 5.
    const g = buildRuler({
      a: [0, 0],
      b: [200, 0],
      length: 100,
      sizePx: 40,
      showTickNumbers: true,
    })
    const numbers = g.text.filter((t) => t.str !== '100.0')
    expect(numbers.length).toBeGreaterThan(0)
    expect(numbers.length).toBeLessThan(20)
    for (const n of numbers) expect(Number(n.str) % 5).toBe(0)
  })

  it('caps the tick count for an enormous measurement', () => {
    const g = buildRuler({ a: [0, 0], b: [1000, 0], length: 5000 })
    const ticks = g.lines.length - 1 - 2 // minus baseline (1) and end caps (2)
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

describe('buildRuler tick thinning', () => {
  it('a long ruler steps 1/2/5 so numbered ticks stay on round values', () => {
    // 500 units: the 200-tick cap needs a step of 2.5, rounded to 5, not 3.
    const g = buildRuler({
      a: [0, 0],
      b: [5000, 0],
      length: 500,
      sizePx: 2,
      showTickNumbers: true,
    })
    const nums = g.text.map((t) => Number(t.str)).filter(Number.isInteger)
    // Numbers sit on every fifth drawn tick: 25, 50, ...
    expect(nums[0]).toBe(25)
    expect(nums.every((n) => n % 25 === 0)).toBe(true)
  })

  it('keeps majors every fifth drawn tick once the step reaches 5', () => {
    // 1000 units: 200 ticks at step 5, so 40 majors (every 25 units).
    const g = buildRuler({ a: [0, 0], b: [1000, 0], length: 1000 })
    const lengths = g.lines
      .slice(3)
      .map((l) => Math.abs((l.data?.[3] ?? 0) - (l.data?.[1] ?? 0)))
    expect(lengths).toHaveLength(200)
    expect(lengths.filter((l) => l === 24)).toHaveLength(40)
  })
})
