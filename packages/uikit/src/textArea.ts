// Pure multi-line text-area model for UIKit: style resolution, layout (an
// optional label above a bordered field of a fixed number of rows), the
// soft-wrapped rows a text falls into, the caret moves that cross rows, the
// whole-row vertical scrolling that keeps the caret in view (through the
// shared scroll model, so no GPU scissor is needed) and the geometry for one
// visual state: the field, the placeholder or the selection, the visible rows
// of text, the caret and a scrollbar. The single-line edit model (textEdit.ts)
// does the character-level work; this file adds the row structure. No GPU and
// no DOM here; UIKitTextAreaOverlay wires it to the pointer, the keyboard, the
// wheel and the draw hook.

import { mixColor } from './button'
import type { UIKitKeyEvent } from './controls'
import { buildRect, type RectData } from './rect'
import {
  revealRow,
  type ScrollWindow,
  scrollWindow,
  type UIKitBox,
} from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, type RGBA } from './text/layout'
import {
  advanceBetween,
  editKey,
  glyphAdvances,
  hasSelection,
  insertText,
  selectionOf,
  setCaret,
  type TextEditState,
} from './textEdit'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a text area. All lengths are in canvas pixels. */
export interface TextAreaStyle {
  /** Field color at rest. */
  fill: RGBA
  /** Field color while the pointer hovers it. */
  hoverFill: RGBA
  /** Field color when disabled. */
  disabledFill: RGBA
  border: RGBA
  /** Border color while the field has keyboard focus. */
  focusBorder: RGBA
  borderWidth: number
  radius: number
  textColor: RGBA
  disabledTextColor: RGBA
  /** Color of the placeholder shown while the field is empty. */
  placeholderColor: RGBA
  /** Label and field text em size. */
  textSizePx: number
  /** Row height as a multiple of the em size. */
  lineHeight: number
  /** Halo outline width around the label (it sits on the scene); 0 draws none. */
  textOutlineWidth: number
  /** Halo color; null picks black or white for contrast with `textColor`. */
  textOutlineColor: RGBA | null
  /** Space between the field's left border and the text. */
  paddingX: number
  /** Space between the rows and the field's top and bottom edges. */
  paddingY: number
  /** Space between a label and the field. */
  labelGap: number
  /** Field width when the spec gives none. */
  fieldWidth: number
  /** Visible rows when the spec gives none. */
  rows: number
  caretColor: RGBA
  caretWidth: number
  /** Color behind selected text. */
  selectionFill: RGBA
  /** Width of the scrollbar thumb shown when the rows overflow. */
  scrollbarWidth: number
  /** Space between the text and the scrollbar, and between it and the border. */
  scrollbarGap: number
  scrollbarColor: RGBA
  scrollbarTrackColor: RGBA
}

export const DEFAULT_TEXT_AREA_STYLE: TextAreaStyle = {
  fill: [0.1, 0.11, 0.14, 0.96],
  hoverFill: [0.13, 0.15, 0.19, 0.96],
  disabledFill: [0.1, 0.11, 0.14, 0.5],
  border: [0.6, 0.66, 0.78, 1],
  focusBorder: [0.55, 0.7, 1, 1],
  borderWidth: 1,
  radius: 4,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  placeholderColor: [1, 1, 1, 0.4],
  textSizePx: 14,
  lineHeight: 1.4,
  textOutlineWidth: 1,
  textOutlineColor: null,
  paddingX: 6,
  paddingY: 4,
  labelGap: 6,
  fieldWidth: 220,
  rows: 4,
  caretColor: [1, 1, 1, 1],
  caretWidth: 1,
  selectionFill: [0.25, 0.47, 0.85, 0.6],
  scrollbarWidth: 4,
  scrollbarGap: 3,
  scrollbarColor: [1, 1, 1, 0.45],
  scrollbarTrackColor: [1, 1, 1, 0.08],
}

export interface TextAreaSpec {
  /** Stable key: the handle for updates, pointer tracking and the callbacks. */
  id: string
  /** Optional label, drawn above the field. */
  label?: string
  /** Top-left corner of the whole control (label included), in canvas pixels. */
  x: number
  y: number
  /** Field width. Default: the style's `fieldWidth`. */
  width?: number
  /** Visible rows; longer text scrolls. Default: the style's `rows`. */
  rows?: number
  /** Initial text. Default empty. */
  value?: string
  /** Dimmed text shown while the field is empty. */
  placeholder?: string
  /** Typing stops at this many characters. */
  maxLength?: number
  /** Characters the field refuses from the keyboard (Enter is always a newline). */
  accept?: (ch: string) => boolean
  /** A disabled area draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-area overrides of the overlay's default style. */
  style?: Partial<TextAreaStyle>
  /** Fired on every keystroke that changes the text. */
  onInput?: (text: string, id: string) => void
  /** Fired once when changed text is committed: on Meta or Ctrl plus Enter and on losing focus. */
  onChange?: (text: string, id: string) => void
  /** Fired on Meta or Ctrl plus Enter, changed or not, after `onChange`. */
  onSubmit?: (text: string, id: string) => void
}

