// The text-bearing part of a field shared by UIKit's single-line entry
// widgets (number inputs, text inputs): which glyphs a text area shows, the
// caret index for a pointer x, and the draw data for the selection, the
// visible run of text and the caret. No GPU and no DOM here.

import { buildRect, type RectData } from './rect'
import type { ScrollWindow, UIKitBox } from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, type RGBA } from './text/layout'
import {
  advanceBetween,
  caretIndexAt,
  glyphAdvances,
  hasSelection,
  selectionOf,
  type TextEditState,
  textWindow,
} from './textEdit'
import type { UIKitTextItem } from './textOverlay'

/** The style knobs the text of a field needs. */
export interface TextFieldStyle {
  textSizePx: number
  caretWidth: number
  caretColor: RGBA
  /** Color behind selected text. */
  selectionFill: RGBA
}

/** The width a text area has for glyphs, keeping room for the caret. */
export function textFieldViewport(area: UIKitBox, caretWidth: number): number {
  return Math.max(0, area.width - caretWidth)
}

/**
 * The run of glyphs a text area shows, starting at `firstGlyph` but scrolled
 * the least distance that keeps `caret` in view.
 */
export function textFieldWindow(
  area: UIKitBox,
  style: TextFieldStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstGlyph: number,
  caret: number,
): ScrollWindow {
  const advances = glyphAdvances(metrics, text, style.textSizePx)
  return textWindow(
    advances,
    textFieldViewport(area, style.caretWidth),
    firstGlyph,
    caret,
  )
}

/** The caret index for a canvas x over text shown from `firstGlyph`. */
export function textFieldCaretAt(
  area: UIKitBox,
  style: TextFieldStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstGlyph: number,
  px: number,
): number {
  const advances = glyphAdvances(metrics, text, style.textSizePx)
  return caretIndexAt(advances, firstGlyph, px - area.x)
}

/**
 * The draw data for a field's text: the selection (behind), the glyphs that
 * fit and, while focused with nothing selected, the caret. `edit` is the
 * edit in progress or null when the field is not focused.
 */
export function buildTextFieldContent(
  area: UIKitBox,
  baseline: number,
  style: TextFieldStyle,
  metrics: UIKitFontMetrics,
  text: string,
  edit: TextEditState | null,
  firstGlyph: number,
  color: RGBA,
  enabled: boolean,
): { rects: RectData[]; text: UIKitTextItem[]; shown: ScrollWindow } {
  const rects: RectData[] = []
  const items: UIKitTextItem[] = []
  const advances = glyphAdvances(metrics, text, style.textSizePx)
  const caret = edit ? edit.caret : 0
  const shown = textWindow(
    advances,
    textFieldViewport(area, style.caretWidth),
    firstGlyph,
    caret,
  )
  const xAt = (index: number): number =>
    area.x + advanceBetween(advances, shown.first, index)
  const capH = capHeight(metrics) * style.textSizePx
  const inkTop = baseline - capH * 1.15
  const inkH = capH * 1.4
  if (edit && hasSelection(edit)) {
    const [a, b] = selectionOf(edit)
    const from = Math.max(a, shown.first)
    const to = Math.min(b, shown.end)
    if (to > from) {
      rects.push(
        buildRect({
          x: xAt(from),
          y: inkTop,
          width: advanceBetween(advances, from, to),
          height: inkH,
          fill: style.selectionFill,
        }),
      )
    }
  }
  if (shown.end > shown.first) {
    items.push({
      str: text.slice(shown.first, shown.end),
      x: area.x,
      y: baseline,
      sizePx: style.textSizePx,
      align: 0,
      color,
    })
  }
  if (
    edit &&
    enabled &&
    !hasSelection(edit) &&
    caret >= shown.first &&
    caret <= shown.end
  ) {
    rects.push(
      buildRect({
        x: xAt(caret),
        y: inkTop,
        width: style.caretWidth,
        height: inkH,
        fill: style.caretColor,
      }),
    )
  }
  return { rects, text: items, shown }
}
