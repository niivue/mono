// Pure toggle (checkbox) model for UIKit: style resolution, layout (a box with
// the label beside it), and geometry (box rect, check-mark lines, focus ring and
// label) for one visual state. No GPU and no DOM here; UIKitToggleOverlay wires
// it to the pointer, the keyboard and the overlay draw hook.

import { mixColor } from './button'
import { buildLine, type LineData } from './line'
import { buildRect, type RectData } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a toggle. All lengths are in canvas pixels. */
export interface ToggleStyle {
  /** Side of the square check box. */
  boxSize: number
  /** Corner radius of the box. */
  radius: number
  /** Space between the box and the label. */
  gap: number
  /** Box color when unchecked. */
  fill: RGBA
  /** Box color when checked. */
  checkedFill: RGBA
  /** Box color when unchecked and hovered. */
  hoverFill: RGBA
  /** Box color when checked and hovered. */
  checkedHoverFill: RGBA
  /** Box color when disabled (checked or not; the mark still shows). */
  disabledFill: RGBA
  /** Box border color. */
  border: RGBA
  borderWidth: number
  /** Check-mark color and stroke width. */
  checkColor: RGBA
  checkWidth: number
  textColor: RGBA
  disabledTextColor: RGBA
  /** Label em size. */
  textSizePx: number
  /**
   * Halo outline width around the label, so it reads over any scene; 0 draws
   * none. 1 to 2 reads best with the bundled font.
   */
  textOutlineWidth: number
  /** Halo color; null picks black or white for contrast with `textColor`. */
  textOutlineColor: RGBA | null
  /** Scale of the box while the pointer holds it down. */
  pressScale: number
  /** Focus ring color (drawn around the box while the toggle has keyboard focus). */
  focusRing: RGBA
  focusRingWidth: number
}

export const DEFAULT_TOGGLE_STYLE: ToggleStyle = {
  boxSize: 18,
  radius: 4,
  gap: 8,
  fill: [0.17, 0.19, 0.24, 0.94],
  checkedFill: [0.25, 0.47, 0.85, 1],
  hoverFill: [0.24, 0.27, 0.34, 0.96],
  checkedHoverFill: [0.33, 0.55, 0.92, 1],
  disabledFill: [0.17, 0.19, 0.24, 0.5],
  border: [0.6, 0.66, 0.78, 1],
  borderWidth: 1,
  checkColor: [1, 1, 1, 1],
  checkWidth: 2.5,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 16,
  textOutlineWidth: 1,
  textOutlineColor: null,
  pressScale: 0.88,
  focusRing: [0.55, 0.7, 1, 0.9],
  focusRingWidth: 2,
}

export interface ToggleSpec {
  /** Stable key: the handle for updates, pointer tracking and the callback. */
  id: string
  label: string
  /** Top-left corner of the whole control (box plus label), in canvas pixels. */
  x: number
  y: number
  /** Initial state. Default false. */
  checked?: boolean
  /** Per-toggle overrides of the overlay's default style. */
  style?: Partial<ToggleStyle>
  /** A disabled toggle draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Fired when the user changes the state (pointer or keyboard), not by `setChecked`. */
  onChange?: (checked: boolean, id: string) => void
}

/** The control's box in canvas pixels, plus the check box inside it. */
export interface ToggleLayout {
  x: number
  y: number
  width: number
  height: number
  box: { x: number; y: number; size: number }
}

/** The transient state that changes how a toggle looks. */
export interface ToggleVisual {
  checked: boolean
  hover: boolean
  pressed: boolean
  focused: boolean
  enabled: boolean
}

export function resolveToggleStyle(
  base: ToggleStyle,
  override?: Partial<ToggleStyle>,
): ToggleStyle {
  return override ? { ...base, ...override } : base
}