/** The control's boxes in canvas pixels. */
export interface TextAreaLayout {
  /** The whole control: label and field. */
  x: number
  y: number
  width: number
  height: number
  /** The bordered field. */
  field: UIKitBox
  /** Where the rows of text, the caret and the selection draw. */
  textArea: UIKitBox
  /** Baseline of the label (meaningful only with a label). */
  labelBaseline: number
  /** Height of one row of text. */
  rowHeight: number
  /** Rows the text area shows at once. */
  rows: number
}

/** The transient state that changes how a text area looks. */
export interface TextAreaVisual {
  /** The text shown: the committed text, or the edit in progress. */
  text: string
  /** The edit in progress while the area has keyboard focus, else null. */
  edit: TextEditState | null
  /** Index of the first row the text area shows (the overlay keeps it between frames). */
  firstRow: number
  hover: boolean
  enabled: boolean
}

/** One visual row: the code units [start, end) of the text it shows. */
export interface TextRow {
  start: number
  end: number
  /** True when the row ends its paragraph (at a newline or the end of the text). */
  hard: boolean
}

export function resolveTextAreaStyle(
  base: TextAreaStyle,
  override?: Partial<TextAreaStyle>,
): TextAreaStyle {
  return override ? { ...base, ...override } : base
}

/** The control's boxes for a spec. */
export function layoutTextArea(
  spec: TextAreaSpec,
  style: TextAreaStyle,
  metrics: UIKitFontMetrics,
): TextAreaLayout {
  const capH = capHeight(metrics) * style.textSizePx
  const rowHeight = Math.ceil(style.textSizePx * style.lineHeight)
  const rows = Math.max(1, Math.floor(spec.rows ?? style.rows))
  const labelH = spec.label ? Math.ceil(capH) + style.labelGap : 0
  const fieldW = spec.width ?? style.fieldWidth
  const fieldH = Math.ceil(rows * rowHeight + 2 * style.paddingY)
  const field = { x: spec.x, y: spec.y + labelH, width: fieldW, height: fieldH }
  const scrollbar = style.scrollbarWidth + style.scrollbarGap
  return {
    x: spec.x,
    y: spec.y,
    width: fieldW,
    height: labelH + fieldH,
    field,
    textArea: {
      x: field.x + style.paddingX,
      y: field.y + style.paddingY,
      width: Math.max(0, fieldW - 2 * style.paddingX - scrollbar),
      height: rows * rowHeight,
    },
    labelBaseline: spec.y + capH,
    rowHeight,
    rows,
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleTextArea(
  spec: TextAreaSpec,
  style: TextAreaStyle,
  k: number,
): { spec: TextAreaSpec; style: TextAreaStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: {
      ...spec,
      x: spec.x * k,
      y: spec.y * k,
      width: spec.width === undefined ? undefined : spec.width * k,
    },
    style: {
      ...style,
      borderWidth: style.borderWidth * k,
      radius: style.radius * k,
      textSizePx: style.textSizePx * k,
      textOutlineWidth: style.textOutlineWidth * k,
      paddingX: style.paddingX * k,
      paddingY: style.paddingY * k,
      labelGap: style.labelGap * k,
      fieldWidth: style.fieldWidth * k,
      caretWidth: style.caretWidth * k,
      scrollbarWidth: style.scrollbarWidth * k,
      scrollbarGap: style.scrollbarGap * k,
    },
  }
}

/** True when canvas point (px, py) lies inside the field (the label is not interactive). */
export function textAreaContains(
  layout: TextAreaLayout,
  px: number,
  py: number,
): boolean {
  const b = layout.field
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
}

/** The track and thumb for an overflowing area's row-based scrollbar. */
export interface TextAreaScrollbar {
  track: UIKitBox
  thumb: UIKitBox
  /** Largest valid first-row index for this content and viewport. */
  maxFirst: number
}

/**
 * Returns the scrollbar geometry when `rowCount` overflows `shown`, otherwise
 * null. Keeping this calculation shared means the drawn thumb and its pointer
 * hit target cannot drift apart.
 */
export function textAreaScrollbar(
  layout: TextAreaLayout,
  style: TextAreaStyle,
  shown: ScrollWindow,
  rowCount: number,
): TextAreaScrollbar | null {
  const visibleRows = shown.end - shown.first
  if (rowCount <= visibleRows) return null
  const track: UIKitBox = {
    x:
      layout.field.x +
      layout.field.width -
      style.borderWidth -
      style.scrollbarGap -
      style.scrollbarWidth,
    y: layout.textArea.y,
    width: style.scrollbarWidth,
    height: layout.textArea.height,
  }
  const thumbHeight = Math.min(
    track.height,
    Math.max(style.scrollbarWidth * 2, track.height * (visibleRows / rowCount)),
  )
  const travel = track.height - thumbHeight
  const thumbY =
    track.y + (shown.maxFirst > 0 ? (travel * shown.first) / shown.maxFirst : 0)
  return {
    track,
    thumb: { x: track.x, y: thumbY, width: track.width, height: thumbHeight },
    maxFirst: shown.maxFirst,
  }
}

/** The width the rows have for glyphs, keeping room for the caret. */
export function textAreaWrapWidth(
  layout: TextAreaLayout,
  style: TextAreaStyle,
): number {
  return Math.max(0, layout.textArea.width - style.caretWidth)
}

/**
 * Break `text` into rows no wider than `maxWidth`: at every newline, else
 * after the last space that fits (the space may overhang the edge), else
 * before the first glyph that does not fit. Every row holds at least one
 * code unit unless its paragraph is empty, and the newline that ends a
 * paragraph belongs to no row (it sits at the hard row's `end`).
 */
export function wrapRows(
  text: string,
  advances: readonly number[],
  maxWidth: number,
): TextRow[] {
  const rows: TextRow[] = []
  let p = 0
  for (;;) {
    const nl = text.indexOf('\n', p)
    const q = nl === -1 ? text.length : nl
    let i = p
    if (i === q) rows.push({ start: i, end: q, hard: true })
    while (i < q) {
      let j = i
      let w = 0
      while (j < q && w + advances[j] <= maxWidth) {
        w += advances[j]
        j++
      }
      if (j === q) {
        rows.push({ start: i, end: q, hard: true })
        break
      }
      let k = -1
      if (text[j] === ' ') k = j + 1
      else {
        for (let s = j; s > i; s--) {
          if (text[s - 1] === ' ') {
            k = s
            break
          }
        }
      }
      const end = k > i ? k : Math.max(j, i + 1)
      rows.push({ start: i, end, hard: end === q })
      i = end
    }
    if (nl === -1) break
    p = nl + 1
  }
  return rows
}

/**
 * The row that shows the caret at `caret`: the row containing it, or a hard
 * row ending exactly there. A caret at a soft break sits on the next row.
 */
export function rowOfCaret(rows: readonly TextRow[], caret: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (caret < r.end || (r.hard && caret === r.end)) return i
  }
  return Math.max(0, rows.length - 1)
}

