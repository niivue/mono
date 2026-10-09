/**
 * What is drawn over the scene by hand: the voxel drawing, the vector
 * annotations, and the distance measurements. Each has a listing tool
 * and an editing tool that takes an `action`, so the schema stays one
 * per kind rather than one per verb.
 */

import { nameFor, SLICE_TYPES } from '../views'
import {
  choice,
  flag,
  integer,
  number,
  type Params,
  point,
  record,
  text,
} from './params'
import type {
  Annotation,
  Handlers,
  Measurement,
  MeasurementOptions,
  NiiVueHost,
} from './view'

const DRAWING_ACTIONS = ['create', 'load', 'undo', 'close', 'svg'] as const
const ANNOTATION_ACTIONS = [
  'add',
  'remove',
  'clear',
  'select',
  'set_text',
  'undo',
  'redo',
  'load',
] as const
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
              `The drawing at ${url} could not be loaded: it does not fit the base volume.`,
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
        ...(view.selectedAnnotation === undefined
          ? {}
          : { selected: view.selectedAnnotation }),
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
          const made = given as unknown as Annotation
          if (
            typeof made.id !== 'string' ||
            !Array.isArray(made.polygons) ||
            typeof made.sliceType !== 'number'
          )
            throw new Error(
              'annotation needs at least id, sliceType, slicePosition, polygons and style.',
            )
          view.addAnnotation(made)
          break
        }
        case 'remove':
          if (!view.removeAnnotation) throw missing()
          view.removeAnnotation(needId())
          break
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
      }
      view.drawScene()
      return {
        action,
        ...(id ? { id } : {}),
        count: annotations().length,
        ...(view.selectedAnnotation === undefined
          ? {}
          : { selected: view.selectedAnnotation }),
      }
    },

    list_measurements() {
      host.beforeAnswer?.()
      return { measurements: measurements().map(describeMeasurement) }
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
      }
    },
  }
}
