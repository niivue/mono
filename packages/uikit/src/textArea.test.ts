import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
import type { UIKitFontMetrics } from './text/font'
import {
  buildTextArea,
  caretInRow,
  DEFAULT_TEXT_AREA_STYLE,
  layoutTextArea,
  moveCaretRows,
  rowOfCaret,
  scaleTextArea,
  type TextAreaSpec,
  textAreaCaretAt,
  textAreaContains,
  textAreaKey,
  textAreaRows,
  textAreaWindow,
  wrapRows,
} from './textArea'
import { textEditState } from './textEdit'

// A stub font where every glyph is half an em wide and the cap height 0.7 em:
// 7 px per glyph and a 9.8 px cap at the default 14 px.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'Hiabcdefghijx '].map((ch) => [ch, GLYPH])),
}
const STYLE = DEFAULT_TEXT_AREA_STYLE
const SEVENS = (n: number): number[] => Array.from({ length: n }, () => 7)

function key(k: string, mods: Partial<UIKitKeyEvent> = {}): UIKitKeyEvent {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  }
}

/** Rect data is Float32, so colors compare within a tolerance. */
function expectColor(
  data: Float32Array,
  offset: number,
  color: readonly number[],
) {
  for (let i = 0; i < 4; i++) expect(data[offset + i]).toBeCloseTo(color[i], 5)
}

// Label 'Hi' above a 60 px wide, two-row field: the rows are 20 px tall and
// 41 px wide, so five 7 px glyphs fit beside the 1 px caret.
const SPEC: TextAreaSpec = {
  id: 'a',
  label: 'Hi',
  x: 100,
  y: 50,
  width: 60,
  rows: 2,
  value: 'abc def ghij',
  placeholder: 'hhh hhh',
}
const TEXT = 'abc def ghij'

describe('wrapRows', () => {
  it('breaks after the last space that fits and keeps the final row hard', () => {
    expect(wrapRows(TEXT, SEVENS(TEXT.length), 40)).toEqual([
      { start: 0, end: 4, hard: false },
      { start: 4, end: 8, hard: false },
      { start: 8, end: 12, hard: true },
    ])
  })

  it('lets a space overhang the edge', () => {
    expect(wrapRows('abcde fgh', SEVENS(9), 35)).toEqual([
      { start: 0, end: 6, hard: false },
      { start: 6, end: 9, hard: true },
    ])
  })

  it('splits a word wider than the row by glyph', () => {
    expect(wrapRows('abcdefg', SEVENS(7), 21)).toEqual([
      { start: 0, end: 3, hard: false },
      { start: 3, end: 6, hard: false },
      { start: 6, end: 7, hard: true },
    ])
  })

  it('gives every paragraph a row, empty ones included', () => {
    expect(wrapRows('ab\n\ncd', SEVENS(6), 100)).toEqual([
      { start: 0, end: 2, hard: true },
      { start: 3, end: 3, hard: true },
      { start: 4, end: 6, hard: true },
    ])
    expect(wrapRows('ab\n', SEVENS(3), 100)).toEqual([
      { start: 0, end: 2, hard: true },
      { start: 3, end: 3, hard: true },
    ])
    expect(wrapRows('', [], 100)).toEqual([{ start: 0, end: 0, hard: true }])
  })
})

describe('rows and carets', () => {
  const rows = wrapRows(TEXT, SEVENS(TEXT.length), 40)
  const advances = SEVENS(TEXT.length)

  it('puts a caret at a soft break on the next row', () => {
    expect(rowOfCaret(rows, 3)).toBe(0)
    expect(rowOfCaret(rows, 4)).toBe(1)
    expect(rowOfCaret(rows, 12)).toBe(2)
  })

  it('maps an x on a row to the nearer glyph edge, staying before a trailing space', () => {
    expect(caretInRow(TEXT, advances, rows[0], 0)).toBe(0)
    expect(caretInRow(TEXT, advances, rows[0], 10)).toBe(1)
    expect(caretInRow(TEXT, advances, rows[0], 100)).toBe(3)
    expect(caretInRow(TEXT, advances, rows[2], 100)).toBe(12)
  })

  it('moves the caret by rows toward a goal x, and to the ends past the rows', () => {
    const s = textEditState(TEXT, 1)
    const down = moveCaretRows(s, rows, advances, 1, null, false)
    expect(down.state.caret).toBe(5)
    expect(down.goalX).toBe(7)
    const bottom = moveCaretRows(
      down.state,
      rows,
      advances,
      1,
      down.goalX,
      false,
    )
    expect(bottom.state.caret).toBe(9)
    expect(
      moveCaretRows(bottom.state, rows, advances, 1, 7, false).state.caret,
    ).toBe(12)
    expect(moveCaretRows(s, rows, advances, -1, null, true).state).toEqual({
      text: TEXT,
      caret: 0,
      anchor: 1,
    })
  })
})