/** The x offset of `caret` from the left edge of its row. */
export function caretXInRow(
  advances: readonly number[],
  row: TextRow,
  caret: number,
): number {
  return advanceBetween(advances, row.start, Math.min(caret, row.end))
}

/**
 * The caret index nearest to `px` (measured from the row's left edge) on a
 * row. Past the end of a soft row the caret lands before a trailing space,
 * so it stays on that row.
 */
export function caretInRow(
  text: string,
  advances: readonly number[],
  row: TextRow,
  px: number,
): number {
  let x = 0
  for (let i = row.start; i < row.end; i++) {
    if (px < x + advances[i] / 2) return i
    x += advances[i]
  }
  if (!row.hard && row.end > row.start && text[row.end - 1] === ' ') {
    return row.end - 1
  }
  return row.end
}

/**
 * The run of rows the text area shows, starting at `firstRow` but scrolled
 * the least distance that keeps `caret` in view.
 */
export function textAreaWindow(
  layout: TextAreaLayout,
  rows: readonly TextRow[],
  firstRow: number,
  caret: number | null,
): ScrollWindow {
  const heights = rows.map(() => layout.rowHeight)
  const viewport = layout.textArea.height
  const w = scrollWindow(heights, viewport, firstRow)
  if (caret === null) return w
  const first = revealRow(heights, viewport, w, rowOfCaret(rows, caret))
  return first === w.first ? w : scrollWindow(heights, viewport, first)
}

