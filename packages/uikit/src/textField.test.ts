import { describe, expect, it } from 'bun:test'
import type { UIKitFontMetrics } from './text/font'
import { textEditState } from './textEdit'
import {
  buildTextFieldContent,
  type TextFieldStyle,
  textFieldCaretAt,
  textFieldViewport,
  textFieldWindow,
} from './textField'

// Stub font: every glyph advances half an em (10 px at 20 px); cap height 0.7 em.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'Hi0123456789'].map((ch) => [ch, GLYPH])),
}
const STYLE: TextFieldStyle = {
  textSizePx: 20,
  caretWidth: 2,
  caretColor: [1, 0, 0, 1],
  selectionFill: [0, 0, 1, 1],
}
const COLOR: [number, number, number, number] = [1, 1, 1, 1]
// 52 px wide: 50 px for glyphs (five of them) plus the caret.
const AREA = { x: 100, y: 0, width: 52, height: 30 }
const TEXT = '0123456789'
const BASELINE = 20

const content = (
  edit: ReturnType<typeof textEditState> | null,
  firstGlyph = 0,
  enabled = true,
) =>
  buildTextFieldContent(
    AREA,
    BASELINE,
    STYLE,
    METRICS,
    TEXT,
    edit,
    firstGlyph,
    COLOR,
    enabled,
  )

// RectData layout: x, y, width, height first.
const box = (r: { data: Float32Array }) => [...r.data.subarray(0, 4)]

describe('textFieldViewport', () => {
  it('keeps room for the caret and never goes negative', () => {
    expect(textFieldViewport(AREA, 2)).toBe(50)
    expect(textFieldViewport({ ...AREA, width: 1 }, 2)).toBe(0)
  })
})

describe('textFieldWindow', () => {
  it('shows what fits from firstGlyph when the caret is in view', () => {
    const w = textFieldWindow(AREA, STYLE, METRICS, TEXT, 0, 2)
    expect([w.first, w.end]).toEqual([0, 5])
  })

  it('scrolls the least distance that brings the caret into view', () => {
    const right = textFieldWindow(AREA, STYLE, METRICS, TEXT, 0, 8)
    expect([right.first, right.end]).toEqual([3, 8])
    const left = textFieldWindow(AREA, STYLE, METRICS, TEXT, 6, 2)
    expect(left.first).toBe(2)
  })
})

describe('textFieldCaretAt', () => {
  it('maps a canvas x to the nearest glyph boundary from firstGlyph', () => {
    expect(textFieldCaretAt(AREA, STYLE, METRICS, TEXT, 0, 100)).toBe(0)
    expect(textFieldCaretAt(AREA, STYLE, METRICS, TEXT, 0, 123)).toBe(2)
    expect(textFieldCaretAt(AREA, STYLE, METRICS, TEXT, 4, 123)).toBe(6)
    expect(textFieldCaretAt(AREA, STYLE, METRICS, TEXT, 0, 999)).toBe(
      TEXT.length,
    )
  })
})

describe('buildTextFieldContent', () => {
  it('draws only the visible run and no caret while unfocused', () => {
    const c = content(null)
    expect(c.rects).toHaveLength(0)
    expect(c.text).toHaveLength(1)
    expect(c.text[0]).toMatchObject({ str: '01234', x: 100, y: BASELINE })
    expect([c.shown.first, c.shown.end]).toEqual([0, 5])
  })

  it('draws the caret at its glyph boundary while focused', () => {
    const c = content(textEditState(TEXT, 3))
    expect(c.rects).toHaveLength(1)
    const [x, , w] = box(c.rects[0])
    expect([x, w]).toEqual([130, STYLE.caretWidth])
    expect(box(c.rects[0])[3]).toBeGreaterThan(0)
  })

  it('hides the caret when disabled', () => {
    expect(content(textEditState(TEXT, 3), 0, false).rects).toHaveLength(0)
  })

  it('clips the selection to the shown run and drops the caret', () => {
    // Caret 7 scrolls to [2, 7); selection [0, 7) is clipped to [2, 7).
    const c = content(textEditState(TEXT, 7, 0))
    expect([c.shown.first, c.shown.end]).toEqual([2, 7])
    expect(c.text[0].str).toBe('23456')
    expect(c.rects).toHaveLength(1)
    const [x, , w] = box(c.rects[0])
    expect([x, w]).toEqual([100, 50])
  })

  it('draws no rect for a selection left of the shown run', () => {
    // Caret 5 on the left edge of [5, 10) with anchor 3: the selection [3, 5)
    // clips to nothing, and a selection never draws a caret.
    const c = content(textEditState(TEXT, 5, 3), 5)
    expect([c.shown.first, c.shown.end]).toEqual([5, 10])
    expect(c.rects).toHaveLength(0)
  })
})
