// The UIKit ruler widget: a measurement line between two screen points with long
// perpendicular end caps, graduated tick marks, and a rotated length+units label
// that stays upright (readability guard). `buildRuler` is pure — it turns a ruler
// spec into plain line + text draw data — so the geometry is unit-testable and the
// overlay (rulerOverlay.ts) just draws it. Ported from the old niivue/niivue uikit
// `drawRuler`. NiiVue core draws its rulers from the same `rulerSegments` and
// `rulerTickNumbers`, with its own label placement.

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

const YELLOW: RGBA = [1, 1, 0, 1]

/** A ruler line segment in canvas pixels: [x0, y0, x1, y1]. */
export type RulerSegment = readonly [number, number, number, number]

// Cap the tick count so an enormous measurement can't emit thousands of lines.
const MAX_RULER_TICKS = 200

/**
 * Units per tick, in 1/2/5 steps (an arbitrary step, 7 say, would number ticks
 * 35, 70, ...): at most MAX_RULER_TICKS ticks, and ticks at least two tick
 * lengths apart on screen, so a short or zoomed-out ruler is not a solid comb.
 */
function tickStep(
  marks: number,
  pxPerUnit: number,
  tickLength: number,
): number {
  const raw = Math.max(marks / MAX_RULER_TICKS, (2 * tickLength) / pxPerUnit)
  if (raw <= 1) return 1
  const decade = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5]) {
    if (m * decade >= raw) return m * decade
  }
  return 10 * decade
}

/**
 * A graduated ruler's lines between two canvas points: the baseline, then long
 * perpendicular end caps at both ends, then ticks every `tickStep` units
 * (majors, twice as long, every fifth drawn tick). `length` is the physical
 * length the ticks divide; <= 0 gives the baseline and caps only, a
 * zero-length ruler nothing.
 */
export function rulerSegments(
  a: Vec2,
  b: Vec2,
  length: number,
  tickLength = 6,
): RulerSegment[] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return []
  // Unit perpendicular in screen space; end caps and ticks straddle the line.
  const px = -dy / len
  const py = dx / len
  const capLen = tickLength * 3
  const segs: RulerSegment[] = [[a[0], a[1], b[0], b[1]]]
  for (const [cx, cy] of [a, b])
    segs.push([
      cx - px * capLen,
      cy - py * capLen,
      cx + px * capLen,
      cy + py * capLen,
    ])
  if (length <= 0) return segs
  const marks = Math.floor(length)
  const step = tickStep(marks, len / length, tickLength)
  for (let i = step; i <= marks; i += step) {
    const t = i / length
    const cx = a[0] + t * dx
    const cy = a[1] + t * dy
    const half = (i / step) % 5 === 0 ? tickLength * 2 : tickLength
    segs.push([cx - px * half, cy - py * half, cx + px * half, cy + py * half])
  }
  return segs
}

/**
 * The major ticks of `rulerSegments` that get a number: each `value` and its
 * fraction `t` of the way along. A number is kept only when it clears the
 * previous one by a gap sized from `numberPx` (its drawn height) and the digit
 * count, so a long ruler numbers every few majors instead of a smear.
 */
export function rulerTickNumbers(
  lenPx: number,
  length: number,
  tickLength: number,
  numberPx: number,
): { value: number; t: number }[] {
  if (lenPx === 0 || length <= 0) return []
  const marks = Math.floor(length)
  const step = tickStep(marks, lenPx / length, tickLength)
  const minGapPx = numberPx * (`${marks}`.length * 0.7 + 0.6)
  let lastPx = Number.NEGATIVE_INFINITY
  const out: { value: number; t: number }[] = []
  for (let i = 5 * step; i <= marks; i += 5 * step) {
    const t = i / length
    if (t * lenPx - lastPx < minGapPx) continue
    lastPx = t * lenPx
    out.push({ value: i, t })
  }
  return out
}

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

  const rawAngle = Math.atan2(dy, dx)
  const { angle, flipped } = readableAngle(rawAngle)
  // The layout lifts along (sin a, -cos a); flipping the angle flips that side, so
  // negate the lift to keep the label on the same side of the line.
  const liftSign = flipped ? -1 : 1

  // Baseline and end caps at `thickness`, ticks at 1 px.
  const segs = rulerSegments(a, b, showTicks ? length : 0, tickLength)
  segs.forEach(([x0, y0, x1, y1], k) => {
    if (!showEndCaps && (k === 1 || k === 2)) return
    lines.push(buildLine(x0, y0, x1, y1, k < 3 ? thickness : 1, lineColor))
  })

  // Graduation numbers just past each numbered major tick.
  const numberScale = 0.5
  if (showTicks && showTickNumbers) {
    for (const { value, t } of rulerTickNumbers(
      len,
      length,
      tickLength,
      sizePx * numberScale,
    )) {
      text.push({
        str: `${value}`,
        x: a[0] + t * dx,
        y: a[1] + t * dy,
        sizePx: sizePx * numberScale,
        rotation: angle,
        align: 0.5,
        liftPx: liftSign * (tickLength * 2 + sizePx * 0.4),
        color: textColor,
        outlineWidthPx: textOutlineWidthPx,
      })
    }
  }

  // Length + units label, centered on the midpoint and lifted off the line. When
  // graduation numbers are drawn on the same side, lift the label clear of them
  // (they sit at ~tickLength*2 + sizePx*0.9) so a midpoint number is never
  // covered; otherwise keep it tight to the line.
  const label = units
    ? `${length.toFixed(decimals)} ${units}`
    : length.toFixed(decimals)
  const labelLift = showTickNumbers
    ? tickLength * 2 + sizePx * 1.5
    : tickLength * 2 + sizePx
  text.push({
    str: label,
    x: (a[0] + b[0]) / 2,
    y: (a[1] + b[1]) / 2,
    sizePx,
    rotation: angle,
    align: 0.5,
    liftPx: liftSign * labelLift,
    color: textColor,
    outlineWidthPx: textOutlineWidthPx,
  })

  return { lines, text }
}
