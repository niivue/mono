/**
 * The tools on what is drawn over the scene by hand: the voxel drawing,
 * the vector annotations, and the measurements.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { SLICE_NAMES } from '../views'
import { registerSimple, triple } from './args'
import { TAB_ARG, type ToolContext } from './context'

const SLICE_ARG = z
  .enum(SLICE_NAMES)
  .optional()
  .describe('The slice orientation. The one shown otherwise.')

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
      ])
      .describe(
        'add one, remove one by id, clear all, select one by id (none without an id), set the ' +
          'text of one, undo, redo, or load a set from json.',
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
        'For add: a NiiVue VectorAnnotation as JSON, with id, label, group, sliceType, ' +
          'slicePosition, polygons (each a list of [x, y] points in slice fractions) and style.',
      ),
    json: z
      .string()
      .optional()
      .describe(
        'For load: the annotations as list_annotations gives them with json.',
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
      'undoes or redoes, or loads a set from JSON. Reports how many there are afterwards.',
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
}
