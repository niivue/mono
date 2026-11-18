/**
 * What is drawn over the scene by hand: the voxel drawing, the vector
 * annotations, and the distance measurements. Each has a listing tool
 * and an editing tool that takes an `action`, so the schema stays one
 * per kind rather than one per verb.
 */

import { MAX_BOXES, MAX_PLANE_OUTLINES } from '../limits'
import { nameFor, SLICE_TYPES, SLIDE_ANNOTATION_TOOLS } from '../views'
import {
  choice,
  color,
  flag,
  integer,
  number,
  type Params,
  point,
  record,
  strings,
  text,
} from './params'
import type {
  Annotation,
  FocusBox,
  Handlers,
  Measurement,
  MeasurementOptions,
  NiiVueHost,
  PlaneOutline,
  SlideAnnotation,
} from './view'
import { worldUnit } from './view'

const DRAWING_ACTIONS = [
  'create',
  'load',
  'undo',
  'close',
  'svg',
  'fill',
] as const
// NiiVue's PEN_SHAPE values.
const FILL_SHAPES = { rectangle: 0, circle: 1, sphere: 2 } as const
const ANNOTATION_ACTIONS = [
  'add',
  'remove',
  'clear',
  'select',
  'set_text',
  'undo',
  'redo',
  'load',
  'set_style',
] as const
const SLIDE_ANNOTATION_ACTIONS = [
  'add',
  'remove',
  'set_label',
  'clear',
] as const

/** Slide base pixels from [[x, y], ...]. */
function slidePoints(params: Params): { x: number; y: number }[] {
  const value = params?.points
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every((v) => typeof v === 'number' && Number.isFinite(v)),
    )
  )
    throw new Error('points must be a list of [x, y] in slide base pixels.')
  return value.map(([x, y]) => ({ x, y }))
}

const describeSlideAnnotation = (a: SlideAnnotation, full: boolean) => ({
  id: a.id,
  tool: a.tool,
  label: a.label,
  stats: a.stats,
  ...(full ? { points: a.points.map(({ x, y }) => [x, y]) } : {}),
})

/** NiiVue's colour for a picked brick, for a box given none. */
const BOX_COLOR = [1, 0.83, 0.28, 1]

/** A box from the tool's words: corners in mm, an optional colour and edge width. */
function boxFrom(given: unknown, what: string): FocusBox {
  if (!given || typeof given !== 'object' || Array.isArray(given))
    throw new Error(`${what} must be {min, max, color?, thickness?}.`)
  const box = given as Params
  const min = point(box, 'min')
  const max = point(box, 'max')
  if (min.some((v, i) => v >= max[i]))
    throw new Error(`${what}: each of min must be below max.`)
  let color = BOX_COLOR
  if (box.color !== undefined) {
    const c = box.color
    if (
      !Array.isArray(c) ||
      c.length < 3 ||
      c.length > 4 ||
      c.some((v) => typeof v !== 'number' || !(v >= 0 && v <= 1))
    )
      throw new Error(
        `${what}: color must be [r, g, b] or [r, g, b, a], each 0 to 1.`,
      )
    color = c.length === 3 ? [...c, 1] : [...c]
  }
  const thickness = number(box, 'thickness') ?? 2
  if (!(thickness > 0))
    throw new Error(`${what}: thickness must be above 0 pixels.`)
  return { min, max, color, thickness }
}

function outlineFrom(given: unknown, what: string): PlaneOutline {
  if (!given || typeof given !== 'object' || Array.isArray(given))
    throw new Error(`${what} must be {corners, color?, width?}.`)
  const o = given as Params
  if (!Array.isArray(o.corners) || o.corners.length !== 4)
    throw new Error(`${what}: corners must be four [x, y, z] points.`)
  const cornersMM = o.corners.map((c, j) => {
    const key = `${what}.corners[${j}]`
    return point({ [key]: c }, key)
  })
  const width = number(o, 'width')
  if (width !== undefined && !(width > 0))
    throw new Error(`${what}: width must be above 0 pixels.`)
  return { cornersMM, color: color(o, 'color'), width }
}

