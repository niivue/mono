// Pure number-input model for UIKit: value arithmetic (parse, clamp, snap to
// step, step up and down), style resolution, layout (an optional label, then
// a field with a text area and a two-button spinner at its right end) and the
// geometry for one visual state, including the caret, the selection and the
// run of glyphs that fits the text area. No GPU and no DOM here;
// UIKitNumberInputOverlay wires it to the pointer, the keyboard and the draw
// hook.

import { mixColor } from './button'
import { buildLine, type LineData } from './line'
import { buildRect, type RectData } from './rect'
import { buildScrollArrow, type ScrollWindow, type UIKitBox } from './scroll'
import { stepDecimals, usableStep } from './slider'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { TextEditState } from './textEdit'
import {
  buildTextFieldContent,
  textFieldCaretAt,
  textFieldWindow,
} from './textField'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a number input. All lengths are in canvas pixels. */
export interface NumberInputStyle {
  /** Field color at rest. */
  fill: RGBA
  /** Field color while the pointer hovers it. */
  hoverFill: RGBA
  /** Field color when disabled. */
  disabledFill: RGBA
  border: RGBA
  /** Border color while the field has keyboard focus. */
  focusBorder: RGBA
  /** Border color while the typed text is not a number. */
  invalidBorder: RGBA
  borderWidth: number
  radius: number
  textColor: RGBA
  disabledTextColor: RGBA
  /** Label and value em size. */
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
  /** Width of the spinner column (the up and down buttons) inside the field. */
  spinnerWidth: number
  spinnerFill: RGBA
  spinnerHoverFill: RGBA
  spinnerPressedFill: RGBA
  /** Color of the lines separating the spinner from the text and its two halves. */
  dividerColor: RGBA
  /** Spinner chevron width, stroke width and color. */
  arrowSize: number
  arrowWidth: number
  arrowColor: RGBA
  caretColor: RGBA
  caretWidth: number
  /** Color behind selected text. */
  selectionFill: RGBA
}

export const DEFAULT_NUMBER_INPUT_STYLE: NumberInputStyle = {
  fill: [0.1, 0.11, 0.14, 0.96],
  hoverFill: [0.13, 0.15, 0.19, 0.96],
  disabledFill: [0.1, 0.11, 0.14, 0.5],
  border: [0.6, 0.66, 0.78, 1],
  focusBorder: [0.55, 0.7, 1, 1],
  invalidBorder: [0.95, 0.4, 0.4, 1],
  borderWidth: 1,
  radius: 4,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 14,
  textOutlineWidth: 1,
  textOutlineColor: null,
  paddingX: 6,
  paddingY: 5,
  labelGap: 8,
  fieldWidth: 80,
  spinnerWidth: 16,
  spinnerFill: [0.17, 0.19, 0.24, 1],
  spinnerHoverFill: [0.24, 0.27, 0.34, 1],
  spinnerPressedFill: [0.25, 0.47, 0.85, 1],
  dividerColor: [0.6, 0.66, 0.78, 0.6],
  arrowSize: 7,
  arrowWidth: 1.5,
  arrowColor: [1, 1, 1, 0.85],
  caretColor: [1, 1, 1, 1],
  caretWidth: 1,
  selectionFill: [0.25, 0.47, 0.85, 0.6],
}

export interface NumberInputSpec {
  /** Stable key: the handle for updates, pointer tracking and the callbacks. */
  id: string
  /** Optional label, drawn to the left of the field. */
  label?: string
  /** Top-left corner of the whole control (label included), in canvas pixels. */
  x: number
  y: number
  /** Field width (the label adds to it). Default: the style's `fieldWidth`. */
  width?: number
  /** Lower bound; omit for none. */
  min?: number
  /** Upper bound; omit for none. */
  max?: number
  /**
   * Value granularity, counted from `min` (or 0). Omit for any number; the
   * spinner and arrow keys then move by 1.
   */
  step?: number
  /** Initial value (clamped and snapped). */
  value: number
  /** Formatter for the displayed value. Default: the step's decimal places. */
  format?: (value: number) => string
  /**
   * Parser for typed text, returning NaN for text that is not a number.
   * Default: `Number` on the trimmed text, with empty text invalid.
   */
  parse?: (text: string) => number
  /** A disabled input draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-input overrides of the overlay's default style. */
  style?: Partial<NumberInputStyle>
  /**
   * Fired while the user edits: for every keystroke that leaves a valid
   * number different from the last one reported, and for every step.
   */
  onInput?: (value: number, id: string) => void
  /**
   * Fired once when a changed value is committed: on Enter, on losing focus,
   * and on every step (spinner, arrow keys, wheel).
   */
  onChange?: (value: number, id: string) => void
}

