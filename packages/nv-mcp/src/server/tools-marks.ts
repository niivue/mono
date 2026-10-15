/**
 * The tools on what is drawn over the scene by hand: the voxel drawing,
 * the vector annotations, and the measurements.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { SLICE_NAMES } from '../views'
import { registerSimple, rgba, triple } from './args'
import { TAB_ARG, type ToolContext } from './context'

const SLICE_ARG = z
  .enum(SLICE_NAMES)
  .optional()
  .describe('The slice orientation. The one shown otherwise.')

/** The most boxes one call outlines; the page holds the same limit. */
const MAX_BOXES = 1000

const BOX_ARG = z.strictObject({
  min: triple('The corner with the lowest x, y and z, in millimetres.'),
  max: triple('The opposite corner, in millimetres.'),
  color: rgba('The edge colour. A yellow otherwise.').optional(),
  thickness: z
    .number()
    .positive()
    .optional()
    .describe('The edge width in pixels. 2 otherwise.'),
})

export const MARK_SCHEMAS = {
  edit_drawing: {
    ...TAB_ARG,
    action: z
      .enum(['create', 'load', 'undo', 'close', 'svg'])
      .describe(
        'create an empty drawing over the base volume, load one from a url, undo the last stroke, ' +
          'close the drawing, or trace it as svg.',
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe('For load: where the drawing is.'),
    slice: SLICE_ARG,
    slice_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'For svg: which slice to trace. The crosshair slice otherwise.',
      ),
  },
  list_annotations: {
    ...TAB_ARG,
    polygons: z
      .boolean()
      .optional()
      .describe(
        "Include each annotation's polygons. Only their count otherwise.",
      ),
    json: z
      .boolean()
      .optional()
      .describe(
        'Include the annotations as the JSON edit_annotations can load.',
      ),
    svg: z
      .boolean()
      .optional()
      .describe('Include the annotations traced as SVG.'),
    slice: SLICE_ARG,
    slice_position: z
      .number()
      .optional()
      .describe(
        'For svg: the slice position, as a fraction. The crosshair otherwise.',
      ),
  },
  edit_annotations: {
    ...TAB_ARG,
    action: z
      .enum([
        'add',
        'remove',
        'clear',
        'select',
        'set_text',
        'undo',
        'redo',
        'load',
        'set_style',
      ])
      .describe(
        'add one, remove one by id, clear all, select one by id (none without an id), set the ' +
          'text of one, undo, redo, load a set from json, or set the style annotations drawn ' +
          'by hand take.',
      ),
    id: z
      .string()
      .min(1)
      .optional()
      .describe('The annotation, as list_annotations gives ids.'),
    text: z.string().optional().describe('For set_text: the text.'),
    annotation: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'For add: a NiiVue VectorAnnotation as JSON, with id, sliceType (0 axial, 1 coronal, ' +
          '2 sagittal), slicePosition (where the slice is in mm along its own axis: the ' +
          "crosshair's z for an axial slice, as where_am_i reports it) and polygons; and, if " +
          'wanted, label (a number), group, text and style ({fillColor, strokeColor} as ' +
          '[r, g, b, a] 0 to 1, strokeWidth in pixels; red otherwise). Each polygon is a list ' +
          'of at least three [x, y] points in mm on the slice plane (axial x and y, coronal x ' +
          'and z, sagittal y and z), or {outer, holes} with such lists.',
      ),
    json: z
      .string()
      .optional()
      .describe(
        'For load: the annotations as list_annotations gives them with json.',
      ),
    style: z
      .strictObject({
        fillColor: z.array(z.number().min(0).max(1)).length(4).optional(),
        strokeColor: z.array(z.number().min(0).max(1)).length(4).optional(),
        strokeWidth: z.number().min(0).optional(),
      })
      .optional()
      .describe(
        'For set_style: fillColor and strokeColor as [r, g, b, a] 0 to 1, strokeWidth in ' +
          'pixels. A field left out keeps its value; list_annotations reports the style.',
      ),
  },
  list_measurements: { ...TAB_ARG },
  edit_measurements: {
    ...TAB_ARG,
    action: z
      .enum(['add', 'remove', 'clear', 'clear_angles', 'clear_distances'])
      .describe(
        'add a distance between two points, remove one by index, or clear all, the angles or the distances.',
      ),
    start_mm: triple(
      'For add: where the measurement starts, in millimetres.',
    ).optional(),
    end_mm: triple('For add: where it ends, in millimetres.').optional(),
    slice: SLICE_ARG,
    slice_index: z.number().int().min(0).optional(),
    slice_position: z.number().optional(),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'For remove: the measurement, as list_measurements counts them.',
      ),
  },
  set_boxes: {
    ...TAB_ARG,
    focus: BOX_ARG.nullable()
      .optional()
      .describe(
        'One box to outline, such as a region in focus. null takes it down.',
      ),
    boxes: z
      .array(BOX_ARG)
      .max(MAX_BOXES)
      .nullable()
      .optional()
      .describe(
        'A set of boxes to outline, such as one per block of a chunked volume. Replaces the ' +
          'set; null or an empty list takes it down.',
      ),
  },
} as const

export function registerMarkTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'edit_drawing', {
    title: 'Edit the drawing',
    description:
      'Works on the voxel drawing over the base volume: creates an empty one, loads one from an ' +
      'address, undoes the last stroke, closes it, or traces a slice of it as SVG. Pen strokes ' +
      'themselves are made by hand on the page; the pen settings are in set_options.',
    inputSchema: MARK_SCHEMAS.edit_drawing,
  })

  registerSimple(server, context, 'list_annotations', {
    title: 'List the annotations',
    description:
      'Lists the vector annotations drawn on the slices, each with its id, label, group, slice ' +
      'and style, and which is selected; with their polygons, as JSON, or traced as SVG when asked.',
    inputSchema: MARK_SCHEMAS.list_annotations,
    readOnly: true,
  })

  registerSimple(server, context, 'edit_annotations', {
    title: 'Edit the annotations',
    description:
      'Adds a vector annotation, removes or selects one by id, sets its text, clears them all, ' +
      'undoes or redoes, loads a set from JSON, or sets the style annotations drawn by hand ' +
      'take. Reports how many there are afterwards.',
    inputSchema: MARK_SCHEMAS.edit_annotations,
  })

  registerSimple(server, context, 'list_measurements', {
    title: 'List the measurements',
    description:
      'Lists the distance measurements drawn on the slices: each with its ends in millimetres, its length, and its slice.',
    inputSchema: MARK_SCHEMAS.list_measurements,
    readOnly: true,
  })

  registerSimple(server, context, 'edit_measurements', {
    title: 'Edit the measurements',
    description:
      'Adds a distance measurement between two points in millimetres, removes one by index, or ' +
      'clears them: all, the angles, or the distances. Reports the measurements afterwards.',
    inputSchema: MARK_SCHEMAS.edit_measurements,
  })

  registerSimple(server, context, 'set_boxes', {
    title: 'Outline boxes on the render',
    description:
      'Outlines boxes on the 3D render (not the slices), each from its two corners in ' +
      'millimetres: one focus box, a set of boxes, or both. They are not saved with the ' +
      'document. Reports the focus box and how many boxes the set has.',
    inputSchema: MARK_SCHEMAS.set_boxes,
  })
}
