import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './text/font'
import {
  buildCheckMark,
  buildFocusRing,
  buildToggle,
  DEFAULT_TOGGLE_STYLE,
  layoutToggle,
  resolveToggleStyle,
  scaleToggle,
  type ToggleSpec,
  type ToggleVisual,
  toggleContains,
} from './toggle'

// Stub font: 'H' and 'i' advance half an em; cap height is 0.7 em.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const STYLE = DEFAULT_TOGGLE_STYLE
const SPEC: ToggleSpec = { id: 't', label: 'Hi', x: 100, y: 50 }
const IDLE: ToggleVisual = {
  checked: false,
  hover: false,
  pressed: false,
  focused: false,
  enabled: true,
}

function expectColor(got: ArrayLike<number>, want: readonly number[]): void {
  expect(got.length).toBe(4)
  for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 5)
}

describe('layoutToggle', () => {
  it('places the box at the origin and sizes the control to box plus label', () => {
    // Label 'Hi' at 16px is 16 wide and 11.2 tall; the box (18) is taller.
    expect(layoutToggle(SPEC, STYLE, METRICS)).toEqual({
      x: 100,
      y: 50,
      width: 42,
      height: 18,
      box: { x: 100, y: 50, size: 18 },
    })
  })

  it('centres a small box on a taller label', () => {
    const style = resolveToggleStyle(STYLE, { boxSize: 10, textSizePx: 20 })
    const l = layoutToggle(SPEC, style, METRICS)
    expect(l.height).toBe(14)
    expect(l.box).toEqual({ x: 100, y: 52, size: 10 })
  })

  it('is just the box for an empty label', () => {
    const l = layoutToggle({ ...SPEC, label: '' }, STYLE, METRICS)
    expect(l.width).toBe(18)
  })
})

describe('toggleContains', () => {
  it('covers the box and the label, half-open on the far edges', () => {
    const l = layoutToggle(SPEC, STYLE, METRICS)
    expect(toggleContains(l, 100, 50)).toBe(true)
    expect(toggleContains(l, 141, 67)).toBe(true)
    expect(toggleContains(l, 142, 60)).toBe(false)
    expect(toggleContains(l, 120, 68)).toBe(false)
    expect(toggleContains(l, 99, 60)).toBe(false)
  })
})

describe('scaleToggle', () => {
  it('scales positions and every length, leaving colors alone', () => {
    const { spec, style } = scaleToggle(SPEC, STYLE, 2)
    expect(spec.x).toBe(200)
    expect(spec.y).toBe(100)
    expect(style.boxSize).toBe(36)
    expect(style.gap).toBe(16)
    expect(style.textSizePx).toBe(32)
    expect(style.checkWidth).toBe(5)
    expect(style.focusRingWidth).toBe(4)
    expect(style.fill).toBe(STYLE.fill)
  })

  it('returns the inputs untouched at scale 1', () => {
    const r = scaleToggle(SPEC, STYLE, 1)
    expect(r.spec).toBe(SPEC)
    expect(r.style).toBe(STYLE)
  })
})

describe('buildCheckMark', () => {
  it('draws two strokes through the box', () => {
    const lines = buildCheckMark(0, 0, 100, 3, [1, 1, 1, 1])
    expect(lines.length).toBe(2)
    // Second stroke runs from the bottom of the tick up to the right corner.
    expect(lines[1].data[0]).toBeCloseTo(42)
    expect(lines[1].data[1]).toBeCloseTo(72)
    expect(lines[1].data[2]).toBeCloseTo(78)
    expect(lines[1].data[3]).toBeCloseTo(30)
  })
})

describe('buildFocusRing', () => {
  it('surrounds the box with a transparent bordered rect', () => {
    const ring = buildFocusRing(
      { x: 10, y: 20, width: 30, height: 30 },
      4,
      [0, 0, 1, 1],
      2,
    )
    const d = ring.data
    expect(d[0]).toBe(7)
    expect(d[1]).toBe(17)
    expect(d[2]).toBe(36)
    expect(d[3]).toBe(36)
    expectColor(d.slice(8, 12), [0, 0, 0, 0])
    expectColor(d.slice(12, 16), [0, 0, 1, 1])
  })
})

describe('buildToggle', () => {
  const layout = layoutToggle(SPEC, STYLE, METRICS)

  it('draws an unchecked box with no mark and the label beside it', () => {
    const geo = buildToggle(SPEC, STYLE, METRICS, layout, IDLE)
    expect(geo.rects.length).toBe(1)
    expect(geo.lines.length).toBe(0)
    expectColor(geo.rects[0].data.slice(8, 12), STYLE.fill)
    expect(geo.text.str).toBe('Hi')
    expect(geo.text.x).toBe(126)
    // Baseline sits so the cap height is centred on the box centre (59).
    expect(geo.text.y).toBeCloseTo(59 + 5.6)
    expectColor(geo.text.color ?? [], STYLE.textColor)
  })

  it('adds the check mark and the checked fill when checked', () => {
    const geo = buildToggle(SPEC, STYLE, METRICS, layout, {
      ...IDLE,
      checked: true,
    })
    expect(geo.lines.length).toBe(2)
    expectColor(geo.rects[0].data.slice(8, 12), STYLE.checkedFill)
  })

  it('uses the hover fills', () => {
    const off = buildToggle(SPEC, STYLE, METRICS, layout, {
      ...IDLE,
      hover: true,
    })
    expectColor(off.rects[0].data.slice(8, 12), STYLE.hoverFill)
    const on = buildToggle(SPEC, STYLE, METRICS, layout, {
      ...IDLE,
      hover: true,
      checked: true,
    })
    expectColor(on.rects[0].data.slice(8, 12), STYLE.checkedHoverFill)
  })

  it('shrinks the box about its centre while pressed', () => {
    const geo = buildToggle(SPEC, STYLE, METRICS, layout, {
      ...IDLE,
      pressed: true,
    })
    const d = geo.rects[0].data
    const size = 18 * STYLE.pressScale
    expect(d[2]).toBeCloseTo(size)
    expect(d[0] + size / 2).toBeCloseTo(109)
    expect(d[1] + size / 2).toBeCloseTo(59)
  })

  it('draws a focus ring first when focused', () => {
    const geo = buildToggle(SPEC, STYLE, METRICS, layout, {
      ...IDLE,
      focused: true,
    })
    expect(geo.rects.length).toBe(2)
    expectColor(geo.rects[0].data.slice(12, 16), STYLE.focusRing)
  })

  it('dims a disabled toggle, ignores press and focus, and keeps the mark', () => {
    const geo = buildToggle(SPEC, STYLE, METRICS, layout, {
      checked: true,
      hover: true,
      pressed: true,
      focused: true,
      enabled: false,
    })
    expect(geo.rects.length).toBe(1)
    expect(geo.rects[0].data[2]).toBe(18)
    expect(geo.lines.length).toBe(2)
    expectColor(geo.text.color ?? [], STYLE.disabledTextColor)
  })
})
