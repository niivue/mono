import { log } from '@/logger'
import { SLICE_TYPE, sliceTypeDim } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
import type { CompletedMeasurement } from '@/NVTypes'
import { computeTolerance } from '@/view/NVAnnotation'
import { projectMeasurementLines } from '@/view/NVMeasurement'

/**
 * Optional metadata for a programmatically added measurement. Interactive
 * measurements record which tile they were drawn on; a programmatic caller may
 * supply the same fields, or omit them to have the slice orientation and
 * position derived from the segment's geometry. None of these fields affect
 * rendering — a measurement draws on every 2D tile whose slice plane contains
 * both endpoints (see view/NVMeasurement.ts).
 *
 * `sliceType`, when supplied, must be one of the 2D slice orientations
 * `SLICE_TYPE.AXIAL`, `SLICE_TYPE.CORONAL`, or `SLICE_TYPE.SAGITTAL` — the only
 * values that name a slice plane and drive `slicePosition` via `sliceTypeDim`.
 * A non-2D value (`MULTIPLANAR`, `RENDER`, `NONE`) warns and is ignored: the
 * orientation is derived from the segment geometry instead.
 */
export type AddMeasurementOptions = Partial<
  Pick<CompletedMeasurement, 'sliceIndex' | 'sliceType' | 'slicePosition'>
>

/** Default hit radius for {@link pickMeasurement}, in canvas pixels. */
export const MEASUREMENT_PICK_RADIUS_PX = 8

/**
 * Derive the slice orientation a segment most plausibly lies on: the axis with
 * the smallest mm extent (a segment drawn on an axial slice has a constant z,
 * etc.). Mirrors sliceTypeDim's AXIAL->2 / CORONAL->1 / SAGITTAL->0 mapping.
 */
function deriveSliceType(
  startMM: [number, number, number],
  endMM: [number, number, number],
): number {
  const dx = Math.abs(endMM[0] - startMM[0])
  const dy = Math.abs(endMM[1] - startMM[1])
  const dz = Math.abs(endMM[2] - startMM[2])
  if (dx <= dy && dx <= dz) return SLICE_TYPE.SAGITTAL
  if (dy <= dx && dy <= dz) return SLICE_TYPE.CORONAL
  return SLICE_TYPE.AXIAL
}

/** The 2D slice orientations that name a slice plane (drive `slicePosition`). */
function is2DSliceType(sliceType: number): boolean {
  return (
    sliceType === SLICE_TYPE.AXIAL ||
    sliceType === SLICE_TYPE.CORONAL ||
    sliceType === SLICE_TYPE.SAGITTAL
  )
}

/**
 * Build a CompletedMeasurement from two mm-space points. `distance` is always
 * computed from the points. Slice metadata defaults: `sliceType` is derived
 * from the segment geometry, `slicePosition` is the segment midpoint's scene
 * fraction on the slice axis (the same [0..1] space the interactive path
 * records from the crosshair), and `sliceIndex` is 0 (the interactive fallback
 * when no tile is hit).
 *
 * An explicit `opts.sliceType` must be a 2D orientation (AXIAL/CORONAL/
 * SAGITTAL); any other value (`MULTIPLANAR`, `RENDER`, `NONE`) does not name a
 * slice plane and would let `sliceTypeDim` derive `slicePosition` on the wrong
 * axis, so it warns and falls back to the geometry-derived orientation
 * (matching how `removeMeasurement` warns and no-ops on bad input rather than
 * throwing).
 */
