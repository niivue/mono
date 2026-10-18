import { describe, expect, it } from 'bun:test'
import {
  acceptNumberChar,
  buildNumberInput,
  DEFAULT_NUMBER_INPUT_STYLE,
  formatNumberInput,
  layoutNumberInput,
  type NumberInputSpec,
  type NumberInputVisual,
  numberInputCaretAt,
  numberInputContains,
  numberInputSpinAt,
  numberInputTextWindow,
  parseNumberInput,
  scaleNumberInput,
  snapNumberInput,
  stepNumberInput,
} from './numberInput'
import type { UIKitFontMetrics } from './text/font'
import { textEditState } from './textEdit'

// Stub font: every glyph advances half an em; cap height is 0.7 em.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'Hi0123456789.-e'].map((ch) => [ch, GLYPH])),
}
const STYLE = DEFAULT_NUMBER_INPUT_STYLE
const SPEC: NumberInputSpec = {
  id: 'n',
  label: 'Hi',
  x: 100,
  y: 50,
  min: 0,
  max: 10,
  step: 1,
  value: 5,
}
const IDLE: NumberInputVisual = {
  text: '5',
  edit: null,
  firstGlyph: 0,
  valid: true,
  hover: false,
  spinHover: 0,
  spinPressed: 0,
  enabled: true,
}

describe('number arithmetic', () => {
  it('clamps and snaps to the step grid from min, or from 0 without one', () => {
    expect(snapNumberInput(SPEC, 7.4)).toBe(7)
    expect(snapNumberInput(SPEC, 12)).toBe(10)
    expect(snapNumberInput(SPEC, -3)).toBe(0)
    expect(snapNumberInput(SPEC, Number.NaN)).toBe(0)
    expect(snapNumberInput({ step: 0.25 }, 1.3)).toBe(1.25)
    expect(snapNumberInput({ step: 0.1 }, 0.3 + 0.1 + 0.1)).toBe(0.5)
    expect(snapNumberInput({ min: 0.5, step: 0.3 }, 0.7)).toBe(0.8)
    expect(snapNumberInput({}, -123.456)).toBe(-123.456)
    expect(snapNumberInput({ max: 1 }, Number.NaN)).toBe(0)
  })

  it('steps by the step (or 1), ten with big, and clamps', () => {
    expect(stepNumberInput(SPEC, 5, 1)).toBe(6)
    expect(stepNumberInput(SPEC, 5, -1, true)).toBe(0)
    expect(stepNumberInput(SPEC, 9, 1, true)).toBe(10)
    expect(stepNumberInput({}, 0.1, 1)).toBe(1.1)
    expect(stepNumberInput({ step: 0.1 }, 0.2, 1)).toBe(0.3)
  })

  it('formats to the step precision, a tidy float, or the spec formatter', () => {
    expect(formatNumberInput(SPEC, 5)).toBe('5')
    expect(formatNumberInput({ step: 0.05 }, 1)).toBe('1.00')
    expect(formatNumberInput({}, 0.1 + 0.2)).toBe('0.3')
    expect(formatNumberInput({}, -2)).toBe('-2')
    expect(formatNumberInput({ format: (v) => `${v} deg` }, 90)).toBe('90 deg')
  })

  it('survives non-finite steps and bounds', () => {
    expect(snapNumberInput({ step: Number.POSITIVE_INFINITY }, 3)).toBe(3)
    expect(snapNumberInput({ step: Number.NaN }, 3)).toBe(3)
    expect(snapNumberInput({ min: Number.NaN, max: Number.NaN }, 3)).toBe(3)
    expect(snapNumberInput({ min: Number.NaN }, Number.NaN)).toBe(0)
    expect(stepNumberInput({ step: Number.NaN }, 3, 1)).toBe(4)
    expect(formatNumberInput({ step: Number.POSITIVE_INFINITY }, 3)).toBe('3')
    expect(() => formatNumberInput({ step: 1e-200 }, 1)).not.toThrow()
  })

  it('parses trimmed text and rejects empty or non-numeric text', () => {
    expect(parseNumberInput({}, ' 12.5 ')).toBe(12.5)
    expect(parseNumberInput({}, '-.5')).toBe(-0.5)
    expect(parseNumberInput({}, '1e2')).toBe(100)
    expect(parseNumberInput({}, '')).toBeNaN()
    expect(parseNumberInput({}, '-')).toBeNaN()
    expect(parseNumberInput({}, '1.2.3')).toBeNaN()
    expect(
      parseNumberInput({ parse: (t) => Number.parseInt(t, 16) }, 'ff'),
    ).toBe(255)
  })

  it('accepts only the characters a number can contain', () => {
    for (const ch of '0123456789.-+eE') expect(acceptNumberChar(ch)).toBe(true)
    for (const ch of 'a x,/') expect(acceptNumberChar(ch)).toBe(false)
  })
})

