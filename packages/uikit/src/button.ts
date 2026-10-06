// Pure button model for UIKit: style resolution, layout (size the box to its
// label, or honour a fixed size), geometry (one rounded rect plus one text item,
// shrunk and recolored by how far pressed it is) and the press-animation step.
// No GPU and no DOM here, so all of it is unit-testable; UIKitButtonOverlay wires
// it to pointer events and the overlay draw hook.

import { buildRect, type RectData } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a button. All lengths are in canvas pixels. */
export interface ButtonStyle {
  /** Face color at rest. */
  fill: RGBA
  /** Face color while the pointer hovers (not pressed). */
  hoverFill: RGBA
  /** Face color at full press; blended in by the press amount. */
  pressedFill: RGBA
  /** Face color when the button is disabled. */
  disabledFill: RGBA
  /** Border ring color. */
  border: RGBA
  /** Border ring width; 0 draws no border. */
  borderWidth: number
  /** Corner radius. */
  radius: number
  textColor: RGBA
  disabledTextColor: RGBA
  /** Label em size. */
  textSizePx: number
  /** Space between the label and the left/right edges when auto-sized. */
  paddingX: number
  /** Space between the cap-height box and the top/bottom edges when auto-sized. */
  paddingY: number
  /** Scale of the whole button at full press (1 disables the shrink). */
  pressScale: number
  /** Time for the press amount to go from 0 to 1 on pointer down. */
  pressMs: number
  /** Time for the press amount to go from 1 back to 0 on release. */
  releaseMs: number
}

export const DEFAULT_BUTTON_STYLE: ButtonStyle = {
  fill: [0.17, 0.19, 0.24, 0.94],
  hoverFill: [0.24, 0.27, 0.34, 0.96],
  pressedFill: [0.09, 0.1, 0.13, 1],
  disabledFill: [0.17, 0.19, 0.24, 0.5],
  border: [0.6, 0.66, 0.78, 1],
  borderWidth: 1,
  radius: 6,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 16,
  paddingX: 14,
  paddingY: 8,
  pressScale: 0.94,
  pressMs: 90,
  releaseMs: 160,
}

export interface ButtonSpec {
  /** Stable key: the handle for updates, pointer tracking and the click callback. */
  id: string
  label: string
  /** Top-left corner of the resting box, in canvas pixels. */
  x: number
  y: number
  /** Fixed box size. Omit either to size that axis to the label plus padding. */
  width?: number
  height?: number
  /** Per-button overrides of the overlay's default style. */
  style?: Partial<ButtonStyle>
  /** A disabled button draws dimmed and ignores the pointer. Default true. */
  enabled?: boolean
  /** Fired on a completed click (pointer up inside the button it went down on). */
  onClick?: (id: string) => void
}

/** The button's resting box (before any press shrink), in canvas pixels. */
export interface ButtonLayout {
  x: number
  y: number
  width: number
  height: number
}

/** The transient state that changes how a button looks. */
export interface ButtonVisual {
  hover: boolean
  /** Press amount, 0 (at rest) to 1 (fully pressed). */
  press: number
  enabled: boolean
}

export function resolveButtonStyle(
  base: ButtonStyle,
  override?: Partial<ButtonStyle>,
): ButtonStyle {
  return override ? { ...base, ...override } : base
}

/** Linear blend of two colors, t in [0, 1]. */
export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  const k = Math.min(1, Math.max(0, t))
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    a[3] + (b[3] - a[3]) * k,
  ]
}

/** Resting box for a spec: fixed where given, otherwise fitted to the label. */
export function layoutButton(
  spec: ButtonSpec,
  style: ButtonStyle,
  metrics: UIKitFontMetrics,
): ButtonLayout {
  const size = style.textSizePx
  const labelW = measureWidth(metrics, spec.label, size)
  const labelH = capHeight(metrics) * size
  return {
    x: spec.x,
    y: spec.y,
    width: spec.width ?? Math.ceil(labelW + 2 * style.paddingX),
    height: spec.height ?? Math.ceil(labelH + 2 * style.paddingY),
  }
}

/**
 * Scale every length in a spec and style by `k` (used to lay out CSS-pixel
 * specs on a high-DPR canvas). Returns new objects; the inputs are untouched.
 */
export function scaleButton(
  spec: ButtonSpec,
  style: ButtonStyle,
  k: number,
): { spec: ButtonSpec; style: ButtonStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: {
      ...spec,
      x: spec.x * k,
      y: spec.y * k,
      width: spec.width === undefined ? undefined : spec.width * k,
      height: spec.height === undefined ? undefined : spec.height * k,
    },
    style: {
      ...style,
      borderWidth: style.borderWidth * k,
      radius: style.radius * k,
      textSizePx: style.textSizePx * k,
      paddingX: style.paddingX * k,
      paddingY: style.paddingY * k,
    },
  }
}

/**
 * The draw data for one button in one visual state: the face rect and the
 * centred label. A press shrinks both about the box centre by
 * `1 - (1 - pressScale) * press` and blends the face toward `pressedFill`.
 */
export function buildButton(
  spec: ButtonSpec,
  style: ButtonStyle,
  metrics: UIKitFontMetrics,
  layout: ButtonLayout,
  visual: ButtonVisual,
): { rect: RectData; text: UIKitTextItem } {
  const press = Math.min(1, Math.max(0, visual.press))
  const scale = 1 - (1 - style.pressScale) * press
  const cx = layout.x + layout.width / 2
  const cy = layout.y + layout.height / 2
  const w = layout.width * scale
  const h = layout.height * scale

  let fill: RGBA
  let textColor: RGBA
  if (!visual.enabled) {
    fill = style.disabledFill
    textColor = style.disabledTextColor
  } else {
    const rest = visual.hover ? style.hoverFill : style.fill
    fill = mixColor(rest, style.pressedFill, press)
    textColor = style.textColor
  }
  const rect = buildRect({
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    radius: style.radius * scale,
    borderWidth: style.borderWidth,
    fill,
    border: visual.enabled ? style.border : mixColor(style.border, fill, 0.5),
  })
  const sizePx = style.textSizePx * scale
  // Centre the cap-height box on the button: the baseline sits half a cap
  // height below the centre line.
  const text: UIKitTextItem = {
    str: spec.label,
    x: cx,
    y: cy + (capHeight(metrics) * sizePx) / 2,
    sizePx,
    align: 0.5,
    color: textColor,
  }
  return { rect, text }
}

/**
 * Move a press amount toward its target at a constant rate so the full travel
 * takes `durationMs`. A non-positive duration snaps to the target.
 */
export function advancePress(
  current: number,
  target: number,
  dtMs: number,
  durationMs: number,
): number {
  if (current === target) return target
  if (durationMs <= 0 || dtMs <= 0) return durationMs <= 0 ? target : current
  const step = dtMs / durationMs
  if (target > current) return Math.min(target, current + step)
  return Math.max(target, current - step)
}

/** True when canvas point (px, py) lies inside the resting box. */
export function buttonContains(
  layout: ButtonLayout,
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
