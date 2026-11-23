// OHIF's CalibrationLine (C35): one uniform length scale per display set.
// Core keeps native mm stats (undo, mirrors and re-import stay consistent);
// the scale applies only where nv-ohif shows or exports a measurement.
// Cornerstone calibrates one image's spacing; this calibrates the whole volume.
import type {
  AnnotationScreenShape,
  AnnotationStats,
  NiiVue,
} from '@niivue/niivue'
import { isContourAnnotation } from './contourSeg'
import { getNiivueEntry, niivueEntries } from './niivueRegistry'

const scales = new Map<string, number>()
/** Fires 'change' with the display set as detail when its scale changes. */
export const calibrationEvents = new EventTarget()

export const calibrationScale = (displaySetUID: string | undefined): number =>
  (displaySetUID && scales.get(displaySetUID)) || 1

/** The pane's base display set, whose scale its measurements take. */
export const paneDisplaySet = (viewportId: string) =>
  getNiivueEntry(viewportId)?.displaySets[0]?.displaySetInstanceUID

export const paneScale = (viewportId: string) =>
  calibrationScale(paneDisplaySet(viewportId))

/**
 * A user calibration: replaces any earlier scale (never compounds); 1 resets
 * to native mm. Later report rows are checked against this one afresh.
 */
export function setCalibrationScale(displaySetUID: string, scale: number) {
  reportRows.delete(displaySetUID)
  applyScale(displaySetUID, scale)
}

function applyScale(displaySetUID: string, scale: number) {
  if (scale === 1) scales.delete(displaySetUID)
  else scales.set(displaySetUID, scale)
  calibrationEvents.dispatchEvent(
    new CustomEvent('change', { detail: displaySetUID }),
  )
}

const near = (a: number, b: number) => Math.abs(a / b - 1) <= 1e-3
// Display set -> its report rows (annotation id -> the scale each gave) and the
// scale before the first of them. Rows of every report on a set must agree,
// whenever they hydrate: a later report at another scale would silently
// rescale the rows already shown. The scale follows the rows a pane still
// holds, so removing rows (or a failed reflection) re-derives it.
const reportRows = new Map<
  string,
  { base: number; rows: Map<string, number> }
>()

function applyReportRows(displaySetUID: string) {
  const entry = reportRows.get(displaySetUID)
  if (!entry) return
  const ratios = [...entry.rows.values()]
  const first = ratios[0]
  if (first === undefined) {
    reportRows.delete(displaySetUID)
    if (!near(entry.base, calibrationScale(displaySetUID)))
      applyScale(displaySetUID, entry.base)
    return
  }
  const agree = ratios.every((r) => near(r, first))
  if (!agree && calibrationScale(displaySetUID) !== 1)
    console.warn('[nv-ohif] report rows disagree on calibration: native mm')
  const scale = agree && !near(first, 1) ? first : 1
  if (!near(scale, calibrationScale(displaySetUID)))
    applyScale(displaySetUID, scale)
}

/** Drops report rows no pane holds any more and re-derives their scale. */
export function pruneReportRows() {
  if (!reportRows.size) return
  const live = new Set(
    niivueEntries().flatMap((e) => e.nv.annotations.map((a) => a.id)),
  )
  for (const [displaySetUID, { rows }] of reportRows) {
    const before = rows.size
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id)
    if (rows.size !== before) applyReportRows(displaySetUID)
  }
}

/**
 * A report row's stored length over the length of its geometry (srImport.ts):
 * a calibrated report restores its scale. Rows that disagree, in one report or
 * across reports, leave native mm rather than contradictory values. Called
 * before the row's annotation is added, so its scale is in place for reflection.
 */
export function adoptReportScale(
  displaySetUID: string,
  annotationId: string,
  ratio: number,
) {
  pruneReportRows()
  const entry = reportRows.get(displaySetUID) ?? {
    base: calibrationScale(displaySetUID),
    rows: new Map<string, number>(),
  }
  reportRows.set(displaySetUID, entry)
  entry.rows.set(annotationId, ratio)
  applyReportRows(displaySetUID)
}

// Cornerstone's calibrated units (getCalibratedLengthUnitsAndScale, type User).
export const lengthUnit = (scale: number) => (scale === 1 ? 'mm' : 'mm User')
export const areaUnit = (scale: number) => (scale === 1 ? 'mm²' : 'mm² User')

/** Lengths x scale, area x scale²; angles, intensities and values unchanged. */
export function calibrateStats<T extends AnnotationStats | undefined>(
  stats: T,
  scale: number,
): T {
  if (!stats || scale === 1) return stats
  const s = stats as AnnotationStats
  return {
    ...s,
    area: s.area * scale * scale,
    ...(s.length !== undefined ? { length: s.length * scale } : {}),
    ...(s.shortLength !== undefined
      ? { shortLength: s.shortLength * scale }
      : {}),
  } as T
}

/**
 * The overlay's shapes with calibrated ruler lengths and stats labels. Label
 * lines follow core's format (NVAnnotation formatAnnotationStats): free text
 * first, then L:/W: or Area: lines carrying lengths.
 */
export function calibrateShapes(
  nv: NiiVue,
  scale: number,
  shapes: readonly AnnotationScreenShape[],
): readonly AnnotationScreenShape[] {
  if (scale === 1) return shapes
  const preview = nv.model._annotationPreview
  const byId = new Map(
    [...nv.annotations, ...(preview ? [preview] : [])].map((a) => [a.id, a]),
  )
  const len = lengthUnit(scale)
  return shapes.map((shape) => {
    const a = byId.get(shape.id)
    if (a && isContourAnnotation(a)) return shape
    const st = a?.stats && calibrateStats(a.stats, scale)
    const label = st &&
      shape.label && {
        ...shape.label,
        lines: shape.label.lines.map((line, i) =>
          i < (a.text ? 1 : 0)
            ? line
            : line.startsWith('L: ') && st.length !== undefined
              ? `L: ${st.length.toFixed(1)} ${len}`
              : line.startsWith('W: ') && st.shortLength !== undefined
                ? `W: ${st.shortLength.toFixed(1)} ${len}`
                : line.startsWith('Area: ')
                  ? `Area: ${st.area.toFixed(1)} ${areaUnit(scale)}`
                  : line,
        ),
      }
    return {
      ...shape,
      ...(label ? { label } : {}),
      ...(shape.length !== undefined
        ? { length: shape.length * scale, unit: len }
        : {}),
    }
  })
}
