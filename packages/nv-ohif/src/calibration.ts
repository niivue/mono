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
import { getNiivueEntry } from './niivueRegistry'

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

/** Replaces any earlier scale (never compounds); 1 resets to native mm. */
export function setCalibrationScale(displaySetUID: string, scale: number) {
  if (scale === 1) scales.delete(displaySetUID)
  else scales.set(displaySetUID, scale)
  calibrationEvents.dispatchEvent(
    new CustomEvent('change', { detail: displaySetUID }),
  )
}

/** The scale making a line of native length `nativeMM` read `enteredMM`. */
export function scaleFromLine(nativeMM: number, enteredMM: number) {
  return nativeMM > 0 && Number.isFinite(enteredMM) && enteredMM > 0
    ? enteredMM / nativeMM
    : undefined
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
  const byId = new Map(nv.annotations.map((a) => [a.id, a]))
  const len = lengthUnit(scale)
  return shapes.map((shape) => {
    // The shape being drawn has no annotation yet: only its ruler scales.
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
