import type NVModel from '@/NVModel'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import type { BuildLineFn, LineData } from './NVLine'

export type MeasurementResult = { lines: LineData[]; labels: GlyphBatch[] }

/** A ruler line segment in canvas pixels: [x0, y0, x1, y1]. */
export type RulerSegment = readonly [number, number, number, number]

// Cap the tick count so an enormous measurement can't emit thousands of lines
// (matches @niivue/uikit's buildRuler).
const MAX_RULER_TICKS = 200

/**
 * Thin the ticks to at most MAX_RULER_TICKS in 1/2/5 steps, as @niivue/uikit's
 * `decimation`: an arbitrary step (7, say) would number ticks 35, 70, ...
 */
function tickStep(marks: number): number {
  if (marks <= MAX_RULER_TICKS) return 1
  const raw = marks / MAX_RULER_TICKS
  const decade = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5]) {
    if (m * decade >= raw) return m * decade
  }
  return 10 * decade
}

/**
 * Screen-pixel line segments for a graduated ruler between two canvas points: a
 * plain baseline, long perpendicular end caps marking the exact start and end,
 * plus perpendicular tick marks — one per unit of `units`, longer every fifth —
 * matching @niivue/uikit's buildRuler (which draws the whole-slide ruler in the
 * OHIF viewport) so the volume and slide measurements look identical. `units` is
 * the physical length used for tick spacing (e.g. millimetres); <= 0 yields just
 * the baseline and end caps. A zero-length ruler yields nothing. Pure geometry;
 * the caller colours and renders the segments. `thickness` is accepted for API
 * symmetry with the drawn line width but does not affect the geometry.
 */
export function rulerSegments(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  units: number,
  _thickness = 2,
  tickLength = 6,
): RulerSegment[] {
  const dx = ex - sx
  const dy = ey - sy
  const len = Math.hypot(dx, dy)
  if (len === 0) return []

  // Unit perpendicular in screen space; end caps and ticks straddle the baseline.
  const px = -dy / len
  const py = dx / len

  const segs: RulerSegment[] = []
  // Plain baseline (no arrowheads — the end caps mark the extent).
  segs.push([sx, sy, ex, ey])
  // Long perpendicular end caps crossing the exact start and end points.
  const capLen = tickLength * 3
  const ends: Array<readonly [number, number]> = [
    [sx, sy],
    [ex, ey],
  ]
  for (const [cx, cy] of ends) {
    segs.push([
      cx - px * capLen,
      cy - py * capLen,
      cx + px * capLen,
      cy + py * capLen,
    ])
  }

  if (units <= 0) return segs

  const marks = Math.floor(units)
  const step = tickStep(marks)
  for (let i = step; i <= marks; i += step) {
    const t = i / units
    const cx = sx + t * dx
    const cy = sy + t * dy
    const half = (i / step) % 5 === 0 ? tickLength * 2 : tickLength
    segs.push([cx - px * half, cy - py * half, cx + px * half, cy + py * half])
  }
  return segs
}

/**
 * Unit perpendicular pointing down the screen (right for a vertical ruler),
 * whichever way the ruler was drawn, so numbers and length never share a side.
 */
function downPerp(dx: number, dy: number, len: number): [number, number] {
  const s = dx > 0 || (dx === 0 && dy < 0) ? 1 : -1
  return [(-dy / len) * s, (dx / len) * s]
}

/** Where the length label goes: past the major ticks, opposite the numbers. */
export function rulerLengthLabel(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  tickLength = 6,
): { x: number; y: number; anchorX: number; anchorY: number } {
  const len = Math.hypot(ex - sx, ey - sy)
  const [px, py] = len > 0 ? downPerp(ex - sx, ey - sy, len) : [0, 1]
  const gap = tickLength * 2 + 3
  return {
    x: (sx + ex) * 0.5 - px * gap,
    y: (sy + ey) * 0.5 - py * gap,
    // The text extends away from the ruler: above it, or beside a vertical one.
    anchorX: 0.5 + 0.5 * px,
    anchorY: 0.5 + 0.5 * py,
  }
}

/** A ruler graduation number and where to draw it (canvas pixels). */
export type RulerTickLabel = { str: string; x: number; y: number }

