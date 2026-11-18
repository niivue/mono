/**
 * The tools on what is drawn over the scene by hand: the voxel drawing,
 * the vector annotations, and the measurements.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_BOXES, MAX_PLANE_OUTLINES } from '../limits'
import { SLICE_NAMES, SLIDE_ANNOTATION_TOOLS } from '../views'
import { registerSimple, rgba, triple } from './args'
import { TAB_ARG, type ToolContext } from './context'

/** An annotation colour: NiiVue keeps all four of [r, g, b, a], each 0 to 1. */
const ANNOTATION_COLOR = z.array(z.number().min(0).max(1)).length(4)

const SLICE_ARG = z
  .enum(SLICE_NAMES)
  .optional()
  .describe('The slice orientation. The one shown otherwise.')

const BOX_ARG = z.strictObject({
  min: triple('The corner with the lowest x, y and z, in world units.'),
  max: triple('The opposite corner, in world units.'),
  color: rgba('The edge colour. A yellow otherwise.').optional(),
  thickness: z
    .number()
    .positive()
    .optional()
    .describe('The edge width in pixels. 2 otherwise.'),
})

const OUTLINE_ARG = z.strictObject({
  corners: z
    .array(triple('A corner, in world units.'))
    .length(4)
    .describe('The four corners in order around the rectangle.'),
  color: rgba('The edge colour. The crosshair colour otherwise.').optional(),
  width: z
    .number()
    .positive()
    .optional()
    .describe('The edge width in pixels on 2D slices. 2 otherwise.'),
})

