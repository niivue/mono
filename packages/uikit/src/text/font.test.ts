import { describe, expect, it } from 'bun:test'
import { parseFont, screenPxRange } from './font'

const RAW = {
  atlas: { width: 100, height: 200, distanceRange: 2, size: 50 },
  glyphs: [
    { unicode: 32, advance: 0.25 }, // space: no bounds -> skipped
    {
      unicode: 65, // 'A'
      advance: 0.6,
      atlasBounds: { left: 10, right: 30, top: 180, bottom: 140 },
      planeBounds: { left: 0.05, right: 0.55, top: 0.7, bottom: -0.1 },
    },
  ],
}

describe('parseFont', () => {
  it('skips glyphs without bounds and parses the rest', () => {
    const f = parseFont(RAW)
    expect(f.glyphs.has(' ')).toBe(false)
    expect(f.glyphs.has('A')).toBe(true)
    expect(f.glyphs.size).toBe(1)
    expect(f.distanceRange).toBe(2)
    expect(f.size).toBe(50)
    expect(f.textureSize).toEqual([100, 200])
  })

  it('normalizes uv (bottom-origin, flipped) and plane (em, l/b/w/h)', () => {
    const g = parseFont(RAW).glyphs.get('A')
    if (!g) throw new Error('missing A')
    // uv: left=10/100, bottom=(200-180)/200, width=(30-10)/100, height=(180-140)/200
    expect(g.uv[0]).toBeCloseTo(0.1)
    expect(g.uv[1]).toBeCloseTo(0.1)
    expect(g.uv[2]).toBeCloseTo(0.2)
    expect(g.uv[3]).toBeCloseTo(0.2)
    // plane: left, bottom, right-left, top-bottom
    expect(g.plane[0]).toBeCloseTo(0.05)
    expect(g.plane[1]).toBeCloseTo(-0.1)
    expect(g.plane[2]).toBeCloseTo(0.5)
    expect(g.plane[3]).toBeCloseTo(0.8)
    expect(g.xadv).toBeCloseTo(0.6)
  })
})

describe('screenPxRange', () => {
  it('scales distance range by size ratio, floored at 1', () => {
    const f = parseFont(RAW)
    // (100 / 50) * 2 = 4
    expect(screenPxRange(f, 100)).toBeCloseTo(4)
    // Tiny text floors at 1
    expect(screenPxRange(f, 1)).toBe(1)
  })
})