const MEASUREMENT_ACTIONS = [
  'add',
  'remove',
  'clear',
  'clear_angles',
  'clear_distances',
] as const

/** A slice type by name, when given. */
function sliceType(params: Params, key: string): number | undefined {
  const name = text(params, key)?.toLowerCase()
  if (name === undefined) return undefined
  if (!Object.hasOwn(SLICE_TYPES, name)) {
    throw new Error(
      `Unknown ${key} "${name}". One of: ${Object.keys(SLICE_TYPES).join(', ')}.`,
    )
  }
  return SLICE_TYPES[name as keyof typeof SLICE_TYPES]
}

/** A measurement as the tools report it. */
function describeMeasurement(m: Measurement, index: number) {
  return {
    index,
    startMM: m.startMM,
    endMM: m.endMM,
    distance: m.distance,
    slice: nameFor(SLICE_TYPES, m.sliceType),
    sliceIndex: m.sliceIndex,
    slicePosition: m.slicePosition,
  }
}

/** An annotation as the tools report it, its polygons left out unless asked. */
function describeAnnotation(a: Annotation, full: boolean) {
  const { polygons, ...rest } = a
  return {
    ...rest,
    slice: nameFor(SLICE_TYPES, a.sliceType),
    ...(full ? { polygons } : { polygonCount: polygons.length }),
  }
}

