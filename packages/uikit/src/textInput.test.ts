import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './text/font'
import { textEditState } from './textEdit'
import {
  buildTextInput,
  DEFAULT_TEXT_INPUT_STYLE,
  layoutTextInput,
  scaleTextInput,
  type TextInputSpec,
  textInputCaretAt,
  textInputContains,
  textInputTextWindow,
} from './textInput'

// A stub font where every glyph is half an em wide and the cap height 0.7 em.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'Hiabcdefgh '].map((ch) => [ch, GLYPH])),
}
const STYLE = DEFAULT_TEXT_INPUT_STYLE

/** Rect data is Float32, so colors compare within a tolerance. */
function expectColor(
  data: Float32Array,
  offset: number,
  color: readonly number[],
) {
  for (let i = 0; i < 4; i++) expect(data[offset + i]).toBeCloseTo(color[i], 5)
}
const SPEC: TextInputSpec = {
  id: 't',
  label: 'Hi',
  x: 100,
  y: 50,
  width: 60,
  value: 'abc',
  placeholder: 'hhh',
}

describe('layoutTextInput', () => {
  it('puts the label left of the field and pads the text area', () => {
    const l = layoutTextInput(SPEC, STYLE, METRICS)
    // Label 'Hi' at 14 px is 14 wide plus the 8 px gap.
    expect(l.field).toEqual({ x: 122, y: 50, width: 60, height: 20 })
    expect(l.width).toBe(82)
    expect(l.textArea).toEqual({ x: 128, y: 51, width: 48, height: 18 })
    expect(l.baseline).toBeCloseTo(64.8, 6)
  })

  it('uses the style width without a spec width and no label gap without a label', () => {
    const l = layoutTextInput({ id: 'u', x: 0, y: 0 }, STYLE, METRICS)
    expect(l.field.x).toBe(0)
    expect(l.field.width).toBe(STYLE.fieldWidth)
  })

  it('scales every length', () => {
    const { spec, style } = scaleTextInput(SPEC, STYLE, 2)
    expect(spec.x).toBe(200)
    expect(spec.width).toBe(120)
    expect(style.textSizePx).toBe(28)
    expect(style.paddingX).toBe(12)
    expect(style.caretWidth).toBe(2)
    expect(scaleTextInput(SPEC, STYLE, 1).style).toBe(STYLE)
  })
})

describe('textInputContains and caret mapping', () => {
  const layout = layoutTextInput(SPEC, STYLE, METRICS)

  it('hits the field but not the label', () => {
    expect(textInputContains(layout, 150, 60)).toBe(true)
    expect(textInputContains(layout, 105, 60)).toBe(false)
    expect(textInputContains(layout, 182, 60)).toBe(false)
  })

  it('maps a canvas x to the nearer caret index', () => {
    // Glyphs are 7 px wide from x 128.
    expect(textInputCaretAt(layout, STYLE, METRICS, 'abc', 0, 128)).toBe(0)
    expect(textInputCaretAt(layout, STYLE, METRICS, 'abc', 0, 132)).toBe(1)
    expect(textInputCaretAt(layout, STYLE, METRICS, 'abc', 0, 200)).toBe(3)
  })

  it('shows the glyphs that fit and scrolls to the caret', () => {
    // 48 px viewport minus the 1 px caret: six 7 px glyphs.
    const text = 'abcdefgh'
    expect(
      textInputTextWindow(layout, STYLE, METRICS, text, 0, 0),
    ).toMatchObject({ first: 0, end: 6 })
    expect(
      textInputTextWindow(layout, STYLE, METRICS, text, 0, 8),
    ).toMatchObject({ first: 2, end: 8 })
  })
})

describe('buildTextInput', () => {
  const layout = layoutTextInput(SPEC, STYLE, METRICS)
  const visual = {
    text: 'abc',
    edit: null,
    firstGlyph: 0,
    hover: false,
    enabled: true,
  }

  it('draws the field, the text and the label at rest', () => {
    const geo = buildTextInput(SPEC, STYLE, layout, METRICS, visual)
    expect(geo.rects).toHaveLength(1)
    expectColor(geo.rects[0].data, 12, STYLE.border)
    expect(geo.text.map((t) => t.str)).toEqual(['abc', 'Hi'])
    expect(geo.text[1].outlineWidthPx).toBe(1)
  })

  it('shows the placeholder only while empty', () => {
    const geo = buildTextInput(SPEC, STYLE, layout, METRICS, {
      ...visual,
      text: '',
    })
    expect(geo.text.map((t) => t.str)).toEqual(['hhh', 'Hi'])
    expect(geo.text[0].color).toEqual(STYLE.placeholderColor)
  })

  it('draws the focus border and a caret while focused without a selection', () => {
    const geo = buildTextInput(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState('abc', 2),
    })
    expectColor(geo.rects[0].data, 12, STYLE.focusBorder)
    expect(geo.rects).toHaveLength(2)
    expect(geo.rects[1].data[0]).toBe(128 + 14)
    expect(geo.rects[1].data[2]).toBe(STYLE.caretWidth)
  })

  it('draws the selection behind the text instead of a caret', () => {
    const geo = buildTextInput(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState('abc', 3, 1),
    })
    expect(geo.rects).toHaveLength(2)
    expect(geo.rects[1].data[0]).toBe(128 + 7)
    expect(geo.rects[1].data[2]).toBe(14)
    expectColor(geo.rects[1].data, 8, STYLE.selectionFill)
  })

  it('dims a disabled input and drops its caret', () => {
    const geo = buildTextInput(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState('abc', 1),
      enabled: false,
    })
    expect(geo.rects).toHaveLength(1)
    expectColor(geo.rects[0].data, 8, STYLE.disabledFill)
    expect(geo.text[0].color).toEqual(STYLE.disabledTextColor)
  })
})
