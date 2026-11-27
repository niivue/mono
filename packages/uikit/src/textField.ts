// The parts of a field shared by UIKit's entry widgets (number inputs, text
// inputs, text areas): the single-line layout and CSS scaling, the bordered
// box and label, which glyphs a text area shows, the caret index for a
// pointer x, and the draw data for the selection, the visible run of text and
// the caret. No GPU and no DOM here.

import { mixColor } from './button'
import { buildRect, type RectData, type UIKitBox } from './rect'
import type { ScrollWindow } from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
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

/** The style knobs the text input, text area and number input share. */
export interface FieldStyle extends TextFieldStyle {
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
  /** Label and field text em size. */
  textSizePx: number
  /** Halo outline width around the label (it sits on the scene); 0 draws none. */
  textOutlineWidth: number
  /** Halo color; null picks black or white for contrast with `textColor`. */
  textOutlineColor: RGBA | null
  /** Space between the field's left border and the text. */
  paddingX: number
  /**
   * Space between the text (a single line's cap-height box, or a text area's
   * rows) and the field's top and bottom edges.
   */
  paddingY: number
  /** Space between a label and the field. */
  labelGap: number
  /** Field width when the spec gives none. */
  fieldWidth: number
}

/** A single-line field's boxes in canvas pixels. */
export interface LineFieldLayout {
  /** The whole control: label and field. */
  x: number
  y: number
  width: number
  height: number
  /** The bordered field. */
  field: UIKitBox
  /** Where the text, caret and selection draw. */
  textArea: UIKitBox
  /** Baseline of the label and the field text. */
  baseline: number
}

interface FieldPlacement {
  label?: string
  x: number
  y: number
  width?: number
}

/** An optional label, then a bordered field padded around one line of text. */
export function layoutLineField(
  spec: FieldPlacement,
  style: FieldStyle,
  metrics: UIKitFontMetrics,
): LineFieldLayout {
  const capH = capHeight(metrics) * style.textSizePx
  const labelW = spec.label
    ? measureWidth(metrics, spec.label, style.textSizePx) + style.labelGap
    : 0
  const fieldW = spec.width ?? style.fieldWidth
  const fieldH = Math.ceil(capH + 2 * style.paddingY)
  const b = style.borderWidth
  const field = { x: spec.x + labelW, y: spec.y, width: fieldW, height: fieldH }
  return {
    x: spec.x,
    y: spec.y,
    width: labelW + fieldW,
    height: fieldH,
    field,
    textArea: {
      x: field.x + style.paddingX,
      y: field.y + b,
      width: Math.max(0, fieldW - 2 * style.paddingX),
      height: fieldH - 2 * b,
    },
    baseline: field.y + style.paddingY + capH,
  }
}

/** Scale a field's position and shared style lengths by `k` (CSS pixels to canvas pixels). */
export function scaleField<S extends FieldPlacement, T extends FieldStyle>(
  spec: S,
  style: T,
  k: number,
): { spec: S; style: T } {
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
    },
  }
}

/** A color as a disabled field draws it: half as opaque. */
export function dimField(c: RGBA, enabled: boolean): RGBA {
  return enabled ? c : mixColor(c, [c[0], c[1], c[2], 0], 0.5)
}

/** The bordered field box, its fill following hover and enabled. */
export function buildFieldBox(
  field: UIKitBox,
  style: FieldStyle,
  border: RGBA,
  hover: boolean,
  enabled: boolean,
): RectData {
  let fill = style.fill
  if (!enabled) fill = style.disabledFill
  else if (hover) fill = style.hoverFill
  return buildRect({
    ...field,
    radius: style.radius,
    borderWidth: style.borderWidth,
    fill,
    border: dimField(border, enabled),
  })
}

/** A single-line field's label, left of the field on its baseline. */
export function buildLineFieldLabel(
  label: string,
  layout: LineFieldLayout,
  style: FieldStyle,
  color: RGBA,
): UIKitTextItem {
  return {
    str: label,
    x: layout.x,
    y: layout.baseline,
    sizePx: style.textSizePx,
    align: 0,
    color,
    outlineWidthPx: style.textOutlineWidth,
    outlineColor: style.textOutlineColor ?? undefined,
  }
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
    text,
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
  return caretIndexAt(text, advances, firstGlyph, px - area.x)
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
    text,
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