/** The rows a text falls into inside a layout. */
export function textAreaRows(
  layout: TextAreaLayout,
  style: TextAreaStyle,
  metrics: UIKitFontMetrics,
  text: string,
): TextRow[] {
  const advances = glyphAdvances(metrics, text, style.textSizePx)
  return wrapRows(text, advances, textAreaWrapWidth(layout, style))
}

/**
 * The caret index for a canvas point over text shown from `firstRow`: the
 * row under `py` (clamped to the rows shown) and the nearest glyph edge on it.
 */
export function textAreaCaretAt(
  layout: TextAreaLayout,
  style: TextAreaStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstRow: number,
  px: number,
  py: number,
): number {
  const advances = glyphAdvances(metrics, text, style.textSizePx)
  const rows = wrapRows(text, advances, textAreaWrapWidth(layout, style))
  const shown = textAreaWindow(layout, rows, firstRow, null)
  const area = layout.textArea
  const offset = Math.floor((py - area.y) / layout.rowHeight)
  const index = Math.max(
    shown.first,
    Math.min(shown.end - 1, shown.first + offset),
  )
  if (index < 0 || index >= rows.length) return text.length
  return caretInRow(text, advances, rows[index], px - area.x)
}

/**
 * Move the caret `delta` rows, keeping `goalX` (the x the caret had before a
 * run of vertical moves, or its current x when null) as far as the target
 * row allows. Past the first or last row the caret goes to the text's ends.
 */
export function moveCaretRows(
  s: TextEditState,
  rows: readonly TextRow[],
  advances: readonly number[],
  delta: number,
  goalX: number | null,
  extend: boolean,
): { state: TextEditState; goalX: number } {
  const from = rowOfCaret(rows, s.caret)
  const x = goalX ?? caretXInRow(advances, rows[from], s.caret)
  const to = from + delta
  if (to < 0) return { state: setCaret(s, 0, extend), goalX: x }
  if (to >= rows.length) {
    return { state: setCaret(s, s.text.length, extend), goalX: x }
  }
  const caret = caretInRow(s.text, advances, rows[to], x)
  return { state: setCaret(s, caret, extend), goalX: x }
}

/**
 * The state after an editing key in a text area: Enter inserts a newline,
 * ArrowUp and ArrowDown move by row (PageUp and PageDown by `pageRows`,
 * Meta or Ctrl to the text's ends), Home and End move within the row (Meta
 * or Ctrl to the text's ends), and every other key goes to the single-line
 * model. `goalX` carries the x a run of vertical moves aims for; it comes
 * back as null after any other key. Returns null for keys that are not edits.
 */
export function textAreaKey(
  s: TextEditState,
  e: UIKitKeyEvent,
  rows: readonly TextRow[],
  advances: readonly number[],
  goalX: number | null,
  pageRows: number,
  accept: (ch: string) => boolean = () => true,
): { state: TextEditState; goalX: number | null } | null {
  const jump = e.metaKey || e.ctrlKey
  switch (e.key) {
    case 'Enter':
      return jump ? null : { state: insertText(s, '\n'), goalX: null }
    case 'ArrowUp':
    case 'ArrowDown':
    case 'PageUp':
    case 'PageDown': {
      const up = e.key === 'ArrowUp' || e.key === 'PageUp'
      if (jump) {
        return {
          state: setCaret(s, up ? 0 : s.text.length, e.shiftKey),
          goalX: null,
        }
      }
      const step = e.key.startsWith('Page') ? Math.max(1, pageRows) : 1
      return moveCaretRows(
        s,
        rows,
        advances,
        up ? -step : step,
        goalX,
        e.shiftKey,
      )
    }
    case 'Home':
    case 'End': {
      if (jump) return { state: editKey(s, e) ?? s, goalX: null }
      const row = rows[rowOfCaret(rows, s.caret)]
      let index = e.key === 'Home' ? row.start : row.end
      if (e.key === 'End' && !row.hard && s.text[row.end - 1] === ' ') {
        index = row.end - 1
      }
      return { state: setCaret(s, index, e.shiftKey), goalX: null }
    }
    default:
      break
  }
  const next = editKey(s, e, accept)
  return next === null ? null : { state: next, goalX: null }
}

/**
 * The draw data for one text area in one visual state: the field, the
 * placeholder or the selection, the visible rows of text, the caret, the
 * scrollbar when the rows overflow, and the label.
 */
