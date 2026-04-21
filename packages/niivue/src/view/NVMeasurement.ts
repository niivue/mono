import { isOnSlice } from "@/annotation/sliceProjection"
import { SLICE_TYPE } from "@/NVConstants"
import type NVModel from "@/NVModel"
import { computeTolerance } from "@/view/NVAnnotation"
import { projectMMToCanvas } from "@/view/sliceUtils"
import type { BuildTextFn, GlyphBatch } from "./NVFont"
import type { BuildLineFn, LineData } from "./NVLine"
import type { SliceTile } from "./NVSliceLayout"

export type MeasurementResult = { lines: LineData[]; labels: GlyphBatch[] }

/** Format distance with smart decimals. */
function formatDistance(dist: number, showUnits: boolean): string {
  let decimals = 2
  if (dist > 9) decimals = 1
  if (dist > 99) decimals = 0
  let label = dist.toFixed(decimals)
  if (showUnits) label += " mm"
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

      // Main line
      lines.push(buildLine(sx, sy, ex, ey, lineWidth, lineColor))

      // End caps
      const dx = ex - sx
      const dy = ey - sy
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 0) {
        const capLen = 6
        const px = (-dy / len) * capLen
        const py = (dx / len) * capLen
        lines.push(
          buildLine(sx - px, sy - py, sx + px, sy + py, lineWidth, lineColor),
          buildLine(ex - px, ey - py, ex + px, ey + py, lineWidth, lineColor),
        )
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