describe('layoutNumberInput', () => {
  it('puts the label left of the field and the spinner inside its right end', () => {
    const l = layoutNumberInput(SPEC, STYLE, METRICS)
    expect(l).toEqual({
      x: 100,
      y: 50,
      width: 102,
      height: 20,
      field: { x: 122, y: 50, width: 80, height: 20 },
      textArea: { x: 128, y: 51, width: 51, height: 18 },
      spinUp: { x: 185, y: 51, width: 16, height: 9 },
      spinDown: { x: 185, y: 60, width: 16, height: 9 },
      baseline: 64.8,
    })
  })

  it('honours a field width and drops the label gap without a label', () => {
    const l = layoutNumberInput(
      { ...SPEC, label: undefined, width: 60 },
      STYLE,
      METRICS,
    )
    expect(l.field).toEqual({ x: 100, y: 50, width: 60, height: 20 })
    expect(l.width).toBe(60)
  })

  it('scales every length for CSS units', () => {
    const { spec, style } = scaleNumberInput({ ...SPEC, width: 50 }, STYLE, 2)
    expect(spec).toMatchObject({ x: 200, y: 100, width: 100 })
    expect(style).toMatchObject({
      textSizePx: 28,
      fieldWidth: 160,
      spinnerWidth: 32,
      caretWidth: 2,
    })
    expect(scaleNumberInput(SPEC, STYLE, 1).spec).toBe(SPEC)
  })

  it('hit-tests the field only and tells the spinner halves apart', () => {
    const l = layoutNumberInput(SPEC, STYLE, METRICS)
    expect(numberInputContains(l, 105, 60)).toBe(false) // on the label
    expect(numberInputContains(l, 122, 50)).toBe(true)
    expect(numberInputContains(l, 201, 69)).toBe(true)
    expect(numberInputContains(l, 202, 60)).toBe(false)
    expect(numberInputSpinAt(l, 190, 55)).toBe(1)
    expect(numberInputSpinAt(l, 190, 65)).toBe(-1)
    expect(numberInputSpinAt(l, 150, 60)).toBe(0)
  })

  it('maps a pointer x to the nearer caret and scrolls long text by whole glyphs', () => {
    const l = layoutNumberInput(SPEC, STYLE, METRICS)
    // Glyphs are 7 px wide from x 128.
    expect(numberInputCaretAt(l, STYLE, METRICS, '123', 0, 130)).toBe(0)
    expect(numberInputCaretAt(l, STYLE, METRICS, '123', 0, 132)).toBe(1)
    expect(numberInputCaretAt(l, STYLE, METRICS, '123', 0, 999)).toBe(3)
    // 51 px minus the caret leaves room for 7 glyphs of 7 px.
    expect(
      numberInputTextWindow(l, STYLE, METRICS, '123456789', 0, 0),
    ).toMatchObject({ first: 0, end: 7 })
    expect(
      numberInputTextWindow(l, STYLE, METRICS, '123456789', 0, 9),
    ).toMatchObject({ first: 2, end: 9 })
    expect(
      numberInputTextWindow(l, STYLE, METRICS, '123456789', 2, 1),
    ).toMatchObject({ first: 1, end: 8 })
  })
})