export function buildTextArea(
  spec: TextAreaSpec,
  style: TextAreaStyle,
  layout: TextAreaLayout,
  metrics: UIKitFontMetrics,
  visual: TextAreaVisual,
): { rects: RectData[]; text: UIKitTextItem[]; shown: ScrollWindow } {
  const dim = (c: RGBA): RGBA =>
    visual.enabled ? c : mixColor(c, [c[0], c[1], c[2], 0], 0.5)
  const focused = visual.edit !== null
  const rects: RectData[] = []
  const text: UIKitTextItem[] = []

  let fill = style.fill
  if (!visual.enabled) fill = style.disabledFill
  else if (visual.hover) fill = style.hoverFill
  const border = visual.enabled && focused ? style.focusBorder : style.border
  rects.push(
    buildRect({
      ...layout.field,
      radius: style.radius,
      borderWidth: style.borderWidth,
      fill,
      border: dim(border),
    }),
  )

  const area = layout.textArea
  const capH = capHeight(metrics) * style.textSizePx
  const baselineOf = (row: number): number =>
    area.y + row * layout.rowHeight + (layout.rowHeight + capH) / 2
  const color = visual.enabled ? style.textColor : style.disabledTextColor
  const wrapWidth = textAreaWrapWidth(layout, style)

  if (visual.text === '' && spec.placeholder) {
    const hint = spec.placeholder
    const hintRows = wrapRows(
      hint,
      glyphAdvances(metrics, hint, style.textSizePx),
      wrapWidth,
    )
    const shownHint = textAreaWindow(layout, hintRows, 0, null)
    for (let i = shownHint.first; i < shownHint.end; i++) {
      const r = hintRows[i]
      if (r.end === r.start) continue
      text.push({
        str: hint.slice(r.start, r.end),
        x: area.x,
        y: baselineOf(i - shownHint.first),
        sizePx: style.textSizePx,
        align: 0,
        color: dim(style.placeholderColor),
      })
    }
  }

  const advances = glyphAdvances(metrics, visual.text, style.textSizePx)
  const rows = wrapRows(visual.text, advances, wrapWidth)
  const caret = visual.edit ? visual.edit.caret : null
  const shown = textAreaWindow(layout, rows, visual.firstRow, caret)
  const selected =
    visual.edit && hasSelection(visual.edit) ? selectionOf(visual.edit) : null
  for (let i = shown.first; i < shown.end; i++) {
    const r = rows[i]
    const top = area.y + (i - shown.first) * layout.rowHeight
    if (selected) {
      const from = Math.max(selected[0], r.start)
      const to = Math.min(selected[1], r.end)
      // A selection that runs past a hard row end marks the newline too.
      const marksNewline = r.hard && selected[0] <= r.end && selected[1] > r.end
      if (to > from || marksNewline) {
        const w = to > from ? advanceBetween(advances, from, to) : 0
        rects.push(
          buildRect({
            x: area.x + caretXInRow(advances, r, Math.max(from, r.start)),
            y: top,
            width: w + (marksNewline ? style.textSizePx * 0.3 : 0),
            height: layout.rowHeight,
            fill: style.selectionFill,
          }),
        )
      }
    }
    if (r.end > r.start) {
      text.push({
        str: visual.text.slice(r.start, r.end),
        x: area.x,
        y: baselineOf(i - shown.first),
        sizePx: style.textSizePx,
        align: 0,
        color,
      })
    }
  }

  if (visual.edit && visual.enabled && caret !== null && !selected) {
    const row = rowOfCaret(rows, caret)
    if (row >= shown.first && row < shown.end) {
      rects.push(
        buildRect({
          x: area.x + caretXInRow(advances, rows[row], caret),
          y: area.y + (row - shown.first) * layout.rowHeight,
          width: style.caretWidth,
          height: layout.rowHeight,
          fill: style.caretColor,
        }),
      )
    }
  }

  const scrollbar = textAreaScrollbar(layout, style, shown, rows.length)
  if (scrollbar) {
    rects.push(
      buildRect({
        ...scrollbar.track,
        radius: style.scrollbarWidth / 2,
        fill: dim(style.scrollbarTrackColor),
      }),
    )
    rects.push(
      buildRect({
        ...scrollbar.thumb,
        radius: style.scrollbarWidth / 2,
        fill: dim(style.scrollbarColor),
      }),
    )
  }

  if (spec.label) {
    text.push({
      str: spec.label,
      x: layout.x,
      y: layout.labelBaseline,
      sizePx: style.textSizePx,
      align: 0,
      color,
      ...(style.textOutlineWidth > 0
        ? {
            outlineWidthPx: style.textOutlineWidth,
            outlineColor: style.textOutlineColor ?? undefined,
          }
        : {}),
    })
  }
  return { rects, text, shown }
}