describe('textAreaKey', () => {
  const rows = wrapRows(TEXT, SEVENS(TEXT.length), 40)
  const advances = SEVENS(TEXT.length)
  const press = (
    s: ReturnType<typeof textEditState>,
    k: UIKitKeyEvent,
    goalX: number | null = null,
  ) => textAreaKey(s, k, rows, advances, goalX, 2)

  it('inserts a newline on Enter and leaves Meta plus Enter to the widget', () => {
    expect(press(textEditState(TEXT, 3), key('Enter'))?.state.text).toBe(
      'abc\n def ghij',
    )
    expect(
      press(textEditState(TEXT, 3), key('Enter', { metaKey: true })),
    ).toBeNull()
  })

  it('moves by row with the arrows, by page with PageDown, and to the ends with Meta', () => {
    const s = textEditState(TEXT, 1)
    expect(press(s, key('ArrowDown'))?.state.caret).toBe(5)
    expect(press(s, key('ArrowDown', { shiftKey: true }))?.state.anchor).toBe(1)
    expect(press(s, key('PageDown'))?.state.caret).toBe(9)
    expect(press(s, key('ArrowDown', { metaKey: true }))?.state.caret).toBe(12)
    expect(
      press(textEditState(TEXT, 9), key('ArrowUp', { ctrlKey: true }))?.state
        .caret,
    ).toBe(0)
  })

  it('moves Home and End within the row, before a trailing space', () => {
    const s = textEditState(TEXT, 5)
    expect(press(s, key('Home'))?.state.caret).toBe(4)
    expect(press(s, key('End'))?.state.caret).toBe(7)
    expect(press(s, key('End', { metaKey: true }))?.state.caret).toBe(12)
    expect(press(s, key('Home'))?.goalX).toBeNull()
  })

  it('hands other keys to the single-line model', () => {
    const s = textEditState(TEXT, 5)
    expect(press(s, key('x'))?.state.text).toBe('abc dxef ghij')
    expect(press(s, key('Backspace'))?.state.text).toBe('abc ef ghij')
    expect(press(s, key('Tab'))).toBeNull()
  })
})

describe('layoutTextArea', () => {
  it('stacks the label over a field of whole rows and reserves scrollbar room', () => {
    const l = layoutTextArea(SPEC, STYLE, METRICS)
    expect(l.field).toEqual({ x: 100, y: 66, width: 60, height: 48 })
    expect(l.textArea).toEqual({ x: 106, y: 70, width: 41, height: 40 })
    expect(l.rowHeight).toBe(20)
    expect(l.rows).toBe(2)
    expect(l.height).toBe(64)
    expect(l.labelBaseline).toBeCloseTo(59.8, 6)
  })

  it('uses the style width and rows without a label', () => {
    const l = layoutTextArea({ id: 'u', x: 0, y: 0 }, STYLE, METRICS)
    expect(l.field).toEqual({ x: 0, y: 0, width: 220, height: 88 })
    expect(l.rows).toBe(4)
  })

  it('scales every length', () => {
    const { spec, style } = scaleTextArea(SPEC, STYLE, 2)
    expect(spec.x).toBe(200)
    expect(spec.width).toBe(120)
    expect(style.textSizePx).toBe(28)
    expect(style.scrollbarWidth).toBe(8)
    expect(style.caretWidth).toBe(2)
    expect(scaleTextArea(SPEC, STYLE, 1).style).toBe(STYLE)
  })
})

describe('hit testing, windows and caret mapping', () => {
  const layout = layoutTextArea(SPEC, STYLE, METRICS)
  const rows = textAreaRows(layout, STYLE, METRICS, TEXT)

  it('hits the field but not the label', () => {
    expect(textAreaContains(layout, 130, 80)).toBe(true)
    expect(textAreaContains(layout, 105, 55)).toBe(false)
  })

  it('wraps to the field width and scrolls by rows to show the caret', () => {
    expect(rows).toHaveLength(3)
    expect(textAreaWindow(layout, rows, 0, null)).toMatchObject({
      first: 0,
      end: 2,
    })
    expect(textAreaWindow(layout, rows, 0, 12)).toMatchObject({
      first: 1,
      end: 3,
    })
    expect(textAreaWindow(layout, rows, 5, null)).toMatchObject({
      first: 1,
      end: 3,
    })
  })

  it('maps a canvas point to a caret on the row under it, clamped to the rows shown', () => {
    const at = (x: number, y: number, first = 0) =>
      textAreaCaretAt(layout, STYLE, METRICS, TEXT, first, x, y)
    expect(at(116, 75)).toBe(1)
    expect(at(106, 95)).toBe(4)
    expect(at(300, 200)).toBe(7)
    expect(at(106, 75, 1)).toBe(4)
    expect(at(300, 95, 1)).toBe(12)
  })
})

