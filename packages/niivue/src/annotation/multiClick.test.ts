import { describe, expect, it } from 'bun:test'
import {
  shouldAppendMultiClickPoint,
  shouldStartFreshMultiClickContour,
} from './multiClick'

describe('shouldAppendMultiClickPoint', () => {
  it('appends the first point of a contour', () => {
    expect(shouldAppendMultiClickPoint(1, undefined, { x: 1, y: 2 }, 0.5)).toBe(
      true,
    )
  })

  it('appends a point away from the last one', () => {
    expect(
      shouldAppendMultiClickPoint(1, { x: 0, y: 0 }, { x: 5, y: 5 }, 0.5),
    ).toBe(true)
  })

  it('skips the second press of a double-click', () => {
    // evt.detail is 2 on the second pointerdown of a double-click; appending
    // there gives a single placed point + double-click three points (two
    // coincident), which passes the >= 3-point commit guard as a degenerate
    // near-zero-area contour.
    expect(
      shouldAppendMultiClickPoint(2, { x: 0, y: 0 }, { x: 9, y: 9 }, 0.5),
    ).toBe(false)
  })

  it('skips a point coincident with the last one', () => {
    // A coincident closing pair puts a Catmull-Rom cusp at the close point.
    expect(
      shouldAppendMultiClickPoint(1, { x: 3, y: 4 }, { x: 3.1, y: 4.1 }, 0.5),
    ).toBe(false)
  })
})

describe('shouldStartFreshMultiClickContour', () => {
  it('starts fresh when there are no prior points', () => {
    expect(shouldStartFreshMultiClickContour(false, 0, 12, 0, 12)).toBe(true)
  })

  it('starts fresh when the orientation changes', () => {
    expect(shouldStartFreshMultiClickContour(true, 0, 12, 1, 12)).toBe(true)
  })

  it('starts fresh when depth changes within the same orientation', () => {
    expect(shouldStartFreshMultiClickContour(true, 0, 12, 0, 13)).toBe(true)
  })

  it('keeps the contour on the same slice within numeric tolerance', () => {
    expect(shouldStartFreshMultiClickContour(true, 0, 12, 0, 12.0005)).toBe(
      false,
    )
  })
})
