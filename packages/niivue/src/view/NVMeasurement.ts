import { isOnSlice } from '@/annotation/sliceProjection'
import { SLICE_TYPE } from '@/NVConstants'
import type NVModel from '@/NVModel'
import { computeTolerance } from '@/view/NVAnnotation'
import { projectMMToCanvas } from '@/view/sliceUtils'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import type { BuildLineFn, LineData } from './NVLine'
import type { SliceTile } from './NVSliceLayout'

export type MeasurementResult = { lines: LineData[]; labels: GlyphBatch[] }

/** A ruler line segment in canvas pixels: [x0, y0, x1, y1]. */
export type RulerSegment = readonly [number, number, number, number]

// Cap the tick count so an enormous measurement can't emit thousands of lines
// (matches @niivue/uikit's buildRuler).
const MAX_RULER_TICKS = 200

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
  const step = Math.max(1, Math.ceil(marks / MAX_RULER_TICKS))
  for (let i = step; i <= marks; i += step) {
    const t = i / units
    const cx = sx + t * dx
    const cy = sy + t * dy
    const half = i % 5 === 0 ? tickLength * 2 : tickLength
    segs.push([cx - px * half, cy - py * half, cx + px * half, cy + py * half])
  }
  return segs
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

  // Same perpendicular the ticks use; numbers sit just beyond the major tick.
  const px = -dy / len
  const py = dx / len
  const off = tickLength * 2 + tickLength
  const marks = Math.floor(units)
  const step = Math.max(1, Math.ceil(marks / MAX_RULER_TICKS))
  // Minimum along-ruler gap between numbers so they never collide (matches
  // @niivue/uikit's buildRuler); derived from the number size and digit count.
  const maxDigits = `${marks}`.length
  const minLabelGapPx = numberPx * (maxDigits * 0.7 + 0.6)
  let lastAlongPx = Number.NEGATIVE_INFINITY
  const out: RulerTickLabel[] = []
  for (let i = step; i <= marks; i += step) {
    if (i % 5 !== 0) continue
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

/** Format distance with smart decimals. */
function formatDistance(dist: number, showUnits: boolean): string {
  let decimals = 2
  if (dist > 9) decimals = 1
  if (dist > 99) decimals = 0
  let label = dist.toFixed(decimals)
  if (showUnits) label += ' mm'
  return label
}

/**
 * Project every persisted measurement that lies on a current 2D slice tile to
 * canvas pixels and store the result on `model._persistedMeasurementScreenLines`
 * (rebuilt each call). This is font-independent and must run every frame so an
 * external overlay (e.g. a @niivue/uikit ruler) can read the current projection
 * and track pan/zoom/slice changes — independently of whether the built-in
 * measurement is drawn or the built-in font renderer is ready.
 */
export function projectMeasurementScreenLines(
  model: NVModel,
  screenSlices: SliceTile[],
): void {
  model._persistedMeasurementScreenLines = []
  const measurements = model.completedMeasurements
  if (measurements.length === 0) return

  const tolerance = computeTolerance(model)
  for (const tile of screenSlices) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue
    if (
      !tile.mvpMatrix ||
      !tile.planeNormal ||
      !tile.planePoint ||
      !tile.leftTopWidthHeight
    )
      continue

    const mvp = tile.mvpMatrix
    const ltwh = tile.leftTopWidthHeight
    const pn = tile.planeNormal
    const pp = tile.planePoint
    for (const m of measurements) {
      if (
        !isOnSlice(m.startMM, pn, pp, tolerance) ||
        !isOnSlice(m.endMM, pn, pp, tolerance)
      )
        continue
      const [sx, sy] = projectMMToCanvas(m.startMM, mvp, ltwh)
      const [ex, ey] = projectMMToCanvas(m.endMM, mvp, ltwh)
      model._persistedMeasurementScreenLines.push({
        sx,
        sy,
        ex,
        ey,
        distance: m.distance,
      })
    }
  }
}

