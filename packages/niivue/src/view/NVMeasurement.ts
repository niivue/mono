import { isOnSlice } from '@/annotation/sliceProjection'
import { SLICE_TYPE } from '@/NVConstants'
import type NVModel from '@/NVModel'
import { computeTolerance } from '@/view/NVAnnotation'
import { projectMMToCanvas } from '@/view/sliceUtils'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import {
  type BuildLineFn,
  buildTerminatedLine,
  type LineData,
  LineTerminator,
} from './NVLine'
import type { SliceTile } from './NVSliceLayout'

export type MeasurementResult = { lines: LineData[]; labels: GlyphBatch[] }

/** A ruler line segment in canvas pixels: [x0, y0, x1, y1]. */
export type RulerSegment = readonly [number, number, number, number]

// Cap the tick count so an enormous measurement can't emit thousands of lines
// (matches @niivue/uikit's buildRuler).
const MAX_RULER_TICKS = 200

/**
 * Screen-pixel line segments for a graduated ruler between two canvas points: an
 * arrowed baseline plus perpendicular tick marks — one per unit of `units`,
 * longer every fifth — matching @niivue/uikit's buildRuler (which draws the
 * whole-slide ruler in the OHIF viewport) so the volume and slide measurements
 * look identical. `units` is the physical length used for tick spacing (e.g.
 * millimetres); <= 0 yields just the arrowed baseline. A zero-length ruler
 * yields nothing. Pure geometry; the caller colours and renders the segments.
 */
export function rulerSegments(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  units: number,
  thickness = 2,
  tickLength = 6,
): RulerSegment[] {
  const dx = ex - sx
  const dy = ey - sy
  const len = Math.hypot(dx, dy)
  if (len === 0) return []

  const segs: RulerSegment[] = []
  // Arrowed baseline: reuse the tested terminator geometry (the shaft is inset so
  // it stops at the barb base), taking each returned segment's endpoints.
  for (const l of buildTerminatedLine(sx, sy, ex, ey, thickness, [0, 0, 0, 1], {
    start: LineTerminator.ARROW,
    end: LineTerminator.ARROW,
  })) {
    segs.push([l.data[0], l.data[1], l.data[2], l.data[3]])
  }

  if (units <= 0) return segs

  // Unit perpendicular in screen space; ticks straddle the baseline along it.
  const px = -dy / len
  const py = dx / len
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
 * real ruler's scale). Mirrors @niivue/uikit's buildRuler tick numbers. Pure:
 * the caller renders each label. Empty for a zero-length or unit-less ruler.
 */
export function rulerTickLabels(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  units: number,
  tickLength = 6,
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
  const out: RulerTickLabel[] = []
  for (let i = step; i <= marks; i += step) {
    if (i % 5 !== 0) continue
    const t = i / units
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
 * Build lines and labels for all persisted measurements and angles.
 * Iterates each 2D slice tile, projects mm coords, and renders
 * measurements/angles that lie on the current slice.
 */
export function buildPersistedMeasurements(
  model: NVModel,
  screenSlices: SliceTile[],
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
): MeasurementResult | null {
  const measurements = model.completedMeasurements
  const angles = model.completedAngles
  // Rebuilt every frame so an external overlay (UIKit ruler) can read the current
  // screen projection of each persisted measurement.
  model._persistedMeasurementScreenLines = []
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

    // Persisted measurements
    for (const m of measurements) {
      if (
        !isOnSlice(m.startMM, pn, pp, tolerance) ||
        !isOnSlice(m.endMM, pn, pp, tolerance)
      )
        continue

      const [sx, sy] = projectMMToCanvas(m.startMM, mvp, ltwh)
      const [ex, ey] = projectMMToCanvas(m.endMM, mvp, ltwh)

      // Expose the screen projection for an external overlay renderer.
      model._persistedMeasurementScreenLines.push({
        sx,
        sy,
        ex,
        ey,
        distance: m.distance,
      })

      // Graduated ruler: arrowed baseline + per-mm ticks (majors every fifth).
      for (const [x0, y0, x1, y1] of rulerSegments(
        sx,
        sy,
        ex,
        ey,
        m.distance,
        lineWidth,
      )) {
        lines.push(buildLine(x0, y0, x1, y1, lineWidth, lineColor))
      }

      // Graduation numbers at each major tick, along the ruler edge.
      for (const t of rulerTickLabels(sx, sy, ex, ey, m.distance)) {
        const b = buildText(t.str, t.x, t.y, 0.5, textColor, 0.5, 0.5)
        if (b.count > 0) labels.push(b)
      }

      // Distance text
      const label = formatDistance(m.distance, ui.isMeasureUnitsVisible)
      const mx = (sx + ex) * 0.5
      const my = (sy + ey) * 0.5
      const batch = buildText(label, mx, my, 0.8, textColor, 0.5, 1, textBack)
      if (batch.count > 0) labels.push(batch)
    }

    // Persisted angles
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
