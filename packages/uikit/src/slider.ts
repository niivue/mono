// Pure slider model for UIKit: value arithmetic (clamp, snap to step, keyboard
// steps), style resolution, layout (an optional label row over a track with a
// thumb) and geometry for one visual state. No GPU and no DOM here;
// UIKitSliderOverlay wires it to the pointer, the keyboard and the draw hook.

import { mixColor } from './button'
import { buildLine, type LineData } from './line'
import { buildRect, type RectData } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'
import { buildFocusRing } from './toggle'

/** Every visual knob on a slider. All lengths are in canvas pixels. */
export interface SliderStyle {
  trackHeight: number
  trackRadius: number
  /** Track color to the right of the thumb. */
  trackFill: RGBA
  /** Track color from the left end to the thumb. */
  trackActiveFill: RGBA
  /** Diameter of the (round) thumb. */
  thumbSize: number
  thumbFill: RGBA
  thumbHoverFill: RGBA
  /** Thumb color while it is being dragged. */
  thumbActiveFill: RGBA
  thumbBorder: RGBA
  thumbBorderWidth: number
  /** Tick marks under the track (drawn when the spec sets `tickStep`). */
  tickColor: RGBA
  tickLength: number
  tickWidth: number
  textColor: RGBA
  disabledTextColor: RGBA
  /** Label and value em size. */
  textSizePx: number
  /** Space between the label row baseline and the thumb row. */
  labelGap: number
  /** Focus ring color (drawn around the thumb while the slider has keyboard focus). */
  focusRing: RGBA
  focusRingWidth: number
}

export const DEFAULT_SLIDER_STYLE: SliderStyle = {
  trackHeight: 6,
  trackRadius: 3,
  trackFill: [0.17, 0.19, 0.24, 0.94],
  trackActiveFill: [0.25, 0.47, 0.85, 1],
  thumbSize: 18,
  thumbFill: [0.92, 0.94, 0.98, 1],
  thumbHoverFill: [1, 1, 1, 1],
  thumbActiveFill: [0.75, 0.85, 1, 1],
  thumbBorder: [0.6, 0.66, 0.78, 1],
  thumbBorderWidth: 1,
  tickColor: [0.6, 0.66, 0.78, 0.8],
  tickLength: 4,
  tickWidth: 1,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 14,
  labelGap: 6,
  focusRing: [0.55, 0.7, 1, 0.9],
  focusRingWidth: 2,
}

export interface SliderSpec {
  /** Stable key: the handle for updates, pointer tracking and the callbacks. */
  id: string
  /** Optional label, drawn above the track at the left. */
  label?: string
  /** Top-left corner of the whole control, in canvas pixels. */
  x: number
  y: number
  /** Width of the whole control (the track spans it, inset by half the thumb). */
  width: number
  min: number
  max: number
  /**
   * Value granularity. Omit for a continuous slider; the keyboard then moves
   * by one hundredth of the range.
   */
  step?: number
  /** Initial value (snapped to the range and step). */
  value: number
  /** Draw the current value above the track at the right. Default false. */
  showValue?: boolean
  /** Formatter for the displayed value. Default: the step's decimal places. */
  format?: (value: number) => string
  /** Spacing of tick marks under the track, in value units. Omit for none. */
  tickStep?: number
  /** A disabled slider draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-slider overrides of the overlay's default style. */
  style?: Partial<SliderStyle>
  /** Fired for every value change during a drag or key press. */
  onInput?: (value: number, id: string) => void
  /**
   * Fired once when an interaction commits a changed value: on pointer release
   * after a drag that moved it, and after each key press that moved it.
   */
  onChange?: (value: number, id: string) => void
}

/** The control's box in canvas pixels plus the track and the thumb's rail. */
export interface SliderLayout {
  x: number
  y: number
  width: number
  height: number
  /** The drawn track bar. */
  track: { x: number; y: number; width: number; height: number }
  /** Where the thumb centre may travel: from x0 (min) to x1 (max) along cy. */
  rail: { x0: number; x1: number; cy: number }
  /** Baseline of the label row, or null when the slider has no label row. */
  labelBaseline: number | null
}

/** The transient state that changes how a slider looks. */
export interface SliderVisual {
  value: number
  hover: boolean
  /** The thumb is being dragged. */
  active: boolean
  focused: boolean
  enabled: boolean
}

export function resolveSliderStyle(
  base: SliderStyle,
  override?: Partial<SliderStyle>,
): SliderStyle {
  return override ? { ...base, ...override } : base
}