/** The control's boxes in canvas pixels. */
export interface NumberInputLayout {
  /** The whole control: label and field. */
  x: number
  y: number
  width: number
  height: number
  /** The bordered field. */
  field: UIKitBox
  /** Where the text, caret and selection draw: the field left of the spinner. */
  textArea: UIKitBox
  spinUp: UIKitBox
  spinDown: UIKitBox
  /** Baseline of the label and the field text. */
  baseline: number
}

/** The transient state that changes how a number input looks. */
export interface NumberInputVisual {
  /** The text shown: the formatted value, or the edit in progress. */
  text: string
  /** The edit in progress while the input has keyboard focus, else null. */
  edit: TextEditState | null
  /** Index of the first glyph the text area shows (the overlay keeps it between frames). */
  firstGlyph: number
  /** False while the text is not a number. */
  valid: boolean
  hover: boolean
  /** The spinner half under the pointer: 1 up, -1 down, 0 neither. */
  spinHover: 1 | -1 | 0
  /** The spinner half held down. */
  spinPressed: 1 | -1 | 0
  enabled: boolean
}

export function resolveNumberInputStyle(
  base: NumberInputStyle,
  override?: Partial<NumberInputStyle>,
): NumberInputStyle {
  return override ? { ...base, ...override } : base
}

type Range = Pick<NumberInputSpec, 'min' | 'max' | 'step'>

/** Clamp `value` into the spec's bounds and snap it to its step grid. NaN clamps to the low end, or 0. */
export function snapNumberInput(spec: Range, value: number): number {
  const lo = boundOf(spec.min, Number.NEGATIVE_INFINITY)
  const hi = boundOf(spec.max, Number.POSITIVE_INFINITY)
  const clamp = (v: number): number => Math.min(hi, Math.max(lo, v))
  if (!Number.isFinite(value)) return clamp(Number.isFinite(lo) ? lo : 0)
  let v = clamp(value)
  const step = usableStep(spec.step)
  if (step !== undefined) {
    const origin = Number.isFinite(lo) ? lo : 0
    // The tiny bias keeps a half-way value rounding up as a reader expects.
    const n = Math.round((v - origin) / step + 1e-9)
    v = Number((origin + n * step).toFixed(stepDecimals(step)))
    v = clamp(v)
  }
  return v
}

/** A bound as given when finite (or an infinity), else `fallback`: NaN never leaks into a value. */
function boundOf(bound: number | undefined, fallback: number): number {
  return bound !== undefined && !Number.isNaN(bound) ? bound : fallback
}

/** Move `value` by one step (ten with `big`) in `direction`, snapped. */
export function stepNumberInput(
  spec: Range,
  value: number,
  direction: 1 | -1,
  big = false,
): number {
  const step = usableStep(spec.step)
  const by = (step ?? 1) * (big ? 10 : 1)
  const next = snapNumberInput(spec, value + direction * by)
  return step === undefined ? Number(next.toPrecision(12)) : next
}

/** The displayed text for a value: the spec's formatter, else the step's precision. */
export function formatNumberInput(
  spec: Pick<NumberInputSpec, 'step' | 'format'>,
  value: number,
): string {
  if (spec.format) return spec.format(value)
  const step = usableStep(spec.step)
  if (step !== undefined) return value.toFixed(stepDecimals(step))
  return String(Number(value.toPrecision(12)))
}

/** The number typed text means, or NaN when it is not one. */
export function parseNumberInput(
  spec: Pick<NumberInputSpec, 'parse'>,
  text: string,
): number {
  if (spec.parse) return spec.parse(text)
  const t = text.trim()
  if (t === '') return Number.NaN
  return Number(t)
}

/** True for a character a number field accepts from the keyboard. */
export function acceptNumberChar(ch: string): boolean {
  return /^[0-9.eE+-]$/.test(ch)
}

/** The control's boxes for a spec. */
export function layoutNumberInput(
  spec: NumberInputSpec,
  style: NumberInputStyle,
  metrics: UIKitFontMetrics,
): NumberInputLayout {
  const capH = capHeight(metrics) * style.textSizePx
  const labelW = spec.label
    ? measureWidth(metrics, spec.label, style.textSizePx) + style.labelGap
    : 0
  const fieldW = spec.width ?? style.fieldWidth
  const fieldH = Math.ceil(capH + 2 * style.paddingY)
  const b = style.borderWidth
  const field = { x: spec.x + labelW, y: spec.y, width: fieldW, height: fieldH }
  const spinX = field.x + fieldW - b - style.spinnerWidth
  const halfH = (fieldH - 2 * b) / 2
  const textX = field.x + style.paddingX
  return {
    x: spec.x,
    y: spec.y,
    width: labelW + fieldW,
    height: fieldH,
    field,
    textArea: {
      x: textX,
      y: field.y + b,
      width: Math.max(0, spinX - style.paddingX - textX),
      height: fieldH - 2 * b,
    },
    spinUp: {
      x: spinX,
      y: field.y + b,
      width: style.spinnerWidth,
      height: halfH,
    },
    spinDown: {
      x: spinX,
      y: field.y + b + halfH,
      width: style.spinnerWidth,
      height: halfH,
    },
    baseline: field.y + style.paddingY + capH,
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleNumberInput(
  spec: NumberInputSpec,
  style: NumberInputStyle,
  k: number,
): { spec: NumberInputSpec; style: NumberInputStyle } {
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
      spinnerWidth: style.spinnerWidth * k,
      arrowSize: style.arrowSize * k,
      arrowWidth: style.arrowWidth * k,
      caretWidth: style.caretWidth * k,
    },
  }
}