/** The handlers for the drawing, annotation and measurement tools. */
export function markHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  const slideAnnotations = () => {
    if (!host.slideAnnotations)
      throw new Error('This page has no slide annotations.')
    return host.slideAnnotations
  }
  const annotations = () => {
    if (!view.annotations)
      throw new Error("This page's NiiVue has no annotations.")
    return view.annotations
  }
  const measurements = () => {
    if (!view.getMeasurements)
      throw new Error("This page's NiiVue keeps no measurements.")
    return view.getMeasurements()
  }
  const requireVolume = () => {
    if (!view.volumes[0])
      throw new Error('No volume is loaded yet. Call load_volume first.')
  }

  return {
    async edit_drawing(params: Params) {
      requireVolume()
      host.beforeAnswer?.()
      const action = choice(params, 'action', DRAWING_ACTIONS)
      if (!action)
        throw new Error(
          `edit_drawing needs an action: one of ${DRAWING_ACTIONS.join(', ')}.`,
        )
      const missing = () =>
        new Error(`This page's NiiVue cannot ${action} a drawing.`)
      switch (action) {
        case 'create':
          if (!view.createEmptyDrawing) throw missing()
          view.createEmptyDrawing()
          break
        case 'load': {
          if (!view.loadDrawing) throw missing()
          const url = text(params, 'url')
          if (!url) throw new Error('Loading a drawing needs a url.')
          let ok = false
          try {
            ok = await view.loadDrawing(url)
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            throw new Error(`The drawing at ${url} could not be loaded: ${why}`)
          }
          if (!ok)
            throw new Error(
              `The drawing at ${url} could not be loaded: it is not a uint8 label image voxel-aligned with the base volume, or a later drawing call replaced it.`,
            )
          break
        }
        case 'undo':
          if (!view.drawUndo) throw missing()
          view.drawUndo()
          break
        case 'close':
          if (!view.closeDrawing) throw missing()
          view.closeDrawing()
          break
        case 'fill': {
          if (!view.drawShapeFill) throw missing()
          const shape = choice(params, 'shape', Object.keys(FILL_SHAPES))
          if (!shape)
            throw new Error(
              `Filling needs a shape: one of ${Object.keys(FILL_SHAPES).join(', ')}.`,
            )
          const plane = sliceType(params, 'slice') ?? SLICE_TYPES.axial
          if (plane > SLICE_TYPES.sagittal)
            throw new Error(
              'A fill lies in an axial, coronal or sagittal slice.',
            )
          const filled = view.drawShapeFill(
            FILL_SHAPES[shape as keyof typeof FILL_SHAPES],
            point(params, 'start_mm'),
            point(params, 'end_mm'),
            plane,
          )
          if (!filled)
            throw new Error(
              'There is no drawing to fill. Create or load one first.',
            )
          break
        }
        case 'svg': {
          if (!view.drawingToSVG)
            throw new Error("This page's NiiVue cannot trace a drawing as SVG.")
          const svg = view.drawingToSVG(
            sliceType(params, 'slice'),
            integer(params, 'slice_index'),
          )
          if (svg === null) throw new Error('There is no drawing to trace.')
          return { action, svg }
        }
      }
      view.drawScene()
      return { action }
    },

    list_annotations(params: Params) {
      host.beforeAnswer?.()
      const all = annotations()
      const full = flag(params, 'polygons') ?? false
      const out: Record<string, unknown> = {
        annotations: all.map((a) => describeAnnotation(a, full)),
        unit: worldUnit(view),
        ...(view.selectedAnnotation === undefined
          ? {}
          : { selected: view.selectedAnnotation }),
        ...(view.annotationStyle === undefined
          ? {}
          : { style: view.annotationStyle }),
      }
      if (flag(params, 'json')) {
        if (!view.getAnnotationsJSON)
          throw new Error(
            "This page's NiiVue cannot give its annotations as JSON.",
          )
        out.json = view.getAnnotationsJSON()
      }
      if (flag(params, 'svg')) {
        if (!view.annotationsToSVG)
          throw new Error(
            "This page's NiiVue cannot trace its annotations as SVG.",
          )
        out.svg = view.annotationsToSVG(
          sliceType(params, 'slice'),
          number(params, 'slice_position'),
        )
      }
      return out
    },

    edit_annotations(params: Params) {
      host.beforeAnswer?.()
      const action = choice(params, 'action', ANNOTATION_ACTIONS)
      if (!action)
        throw new Error(
          `edit_annotations needs an action: one of ${ANNOTATION_ACTIONS.join(', ')}.`,
        )
      const missing = () =>
        new Error(
          `This page's NiiVue cannot ${action.replace('_', ' ')} an annotation.`,
        )
      const id = text(params, 'id')
      const needId = () => {
        if (!id) throw new Error(`Action ${action} needs the annotation's id.`)
        if (!annotations().some((a) => a.id === id))
          throw new Error(`There is no annotation with the id "${id}".`)
        return id
      }
      switch (action) {
        case 'add': {
          if (!view.addAnnotation) throw missing()
          const given = record(params, 'annotation')
          if (!given)
            throw new Error(
              'Adding needs annotation: a NiiVue VectorAnnotation as JSON.',
            )
          const made = given as Record<string, unknown>
          const { id: madeId, sliceType, slicePosition, polygons } = made
          if (
            typeof madeId !== 'string' ||
            !Array.isArray(polygons) ||
            polygons.length === 0 ||
            typeof sliceType !== 'number' ||
            typeof slicePosition !== 'number'
          )
            throw new Error(
              'annotation needs at least id, sliceType, slicePosition and polygons.',
            )
          view.addAnnotation({
            ...made,
            id: madeId,
            sliceType,
            slicePosition,
            label: typeof made.label === 'number' ? made.label : 1,
            group: typeof made.group === 'string' ? made.group : 'default',
            style: styleFrom(made.style),
            polygons: polygons.map(polygonFrom),
          })
          break
        }
        case 'remove': {
          const ids = strings(params, 'ids')
          const isUndoable = flag(params, 'is_undoable') ?? false
          if (!ids) {
            if (!view.removeAnnotation) throw missing()
            view.removeAnnotation(needId(), isUndoable)
            break
          }
          if (!view.removeAnnotations) throw missing()
          const unknown = ids.find(
            (i) => !annotations().some((a) => a.id === i),
          )
          if (unknown !== undefined)
            throw new Error(`There is no annotation with the id "${unknown}".`)
          view.removeAnnotations(ids, isUndoable)
          break
        }
        case 'clear':
          if (!view.clearAnnotations) throw missing()
          view.clearAnnotations()
          break
        case 'select':
          if (!view.selectAnnotation) throw missing()
          view.selectAnnotation(id === undefined ? null : needId())
          break
        case 'set_text': {
          if (!view.setAnnotationText) throw missing()
          const label = params?.text
          if (typeof label !== 'string') throw new Error('set_text needs text.')
          view.setAnnotationText(needId(), label)
          break
        }
        case 'undo':
          if (!view.annotationUndo) throw missing()
          view.annotationUndo()
          break
        case 'redo':
          if (!view.annotationRedo) throw missing()
          view.annotationRedo()
          break
        case 'load': {
          if (!view.loadAnnotationsJSON) throw missing()
          const json = params?.json
          if (typeof json !== 'string' || !json.trim())
            throw new Error(
              'Loading needs json: the annotations as list_annotations gives them.',
            )
          view.loadAnnotationsJSON(json)
          break
        }
        case 'set_style': {
          if (view.annotationStyle === undefined)
            throw new Error(
              "This page's NiiVue has no style for the annotations drawn by hand.",
            )
          const given = record(params, 'style')
          if (!given)
            throw new Error(
              'set_style needs style: {fillColor, strokeColor, strokeWidth}, any of them.',
            )
          // Over the current style, so a field left out keeps its value.
          view.annotationStyle = styleFrom({
            ...view.annotationStyle,
            ...given,
          })
          break
        }
      }
      view.drawScene()
      return {
        action,
        ...(action === 'set_style' ? { style: view.annotationStyle } : {}),
        ...(id ? { id } : {}),
        count: annotations().length,
        ...(view.selectedAnnotation === undefined
          ? {}
          : { selected: view.selectedAnnotation }),
      }
    },

    set_boxes(params: Params) {
      host.beforeAnswer?.()
      if (view.focusBox === undefined || view.lodBoxes === undefined)
        throw new Error(
          "This page's NiiVue cannot outline boxes on the render.",
        )
      const focus = params?.focus
      const list = params?.boxes
      if (focus === undefined && list === undefined)
        throw new Error(
          'set_boxes needs focus, boxes, or both; null takes either down.',
        )
      if (list !== undefined && list !== null && !Array.isArray(list))
        throw new Error('boxes must be a list of boxes.')
      if (Array.isArray(list) && list.length > MAX_BOXES)
        throw new Error(`At most ${MAX_BOXES} boxes at once.`)
      // Every box is read before NiiVue is touched, so a refused call
      // leaves the render as it was.
      const one = focus ? boxFrom(focus, 'focus') : null
      const many = Array.isArray(list)
        ? list.map((b, i) => boxFrom(b, `boxes[${i}]`))
        : null
      if (focus !== undefined) view.focusBox = one
      if (list !== undefined) view.lodBoxes = many?.length ? many : null
      view.drawScene()
      return {
        focus: view.focusBox,
        boxes: view.lodBoxes?.length ?? 0,
        unit: worldUnit(view),
      }
    },

    set_plane_outlines(params: Params) {
      host.beforeAnswer?.()
      if (view.planeOutlines === undefined)
        throw new Error("This page's NiiVue cannot outline rectangles.")
      const list = params?.outlines ?? []
      if (!Array.isArray(list))
        throw new Error('outlines must be a list of rectangles, or null.')
      if (list.length > MAX_PLANE_OUTLINES)
        throw new Error(`At most ${MAX_PLANE_OUTLINES} outlines at once.`)
      // Every outline is read before NiiVue is touched, so a refused call
      // leaves the scene as it was. NiiVue's setter redraws.
      view.planeOutlines = list.map((o, i) => outlineFrom(o, `outlines[${i}]`))
      return { outlines: view.planeOutlines.length }
    },

    list_slide_annotations(params: Params) {
      host.beforeAnswer?.()
      const full = flag(params, 'points') ?? false
      return {
        annotations: slideAnnotations()
          .list()
          .map((a) => describeSlideAnnotation(a, full)),
      }
    },

    edit_slide_annotations(params: Params) {
      host.beforeAnswer?.()
      const store = slideAnnotations()
      const action = choice(params, 'action', SLIDE_ANNOTATION_ACTIONS)
      if (!action)
        throw new Error(
          `edit_slide_annotations needs an action: one of ${SLIDE_ANNOTATION_ACTIONS.join(', ')}.`,
        )
      const label = params?.label
      if (label !== undefined && typeof label !== 'string')
        throw new Error('label must be text.')
      const id = text(params, 'id')
      const out: Record<string, unknown> = {}
      switch (action) {
        case 'add': {
          const tool = choice(params, 'tool', SLIDE_ANNOTATION_TOOLS)
          if (!tool)
            throw new Error(
              `Adding needs tool: one of ${SLIDE_ANNOTATION_TOOLS.join(', ')}.`,
            )
          const made = store.add(tool, slidePoints(params), label)
          if (!made) throw new Error(`Too few points for a ${tool}.`)
          out.annotation = describeSlideAnnotation(made, false)
          break
        }
        case 'remove':
        case 'set_label': {
          if (!id)
            throw new Error(`Action ${action} needs the annotation's id.`)
          if (action === 'set_label' && label === undefined)
            throw new Error('set_label needs label.')
          const found =
            action === 'remove'
              ? store.remove(id)
              : store.setLabel(id, label as string)
          if (!found)
            throw new Error(`There is no slide annotation with the id "${id}".`)
          break
        }
        case 'clear':
          store.clear()
      }
      out.count = store.list().length
      return out
    },

    list_measurements() {
      host.beforeAnswer?.()
      return {
        measurements: measurements().map(describeMeasurement),
        unit: worldUnit(view),
      }
    },

    edit_measurements(params: Params) {
      host.beforeAnswer?.()
      const action = choice(params, 'action', MEASUREMENT_ACTIONS)
      if (!action)
        throw new Error(
          `edit_measurements needs an action: one of ${MEASUREMENT_ACTIONS.join(', ')}.`,
        )
      const missing = () =>
        new Error(
          `This page's NiiVue cannot ${action.replace('_', ' ')} measurements.`,
        )
      let index: number | undefined
      switch (action) {
        case 'add': {
          if (!view.addMeasurement) throw missing()
          const start = point(params, 'start_mm')
          const end = point(params, 'end_mm')
          const options: MeasurementOptions = {}
          const slice = sliceType(params, 'slice')
          if (slice !== undefined) options.sliceType = slice
          const sliceIndex = integer(params, 'slice_index')
          if (sliceIndex !== undefined) options.sliceIndex = sliceIndex
          const position = number(params, 'slice_position')
          if (position !== undefined) options.slicePosition = position
          index = view.addMeasurement(start, end, options)
          break
        }
        case 'remove': {
          if (!view.removeMeasurement) throw missing()
          index = integer(params, 'index')
          if (index === undefined)
            throw new Error(
              'Removing needs index, as list_measurements counts them.',
            )
          if (!measurements()[index])
            throw new Error(
              `There is no measurement ${index}: ${measurements().length} kept, numbered from 0.`,
            )
          view.removeMeasurement(index)
          break
        }
        case 'clear':
          if (!view.clearMeasurements) throw missing()
          view.clearMeasurements()
          break
        case 'clear_angles':
          if (!view.clearAngles) throw missing()
          view.clearAngles()
          break
        case 'clear_distances':
          if (!view.clearDistanceMeasurements) throw missing()
          view.clearDistanceMeasurements()
          break
      }
      view.drawScene()
      const kept = view.getMeasurements ? view.getMeasurements() : []
      return {
        action,
        ...(index === undefined ? {} : { index }),
        ...(action === 'add' && index !== undefined && kept[index]
          ? { measurement: describeMeasurement(kept[index], index) }
          : {}),
        measurements: kept.map(describeMeasurement),
        unit: worldUnit(view),
      }
    },
  }
}

