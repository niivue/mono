import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './font'
import {
  autoOutlineColor,
  FLOATS_PER_GLYPH,
  layoutText,
  measureWidth,
  readableAngle,
} from './layout'

// Synthetic one-glyph font: 'A' is a unit em square (plane [0,0,1,1]), full-atlas
// uv [0,0,1,1], advance 1 em. Deterministic geometry for the transform tests.
const FONT: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([['A', { plane: [0, 0, 1, 1], uv: [0, 0, 1, 1], xadv: 1 }]]),
}

// Glyph record i: quad top-left, size, uv rect, rotation sin and cos - 1.
function glyph(buf: Float32Array, i: number) {
  const r = Array.from(
    buf.subarray(i * FLOATS_PER_GLYPH, (i + 1) * FLOATS_PER_GLYPH),
  )
  return {
    x: r[0],
    y: r[1],
    w: r[2],
    h: r[3],
    uv: r.slice(4, 8),
    color: r.slice(8, 12),
    sin: r[13],
    cosM1: r[14],
  }
}

describe('measureWidth', () => {
  it('sums advance * size, ignoring missing glyphs', () => {
    expect(measureWidth(FONT, 'AA', 10)).toBeCloseTo(20)
    expect(measureWidth(FONT, 'A?A', 10)).toBeCloseTo(20) // '?' missing
  })
})

describe('readableAngle', () => {
  it('passes through rightward angles unchanged', () => {
    expect(readableAngle(0)).toEqual({ angle: 0, flipped: false })
    expect(readableAngle(Math.PI / 4).flipped).toBe(false)
  })
  it('flips leftward angles by pi', () => {
    const r = readableAngle(Math.PI) // pointing left
    expect(r.flipped).toBe(true)
    expect(r.angle).toBeCloseTo(2 * Math.PI)
    expect(readableAngle((3 * Math.PI) / 4).flipped).toBe(true)
  })
})

describe('autoOutlineColor', () => {
  it('returns black for light fills and white for dark fills', () => {
    expect(autoOutlineColor([1, 1, 0, 1])).toEqual([0, 0, 0, 1]) // yellow -> black
    expect(autoOutlineColor([1, 1, 1, 1])).toEqual([0, 0, 0, 1]) // white -> black
    expect(autoOutlineColor([0, 0, 0, 1])).toEqual([1, 1, 1, 1]) // black -> white
    expect(autoOutlineColor([0, 0, 0.6, 1])).toEqual([1, 1, 1, 1]) // dark blue -> white
  })
})

describe('layoutText', () => {
  it('emits one record per rendered glyph', () => {
    const { glyphs, count } = layoutText(FONT, 'A?A', {
      x: 0,
      y: 0,
      sizePx: 10,
    })
    expect(count).toBe(2) // '?' is missing
    expect(glyphs.length).toBe(2 * FLOATS_PER_GLYPH)
  })

  it('places an unrotated glyph above the baseline, rotation floats zero', () => {
    const { glyphs } = layoutText(FONT, 'A', {
      x: 100,
      y: 100,
      sizePx: 10,
      color: [1, 0, 0, 1],
    })
    // Plane bottom pb=0 sits at the baseline y=100; top (h=1, size 10) is 10 up.
    const g = glyph(glyphs, 0)
    expect([g.x, g.y, g.w, g.h]).toEqual([100, 90, 10, 10])
    expect(g.color).toEqual([1, 0, 0, 1])
    // Exactly zero, so the shader's rotation is the identity, bit for bit.
    expect([g.sin, g.cosM1]).toEqual([0, 0])
  })

  it('passes the atlas uv rect through unflipped', () => {
    const font = {
      distanceRange: 2,
      size: 50,
      textureSize: [64, 64],
      glyphs: new Map([
        ['Z', { plane: [0, 0, 2, 1], uv: [0.1, 0.2, 0.3, 0.4], xadv: 2 }],
      ]),
    } as unknown as UIKitFontMetrics
    const g = glyph(layoutText(font, 'Z', { x: 0, y: 0, sizePx: 10 }).glyphs, 0)
    for (const [k, v] of g.uv.entries())
      expect(v).toBeCloseTo([0.1, 0.2, 0.3, 0.4][k] ?? 0)
  })

  // y-down screen space: a quarter turn runs the text downward, and the
  // glyph's top-left (one em above the baseline) swings to the pen's right.
  it('rotation by pi/2 runs the baseline downward', () => {
    const { glyphs } = layoutText(FONT, 'AA', {
      x: 0,
      y: 0,
      sizePx: 10,
      rotation: Math.PI / 2,
    })
    const a = glyph(glyphs, 0)
    const b = glyph(glyphs, 1)
    expect(b.y - a.y).toBeCloseTo(10)
    expect(a.x).toBeCloseTo(10)
    expect(a.sin).toBeCloseTo(1)
    expect(a.cosM1).toBeCloseTo(-1)
  })

  it('center alignment splits the advance width about the anchor', () => {
    const left = layoutText(FONT, 'AA', { x: 0, y: 0, sizePx: 10, align: 0 })
    const center = layoutText(FONT, 'AA', {
      x: 0,
      y: 0,
      sizePx: 10,
      align: 0.5,
    })
    // Width is 20; centering shifts the whole run left by 10 along +x.
    expect(glyph(center.glyphs, 0).x - glyph(left.glyphs, 0).x).toBeCloseTo(-10)
  })

  it('lift shifts the run perpendicular (upward at rotation 0)', () => {
    const base = layoutText(FONT, 'A', { x: 0, y: 0, sizePx: 10 })
    const lifted = layoutText(FONT, 'A', { x: 0, y: 0, sizePx: 10, liftPx: 5 })
    expect(glyph(lifted.glyphs, 0).y - glyph(base.glyphs, 0).y).toBeCloseTo(-5)
  })
})