export function buildMeasurement(
  ctrl: NiiVue,
  startMM: [number, number, number],
  endMM: [number, number, number],
  opts: AddMeasurementOptions = {},
): CompletedMeasurement {
  const distance = Math.hypot(
    endMM[0] - startMM[0],
    endMM[1] - startMM[1],
    endMM[2] - startMM[2],
  )
  let sliceType = deriveSliceType(startMM, endMM)
  if (opts.sliceType !== undefined) {
    if (is2DSliceType(opts.sliceType)) {
      sliceType = opts.sliceType
    } else {
      log.warn(
        `Ignoring non-2D measurement sliceType ${opts.sliceType}; expected AXIAL (${SLICE_TYPE.AXIAL}), CORONAL (${SLICE_TYPE.CORONAL}), or SAGITTAL (${SLICE_TYPE.SAGITTAL}). Deriving orientation from geometry.`,
      )
    }
  }
  let slicePosition = opts.slicePosition
  if (slicePosition !== undefined) {
    // A caller-supplied position is a scene fraction like the derived one:
    // clamp it (and reject non-finite) so no out-of-range metadata leaks into
    // getMeasurements() or event payloads.
    slicePosition = Number.isFinite(slicePosition)
      ? Math.min(1, Math.max(0, slicePosition))
      : 0
  } else {
    const mid: [number, number, number] = [
      (startMM[0] + endMM[0]) * 0.5,
      (startMM[1] + endMM[1]) * 0.5,
      (startMM[2] + endMM[2]) * 0.5,
    ]
    // mm2scene does not clamp; keep the recorded fraction in the same [0..1]
    // space as scene.crosshairPos even for points outside the volume.
    const frac = ctrl.model.mm2scene(mid)[sliceTypeDim(sliceType)]
    slicePosition = Math.min(1, Math.max(0, frac))
  }
  return {
    startMM: [...startMM],
    endMM: [...endMM],
    distance,
    sliceIndex: opts.sliceIndex ?? 0,
    sliceType,
    slicePosition,
  }
}

/**
 * Append a measurement built from two mm points, emit `measurementCompleted`
 * (after the mutation, matching interactive completion), redraw, and return the
 * new measurement's index.
 */
export function addMeasurement(
  ctrl: NiiVue,
  startMM: [number, number, number],
  endMM: [number, number, number],
  opts: AddMeasurementOptions = {},
): number {
  const measurement = buildMeasurement(ctrl, startMM, endMM, opts)
  ctrl.model.completedMeasurements.push(measurement)
  ctrl.emit('measurementCompleted', measurement)
  ctrl.drawScene()
  return ctrl.model.completedMeasurements.length - 1
}

/**
 * Remove one measurement by index. Out-of-bounds indices warn and no-op
 * (matching removeVolume). Emits `measurementRemoved` BEFORE the mutation, so a
 * listener can still reach the referenced measurement in the collection.
 */
export function removeMeasurement(ctrl: NiiVue, index: number): void {
  const measurements = ctrl.model.completedMeasurements
  if (index < 0 || index >= measurements.length) {
    log.warn(
      `Measurement index ${index} out of bounds (${measurements.length} measurements).`,
    )
    return
  }
  ctrl.emit('measurementRemoved', { measurement: measurements[index], index })
  measurements.splice(index, 1)
  ctrl.drawScene()
}

/** Distance from a point to a line segment, all in canvas pixels. */
function pointToSegmentDistance(
  px: number,
  py: number,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): number {
  const dx = ex - sx
  const dy = ey - sy
  const lenSq = dx * dx + dy * dy
  let t = 0
  if (lenSq > 0) {
    t = ((px - sx) * dx + (py - sy) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
  }
  return Math.hypot(px - (sx + t * dx), py - (sy + t * dy))
}

/**
 * Find the measurement under a canvas point. Each measurement is projected to
 * canvas pixels on every visible 2D slice tile with the same tile filtering and
 * matrices the renderer uses to draw it ({@link projectMeasurementLines}), so
 * the hit-test agrees with what is on screen. Returns the index of the closest
 * measurement whose projected segment is within `radiusPx`, or null.
 */
export function pickMeasurement(
  ctrl: NiiVue,
  canvasX: number,
  canvasY: number,
  radiusPx = MEASUREMENT_PICK_RADIUS_PX,
): number | null {
  const lines = projectMeasurementLines(
    ctrl.model.completedMeasurements,
    ctrl.view?.screenSlices ?? [],
    computeTolerance(ctrl.model),
  )
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const line of lines) {
    const d = pointToSegmentDistance(
      canvasX,
      canvasY,
      line.sx,
      line.sy,
      line.ex,
      line.ey,
    )
    if (d <= radiusPx && d < bestDist) {
      bestDist = d
      best = line.index
    }
  }
  return best
}