function boxContains(b: UIKitBox, px: number, py: number): boolean {
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
}

/** True when canvas point (px, py) lies inside the field (the label is not interactive). */
export function numberInputContains(
  layout: NumberInputLayout,
  px: number,
  py: number,
): boolean {
  return boxContains(layout.field, px, py)
}

/** The spinner half under a canvas point: 1 up, -1 down, 0 neither. */
export function numberInputSpinAt(
  layout: NumberInputLayout,
  px: number,
  py: number,
): 1 | -1 | 0 {
  if (boxContains(layout.spinUp, px, py)) return 1
  if (boxContains(layout.spinDown, px, py)) return -1
  return 0
}

/**
 * The run of glyphs the text area shows, starting at `firstGlyph` but
 * scrolled the least distance that keeps `caret` in view.
 */
export function numberInputTextWindow(
  layout: NumberInputLayout,
  style: NumberInputStyle,
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
export function numberInputCaretAt(
  layout: NumberInputLayout,
  style: NumberInputStyle,
  metrics: UIKitFontMetrics,
  text: string,
  firstGlyph: number,
  px: number,
): number {
  return textFieldCaretAt(layout.textArea, style, metrics, text, firstGlyph, px)
}

/**
 * The draw data for one number input in one visual state: the field, the
 * spinner with its chevrons, the selection, the visible run of text, the
 * caret and the label.
 */
export function buildNumberInput(
  spec: NumberInputSpec,
  style: NumberInputStyle,
  layout: NumberInputLayout,
  metrics: UIKitFontMetrics,
  visual: NumberInputVisual,
): { rects: RectData[]; lines: LineData[]; text: UIKitTextItem[] } {
  const dim = (c: RGBA): RGBA =>
    visual.enabled ? c : mixColor(c, [c[0], c[1], c[2], 0], 0.5)
  const focused = visual.edit !== null
  const rects: RectData[] = []
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []

  let fill = style.fill
  if (!visual.enabled) fill = style.disabledFill
  else if (visual.hover) fill = style.hoverFill
  let border = style.border
  if (visual.enabled && !visual.valid) border = style.invalidBorder
  else if (visual.enabled && focused) border = style.focusBorder
  rects.push(
    buildRect({
      ...layout.field,
      radius: style.radius,
      borderWidth: style.borderWidth,
      fill,
      border: dim(border),
    }),
  )

  // Spinner: two faces, a divider against the text and one between them.
  const spinFill = (half: 1 | -1): RGBA => {
    if (!visual.enabled) return dim(style.spinnerFill)
    if (visual.spinPressed === half) return style.spinnerPressedFill
    if (visual.spinHover === half) return style.spinnerHoverFill
    return style.spinnerFill
  }
  rects.push(
    buildRect({ ...layout.spinUp, fill: spinFill(1) }),
    buildRect({ ...layout.spinDown, fill: spinFill(-1) }),
  )
  const divider = dim(style.dividerColor)
  const w = style.borderWidth
  lines.push(
    buildLine(
      layout.spinUp.x,
      layout.spinUp.y,
      layout.spinUp.x,
      layout.spinDown.y + layout.spinDown.height,
      w,
      divider,
    ),
    buildLine(
      layout.spinUp.x,
      layout.spinDown.y,
      layout.spinUp.x + layout.spinUp.width,
      layout.spinDown.y,
      w,
      divider,
    ),
  )
  const arrow = {
    height: layout.spinUp.height,
    arrowSize: style.arrowSize,
    arrowWidth: style.arrowWidth,
    arrowColor: dim(style.arrowColor),
  }
  lines.push(
    ...buildScrollArrow(layout.spinUp, -1, arrow),
    ...buildScrollArrow(layout.spinDown, 1, arrow),
  )

  // The text: only the glyphs that fit, scrolled to keep the caret in view.
  const color = visual.enabled ? style.textColor : style.disabledTextColor
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
  return { rects, lines, text }
}