/** The control box for a spec: the check box plus the label beside it. */
export function layoutToggle(
  spec: ToggleSpec,
  style: ToggleStyle,
  metrics: UIKitFontMetrics,
): ToggleLayout {
  const size = style.textSizePx
  const labelW = measureWidth(metrics, spec.label, size)
  const labelH = capHeight(metrics) * size
  const height = Math.ceil(Math.max(style.boxSize, labelH))
  const width = Math.ceil(style.boxSize + (spec.label ? style.gap + labelW : 0))
  return {
    x: spec.x,
    y: spec.y,
    width,
    height,
    box: {
      x: spec.x,
      y: spec.y + (height - style.boxSize) / 2,
      size: style.boxSize,
    },
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleToggle(
  spec: ToggleSpec,
  style: ToggleStyle,
  k: number,
): { spec: ToggleSpec; style: ToggleStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: { ...spec, x: spec.x * k, y: spec.y * k },
    style: {
      ...style,
      boxSize: style.boxSize * k,
      radius: style.radius * k,
      gap: style.gap * k,
      borderWidth: style.borderWidth * k,
      checkWidth: style.checkWidth * k,
      textSizePx: style.textSizePx * k,
      textOutlineWidth: style.textOutlineWidth * k,
      focusRingWidth: style.focusRingWidth * k,
    },
  }
}

// The check mark as a polyline in box-fraction coordinates (y-down).
const CHECK_PATH: ReadonlyArray<readonly [number, number]> = [
  [0.22, 0.52],
  [0.42, 0.72],
  [0.78, 0.3],
]

/**
 * Check-mark strokes inside a square box, as line segments. Exported so a
 * checkable menu item can draw the same mark.
 */
export function buildCheckMark(
  x: number,
  y: number,
  size: number,
  width: number,
  color: RGBA,
): LineData[] {
  const lines: LineData[] = []
  for (let i = 1; i < CHECK_PATH.length; i++) {
    const [ax, ay] = CHECK_PATH[i - 1]
    const [bx, by] = CHECK_PATH[i]
    lines.push(
      buildLine(
        x + ax * size,
        y + ay * size,
        x + bx * size,
        y + by * size,
        width,
        color,
      ),
    )
  }
  return lines
}

/** A transparent rect whose border is the focus ring, drawn `inset` outside a box. */
export function buildFocusRing(
  box: { x: number; y: number; width: number; height: number },
  radius: number,
  color: RGBA,
  width: number,
  inset = 3,
): RectData {
  return buildRect({
    x: box.x - inset,
    y: box.y - inset,
    width: box.width + 2 * inset,
    height: box.height + 2 * inset,
    radius: radius + inset,
    borderWidth: width,
    fill: [0, 0, 0, 0],
    border: color,
  })
}

/**
 * The draw data for one toggle in one visual state: the box (shrunk about its
 * centre while pressed), the check mark when checked, a focus ring when
 * focused, and the label vertically centred on the box.
 */
export function buildToggle(
  spec: ToggleSpec,
  style: ToggleStyle,
  metrics: UIKitFontMetrics,
  layout: ToggleLayout,
  visual: ToggleVisual,
): { rects: RectData[]; lines: LineData[]; text: UIKitTextItem } {
  const scale = visual.pressed && visual.enabled ? style.pressScale : 1
  const size = layout.box.size * scale
  const cx = layout.box.x + layout.box.size / 2
  const cy = layout.box.y + layout.box.size / 2
  const bx = cx - size / 2
  const by = cy - size / 2

  let fill: RGBA
  let textColor: RGBA
  let border: RGBA
  if (!visual.enabled) {
    fill = visual.checked
      ? mixColor(style.checkedFill, style.disabledFill, 0.6)
      : style.disabledFill
    textColor = style.disabledTextColor
    border = mixColor(style.border, fill, 0.5)
  } else if (visual.checked) {
    fill = visual.hover ? style.checkedHoverFill : style.checkedFill
    textColor = style.textColor
    border = style.border
  } else {
    fill = visual.hover ? style.hoverFill : style.fill
    textColor = style.textColor
    border = style.border
  }

  const rects: RectData[] = []
  if (visual.focused && visual.enabled) {
    rects.push(
      buildFocusRing(
        {
          x: layout.box.x,
          y: layout.box.y,
          width: layout.box.size,
          height: layout.box.size,
        },
        style.radius,
        style.focusRing,
        style.focusRingWidth,
      ),
    )
  }
  rects.push(
    buildRect({
      x: bx,
      y: by,
      width: size,
      height: size,
      radius: style.radius * scale,
      borderWidth: style.borderWidth,
      fill,
      border,
    }),
  )
  const lines = visual.checked
    ? buildCheckMark(
        bx,
        by,
        size,
        style.checkWidth * scale,
        visual.enabled
          ? style.checkColor
          : mixColor(style.checkColor, fill, 0.4),
      )
    : []
  const text: UIKitTextItem = {
    str: spec.label,
    x: layout.box.x + layout.box.size + style.gap,
    y: cy + (capHeight(metrics) * style.textSizePx) / 2,
    sizePx: style.textSizePx,
    align: 0,
    color: textColor,
    ...(style.textOutlineWidth > 0
      ? {
          outlineWidthPx: style.textOutlineWidth,
          outlineColor: style.textOutlineColor ?? undefined,
        }
      : {}),
  }
  return { rects, lines, text }
}

/** True when canvas point (px, py) lies inside the control box (box plus label). */
export function toggleContains(
  layout: ToggleLayout,
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
