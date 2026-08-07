import { describe, expect, it } from 'bun:test'
import { shouldStartFreshMultiClickContour } from './multiClick'

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