/** The number of decimal places needed to print multiples of `step` exactly. */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const s = step.toString()
  const [mantissa, exponent] = s.split('e')
  const dot = mantissa.indexOf('.')
  const mantissaDecimals = dot < 0 ? 0 : mantissa.length - dot - 1
  const exp = exponent === undefined ? 0 : Number(exponent)
  return Math.max(0, mantissaDecimals - exp)
}

/** Clamp `value` into [min, max] and, with a positive step, snap it to the step grid from min. */
export function snapValue(
  value: number,
  min: number,
  max: number,
  step?: number,
): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  let v = Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo))
  if (step !== undefined && step > 0) {
    // The tiny bias keeps a half-way value (0.35 by 0.1) rounding up as a
    // reader expects, despite the division landing a hair under .5.
    const n = Math.round((v - min) / step + 1e-9)
    v = Number((min + n * step).toFixed(decimalsOf(step)))
    v = Math.min(hi, Math.max(lo, v))
  }
  return v
}

/** Position of `value` along the range as 0..1 (0 when the range is empty). */
export function valueToFraction(
  value: number,
  min: number,
  max: number,
): number {
  if (max === min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

export function fractionToValue(
  fraction: number,
  min: number,
  max: number,
): number {
  return min + Math.min(1, Math.max(0, fraction)) * (max - min)
}

/** The step a key press moves by: the spec's, or a hundredth of the range. */
export function effectiveStep(
  spec: Pick<SliderSpec, 'min' | 'max' | 'step'>,
): number {
  if (spec.step !== undefined && spec.step > 0) return spec.step
  const range = Math.abs(spec.max - spec.min)
  return range > 0 ? range / 100 : 1
}

/** Move `value` by one step (ten with `big`) in `direction` (+1 or -1), snapped. */
export function stepValue(
  value: number,
  spec: Pick<SliderSpec, 'min' | 'max' | 'step'>,
  direction: 1 | -1,
  big = false,
): number {
  const step = effectiveStep(spec) * (big ? 10 : 1)
  const next = value + direction * step
  const snapped = snapValue(next, spec.min, spec.max, spec.step)
  // A continuous slider has no grid: still print a tidy number.
  return spec.step === undefined ? Number(snapped.toFixed(6)) : snapped
}

/** The displayed text for a value: the spec's formatter, else the step's precision. */
export function formatSliderValue(
  spec: Pick<SliderSpec, 'step' | 'format'>,
  value: number,
): string {
  if (spec.format) return spec.format(value)
  if (spec.step !== undefined && spec.step > 0) {
    return value.toFixed(decimalsOf(spec.step))
  }
  return String(Number(value.toFixed(2)))
}

/** The control box for a spec: an optional label row above the thumb row. */
export function layoutSlider(
  spec: SliderSpec,
  style: SliderStyle,
  metrics: UIKitFontMetrics,
): SliderLayout {
  const hasLabelRow = Boolean(spec.label) || spec.showValue === true
  const labelH = hasLabelRow ? capHeight(metrics) * style.textSizePx : 0
  const rowTop = spec.y + (hasLabelRow ? labelH + style.labelGap : 0)
  const rowH = Math.max(style.thumbSize, style.trackHeight)
  const ticksH =
    spec.tickStep !== undefined && spec.tickStep > 0 ? style.tickLength + 2 : 0
  const cy = rowTop + rowH / 2
  const inset = style.thumbSize / 2
  const x0 = spec.x + inset
  const x1 = Math.max(x0, spec.x + spec.width - inset)
  return {
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: Math.ceil(rowTop - spec.y + rowH + ticksH),
    track: {
      x: spec.x,
      y: cy - style.trackHeight / 2,
      width: spec.width,
      height: style.trackHeight,
    },
    rail: { x0, x1, cy },
    labelBaseline: hasLabelRow ? spec.y + labelH : null,
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleSlider(
  spec: SliderSpec,
  style: SliderStyle,
  k: number,
): { spec: SliderSpec; style: SliderStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: { ...spec, x: spec.x * k, y: spec.y * k, width: spec.width * k },
    style: {
      ...style,
      trackHeight: style.trackHeight * k,
      trackRadius: style.trackRadius * k,
      thumbSize: style.thumbSize * k,
      thumbBorderWidth: style.thumbBorderWidth * k,
      tickLength: style.tickLength * k,
      tickWidth: style.tickWidth * k,
      textSizePx: style.textSizePx * k,
      labelGap: style.labelGap * k,
      focusRingWidth: style.focusRingWidth * k,
    },
  }
}

/** The thumb centre x for a value. */
export function sliderThumbX(
  layout: SliderLayout,
  spec: Pick<SliderSpec, 'min' | 'max'>,
  value: number,
): number {
  const f = valueToFraction(value, spec.min, spec.max)
  return layout.rail.x0 + f * (layout.rail.x1 - layout.rail.x0)
}

/** The (snapped) value for a pointer x along the rail. */
export function sliderValueAt(
  layout: SliderLayout,
  spec: Pick<SliderSpec, 'min' | 'max' | 'step'>,
  px: number,
): number {
  const span = layout.rail.x1 - layout.rail.x0
  const f = span > 0 ? (px - layout.rail.x0) / span : 0
  const raw = fractionToValue(f, spec.min, spec.max)
  const v = snapValue(raw, spec.min, spec.max, spec.step)
  return spec.step === undefined ? Number(v.toFixed(6)) : v
}

/** True when canvas point (px, py) lies inside the control box. */
export function sliderContains(
  layout: SliderLayout,
  px: number,
  py: number,
): boolean {
  return (
    px >= layout.x &&
    px < layout.x + layout.width &&
    py >= layout.y &&
    py < layout.y + layout.height
  )
}

/**
 * The draw data for one slider in one visual state: the track with its active
 * part filled to the thumb, tick marks, the thumb (with a focus ring when
 * focused), and the label row.
 */
export function buildSlider(
  spec: SliderSpec,
  style: SliderStyle,
  layout: SliderLayout,
  visual: SliderVisual,
): { rects: RectData[]; lines: LineData[]; text: UIKitTextItem[] } {
  const dim = (c: RGBA): RGBA =>
    visual.enabled ? c : mixColor(c, [c[0], c[1], c[2], 0], 0.5)
  const tx = sliderThumbX(layout, spec, visual.value)
  const rects: RectData[] = []
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []

  rects.push(
    buildRect({
      ...layout.track,
      radius: style.trackRadius,
      fill: dim(style.trackFill),
    }),
  )
  const activeW = tx - layout.track.x
  if (activeW > 0) {
    rects.push(
      buildRect({
        x: layout.track.x,
        y: layout.track.y,
        width: activeW,
        height: layout.track.height,
        radius: style.trackRadius,
        fill: dim(style.trackActiveFill),
      }),
    )
  }

  if (
    spec.tickStep !== undefined &&
    spec.tickStep > 0 &&
    spec.max !== spec.min
  ) {
    const top =
      layout.rail.cy + Math.max(style.thumbSize, style.trackHeight) / 2 + 1
    const count = Math.floor(
      Math.abs(spec.max - spec.min) / spec.tickStep + 1e-9,
    )
    for (let i = 0; i <= count; i++) {
      const v = spec.min + i * spec.tickStep * Math.sign(spec.max - spec.min)
      const x = sliderThumbX(layout, spec, v)
      lines.push(
        buildLine(
          x,
          top,
          x,
          top + style.tickLength,
          style.tickWidth,
          dim(style.tickColor),
        ),
      )
    }
  }

  const half = style.thumbSize / 2
  const thumb = {
    x: tx - half,
    y: layout.rail.cy - half,
    width: style.thumbSize,
    height: style.thumbSize,
  }
  if (visual.focused && visual.enabled) {
    rects.push(
      buildFocusRing(thumb, half, style.focusRing, style.focusRingWidth),
    )
  }
  let thumbFill = style.thumbFill
  if (visual.enabled && visual.active) thumbFill = style.thumbActiveFill
  else if (visual.enabled && visual.hover) thumbFill = style.thumbHoverFill
  rects.push(
    buildRect({
      ...thumb,
      radius: half,
      borderWidth: style.thumbBorderWidth,
      fill: dim(thumbFill),
      border: dim(style.thumbBorder),
    }),
  )

  if (layout.labelBaseline !== null) {
    const color = visual.enabled ? style.textColor : style.disabledTextColor
    if (spec.label) {
      text.push({
        str: spec.label,
        x: layout.x,
        y: layout.labelBaseline,
        sizePx: style.textSizePx,
        align: 0,
        color,
      })
    }
    if (spec.showValue) {
      text.push({
        str: formatSliderValue(spec, visual.value),
        x: layout.x + layout.width,
        y: layout.labelBaseline,
        sizePx: style.textSizePx,
        align: 1,
        color,
      })
    }
  }
  return { rects, lines, text }
}
