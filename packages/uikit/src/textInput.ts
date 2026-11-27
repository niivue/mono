// Pure single-line text-input model for UIKit: style resolution, layout (an
// optional label, then a bordered field with a text area) and the geometry
// for one visual state, including the placeholder, the selection, the caret
// and the run of glyphs that fits. No GPU and no DOM here; UIKitTextInputOverlay
// wires it to the pointer, the keyboard and the draw hook.

import { type RectData, rectContains } from './rect'
import type { UIKitFontMetrics } from './text/font'
import type { RGBA } from './text/layout'
import type { TextEditState } from './textEdit'
import {
  buildFieldBox,
  buildLineFieldLabel,
  buildTextFieldContent,
  dimField,
  type FieldStyle,
  type LineFieldLayout,
  layoutLineField,
  scaleField,
} from './textField'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a text input. All lengths are in canvas pixels. */
export interface TextInputStyle extends FieldStyle {
  /** Color of the placeholder shown while the field is empty. */
  placeholderColor: RGBA
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
export type TextInputLayout = LineFieldLayout

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

/** The control's boxes for a spec. */
export function layoutTextInput(
  spec: TextInputSpec,
  style: TextInputStyle,
  metrics: UIKitFontMetrics,
): TextInputLayout {
  return layoutLineField(spec, style, metrics)
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleTextInput(
  spec: TextInputSpec,
  style: TextInputStyle,
  k: number,
): { spec: TextInputSpec; style: TextInputStyle } {
  return scaleField(spec, style, k)
}

/** True when canvas point (px, py) lies inside the field (the label is not interactive). */
export function textInputContains(
  layout: TextInputLayout,
  px: number,
  py: number,
): boolean {
  return rectContains(layout.field, px, py)
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
  const focused = visual.edit !== null
  const rects: RectData[] = []
  const text: UIKitTextItem[] = []

  const border = visual.enabled && focused ? style.focusBorder : style.border
  rects.push(
    buildFieldBox(layout.field, style, border, visual.hover, visual.enabled),
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
      dimField(style.placeholderColor, visual.enabled),
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

  if (spec.label)
    text.push(buildLineFieldLabel(spec.label, layout, style, color))
  return { rects, text }
}
