// The UIKit ruler widget: a measurement line between two screen points with long
// perpendicular end caps, graduated tick marks, and a rotated length+units label
// that stays upright (readability guard). `buildRuler` is pure — it turns a ruler
// spec into plain line + text draw data — so the geometry is unit-testable and the
// overlay (rulerOverlay.ts) just draws it. Ported from the old niivue/niivue uikit
// `drawRuler`.

import { buildLine, type LineData } from './line'
import { readableAngle } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

export type Vec2 = readonly [number, number]
export type RGBA = readonly [number, number, number, number]

export interface RulerSpec {
  /** Endpoints in screen pixels. */
  a: Vec2
  b: Vec2
  /** Measured length to display (in `units`). */
  length: number
  /** Unit suffix, e.g. 'mm'. */
  units?: string
  /** Label text height in pixels. Default 36. */
  sizePx?: number
  /** Decimals in the length label. Default 1. */
  decimals?: number
  lineColor?: RGBA
  textColor?: RGBA
  /** Line thickness in pixels. Default 2. */
  thickness?: number
  /** Half-length of a minor tick in pixels. Default 6. */
  tickLength?: number
  /** Draw tick marks every unit (majors every 5). Default true. */
  showTicks?: boolean
  /** Draw the number at every major tick. Default false. */
  showTickNumbers?: boolean
  /**
   * Draw long perpendicular end caps crossing the start and end points to mark
   * the measurement's exact extent (longer than a major tick). Default true.
   */
  showEndCaps?: boolean
  /**
   * Outline width (px) for the label + tick text, for readability over busy
   * backgrounds. Default 2. The outline color auto-contrasts the text color
   * (black on light text, white on dark). Set 0 to disable.
   */
  textOutlineWidthPx?: number
}

export interface RulerGeometry {
  lines: LineData[]
  text: UIKitTextItem[]
}

// Cap the tick count so an enormous measurement can't emit thousands of lines.
const MAX_TICKS = 200

const YELLOW: RGBA = [1, 1, 0, 1]

/**
 * Build the line + text draw data for a ruler. Pure geometry; font-independent
 * (glyph widths are resolved when the text is laid out at draw time).
 */
export function buildRuler(spec: RulerSpec): RulerGeometry {
  const {
    a,
    b,
    length,
    units = '',
    sizePx = 36,
    decimals = 1,
    lineColor = YELLOW,
    textColor = YELLOW,
    thickness = 2,
    tickLength = 6,
    showTicks = true,
    showTickNumbers = false,
    showEndCaps = true,
    textOutlineWidthPx = 2,
  } = spec

  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []
  if (len === 0) return { lines, text }

  const ux = dx / len
  const uy = dy / len
  // Unit perpendicular (screen space). Ticks straddle the line along this.
  const px = -uy
  const py = ux
  const rawAngle = Math.atan2(dy, dx)
  const { angle, flipped } = readableAngle(rawAngle)
  // The layout lifts along (sin a, -cos a); flipping the angle flips that side, so
  // negate the lift to keep the label on the same side of the line.
  const liftSign = flipped ? -1 : 1

  // Measurement baseline. The perpendicular end caps (below) mark the extent, so
  // the baseline is a plain line with no arrowheads.
  lines.push(buildLine(a[0], a[1], b[0], b[1], thickness, lineColor))

  // Long perpendicular end caps crossing the exact start and end points, so the
  // measurement's extent is unambiguous (longer than a major tick).
  if (showEndCaps) {
    const capLen = tickLength * 3
    for (const p of [a, b]) {
      lines.push(
        buildLine(
          p[0] - px * capLen,
          p[1] - py * capLen,
          p[0] + px * capLen,
          p[1] + py * capLen,
          thickness,
          lineColor,
        ),
      )
    }
  }

  // Tick marks every unit, longer (and optionally numbered) every fifth.
  if (showTicks && length > 0) {
    const marks = Math.floor(length)
    const step = Math.max(1, Math.ceil(marks / MAX_TICKS))
    // Minimum along-ruler gap between graduation numbers so they never collide;
    // a long ruler thus labels only every few majors (e.g. 20/40/60) instead of
    // running every fifth value into an unreadable smear.
    const numberScale = 0.5
    const maxDigits = `${marks}`.length
    const minLabelGapPx = sizePx * numberScale * (maxDigits * 0.7 + 0.6)
    let lastLabelAlongPx = Number.NEGATIVE_INFINITY
    for (let i = step; i <= marks; i += step) {
      const t = i / length
      const cx = a[0] + t * dx
      const cy = a[1] + t * dy
      const major = i % 5 === 0
      const half = major ? tickLength * 2 : tickLength
      lines.push(
        buildLine(
          cx - px * half,
          cy - py * half,
          cx + px * half,
          cy + py * half,
          1,
          lineColor,
        ),
      )
      if (major && showTickNumbers) {
        const alongPx = t * len
        if (alongPx - lastLabelAlongPx >= minLabelGapPx) {
          lastLabelAlongPx = alongPx
          text.push({
            str: `${i}`,
            x: cx,
            y: cy,
            sizePx: sizePx * numberScale,
            rotation: angle,
            align: 0.5,
            liftPx: liftSign * (half + sizePx * 0.4),
            color: textColor,
            outlineWidthPx: textOutlineWidthPx,
          })
        }
      }
    }
  }

  // Length + units label, centered on the midpoint and lifted off the line.
  const label = units
    ? `${length.toFixed(decimals)} ${units}`
    : length.toFixed(decimals)
  text.push({
    str: label,
    x: (a[0] + b[0]) / 2,
    y: (a[1] + b[1]) / 2,
    sizePx,
    rotation: angle,
    align: 0.5,
    liftPx: liftSign * (tickLength * 2 + sizePx),
    color: textColor,
    outlineWidthPx: textOutlineWidthPx,
  })

  return { lines, text }
}