/** A point as NiiVue keeps it, from `[x, y]` or `{x, y}`, in mm on the slice plane. */
function pointFrom(given: unknown): { x: number; y: number } {
  const pair = Array.isArray(given)
    ? given
    : given && typeof given === 'object'
      ? [(given as { x?: unknown }).x, (given as { y?: unknown }).y]
      : []
  const [x, y] = pair
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    throw new Error(
      'Each polygon point must be [x, y] or {x, y}, in mm on the slice plane.',
    )
  return { x, y }
}

const RED: [number, number, number, number] = [1, 0, 0, 1]

/**
 * An annotation's style as NiiVue needs it, every field present. NiiVue 1.0
 * reads fillColor, strokeColor and strokeWidth at draw time with no defaults
 * of its own, so a missing one would draw nothing; the defaults here are
 * NiiVue's for a drawn annotation, and a fill given no colour takes the
 * stroke's at a third of its alpha.
 */
function styleFrom(given: unknown): Record<string, unknown> {
  const style =
    given && typeof given === 'object' ? (given as Record<string, unknown>) : {}
  const colour = (
    key: string,
  ): [number, number, number, number] | undefined => {
    const value = style[key]
    if (value === undefined) return undefined
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value.some((n) => typeof n !== 'number' || !(n >= 0 && n <= 1))
    )
      throw new Error(`style.${key} must be [r, g, b, a], each 0 to 1.`)
    return value as [number, number, number, number]
  }
  const strokeColor = colour('strokeColor') ?? RED
  const fillColor = colour('fillColor') ?? [
    strokeColor[0],
    strokeColor[1],
    strokeColor[2],
    strokeColor[3] * 0.3,
  ]
  const strokeWidth = style.strokeWidth ?? 2
  if (
    typeof strokeWidth !== 'number' ||
    !(strokeWidth >= 0) ||
    !Number.isFinite(strokeWidth)
  )
    throw new Error('style.strokeWidth must be a number of pixels, 0 or more.')
  // Only what NiiVue reads: anything else would ride along into its saved
  // annotations unchecked.
  return { fillColor, strokeColor, strokeWidth }
}

/**
 * A polygon as NiiVue keeps it, `{outer, holes}`, from that or from a bare
 * list of points. NiiVue 1.0 takes what it is given and reads `outer` and
 * `holes` at draw time, so a point list handed straight through would
 * break the render and the svg trace.
 */
function polygonFrom(given: unknown): {
  outer: { x: number; y: number }[]
  holes: { x: number; y: number }[][]
} {
  const shaped =
    given && typeof given === 'object' && !Array.isArray(given)
      ? (given as { outer?: unknown; holes?: unknown })
      : undefined
  const outer = shaped ? shaped.outer : given
  if (!Array.isArray(outer) || outer.length < 3)
    throw new Error(
      'Each polygon needs at least three points: a list of them, or {outer, holes}.',
    )
  const holes = shaped?.holes ?? []
  if (!Array.isArray(holes) || holes.some((h) => !Array.isArray(h)))
    throw new Error("A polygon's holes must be a list of point lists.")
  return {
    outer: outer.map(pointFrom),
    holes: holes.map((hole: unknown[]) => hole.map(pointFrom)),
  }
}
