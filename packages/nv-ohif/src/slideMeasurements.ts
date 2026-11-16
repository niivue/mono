import type {
  NVSlideAnnotations,
  NVSlidePoint,
  SlideAnnotation,
  SlideAnnotationTool,
} from '@niivue/niivue'
import {
  type MeasurementServiceLike,
  niivueMeasurementSource,
  roundNumber,
} from './commands'
import { ohifServices } from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'
import {
  ANNOTATION_TO_OHIF,
  OHIF_TO_SLIDE_TOOL,
  SLIDE_UID_PREFIX,
} from './toolBridge'

// Default row tool per slide tool (polygon: SplineROI, the first listed).
const SLIDE_TO_OHIF: Record<SlideAnnotationTool, string> = {
  freehandLine: 'PlanarFreehandROI',
  ...Object.fromEntries(
    Object.entries(OHIF_TO_SLIDE_TOOL)
      .reverse()
      .map(([ohif, slide]) => [slide, ohif]),
  ),
} as Record<SlideAnnotationTool, string>

/** Row points (slide base px, z 0) in the layout OHIF's mapping of the tool reads. */
export function slideRowPoints({
  tool,
  points,
}: Pick<SlideAnnotation, 'tool' | 'points'>): [number, number, number][] {
  const [a, b] = points as [NVSlidePoint, NVSlidePoint]
  let out = points
  if (tool === 'rectangle' || tool === 'ellipse') {
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2]
    out =
      tool === 'rectangle'
        ? [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ]
        : // Axis pairs, as the volume bridge's EllipticalROI: vertical, horizontal.
          [
            { x: cx, y: y0 },
            { x: cx, y: y1 },
            { x: x0, y: cy },
            { x: x1, y: cy },
          ]
  } else if (tool === 'circle') {
    out = [a, { x: a.x + Math.hypot(b.x - a.x, b.y - a.y), y: a.y }]
  }
  return out.map((p) => [p.x, p.y, 0])
}

/** Stats in µm / µm² (px / px² without pixel spacing), as the panel shows them. */
export function slideRowValues({ stats }: Pick<SlideAnnotation, 'stats'>): {
  primary: string[]
  data: Record<string, number | string>
} {
  const [unit, k] = stats.unit === 'mm' ? ['µm', 1000] : ['px', 1]
  if (stats.length !== undefined) {
    const length = stats.length * k
    return {
      primary: [`${roundNumber(length)} ${unit}`],
      data: { length, unit },
    }
  }
  if (stats.area === undefined) return { primary: [], data: {} }
  const area = stats.area * k * k
  return {
    primary: [`${roundNumber(area)} ${unit}²`],
    data: {
      area,
      perimeter: (stats.perimeter ?? 0) * k,
      unit,
      areaUnit: `${unit}²`,
    },
  }
}

let bindings = 0
const rowTools = new WeakMap<SlideAnnotation, string>()

/** The OHIF tool of an annotation's row (that drew it), once bound. */
export const slideRowTool = (a: SlideAnnotation): string | undefined =>
  rowTools.get(a)

/**
 * Mirror a slide's annotations as 'NiiVue' rows in OHIF's MeasurementService,
 * and the panel's remove, label edit and jump back onto them. A row's tool is
 * the OHIF tool that drew it. Returns a teardown that clears both.
 */
