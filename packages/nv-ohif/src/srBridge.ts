// NiiVue measurement rows mirrored as cornerstone annotations, so OHIF's DICOM
// SR export (which reads cornerstoneTools' annotation state, not the
// MeasurementService) includes them. They go in through the annotation manager
// directly: that fires no annotation events, so OHIF's cornerstone source makes
// no duplicate row. Cornerstone panes on the same frame of reference draw them.
// ponytail: editing a mirrored annotation in a cornerstone pane updates the row
// through cornerstone's mapping, not back into NiiVue.
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'

const CORNERSTONE_COMMON = '@ohif/extension-cornerstone.utilityModule.common'
// Tools the SR adapters encode (SplineROI and LivewireContour have none).
const SR_TOOLS = new Set([
  'Length',
  'EllipticalROI',
  'RectangleROI',
  'CircleROI',
  'Probe',
  'ArrowAnnotate',
  'Bidirectional',
  'PlanarFreehandROI',
  'Angle',
  'CobbAngle',
])

// Cornerstone's RectangleROI handles are [top-left, top-right, bottom-left,
// bottom-right]; the row's points run around the outline (0 1 2 3).
const toHandles = (m: MirroredMeasurement) =>
  m.toolName === 'RectangleROI'
    ? [m.points[0], m.points[1], m.points[3], m.points[2]]
    : m.points

// The stats each adapter reads: an ROI's intensity unit as modalityUnit (its
// row carries it as unit), and a circle's perimeter from its row's radius.
function statsFor(m: MirroredMeasurement): Record<string, unknown> {
  const data = m.data ?? {}
  const stats = data.areaUnit ? { ...data, modalityUnit: data.unit } : data
  if (m.toolName !== 'CircleROI') return stats
  return { ...stats, perimeter: 2 * Math.PI * (data.radius as number) }
}

export interface MirroredMeasurement {
  uid: string
  source?: { name?: string }
  toolName: string
  points: number[][]
  label?: string
  FrameOfReferenceUID?: string
  referencedImageId?: string
  data?: Record<string, unknown>
}

/** The cornerstone annotation for a NiiVue row; undefined when SR cannot encode it. */
export function toCornerstoneAnnotation(m: MirroredMeasurement) {
  // The adapters map world points onto the referenced image.
  if (!SR_TOOLS.has(m.toolName) || !m.referencedImageId) return undefined
  const isContour = m.toolName === 'PlanarFreehandROI'
  return {
    annotationUID: m.uid,
    highlighted: false,
    isLocked: false,
    invalidated: false,
    metadata: {
      toolName: m.toolName,
      referencedImageId: m.referencedImageId,
      FrameOfReferenceUID: m.FrameOfReferenceUID,
    },
    data: {
      label: m.label,
      text: m.label,
      handles: {
        points: toHandles(m),
        activeHandleIndex: null,
        // nv-ohif emits an arrow tip first.
        arrowFirst: true,
        textBox: { hasMoved: false },
      },
      ...(isContour ? { contour: { polyline: m.points, closed: true } } : {}),
      cachedStats: { [`imageId:${m.referencedImageId}`]: statsFor(m) },
    },
  }
}

type AnnotationManager = {
  addAnnotation: (annotation: unknown, groupKey?: string) => void
  removeAnnotation: (uid: string) => void
}

function annotationManager(
  extensionManager: OhifExtensionManager | undefined,
): AnnotationManager | undefined {
  const entry = extensionManager?.getModuleEntry(CORNERSTONE_COMMON) as
    | { exports?: { getCornerstoneLibraries?: () => unknown } }
    | undefined
  const libs = entry?.exports?.getCornerstoneLibraries?.() as
    | {
        cornerstoneTools?: {
          annotation?: { state?: { getAnnotationManager?: () => unknown } }
        }
      }
    | undefined
  return libs?.cornerstoneTools?.annotation?.state?.getAnnotationManager?.() as
    | AnnotationManager
    | undefined
}

type MeasurementEvent = {
  source?: { name?: string }
  measurement?: MirroredMeasurement | string
}
type Subscribable = {
  EVENTS?: Record<string, string>
  getMeasurements?: () => MirroredMeasurement[]
  subscribe?: (
    event: string,
    cb: (e: MeasurementEvent) => void,
  ) => { unsubscribe: () => void }
}

/** Mirror NiiVue-source rows into cornerstone's annotation state; returns the unsubscribe. */
export function mirrorNiivueMeasurements(
  servicesManager: OhifServicesManager | undefined,
  extensionManager: OhifExtensionManager | undefined,
): () => void {
  const ms = servicesManager?.services?.measurementService as
    | Subscribable
    | undefined
  if (!ms?.EVENTS || !ms.subscribe) return () => {}
  const mirrored = new Set<string>()
  // Looked up on use: the cornerstone extension may register after this one.
  const remove = (uid: string) => {
    if (mirrored.delete(uid))
      annotationManager(extensionManager)?.removeAnnotation(uid)
  }
  const upsert = (e: MeasurementEvent) => {
    const m = e.measurement
    if (!m || typeof m === 'string') return
    if ((e.source ?? m.source)?.name !== 'NiiVue') return
    remove(m.uid)
    const annotation = toCornerstoneAnnotation(m)
    const manager = annotationManager(extensionManager)
    if (!annotation || !manager) return
    manager.addAnnotation(annotation)
    mirrored.add(m.uid)
  }
  const clear = () => {
    for (const uid of [...mirrored]) remove(uid)
  }
  // addRawMeasurement (how NiiVue rows arrive) fires RAW_MEASUREMENT_ADDED.
  const {
    MEASUREMENT_ADDED,
    RAW_MEASUREMENT_ADDED,
    MEASUREMENT_UPDATED,
    MEASUREMENT_REMOVED,
    MEASUREMENTS_CLEARED,
  } = ms.EVENTS
  const subs = [
    MEASUREMENT_ADDED && ms.subscribe(MEASUREMENT_ADDED, upsert),
    RAW_MEASUREMENT_ADDED && ms.subscribe(RAW_MEASUREMENT_ADDED, upsert),
    MEASUREMENT_UPDATED && ms.subscribe(MEASUREMENT_UPDATED, upsert),
    MEASUREMENT_REMOVED &&
      ms.subscribe(MEASUREMENT_REMOVED, (e) => {
        const m = e.measurement
        remove(typeof m === 'string' ? m : (m?.uid ?? ''))
      }),
    MEASUREMENTS_CLEARED && ms.subscribe(MEASUREMENTS_CLEARED, clear),
  ]
  // Rows made before this mirror: a rebuilt commands module stopped the old one, which removed them.
  for (const m of ms.getMeasurements?.() ?? []) upsert({ measurement: m })
  return () => {
    for (const s of subs) if (s) s.unsubscribe()
    clear()
  }
}
