import { describe, expect, it } from 'bun:test'
import { buildCrosshair } from './crosshair'
import type { LineData } from './line'

// [sx, sy, ex, ey] of a LineData record.
function ends(line: LineData | undefined): number[] {
  const d = line?.data
  return [d?.[0] ?? 0, d?.[1] ?? 0, d?.[2] ?? 0, d?.[3] ?? 0]
}

// Thickness is the fifth float of the record.
function thicknessOf(line: LineData | undefined): number {
  return line?.data[4] ?? 0
}

describe('buildCrosshair', () => {
  it('emits four gapped arms reaching the frame edges', () => {
    const g = buildCrosshair({ at: [50, 40], width: 100, height: 80, gapPx: 6 })
    expect(g.lines).toHaveLength(4)
    expect(g.text).toHaveLength(0)
    expect(ends(g.lines[0])).toEqual([0, 40, 44, 40])
    expect(ends(g.lines[1])).toEqual([56, 40, 100, 40])
    expect(ends(g.lines[2])).toEqual([50, 0, 50, 34])
    expect(ends(g.lines[3])).toEqual([50, 46, 50, 80])
  })

  it('leaves the centre pixel uncovered', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 10,
    })
    // No segment spans the centre on either axis.
    for (const line of g.lines) {
      const [sx, sy, ex, ey] = ends(line)
      const spansX = Math.min(sx, ex) < 50 && Math.max(sx, ex) > 50
      const spansY = Math.min(sy, ey) < 40 && Math.max(sy, ey) > 40
      expect(spansX && spansY).toBe(false)
    }
  })

  it('honors a finite arm length instead of reaching the edges', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 6,
      armPx: 10,
    })
    expect(ends(g.lines[0])).toEqual([34, 40, 44, 40])
    expect(ends(g.lines[1])).toEqual([56, 40, 66, 40])
  })

  it('draws an unbroken cross when the gap is zero', () => {
    const g = buildCrosshair({ at: [50, 40], width: 100, height: 80, gapPx: 0 })
    expect(g.lines).toHaveLength(4)
    expect(ends(g.lines[0])).toEqual([0, 40, 50, 40])
  })

  it('drops the axis whose centre is off-frame, keeping the other', () => {
    // Panned off the left edge: the row is still meaningful, the column is not.
    const g = buildCrosshair({ at: [-30, 40], width: 100, height: 80 })
    expect(g.lines).toHaveLength(1)
    const [sx, , ex] = ends(g.lines[0])
    expect(sx).toBe(0)
    expect(ex).toBe(100)
  })

  it('returns nothing for a non-finite centre or an empty frame', () => {
    expect(
      buildCrosshair({ at: [Number.NaN, 40], width: 100, height: 80 }).lines,
    ).toHaveLength(0)
    expect(
      buildCrosshair({ at: [50, 40], width: 0, height: 80 }).lines,
    ).toHaveLength(0)
  })

  it('graduates both arms of an axis outward from the centre', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 20,
      showTicks: true,
      pxPerUnit: 10,
      tickLength: 4,
    })
    // Two arms + 2 ticks each way on x (10, 20), same on y.
    const xTicks = g.lines.filter((l) => ends(l)[0] === ends(l)[2])
    // Vertical strokes: the two vertical ARMS plus the horizontal arm's ticks.
    expect(xTicks.length).toBe(2 + 4)
    // A tick at 10px left of centre, straddling the arm.
    expect(ends(g.lines[2])).toEqual([40, 36, 40, 44])
  })

  it('skips graduation when no scale is supplied', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      showTicks: true,
    })
    expect(g.lines).toHaveLength(4)
  })

  it('draws majors twice the length of minors', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 50,
      showTicks: true,
      pxPerUnit: 5,
      tickLength: 4,
    })
    // Unit 5 is the first major, at 25px from centre.
    const major = g.lines.find((l) => ends(l)[0] === 75 && ends(l)[1] === 32)
    expect(major).toBeDefined()
    expect(ends(major)).toEqual([75, 32, 75, 48])
  })

  it('numbers the majors only, with the unit suffix when given', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 50,
      showTicks: true,
      showTickNumbers: true,
      pxPerUnit: 5,
      units: 'um',
      sizePx: 6,
    })
    expect(g.text.length).toBeGreaterThan(0)
    // Distance from the centre, so both sides of an axis carry the same value.
    expect(g.text.every((t) => /^\d+ um$/.test(t.str))).toBe(true)
    expect(g.text.some((t) => t.str === '5 um')).toBe(true)
    // Nothing at a minor (units 1-4).
    expect(g.text.some((t) => t.str === '3 um')).toBe(false)
  })

  it('drops numbers that would collide, keeping the ticks', () => {
    const dense = {
      at: [50, 40] as const,
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 50,
      showTicks: true,
      showTickNumbers: true,
      pxPerUnit: 1,
      sizePx: 20,
    }
    const g = buildCrosshair(dense)
    const roomy = buildCrosshair({ ...dense, sizePx: 4 })
    expect(g.text.length).toBeLessThan(roomy.text.length)
    expect(g.lines.length).toBe(roomy.lines.length)
  })

  it('spaces ticks by unitsPerTick and numbers them by distance', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 50,
      showTicks: true,
      showTickNumbers: true,
      // One unit is 1px, but ticks land every 10 units.
      pxPerUnit: 1,
      unitsPerTick: 10,
      units: 'um',
      sizePx: 6,
      tickLength: 4,
    })
    // First tick 10px out, first major (fifth tick) at 50 units.
    expect(ends(g.lines[2])).toEqual([40, 36, 40, 44])
    // The number reads the distance, not the tick index.
    expect(g.text.some((t) => t.str === '50 um')).toBe(true)
    expect(g.text.some((t) => t.str === '5 um')).toBe(false)
  })

  it('keeps fractional tick values short', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 50,
      showTicks: true,
      showTickNumbers: true,
      pxPerUnit: 20,
      unitsPerTick: 0.25,
      sizePx: 6,
    })
    // Fifth tick = 1.25 units, not 1.2500000000000002.
    expect(g.text.some((t) => t.str === '1.25')).toBe(true)
  })

  it('graduates each arm on its own scale when given a pair', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 20,
      showTicks: true,
      // x every 10px, y every 5px: an anisotropic plane.
      pxPerUnit: [10, 5],
      tickLength: 4,
    })
    // Horizontal arm ticks are vertical strokes at 10px steps.
    expect(ends(g.lines[2])).toEqual([40, 36, 40, 44])
    // Vertical arm ticks are horizontal strokes at 5px steps.
    const first = g.lines.find(
      (l) => ends(l)[1] === 35 && ends(l)[1] === ends(l)[3],
    )
    expect(ends(first)).toEqual([46, 35, 54, 35])
  })

  it('defaults tick thickness to half the line thickness', () => {
    const g = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 20,
      thickness: 6,
      showTicks: true,
      pxPerUnit: 10,
    })
    expect(thicknessOf(g.lines[0])).toBe(6)
    expect(thicknessOf(g.lines[2])).toBe(3)
    const explicit = buildCrosshair({
      at: [50, 40],
      width: 100,
      height: 80,
      gapPx: 0,
      armPx: 20,
      thickness: 6,
      tickThickness: 5,
      showTicks: true,
      pxPerUnit: 10,
    })
    expect(thicknessOf(explicit.lines[2])).toBe(5)
  })
})