export function bindSlideMeasurements(
  view: {
    annotations: NVSlideAnnotations | undefined
    focusAnnotation(id: string): void
    readonly tool: string | undefined
  },
  servicesManager: OhifExtensionParams['servicesManager'],
  ds: OhifDisplaySet,
): () => void {
  const annotations = view.annotations
  const ms = ohifServices(servicesManager)?.measurementService as
    | (MeasurementServiceLike & {
        remove(uid: string): void
        getMeasurement(uid: string): unknown
        EVENTS?: { MEASUREMENTS_CLEARED?: string }
      })
    | undefined
  if (!annotations || !ms?.addRawMeasurement) return () => {}
  const source = niivueMeasurementSource(ms)
  // Annotation ids restart per slide: a binding prefix keeps uids unique.
  const prefix = `${SLIDE_UID_PREFIX}${++bindings}-`
  const idOf = (uid: unknown) =>
    typeof uid === 'string' && uid.startsWith(prefix)
      ? uid.slice(prefix.length)
      : undefined

  const upsert = ({ detail: a }: CustomEvent<SlideAnnotation>): void => {
    let toolName = rowTools.get(a)
    if (!toolName) {
      const active = view.tool ?? ''
      toolName =
        OHIF_TO_SLIDE_TOOL[active] === a.tool ? active : SLIDE_TO_OHIF[a.tool]
      rowTools.set(a, toolName)
    }
    const mapping = Object.values(ANNOTATION_TO_OHIF).find(
      (m) => m.toolName === toolName,
    )
    const uid = prefix + a.id
    const { primary, data } = slideRowValues(a)
    ms.addRawMeasurement(
      source,
      toolName,
      {
        uid,
        // addRawMeasurement destructures data.annotation.data.
        annotation: { data: {} },
        measurement: {
          uid,
          toolName,
          label: a.label,
          referenceSeriesUID: ds.SeriesInstanceUID,
          referenceStudyUID: ds.StudyInstanceUID,
          displaySetInstanceUID: ds.displaySetInstanceUID,
          points: slideRowPoints(a),
          displayText: { primary, secondary: [] },
          data,
          type: mapping?.valueType,
          metadata: { toolName },
        },
      },
      (d) => d.measurement,
    )
  }
  const onRemoved = ({ detail: a }: CustomEvent<SlideAnnotation>): void => {
    // A no-op when the panel removed the row first.
    ms.remove(prefix + a.id)
  }
  const listeners = [
    ['added', upsert],
    ['changed', upsert],
    ['removed', onRemoved],
  ] as const
  for (const [type, fn] of listeners)
    annotations.addEventListener(type, fn as EventListener)

  const {
    MEASUREMENT_UPDATED,
    MEASUREMENT_REMOVED,
    MEASUREMENTS_CLEARED,
    JUMP_TO_MEASUREMENT,
  } = ms.EVENTS ?? {}
  const subscriptions = ms.subscribe
    ? [
        MEASUREMENT_REMOVED &&
          ms.subscribe(MEASUREMENT_REMOVED, ({ measurement }) => {
            const id = idOf(measurement)
            if (id) annotations.remove(id)
          }),
        // Delete-all and removeMany broadcast this, not MEASUREMENT_REMOVED.
        MEASUREMENTS_CLEARED &&
          ms.subscribe(MEASUREMENTS_CLEARED, () => {
            for (const a of annotations.list())
              if (!ms.getMeasurement(prefix + a.id)) annotations.remove(a.id)
          }),
        MEASUREMENT_UPDATED &&
          ms.subscribe(MEASUREMENT_UPDATED, ({ measurement: m }) => {
            const id = typeof m === 'object' ? idOf(m.uid) : undefined
            // Our own upsert echoes the label back: skip an unchanged one.
            if (
              id &&
              typeof m === 'object' &&
              typeof m.label === 'string' &&
              m.label !== annotations.get(id)?.label
            )
              annotations.setLabel(id, m.label)
          }),
        JUMP_TO_MEASUREMENT &&
          ms.subscribe(JUMP_TO_MEASUREMENT, ({ measurement: m }) => {
            const id = typeof m === 'object' ? idOf(m.uid) : undefined
            if (id) view.focusAnnotation(id)
          }),
      ]
    : []

  return () => {
    for (const s of subscriptions) if (s) s.unsubscribe?.()
    // Still listening: each removal drops its row.
    annotations.clear()
    for (const [type, fn] of listeners)
      annotations.removeEventListener(type, fn as EventListener)
  }
}
