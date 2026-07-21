import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './font'
import {
  autoOutlineColor,
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

describe('autoOutlineColor', () => {
  it('returns black for light fills and white for dark fills', () => {
    expect(autoOutlineColor([1, 1, 0, 1])).toEqual([0, 0, 0, 1]) // yellow -> black
    expect(autoOutlineColor([1, 1, 1, 1])).toEqual([0, 0, 0, 1]) // white -> black
    expect(autoOutlineColor([0, 0, 0, 1])).toEqual([1, 1, 1, 1]) // black -> white
    expect(autoOutlineColor([0, 0, 0.6, 1])).toEqual([1, 1, 1, 1]) // dark blue -> white
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

  it('maps screen corners to the matching atlas corners (no flip)', () => {
    // Asymmetric glyph so a U or V flip is detectable: plane 2 wide x 1 tall,
    // atlas rect at uv (0.1, 0.2) size (0.3, 0.4).
    const font = {
      distanceRange: 2,
      size: 50,
      textureSize: [64, 64],
      glyphs: new Map([
        ['Z', { plane: [0, 0, 2, 1], uv: [0.1, 0.2, 0.3, 0.4], xadv: 2 }],
      ]),
    } as unknown as UIKitFontMetrics
    const { vertices } = layoutText(font, 'Z', { x: 0, y: 0, sizePx: 10 })
    let topLeft = { x: Infinity, y: Infinity, u: 0, v: 0 }
    let bottomRight = { x: -Infinity, y: -Infinity, u: 0, v: 0 }
    for (let i = 0; i < 6; i++) {
      const p = vert(vertices, i)
      // Top-left screen corner: smallest x, smallest y (screen y-down).
      if (p.x <= topLeft.x && p.y <= topLeft.y) topLeft = p
      if (p.x >= bottomRight.x && p.y >= bottomRight.y) bottomRight = p
    }
    // Top-left of the glyph on screen samples the top-left of the atlas rect.
    expect(topLeft.u).toBeCloseTo(0.1)
    expect(topLeft.v).toBeCloseTo(0.2)
    // Bottom-right on screen samples the bottom-right of the atlas rect.
    expect(bottomRight.u).toBeCloseTo(0.4)
    expect(bottomRight.v).toBeCloseTo(0.6)
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
