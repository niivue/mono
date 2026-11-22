import { describe, expect, it } from 'bun:test'
import {
  layoutRadialMenu,
  type RadialMenuItem,
  radialItemAt,
  radialMenuContains,
  DEFAULT_RADIAL_MENU_STYLE as STYLE,
} from './radialMenu'
import type { UIKitFontMetrics } from './text/font'

// 'H' advances 0.5 em, so a 13 px label of n H's is 6.5n px wide.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}

const pills = (n: number, ring = 0): RadialMenuItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${ring}-${i}`,
    label: 'HH',
    ring,
  }))
const swatches = (n: number): RadialMenuItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    label: 'Red',
    color: [1, 0, 0, 1] as const,
    ring: 1,
  }))
const centre = (f: { x: number; y: number; width: number; height: number }) => [
  f.x + f.width / 2,
  f.y + f.height / 2,
]
// Pills and swatches are round-ended, so each fits a circle of its width.
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
) => {
  const [ax, ay] = centre(a)
  const [bx, by] = centre(b)
  return Math.hypot(ax - bx, ay - by) < (a.width + b.width) / 2
}

describe('layoutRadialMenu', () => {
  it('starts each ring at 12 o clock and keeps every item apart', () => {
    const items = [...pills(5), ...swatches(12)]
    const layout = layoutRadialMenu(items, 300, 300, STYLE, METRICS, null)
    const [x, y] = centre(layout.items[0])
    expect(x).toBeCloseTo(300)
    expect(y).toBeCloseTo(300 - STYLE.innerRadius)
    const [sx, sy] = centre(layout.items[5])
    expect(sx).toBeCloseTo(300)
    expect(sy).toBeLessThan(y)
    expect(layout.items[5].width).toBe(STYLE.itemSize)
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        expect(overlaps(layout.items[i], layout.items[j])).toBe(false)
    // The backdrop holds every face's circle.
    for (const face of layout.items) {
      const [fx, fy] = centre(face)
      const reach = Math.hypot(fx - layout.cx, fy - layout.cy) + face.width / 2
      expect(reach).toBeLessThanOrEqual(layout.radius)
    }
    expect(radialMenuContains(layout, 300, 300 - layout.radius + 1)).toBe(true)
    expect(radialMenuContains(layout, 300, 300 - layout.radius - 1)).toBe(false)
  })

  it('pushes a crowded ring out', () => {
    const few = layoutRadialMenu(pills(3), 0, 0, STYLE, METRICS, null)
    const many = layoutRadialMenu(pills(20), 0, 0, STYLE, METRICS, null)
    expect(many.radius).toBeGreaterThan(few.radius)
  })

  it('pulls a menu opened at an edge inside the bounds', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 }
    const layout = layoutRadialMenu(pills(4), 5, 595, STYLE, METRICS, bounds)
    expect(layout.cx - layout.radius).toBeCloseTo(0)
    expect(layout.cy + layout.radius).toBeCloseTo(600)
  })

  it('hits enabled items only', () => {
    const items = pills(2)
    items[1].enabled = false
    const layout = layoutRadialMenu(items, 300, 300, STYLE, METRICS, null)
    const [x0, y0] = centre(layout.items[0])
    const [x1, y1] = centre(layout.items[1])
    expect(radialItemAt(items, layout, x0, y0)).toBe(0)
    expect(radialItemAt(items, layout, x1, y1)).toBe(-1)
    expect(radialItemAt(items, layout, 300, 300)).toBe(-1)
  })
})
