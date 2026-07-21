import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './font'
import {
  FLOATS_PER_VERTEX,
  layoutText,
  measureWidth,
  readableAngle,
  VERTICES_PER_GLYPH,
} from './layout'

// Synthetic one-glyph font: 'A' is a unit em square (plane [0,0,1,1]), full-atlas
// uv [0,0,1,1], advance 1 em. Deterministic geometry for the transform tests.
const FONT: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([['A', { plane: [0, 0, 1, 1], uv: [0, 0, 1, 1], xadv: 1 }]]),
}

// Read vertex i's [x, y, u, v] from a packed buffer.
function vert(buf: Float32Array, i: number) {
  const o = i * FLOATS_PER_VERTEX
  return { x: buf[o], y: buf[o + 1], u: buf[o + 2], v: buf[o + 3] }
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

describe('layoutText', () => {
  it('emits six vertices per rendered glyph', () => {
    const { vertices, count } = layoutText(FONT, 'AA', {
      x: 0,
      y: 0,
      sizePx: 10,
    })
    expect(count).toBe(2 * VERTICES_PER_GLYPH)
    expect(vertices.length).toBe(2 * VERTICES_PER_GLYPH * FLOATS_PER_VERTEX)
  })

  it('places an unrotated glyph as an axis-aligned quad above the baseline', () => {
    const { vertices } = layoutText(FONT, 'A', {
      x: 100,
      y: 100,
      sizePx: 10,
      color: [1, 0, 0, 1],
    })
    // 6 verts, corners TL(0,0) BL(0,1) TR(1,0) [tri1], TR BL BR(1,1) [tri2].
    const xs = []
    const ys = []
    for (let i = 0; i < 6; i++) {
      const p = vert(vertices, i)
      xs.push(p.x)
      ys.push(p.y)
    }
    // Plane bottom pb=0 sits at the baseline y=100; top (h=1, size 10) is 10 up.
    expect(Math.min(...xs)).toBeCloseTo(100)
    expect(Math.max(...xs)).toBeCloseTo(110)
    expect(Math.min(...ys)).toBeCloseTo(90) // above baseline (screen y-down)
    expect(Math.max(...ys)).toBeCloseTo(100)
    // Corner colors are the requested color.
    const o = 0
    expect([
      vertices[o + 4],
      vertices[o + 5],
      vertices[o + 6],
      vertices[o + 7],
    ]).toEqual([1, 0, 0, 1])
  })

  it('rotation by pi/2 runs the baseline downward', () => {
    const { vertices } = layoutText(FONT, 'AA', {
      x: 0,
      y: 0,
      sizePx: 10,
      rotation: Math.PI / 2,
    })
    // Second glyph advances along +y (screen-down) for a 90-degree rotation.
    const firstOriginY = vert(vertices, 0).y
    const secondOriginY = vert(vertices, VERTICES_PER_GLYPH).y
    expect(secondOriginY - firstOriginY).toBeCloseTo(10)
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
    expect(vert(center.vertices, 0).x - vert(left.vertices, 0).x).toBeCloseTo(
      -10,
    )
  })

  it('lift shifts the run perpendicular (upward at rotation 0)', () => {
    const base = layoutText(FONT, 'A', { x: 0, y: 0, sizePx: 10 })
    const lifted = layoutText(FONT, 'A', { x: 0, y: 0, sizePx: 10, liftPx: 5 })
    expect(vert(lifted.vertices, 0).y - vert(base.vertices, 0).y).toBeCloseTo(
      -5,
    )
  })
})