describe('buildNumberInput', () => {
  const layout = layoutNumberInput(SPEC, STYLE, METRICS)
  const colorOf = (d: Float32Array, at: number) =>
    [...d.slice(at, at + 4)].map((c) => Math.round(c * 100) / 100)

  it('draws the field, the spinner faces and chevrons, the text and the label', () => {
    const g = buildNumberInput(SPEC, STYLE, layout, METRICS, IDLE)
    expect(g.rects).toHaveLength(3)
    expect([...g.rects[0].data.slice(0, 4)]).toEqual([122, 50, 80, 20])
    expect(colorOf(g.rects[0].data, 12)).toEqual([0.6, 0.66, 0.78, 1])
    expect([...g.rects[1].data.slice(0, 4)]).toEqual([185, 51, 16, 9])
    expect(g.lines).toHaveLength(6) // two dividers, two chevrons of two strokes
    expect(g.text.map((t) => t.str)).toEqual(['5', 'Hi'])
    expect(g.text[0]).toMatchObject({ x: 128, y: 64.8, align: 0 })
    expect(g.text[1]).toMatchObject({ x: 100, y: 64.8, outlineWidthPx: 1 })
  })

  it('shows focus and invalid text on the border and tints the spinner', () => {
    const focused = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      edit: textEditState('5'),
    })
    expect(colorOf(focused.rects[0].data, 12)).toEqual([0.55, 0.7, 1, 1])
    const invalid = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      text: '5.',
      edit: textEditState('5.'),
      valid: false,
    })
    expect(colorOf(invalid.rects[0].data, 12)).toEqual([0.95, 0.4, 0.4, 1])
    const pressed = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      spinHover: 1,
      spinPressed: -1,
    })
    expect(colorOf(pressed.rects[1].data, 8)).toEqual([0.24, 0.27, 0.34, 1])
    expect(colorOf(pressed.rects[2].data, 8)).toEqual([0.25, 0.47, 0.85, 1])
  })

  it('draws a caret after the glyph before it, or a selection rect instead', () => {
    const inkTop = 64.8 - 9.8 * 1.15
    const caret = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      text: '12',
      edit: textEditState('12', 1),
    })
    expect(caret.rects).toHaveLength(4)
    expect(caret.rects[3].data[0]).toBe(135)
    expect(caret.rects[3].data[1]).toBeCloseTo(inkTop, 4)
    expect(caret.rects[3].data[2]).toBe(1)
    const selected = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      text: '123',
      edit: textEditState('123', 3, 1),
    })
    expect(selected.rects).toHaveLength(4)
    expect(selected.rects[3].data[0]).toBe(135)
    expect(selected.rects[3].data[1]).toBeCloseTo(inkTop, 4)
    expect(selected.rects[3].data[2]).toBe(14)
    expect(colorOf(selected.rects[3].data, 8)).toEqual([0.25, 0.47, 0.85, 0.6])
  })

  it('shows only the glyphs that fit, scrolled to the caret', () => {
    const g = buildNumberInput(SPEC, STYLE, layout, METRICS, {
      ...IDLE,
      text: '123456789',
      edit: textEditState('123456789'),
    })
    expect(g.text[0].str).toBe('3456789')
    expect([...g.rects[3].data.slice(0, 1)]).toEqual([128 + 49])
  })

  it('dims a disabled input and drops the caret', () => {
    const g = buildNumberInput(
      { ...SPEC, enabled: false },
      STYLE,
      layout,
      METRICS,
      {
        ...IDLE,
        edit: textEditState('5'),
        enabled: false,
      },
    )
    expect(g.rects).toHaveLength(3)
    expect(colorOf(g.rects[0].data, 8)).toEqual([0.1, 0.11, 0.14, 0.5])
    expect(g.text[0].color).toEqual(STYLE.disabledTextColor)
  })
})
