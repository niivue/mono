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
import { rowReport } from './csvReport'
import { ohifServices } from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'
import { type CommandsLike, routeSlideSR, type SlideRow } from './slideSR'
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
function slideRowPoints({
  tool,
  points,
}: Pick<SlideAnnotation, 'tool' | 'points'>): [number, number, number][] {
  const [a, b] = points as [NVSlidePoint, NVSlidePoint]
  let out = points
  // ArrowAnnotate rows lead with the tip, as cornerstone's (and volume rows).
  if (tool === 'arrow') out = [b, a]
  else if (tool === 'rectangle' || tool === 'ellipse') {
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
  if (stats.length !== undefined && stats.shortLength !== undefined) {
    // As a volume Bidirectional row: length and width.
    const [length, width] = [stats.length * k, stats.shortLength * k]
    return {
      primary: [
        `L: ${roundNumber(length)} ${unit}`,
        `W: ${roundNumber(width)} ${unit}`,
      ],
      data: { length, width, unit },
    }
  }
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
// By annotation id: events and list() hand out copies.
const rowTools = new WeakMap<NVSlideAnnotations, Map<string, string>>()

/** The OHIF tool of an annotation's row (that drew it), once bound. */
export const slideRowTool = (
  slide: NVSlideAnnotations,
  a: SlideAnnotation,
): string | undefined => rowTools.get(slide)?.get(a.id)

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
  commandsManager?: CommandsLike,
): () => void {
  const annotations = view.annotations
  const services = ohifServices(servicesManager)
  const displaySets = services?.displaySetService as
    | { getDisplaySetByUID?: (uid: string) => OhifDisplaySet | undefined }
    | undefined
  // A row's base level: its series' largest total pixel matrix.
  const smOf = (row: SlideRow) =>
    displaySets
      ?.getDisplaySetByUID?.(row.displaySetInstanceUID ?? '')
      ?.instances?.reduce((a, b) =>
        Number(b.TotalPixelMatrixColumns) > Number(a.TotalPixelMatrixColumns)
          ? b
          : a,
      )
  routeSlideSR(commandsManager, smOf)
  const ms = services?.measurementService as
    | (MeasurementServiceLike & {
        remove(uid: string): void
        getMeasurement(uid: string): unknown
        EVENTS?: { MEASUREMENTS_CLEARED?: string }
      })
    | undefined
  if (!annotations || !ms?.addRawMeasurement) return () => {}
  const source = niivueMeasurementSource(ms)
  const tools = new Map<string, string>()
  rowTools.set(annotations, tools)
  // Annotation ids restart per slide: a binding prefix keeps uids unique.
  const prefix = `${SLIDE_UID_PREFIX}${++bindings}-`
  const idOf = (uid: unknown) =>
    typeof uid === 'string' && uid.startsWith(prefix)
      ? uid.slice(prefix.length)
      : undefined

  const upsert = ({ detail: a }: CustomEvent<SlideAnnotation>): void => {
    let toolName = tools.get(a.id)
    if (!toolName) {
      const active = view.tool ?? ''
      toolName =
        OHIF_TO_SLIDE_TOOL[active] === a.tool ? active : SLIDE_TO_OHIF[a.tool]
      tools.set(a.id, toolName)
    }
    const mapping = Object.values(ANNOTATION_TO_OHIF).find(
      (m) => m.toolName === toolName,
    )
    const uid = prefix + a.id
    const { primary, data } = slideRowValues(a)
    const points = slideRowPoints(a)
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
          points,
          displayText: { primary, secondary: [] },
          data,
          getReport: rowReport(toolName, data, points),
          type: mapping?.valueType,
          metadata: { toolName, slideTool: a.tool },
        },
      },
      (d) => d.measurement,
    )
  }
  const onRemoved = ({ detail: a }: CustomEvent<SlideAnnotation>): void => {
    // A no-op when the panel removed the row first.
    ms.remove(prefix + a.id)
  }
  // A drawn arrow asks for its text through OHIF's dialog, as cornerstone's;
  // an empty save removes it (a dismissed dialog keeps it unlabelled).
  const askArrowText = ({ detail: a }: CustomEvent<SlideAnnotation>): void => {
    if (a.tool !== 'arrow' || a.label) return
    commandsManager?.runCommand?.('arrowTextCallback', {
      callback: (text: unknown) => {
        if (typeof text !== 'string') return
        if (text) annotations.setLabel(a.id, text)
        else annotations.remove(a.id)
      },
      data: { data: { label: '' } },
    })
  }
  const listeners = [
    ['added', upsert],
    ['added', askArrowText],
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
