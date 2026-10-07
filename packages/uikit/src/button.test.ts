import { describe, expect, it } from 'bun:test'
import {
  advancePress,
  type ButtonSpec,
  buildButton,
  buttonContains,
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  mixColor,
  resolveButtonStyle,
  scaleButton,
} from './button'
import type { UIKitFontMetrics } from './text/font'
import { capHeight } from './text/layout'

// Synthetic font: every glyph advances 0.5 em; 'H' is 0.7 em tall from the
// baseline so the cap height is 0.7.
const FONT: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}

const STYLE = resolveButtonStyle(DEFAULT_BUTTON_STYLE, {
  textSizePx: 20,
  paddingX: 10,
  paddingY: 5,
  pressScale: 0.5,
  radius: 4,
})

const SPEC: ButtonSpec = { id: 'a', label: 'Hi', x: 100, y: 50 }

// Rect records are Float32, so colors come back with round-off.
function expectColor(got: Float32Array, want: readonly number[]): void {
  expect(got).toHaveLength(4)
  for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 5)
}

describe('layoutButton', () => {
  it('fits the box to the label plus padding when no size is given', () => {
    const l = layoutButton(SPEC, STYLE, FONT)
    // Label: 2 glyphs * 0.5 em * 20 px = 20 px wide; cap height 0.7 * 20 = 14 px.
    expect(l).toEqual({ x: 100, y: 50, width: 40, height: 24 })
  })

  it('honours a fixed size per axis', () => {
    const l = layoutButton({ ...SPEC, width: 120 }, STYLE, FONT)
    expect(l.width).toBe(120)
    expect(l.height).toBe(24)
    expect(layoutButton({ ...SPEC, height: 60 }, STYLE, FONT).height).toBe(60)
  })
})

describe('capHeight', () => {
  it('reads the top of H, or falls back without one', () => {
    expect(capHeight(FONT)).toBeCloseTo(0.7)
    expect(capHeight({ ...FONT, glyphs: new Map() })).toBeCloseTo(0.7)
  })
})

describe('buildButton', () => {
  const layout = layoutButton(SPEC, STYLE, FONT)

  it('draws the resting box with the rest fill and a centred label', () => {
    const { rect, text } = buildButton(SPEC, STYLE, FONT, layout, {
      hover: false,
      press: 0,
      enabled: true,
    })
    expect([...rect.data.slice(0, 5)]).toEqual([100, 50, 40, 24, 4])
    expectColor(rect.data.slice(8, 12), STYLE.fill)
    expect(text.str).toBe('Hi')
    expect(text.align).toBe(0.5)
    expect(text.x).toBe(120)
    // Baseline half a cap height (7 px) below the centre line (y = 62).
    expect(text.y).toBeCloseTo(69)
    expect(text.sizePx).toBe(20)
  })

  it('shrinks about the centre and blends toward the pressed fill', () => {
    const { rect, text } = buildButton(SPEC, STYLE, FONT, layout, {
      hover: true,
      press: 1,
      enabled: true,
    })
    // pressScale 0.5: the 40x24 box becomes 20x12, still centred on (120, 62).
    expect([...rect.data.slice(0, 4)]).toEqual([110, 56, 20, 12])
    expect(rect.data[4]).toBe(2) // radius scales too
    expectColor(rect.data.slice(8, 12), STYLE.pressedFill)
    expect(text.sizePx).toBe(10)
    expect(text.y).toBeCloseTo(62 + 3.5)
  })

  it('uses the hover fill when hovered and unpressed', () => {
    const { rect } = buildButton(SPEC, STYLE, FONT, layout, {
      hover: true,
      press: 0,
      enabled: true,
    })
    expectColor(rect.data.slice(8, 12), STYLE.hoverFill)
  })

  it('blends half-way at press 0.5', () => {
    const { rect } = buildButton(SPEC, STYLE, FONT, layout, {
      hover: false,
      press: 0.5,
      enabled: true,
    })
    expectColor(
      rect.data.slice(8, 12),
      mixColor(STYLE.fill, STYLE.pressedFill, 0.5),
    )
    expect(rect.data[2]).toBeCloseTo(30)
  })

  it('dims a disabled button and ignores hover/press', () => {
    const { rect, text } = buildButton(SPEC, STYLE, FONT, layout, {
      hover: true,
      press: 1,
      enabled: false,
    })
    expectColor(rect.data.slice(8, 12), STYLE.disabledFill)
    expect(text.color).toEqual(STYLE.disabledTextColor)
  })
})

describe('scaleButton', () => {
  it('scales positions, sizes and style lengths, leaving colors alone', () => {
    const { spec, style } = scaleButton(
      { ...SPEC, width: 30, height: undefined },
      STYLE,
      2,
    )
    expect([spec.x, spec.y, spec.width, spec.height]).toEqual([
      200,
      100,
      60,
      undefined,
    ])
    expect(style.textSizePx).toBe(40)
    expect(style.paddingX).toBe(20)
    expect(style.radius).toBe(8)
    expect(style.fill).toEqual(STYLE.fill)
    expect(style.pressMs).toBe(STYLE.pressMs)
  })

  it('returns the inputs untouched at scale 1', () => {
    const out = scaleButton(SPEC, STYLE, 1)
    expect(out.spec).toBe(SPEC)
    expect(out.style).toBe(STYLE)
  })
})

describe('advancePress', () => {
  it('snaps to the target on a non-finite duration, clock or value', () => {
    expect(advancePress(0, 1, 16, Number.NaN)).toBe(1)
    expect(advancePress(0, 1, 16, Infinity)).toBe(1)
    expect(advancePress(0, 1, Number.NaN, 100)).toBe(1)
    expect(advancePress(Number.NaN, 1, 16, 100)).toBe(1)
  })

  it('moves at a constant rate and clamps at the target', () => {
    expect(advancePress(0, 1, 50, 100)).toBeCloseTo(0.5)
    expect(advancePress(0.5, 1, 500, 100)).toBe(1)
    expect(advancePress(1, 0, 40, 160)).toBeCloseTo(0.75)
    expect(advancePress(0.3, 0.3, 10, 100)).toBe(0.3)
  })

  it('snaps when the duration is zero and holds when no time passed', () => {
    expect(advancePress(0, 1, 10, 0)).toBe(1)
    expect(advancePress(0.2, 1, 0, 100)).toBe(0.2)
  })
})

describe('buttonContains', () => {
  it('tests the resting box', () => {
    const layout = { x: 10, y: 10, width: 40, height: 20 }
    expect(buttonContains(layout, 10, 10)).toBe(true)
    expect(buttonContains(layout, 49, 29)).toBe(true)
    expect(buttonContains(layout, 50, 15)).toBe(false)
    expect(buttonContains(layout, -1, -1)).toBe(false)
  })
})