/**
 * Graduation numbers for a ruler between two canvas points: the value at each
 * major tick (every fifth unit), positioned just past the tick along the
 * ruler's edge (offset on the same side for every number so they line up like a
 * real ruler's scale). Mirrors @niivue/uikit's buildRuler tick numbers,
 * including its collision guard: a number is emitted only when it clears a
 * minimum along-ruler pixel gap from the previous one, so a long ruler labels
 * every few majors instead of an unreadable smear. `numberPx` is the drawn
 * height of a graduation number in canvas pixels (used to size that gap). Pure:
 * the caller renders each label. Empty for a zero-length or unit-less ruler.
 */
export function rulerTickLabels(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  units: number,
  tickLength = 6,
  numberPx = 12,
): RulerTickLabel[] {
  const dx = ex - sx
  const dy = ey - sy
  const len = Math.hypot(dx, dy)
  if (len === 0 || units <= 0) return []

  // Numbers sit just beyond the major tick, on the screen-down side.
  const [px, py] = downPerp(dx, dy, len)
  const off = tickLength * 2 + tickLength
  const marks = Math.floor(units)
  const step = tickStep(marks)
  // Minimum along-ruler gap between numbers so they never collide (matches
  // @niivue/uikit's buildRuler); derived from the number size and digit count.
  const maxDigits = `${marks}`.length
  const minLabelGapPx = numberPx * (maxDigits * 0.7 + 0.6)
  let lastAlongPx = Number.NEGATIVE_INFINITY
  const out: RulerTickLabel[] = []
  for (let i = step; i <= marks; i += step) {
    if ((i / step) % 5 !== 0) continue // majors: every fifth drawn tick
    const t = i / units
    const alongPx = t * len
    if (alongPx - lastAlongPx < minLabelGapPx) continue
    lastAlongPx = alongPx
    const cx = sx + t * dx
    const cy = sy + t * dy
    out.push({ str: `${i}`, x: cx + px * off, y: cy + py * off })
  }
  return out
}

/** Format distance with smart decimals, suffixed with `unit` when shown. */
export function formatDistance(
  dist: number,
  showUnits: boolean,
  unit = 'mm',
): string {
  let decimals = 2
  if (dist > 9) decimals = 1
  if (dist > 99) decimals = 0
  let label = dist.toFixed(decimals)
  if (showUnits) label += ` ${unit}`
  return label
}

/** Translucent backing that keeps measurement text readable on any image. */
export function measureTextBack(textColor: number[]): number[] {
  return textColor[0] + textColor[1] + textColor[2] > 0.8
    ? [0, 0, 0, 0.5]
    : [1, 1, 1, 0.5]
}

/** A ruler between two canvas points, `distance` units long (0: no ticks). */
export type ScreenRuler = {
  sx: number
  sy: number
  ex: number
  ey: number
  distance: number
  /** Replaces the formatted distance. */
  label?: string
}

/**
 * Graduated rulers as NiiVue draws them: baseline, end caps, per-unit ticks
 * (majors every fifth), graduation numbers and the length at the midpoint.
 */
export function buildRulers(
  rulers: readonly ScreenRuler[],
  style: Pick<
    NVModel['ui'],
    | 'measureLineColor'
    | 'measureTextColor'
    | 'rulerWidth'
    | 'isMeasureUnitsVisible'
  >,
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  numberPx = 12,
  unit = 'mm',
): MeasurementResult {
  const lineColor = style.measureLineColor
  const lineWidth = style.rulerWidth
  const textColor = style.measureTextColor
  const textBack = measureTextBack(textColor)
  const lines: LineData[] = []
  const labels: GlyphBatch[] = []
  for (const { sx, sy, ex, ey, distance, label: text } of rulers) {
    for (const [x0, y0, x1, y1] of rulerSegments(
      sx,
      sy,
      ex,
      ey,
      distance,
      lineWidth,
    )) {
      lines.push(buildLine(x0, y0, x1, y1, lineWidth, lineColor))
    }
    for (const t of rulerTickLabels(sx, sy, ex, ey, distance, 6, numberPx)) {
      const b = buildText(t.str, t.x, t.y, 0.5, textColor, 0.5, 0.5)
      if (b.count > 0) labels.push(b)
    }
    const label =
      text ?? formatDistance(distance, style.isMeasureUnitsVisible, unit)
    const at = rulerLengthLabel(sx, sy, ex, ey)
    const batch = buildText(
      label,
      at.x,
      at.y,
      0.8,
      textColor,
      at.anchorX,
      at.anchorY,
      textBack,
    )
    if (batch.count > 0) labels.push(batch)
  }
  return { lines, labels }
}
