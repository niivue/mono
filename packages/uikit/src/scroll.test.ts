import { describe, expect, it } from 'bun:test'
import {
  buildScrollArrow,
  canScrollDown,
  canScrollUp,
  revealRow,
  scrollWindow,
  WheelAccumulator,
} from './scroll'

// Five rows: item, item, separator, item, item.
const HEIGHTS = [28, 28, 9, 28, 28]

describe('scrollWindow', () => {
  it('shows the whole rows that fit from the first row', () => {
    const w = scrollWindow(HEIGHTS, 60, 0)
    expect(w).toEqual({ first: 0, end: 2, maxFirst: 3, usedHeight: 56 })
    // From row 1 the separator fits but the next item does not.
    expect(scrollWindow(HEIGHTS, 60, 1)).toMatchObject({
      first: 1,
      end: 3,
      usedHeight: 37,
    })
  })

  it('clamps the first row so the list never scrolls past its end', () => {
    expect(scrollWindow(HEIGHTS, 60, 10)).toMatchObject({ first: 3, end: 5 })
    expect(scrollWindow(HEIGHTS, 60, -2)).toMatchObject({ first: 0, end: 2 })
    expect(scrollWindow(HEIGHTS, 60, 1.9).first).toBe(1)
  })

  it('shows everything when it all fits, and nothing when no row fits', () => {
    expect(scrollWindow(HEIGHTS, 200, 2)).toEqual({
      first: 0,
      end: 5,
      maxFirst: 0,
      usedHeight: 121,
    })
    expect(scrollWindow(HEIGHTS, 20, 0)).toEqual({
      first: 0,
      end: 0,
      maxFirst: 5,
      usedHeight: 0,
    })
    expect(scrollWindow([], 60, 3)).toEqual({
      first: 0,
      end: 0,
      maxFirst: 0,
      usedHeight: 0,
    })
  })
})

describe('revealRow', () => {
  it('leaves a visible row alone and scrolls up to one above', () => {
    expect(revealRow(HEIGHTS, 60, { first: 0, end: 2 }, 1)).toBe(0)
    expect(revealRow(HEIGHTS, 60, { first: 3, end: 5 }, 1)).toBe(1)
    expect(revealRow(HEIGHTS, 60, { first: 3, end: 5 }, 0)).toBe(0)
  })

  it('scrolls down just far enough for a row below to be the last shown', () => {
    // Row 4 plus row 3 fit (56); adding the separator would not (65).
    expect(revealRow(HEIGHTS, 60, { first: 0, end: 2 }, 4)).toBe(3)
    expect(revealRow(HEIGHTS, 60, { first: 0, end: 2 }, 3)).toBe(2)
  })

  it('ignores an index outside the list', () => {
    expect(revealRow(HEIGHTS, 60, { first: 1, end: 3 }, -1)).toBe(1)
    expect(revealRow(HEIGHTS, 60, { first: 1, end: 3 }, 5)).toBe(1)
  })
})

describe('canScrollUp / canScrollDown', () => {
  it('report rows beyond each end of the shown range', () => {
    expect(canScrollUp({ first: 0, end: 2 })).toBe(false)
    expect(canScrollUp({ first: 1, end: 3 })).toBe(true)
    expect(canScrollDown({ first: 0, end: 2 }, 5)).toBe(true)
    expect(canScrollDown({ first: 3, end: 5 }, 5)).toBe(false)
  })
})

describe('WheelAccumulator', () => {
  it('turns pixel deltas into whole row steps and carries the rest', () => {
    const acc = new WheelAccumulator(28)
    expect(acc.add(10)).toBe(0)
    expect(acc.add(20)).toBe(1) // 30: one row, 2 carried
    expect(acc.add(-30)).toBe(-1) // -28 exactly
    expect(acc.add(84)).toBe(3)
  })

  it('ignores bad input and can drop its carry', () => {
    const acc = new WheelAccumulator(28)
    expect(acc.add(Number.NaN)).toBe(0)
    expect(acc.add(27)).toBe(0)
    acc.reset()
    expect(acc.add(1)).toBe(0)
    expect(new WheelAccumulator(0).add(100)).toBe(0)
  })
})

describe('buildScrollArrow', () => {
  const strip = { x: 0, y: 0, width: 40, height: 14 }
  const style = {
    height: 14,
    arrowSize: 10,
    arrowWidth: 1.5,
    arrowColor: [1, 1, 1, 0.8] as [number, number, number, number],
  }
  const ends = (d: Float32Array) => [...d.slice(0, 4)]

  it('draws a chevron pointing up or down, centred on the strip', () => {
    const up = buildScrollArrow(strip, -1, style)
    expect(up).toHaveLength(2)
    expect(ends(up[0].data)).toEqual([15, 9.5, 20, 4.5])
    expect(ends(up[1].data)).toEqual([20, 4.5, 25, 9.5])
    expect(up[0].data[4]).toBe(1.5)
    expect([...up[0].data.slice(8, 11)]).toEqual([1, 1, 1])
    expect(up[0].data[11]).toBeCloseTo(0.8, 5)
    const down = buildScrollArrow(strip, 1, style)
    expect(ends(down[0].data)).toEqual([15, 4.5, 20, 9.5])
    expect(ends(down[1].data)).toEqual([20, 9.5, 25, 4.5])
  })
})
