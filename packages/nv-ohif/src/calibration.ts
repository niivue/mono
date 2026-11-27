// OHIF's CalibrationLine (C35): one uniform length scale per display set.
// Core keeps native mm stats (undo, mirrors and re-import stay consistent);
// the scale applies only where nv-ohif shows or exports a measurement.
// Cornerstone calibrates one image's spacing; this calibrates the whole volume.
import type { AnnotationStats } from '@niivue/niivue'
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
// rescale the rows already shown. The scale follows the rows panes hold (or
// OHIF holds after a release), so removing rows (or a failed reflection)
// re-derives it. Rows are kept after removal so an undo that brings one back
// brings its scale back.
const reportRows = new Map<
  string,
  { base: number; rows: Map<string, number> }
>()

// Report rows a pane released to OHIF (unmount, series swap): the OHIF row
// keeps its calibrated values until a pane takes it back or it is removed.
const parkedRows = new Set<string>()

const liveAnnotationIds = () =>
  new Set([
    ...parkedRows,
    ...niivueEntries().flatMap((e) => e.nv.annotations.map((a) => a.id)),
  ])

const isReportRow = (id: string) =>
  [...reportRows.values()].some((e) => e.rows.has(id))

/** Keep released rows' scale while their OHIF rows wait for a pane. */
export function parkReportRows(annotationIds: Iterable<string>) {
  for (const id of annotationIds) if (isReportRow(id)) parkedRows.add(id)
}

/** A released row's OHIF row is gone: its scale no longer counts. */
export function unparkReportRow(annotationId: string) {
  if (parkedRows.delete(annotationId)) syncReportRows()
}

/** A pane took a released row back under a new annotation id. */
export function moveReportRow(from: string, to: string) {
  parkedRows.delete(from)
  for (const { rows } of reportRows.values()) {
    const ratio = rows.get(from)
    if (ratio === undefined) continue
    rows.delete(from)
    rows.set(to, ratio)
  }
}

function applyReportRows(displaySetUID: string, live: Set<string>) {
  const entry = reportRows.get(displaySetUID)
  if (!entry) return
  const ratios = [...entry.rows]
    .filter(([id]) => live.has(id))
    .map(([, r]) => r)
  const first = ratios[0]
  const agree = ratios.every((r) => near(r, first ?? r))
  const scale =
    first === undefined ? entry.base : agree && !near(first, 1) ? first : 1
  if (near(scale, calibrationScale(displaySetUID))) return
  if (!agree)
    console.warn('[nv-ohif] report rows disagree on calibration: native mm')
  applyScale(displaySetUID, scale)
}

/** Re-derives each report scale from the report rows panes hold now. */
export function syncReportRows() {
  if (!reportRows.size) return
  const live = liveAnnotationIds()
  for (const displaySetUID of reportRows.keys())
    applyReportRows(displaySetUID, live)
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
  const entry = reportRows.get(displaySetUID) ?? {
    base: calibrationScale(displaySetUID),
    rows: new Map<string, number>(),
  }
  reportRows.set(displaySetUID, entry)
  entry.rows.set(annotationId, ratio)
  // The row's annotation is added after this, so count it as held already.
  applyReportRows(displaySetUID, liveAnnotationIds().add(annotationId))
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

/** Core's label calibration for a pane scale (null: native mm). */
export const labelCalibration = (scale: number) =>
  scale === 1
    ? null
    : { scale, lengthUnit: lengthUnit(scale), areaUnit: areaUnit(scale) }