describe('buildTextArea', () => {
  const layout = layoutTextArea(SPEC, STYLE, METRICS)
  const visual = {
    text: TEXT,
    edit: null,
    firstRow: 0,
    hover: false,
    enabled: true,
  }

  it('draws the field, the visible rows, a scrollbar and the haloed label at rest', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, visual)
    expect(geo.text.map((t) => t.str)).toEqual(['abc ', 'def ', 'Hi'])
    expect(geo.text[0].y).toBeCloseTo(70 + (20 + 9.8) / 2, 6)
    expect(geo.text[1].y).toBeCloseTo(90 + (20 + 9.8) / 2, 6)
    expect(geo.text[2].outlineWidthPx).toBe(1)
    expect(geo.rects).toHaveLength(3)
    expectColor(geo.rects[0].data, 12, STYLE.border)
    // Track and thumb at the field's right edge, inside the border and gap.
    expect(geo.rects[1].data[0]).toBe(152)
    expect(geo.rects[1].data[3]).toBe(40)
    expect(geo.rects[2].data[3]).toBeCloseTo(40 * (2 / 3), 4)
    expect(geo.shown).toMatchObject({ first: 0, end: 2 })
  })

  it('keeps a manual scroll instead of revealing the caret when told to', () => {
    // Five rows, two visible, caret on the first row, scrolled to row 2.
    const edit = { text: 'a\nb\nc\nd\ne', caret: 1, anchor: 1 }
    const scrolled = { ...visual, text: edit.text, edit, firstRow: 2 }
    const revealed = buildTextArea(SPEC, STYLE, layout, METRICS, scrolled)
    expect(revealed.shown).toMatchObject({ first: 0, end: 2 })
    const kept = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...scrolled,
      revealCaret: false,
    })
    expect(kept.shown).toMatchObject({ first: 2, end: 4 })
    expect(kept.text.map((t) => t.str)).toEqual(['c', 'd', 'Hi'])
    // The thumb sits where the hit test expects it: at firstRow 2 of 3.
    const thumbY = (r: { data: Float32Array }) => r.data[1]
    expect(thumbY(kept.rects[2])).toBeGreaterThan(thumbY(revealed.rects[2]))
  })

  it('draws no scrollbar when every row fits', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      text: 'abc',
    })
    expect(geo.rects).toHaveLength(1)
  })

  it('shows the wrapped placeholder only while empty', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      text: '',
    })
    expect(geo.text.map((t) => t.str)).toEqual(['hhh ', 'hhh', 'Hi'])
    expect(geo.text[0].color).toEqual(STYLE.placeholderColor)
  })

  it('draws the focus border and a caret on its row while focused without a selection', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState(TEXT, 5),
    })
    expectColor(geo.rects[0].data, 12, STYLE.focusBorder)
    const caret = geo.rects[1].data
    expect([caret[0], caret[1], caret[2], caret[3]]).toEqual([113, 90, 1, 20])
  })

  it('scrolls so the caret row is shown', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState(TEXT, 12),
    })
    expect(geo.shown).toMatchObject({ first: 1, end: 3 })
    expect(geo.text.map((t) => t.str)).toEqual(['def ', 'ghij', 'Hi'])
    expect(geo.rects[1].data[1]).toBe(90)
  })

  it('draws the selection row by row instead of a caret', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      edit: textEditState(TEXT, 6, 2),
    })
    const sel = geo.rects
      .slice(1, 3)
      .map((r) => [r.data[0], r.data[1], r.data[2]])
    expect(sel).toEqual([
      [120, 70, 14],
      [106, 90, 14],
    ])
    expectColor(geo.rects[1].data, 8, STYLE.selectionFill)
  })

  it('marks a selected newline', () => {
    const l = layoutTextArea({ ...SPEC, value: 'ab\ncd' }, STYLE, METRICS)
    const geo = buildTextArea(SPEC, STYLE, l, METRICS, {
      ...visual,
      text: 'ab\ncd',
      edit: textEditState('ab\ncd', 4, 1),
    })
    // Row 0 selects 'b' plus a newline marker; row 1 selects 'c'.
    expect(geo.rects[1].data[2]).toBeCloseTo(7 + 14 * 0.3, 5)
    expect(geo.rects[2].data[2]).toBe(7)
  })

  it('dims a disabled area and drops its caret', () => {
    const geo = buildTextArea(SPEC, STYLE, layout, METRICS, {
      ...visual,
      text: 'abc',
      edit: textEditState('abc', 1),
      enabled: false,
    })
    expect(geo.rects).toHaveLength(1)
    expectColor(geo.rects[0].data, 8, STYLE.disabledFill)
    expect(geo.text[0].color).toEqual(STYLE.disabledTextColor)
  })
})
