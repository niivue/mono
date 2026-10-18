// Pure single-line text-input model for UIKit: style resolution, layout (an
// optional label, then a bordered field with a text area) and the geometry
// for one visual state, including the placeholder, the selection, the caret
// and the run of glyphs that fits. No GPU and no DOM here; UIKitTextInputOverlay
// wires it to the pointer, the keyboard and the draw hook.

import { mixColor } from './button'
import { buildRect, type RectData } from './rect'
import type { ScrollWindow, UIKitBox } from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { TextEditState } from './textEdit'
import {
  buildTextFieldContent,
  textFieldCaretAt,
  textFieldWindow,
} from './textField'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a text input. All lengths are in canvas pixels. */
export interface TextInputStyle {
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
  /** Halo outline width around the label (it sits on the scene); 0 draws none. */
  textOutlineWidth: number
  /** Halo color; null picks black or white for contrast with `textColor`. */
  textOutlineColor: RGBA | null
  /** Space between the field's left border and the text. */
  paddingX: number
  /** Space between the cap-height box and the field's top and bottom edges. */
  paddingY: number
  /** Space between a label and the field. */
  labelGap: number
  /** Field width when the spec gives none. */
  fieldWidth: number
  caretColor: RGBA
  caretWidth: number
  /** Color behind selected text. */
  selectionFill: RGBA
}

export const DEFAULT_TEXT_INPUT_STYLE: TextInputStyle = {
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
  textOutlineWidth: 1,
  textOutlineColor: null,
  paddingX: 6,
  paddingY: 5,
  labelGap: 8,
  fieldWidth: 160,
  caretColor: [1, 1, 1, 1],
  caretWidth: 1,
  selectionFill: [0.25, 0.47, 0.85, 0.6],
}

export interface TextInputSpec {
  /** Stable key: the handle for updates, pointer tracking and the callbacks. */
  id: string
  /** Optional label, drawn to the left of the field. */
  label?: string
  /** Top-left corner of the whole control (label included), in canvas pixels. */
  x: number
  y: number
  /** Field width (the label adds to it). Default: the style's `fieldWidth`. */
  width?: number
  /** Initial text. Default empty. */
  value?: string
  /** Dimmed text shown while the field is empty. */
  placeholder?: string
  /** Typing stops at this many characters. */
  maxLength?: number
  /** Characters the field refuses from the keyboard. Default: accept all. */
  accept?: (ch: string) => boolean
  /** A disabled input draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-input overrides of the overlay's default style. */
  style?: Partial<TextInputStyle>
  /** Fired on every keystroke that changes the text. */
  onInput?: (text: string, id: string) => void
  /** Fired once when changed text is committed: on Enter and on losing focus. */
  onChange?: (text: string, id: string) => void
  /** Fired on Enter, changed or not, after `onChange`. */
  onSubmit?: (text: string, id: string) => void
}

/** The control's boxes in canvas pixels. */
export interface TextInputLayout {
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

/** The transient state that changes how a text input looks. */
export interface TextInputVisual {
  /** The text shown: the committed text, or the edit in progress. */
  text: string
  /** The edit in progress while the input has keyboard focus, else null. */
  edit: TextEditState | null
  /** Index of the first glyph the text area shows (the overlay keeps it between frames). */
  firstGlyph: number
  hover: boolean
  enabled: boolean
}

export function resolveTextInputStyle(
  base: TextInputStyle,
  override?: Partial<TextInputStyle>,
): TextInputStyle {
  return override ? { ...base, ...override } : base
}

/** The control's boxes for a spec. */
export function layoutTextInput(
  spec: TextInputSpec,
  style: TextInputStyle,
  metrics: UIKitFontMetrics,
): TextInputLayout {
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

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleTextInput(
  spec: TextInputSpec,
  style: TextInputStyle,
  k: number,
): { spec: TextInputSpec; style: TextInputStyle } {
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

/** True when canvas point (px, py) lies inside the field (the label is not interactive). */
export function textInputContains(
  layout: TextInputLayout,
  px: number,
  py: number,
): boolean {
  const b = layout.field
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
}

/**
 * The run of glyphs the text area shows, starting at `firstGlyph` but
 * scrolled the least distance that keeps `caret` in view.
 */
export function textInputTextWindow(
  layout: TextInputLayout,
  style: TextInputStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstGlyph: number,
  caret: number,
): ScrollWindow {
  return textFieldWindow(
    layout.textArea,
    style,
    metrics,
    text,
    firstGlyph,
    caret,
  )
}

/** The caret index for a canvas x over text shown from `firstGlyph`. */
export function textInputCaretAt(
  layout: TextInputLayout,
  style: TextInputStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstGlyph: number,
  px: number,
): number {
  return textFieldCaretAt(layout.textArea, style, metrics, text, firstGlyph, px)
}

/**
 * The draw data for one text input in one visual state: the field, the
 * placeholder or the selection, the visible run of text and the caret, and
 * the label.
 */
export function buildTextInput(
  spec: TextInputSpec,
  style: TextInputStyle,
  layout: TextInputLayout,
  metrics: UIKitFontMetrics,
  visual: TextInputVisual,
): { rects: RectData[]; text: UIKitTextItem[] } {
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

  const color = visual.enabled ? style.textColor : style.disabledTextColor
  if (visual.text === '' && spec.placeholder) {
    // The placeholder is clipped to the text area the same way as text.
    const hint = buildTextFieldContent(
      layout.textArea,
      layout.baseline,
      style,
      metrics,
      spec.placeholder,
      null,
      0,
      dim(style.placeholderColor),
      visual.enabled,
    )
    text.push(...hint.text)
  }
  const content = buildTextFieldContent(
    layout.textArea,
    layout.baseline,
    style,
    metrics,
    visual.text,
    visual.edit,
    visual.firstGlyph,
    color,
    visual.enabled,
  )
  rects.push(...content.rects)
  text.push(...content.text)

  if (spec.label) {
    text.push({
      str: spec.label,
      x: layout.x,
      y: layout.baseline,
      sizePx: style.textSizePx,
      align: 0,
      color,
      outlineWidthPx: style.textOutlineWidth,
      outlineColor: style.textOutlineColor ?? undefined,
    })
  }
  return { rects, text }
}