export const MARK_SCHEMAS = {
  edit_drawing: {
    ...TAB_ARG,
    action: z
      .enum(['create', 'load', 'undo', 'close', 'svg', 'fill'])
      .describe(
        'create an empty drawing over the base volume, load one from a url, undo the last stroke, ' +
          'close the drawing, trace it as svg, or fill a shape in it with the pen value.',
      ),
    shape: z
      .enum(['rectangle', 'circle', 'sphere'])
      .optional()
      .describe(
        'For fill: a rectangle (start_mm and end_mm are opposite corners), or a circle or sphere ' +
          '(start_mm is the centre, end_mm a point on the edge).',
      ),
    start_mm: triple('For fill: the first point, in world units.').optional(),
    end_mm: triple('For fill: the second point, in world units.').optional(),
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
        'add one, remove one by id (or several by ids), clear all, select one by id (none without an id), set the ' +
          'text of one, undo, redo, load a set from json, or set the style annotations drawn ' +
          'by hand take.',
      ),
    id: z
      .string()
      .min(1)
      .optional()
      .describe('The annotation, as list_annotations gives ids.'),
    ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('For remove: several annotations at once, in place of id.'),
    is_undoable: z
      .boolean()
      .optional()
      .describe('For remove: record a step undo can restore.'),
    text: z.string().optional().describe('For set_text: the text.'),
    annotation: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'For add: a NiiVue VectorAnnotation as JSON, with id, sliceType (0 axial, 1 coronal, ' +
          '2 sagittal), slicePosition (where the slice is in world units along its own axis: the ' +
          "crosshair's z for an axial slice, as where_am_i reports it) and polygons; and, if " +
          'wanted, label (a number), group, text and style ({fillColor, strokeColor} as ' +
          '[r, g, b, a] 0 to 1, strokeWidth in pixels; red otherwise). Each polygon is a list ' +
          'of at least three [x, y] points in world units on the slice plane (axial x and y, coronal x ' +
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
        fillColor: ANNOTATION_COLOR.optional(),
        strokeColor: ANNOTATION_COLOR.optional(),
        strokeWidth: z.number().min(0).optional(),
      })
      .optional()
      .describe(
        'For set_style: fillColor and strokeColor as [r, g, b, a] 0 to 1, strokeWidth in ' +
          'pixels. A field left out keeps its value; list_annotations reports the style.',
      ),
  },
  list_slide_annotations: {
    ...TAB_ARG,
    points: z
      .boolean()
      .optional()
      .describe("Include each annotation's points. Only its stats otherwise."),
  },
  edit_slide_annotations: {
    ...TAB_ARG,
    action: z
      .enum(['add', 'remove', 'set_label', 'clear'])
      .describe(
        'add one, remove one by id, set the label of one, or clear all.',
      ),
    tool: z
      .enum(SLIDE_ANNOTATION_TOOLS)
      .optional()
      .describe(
        'For add: the shape. point takes 1 point; line [start, end]; rectangle and ellipse ' +
          'two opposite corners; circle [centre, rim]; polygon and freehand (closed, 3 or more) ' +
          'and freehandLine (open, 2 or more) their vertices.',
      ),
    points: z
      .array(z.tuple([z.number(), z.number()]))
      .min(1)
      .optional()
      .describe('For add: [x, y] points in slide base (level 0) pixels.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'For remove and set_label: the annotation, as list_slide_annotations gives ids.',
      ),
    label: z.string().optional().describe('For add and set_label: the label.'),
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
      'For add: where the measurement starts, in world units.',
    ).optional(),
    end_mm: triple('For add: where it ends, in world units.').optional(),
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
  set_plane_outlines: {
    ...TAB_ARG,
    outlines: z
      .array(OUTLINE_ARG)
      .max(MAX_PLANE_OUTLINES)
      .nullable()
      .describe(
        'Rectangles to outline, such as the field of view of a linked slide viewer. Replaces ' +
          'the set; null or an empty list takes it down.',
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
      'address, undoes the last stroke, closes it, traces a slice of it as SVG, or fills a ' +
      'rectangle, circle or sphere with the pen value as one undo step (a rectangle or circle in ' +
      'the axial plane unless slice says otherwise). Freehand strokes are made by hand on the ' +
      'page; the pen settings are in set_options.',
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

  registerSimple(server, context, 'list_slide_annotations', {
    title: 'List the slide annotations',
    description:
      "Lists the annotations on the page's whole-slide viewer, each with its id, tool, label and " +
      'stats (length, area and perimeter in mm, or base pixels without a pixel spacing); with ' +
      'their points when asked. These are not the slice annotations of list_annotations.',
    inputSchema: MARK_SCHEMAS.list_slide_annotations,
    readOnly: true,
  })

  registerSimple(server, context, 'edit_slide_annotations', {
    title: 'Edit the slide annotations',
    description:
      "Adds an annotation to the page's whole-slide viewer (a point, line, rectangle, ellipse, " +
      'circle, polygon, freehand shape or freehand line, in slide base pixels), removes one or ' +
      'sets its label by id, or clears them. Reports how many there are afterwards.',
    inputSchema: MARK_SCHEMAS.edit_slide_annotations,
  })

  registerSimple(server, context, 'list_measurements', {
    title: 'List the measurements',
    description:
      'Lists the distance measurements drawn on the slices: each with its ends in world units, its length, and its slice.',
    inputSchema: MARK_SCHEMAS.list_measurements,
    readOnly: true,
  })

  registerSimple(server, context, 'edit_measurements', {
    title: 'Edit the measurements',
    description:
      'Adds a distance measurement between two points in world units, removes one by index, or ' +
      'clears them: all, the angles, or the distances. Reports the measurements afterwards.',
    inputSchema: MARK_SCHEMAS.edit_measurements,
  })

  registerSimple(server, context, 'set_boxes', {
    title: 'Outline boxes on the render',
    description:
      'Outlines boxes on the 3D render (not the slices), each from its two corners in ' +
      'world units: one focus box, a set of boxes, or both. They are not saved with the ' +
      'document. Reports the focus box and how many boxes the set has.',
    inputSchema: MARK_SCHEMAS.set_boxes,
  })

  registerSimple(server, context, 'set_plane_outlines', {
    title: 'Outline rectangles in the scene',
    description:
      'Outlines rectangles given by four corners in world units: on a 2D slice a rectangle ' +
      'lies in as the whole rectangle, on one that cuts it as the crossing segment, on one ' +
      'it misses not at all; on the 3D render as a thin frame. They are not saved with the ' +
      'document. Reports how many are shown.',
    inputSchema: MARK_SCHEMAS.set_plane_outlines,
  })
}