/**
 * Build lines and labels for all persisted measurements and angles. Draws each
 * measurement from `model._persistedMeasurementScreenLines` as a graduated ruler
 * (unless an external overlay has taken over via `ui.isMeasurementDrawn ===
 * false`) and draws persisted angles per tile. The caller must have refreshed
 * the projection this frame via {@link projectMeasurementScreenLines} (the view
 * does so unconditionally, so measurements track even before the font is ready).
 */
export function buildPersistedMeasurements(
  model: NVModel,
  screenSlices: SliceTile[],
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  // Canvas-pixel height of a graduation number (the view passes its rasterized
  // font size x the 0.5 number scale) so the number-collision gap is sized right
  // at any fontScale / DPI.
  numberPx = 12,
): MeasurementResult | null {
  const measurements = model.completedMeasurements
  const angles = model.completedAngles
  if (measurements.length === 0 && angles.length === 0) return null

  const ui = model.ui
  const lineColor = ui.measureLineColor
  const lineWidth = ui.rulerWidth
  const textColor = ui.measureTextColor
  const textBack =
    textColor[0] + textColor[1] + textColor[2] > 0.8
      ? [0, 0, 0, 0.5]
      : [1, 1, 1, 0.5]
  const tolerance = computeTolerance(model)

  const lines: LineData[] = []
  const labels: GlyphBatch[] = []

  // Persisted measurements: drawn from the pre-projected screen lines. Skipped
  // when an external overlay is drawing the ruler instead of the built-in.
  if (ui.isMeasurementDrawn) {
    for (const {
      sx,
      sy,
      ex,
      ey,
      distance,
    } of model._persistedMeasurementScreenLines) {
      // Plain baseline + end caps + per-mm ticks (majors every fifth).
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

      // Graduation numbers at each major tick, along the ruler edge.
      for (const t of rulerTickLabels(sx, sy, ex, ey, distance, 6, numberPx)) {
        const b = buildText(t.str, t.x, t.y, 0.5, textColor, 0.5, 0.5)
        if (b.count > 0) labels.push(b)
      }

      // Distance text
      const label = formatDistance(distance, ui.isMeasureUnitsVisible)
      const mx = (sx + ex) * 0.5
      const my = (sy + ey) * 0.5
      const batch = buildText(label, mx, my, 0.8, textColor, 0.5, 1, textBack)
      if (batch.count > 0) labels.push(batch)
    }
  }

  // Persisted angles: projected per tile (not exposed to external overlays).
  for (const tile of screenSlices) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue
    if (
      !tile.mvpMatrix ||
      !tile.planeNormal ||
      !tile.planePoint ||
      !tile.leftTopWidthHeight
    )
      continue

    const mvp = tile.mvpMatrix
    const ltwh = tile.leftTopWidthHeight
    const pn = tile.planeNormal
    const pp = tile.planePoint

    for (const a of angles) {
      // Test intersection point (end of first line / start of second)
      if (!isOnSlice(a.firstLine.endMM, pn, pp, tolerance)) continue

      const [x0, y0] = projectMMToCanvas(a.firstLine.startMM, mvp, ltwh)
      const [x1, y1] = projectMMToCanvas(a.firstLine.endMM, mvp, ltwh)
      const [x2, y2] = projectMMToCanvas(a.secondLine.endMM, mvp, ltwh)

      // Two line segments
      lines.push(
        buildLine(x0, y0, x1, y1, lineWidth, lineColor),
        buildLine(x1, y1, x2, y2, lineWidth, lineColor),
      )

      // Angle text at intersection
      const angleStr = `${a.angle.toFixed(1)}\u00B0`
      const batch = buildText(
        angleStr,
        x1,
        y1,
        0.8,
        textColor,
        0.5,
        1,
        textBack,
      )
      if (batch.count > 0) labels.push(batch)
    }
  }

  if (lines.length === 0 && labels.length === 0) return null
  return { lines, labels }
}
