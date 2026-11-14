import { describe, expect, it } from 'bun:test'
import { layoutMagnifier, type MagnifierSpec } from './magnifier'

const spec = (over: Partial<MagnifierSpec> = {}): MagnifierSpec => ({
  x: 400,
  y: 300,
  width: 800,
  height: 600,
  dpr: 2,
  radiusCss: 50,
  zoom: 4,
  ...over,
})

describe('layoutMagnifier', () => {
  it('centres the lens on the pointer, radius in device px', () => {
    const l = layoutMagnifier(spec())
    expect(l?.radius).toBe(100)
    expect(l?.lens).toEqual({ x: 300, y: 200, width: 200, height: 200 })
  })

  it('shows a source 1/zoom the lens size around the same point', () => {
    const l = layoutMagnifier(spec())
    expect(l?.source).toEqual({ x: 375, y: 275, width: 50, height: 50 })
  })

  it('keeps the magnified point under the pointer at an edge', () => {
    const l = layoutMagnifier(spec({ x: 0, y: 599 }))
    expect(l?.centerX).toBe(0)
    expect(l?.centerY).toBe(599)
    expect(l?.source.x).toBe(-25)
  })

  it('is null off the drawable (a pointer leave)', () => {
    expect(layoutMagnifier(spec({ x: -1, y: -1 }))).toBeNull()
    expect(layoutMagnifier(spec({ x: 800 }))).toBeNull()
    expect(layoutMagnifier(spec({ y: 600 }))).toBeNull()
  })
})
