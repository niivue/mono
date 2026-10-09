/**
 * The tools on meshes and their layers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { MESH_ARG, named, registerSimple, rgba } from './args'
import { TAB_ARG, type ToolContext } from './context'

/** The fields a mesh layer takes, on loading and on a change alike. */
const LAYER_FIELDS = {
  colormap: z.string().optional().describe('A NiiVue colormap name.'),
  colormap_negative: z
    .string()
    .optional()
    .describe('The colormap for values below zero, when they get their own.'),
  cal_min: z.number().optional().describe('The low end of the display window.'),
  cal_max: z
    .number()
    .optional()
    .describe('The high end of the display window.'),
  cal_min_neg: z
    .number()
    .optional()
    .describe('The low end of the negative window.'),
  cal_max_neg: z
    .number()
    .optional()
    .describe('The high end of the negative window.'),
  opacity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('0 (hidden) to 1 (opaque).'),
  colorbar: z
    .boolean()
    .optional()
    .describe('Whether a colorbar is drawn for it.'),
  invert: z
    .boolean()
    .optional()
    .describe('Whether the colormap runs backwards.'),
  transparent_below_cal_min: z
    .boolean()
    .optional()
    .describe('Whether values under cal_min are left unpainted.'),
  additive: z
    .boolean()
    .optional()
    .describe('Whether the layer adds to the colours under it.'),
  outline_width: z
    .number()
    .min(0)
    .optional()
    .describe(
      'The width of the outline drawn round painted regions, 0 for none.',
    ),
} as const

const LAYER_ARG = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe(
    "Which layer: its index among the mesh's layers as list_meshes lists them, or its name. " +
      'The only one otherwise.',
  )

export const LAYER_SCHEMAS = {
  load_mesh: {
    ...TAB_ARG,
    url: z
      .string()
      .min(1)
      .describe('Where the mesh is: an address the page can fetch.'),
    name: z
      .string()
      .optional()
      .describe('A name for it; the file name otherwise.'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace the meshes shown instead of adding to them.'),
    opacity: z.number().min(0).max(1).optional(),
    color: rgba('The colour of the mesh:').optional(),
    shader: z
      .string()
      .optional()
      .describe('The 3D shader, as list_meshes names them.'),
    slice_shader: z
      .string()
      .optional()
      .describe('The shader for where the mesh crosses a 2D slice.'),
    visible: z.boolean().optional(),
    colorbar: z.boolean().optional(),
    legend: z.boolean().optional(),
    layers: z
      .array(
        z.object({
          url: z.string().min(1),
          name: z.string().optional(),
          ...LAYER_FIELDS,
        }),
      )
      .optional()
      .describe('Overlays on the mesh to load with it.'),
  },
  list_meshes: { ...TAB_ARG },
  set_mesh: {
    ...TAB_ARG,
    mesh: MESH_ARG.optional().describe(
      'Which mesh: its index as list_meshes lists them, or its name. The first otherwise.',
    ),
    name: z.string().optional().describe('A new name for it.'),
    opacity: z.number().min(0).max(1).optional(),
    color: rgba('The colour of the mesh:').optional(),
    shader: z
      .string()
      .optional()
      .describe('The 3D shader, as list_meshes names them.'),
    slice_shader: z.string().optional(),
    visible: z.boolean().optional(),
    colorbar: z.boolean().optional(),
    legend: z.boolean().optional(),
    tract: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'For a tract: NiiVue tract options (colormap, dither, fiberRadius, fiberLength, ' +
          'fiberDecimation, fiberGroupColormap and the rest), only what changes.',
      ),
    connectome: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'For a connectome: NiiVue connectome options, only what changes.',
      ),
  },
  remove_mesh: {
    ...TAB_ARG,
    mesh: MESH_ARG.optional(),
    all: z.boolean().optional().describe('Remove every mesh instead of one.'),
  },
  add_mesh_layer: {
    ...TAB_ARG,
    mesh: MESH_ARG.optional(),
    url: z
      .string()
      .min(1)
      .describe('Where the layer is: an address the page can fetch.'),
    name: z.string().optional(),
    ...LAYER_FIELDS,
  },
  set_mesh_layer: {
    ...TAB_ARG,
    mesh: MESH_ARG.optional(),
    layer: LAYER_ARG.optional(),
    ...LAYER_FIELDS,
    frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The frame of a 4D layer to show, counted from 0.'),
  },
  remove_mesh_layer: {
    ...TAB_ARG,
    mesh: MESH_ARG.optional(),
    layer: LAYER_ARG.optional(),
  },
} as const

export function registerLayerTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'load_mesh', {
    title: 'Load a mesh',
    description:
      'Loads a surface, tract or connectome from an address and adds it to the meshes shown, or ' +
      'replaces them with `replace`, with any layers to overlay on it. Reports the mesh and every ' +
      'mesh shown, as list_meshes does.',
    inputSchema: LAYER_SCHEMAS.load_mesh,
    lead: named('mesh', 'Loaded'),
  })

  registerSimple(server, context, 'list_meshes', {
    title: 'List the meshes',
    description:
      'Lists the meshes shown: each with its index, name, kind, how it is drawn, and its layers, ' +
      'plus the shaders a mesh can be drawn with.',
    inputSchema: LAYER_SCHEMAS.list_meshes,
    readOnly: true,
  })

  registerSimple(server, context, 'set_mesh', {
    title: 'Change how a mesh is drawn',
    description:
      'Changes how one mesh is drawn, leaving the rest as it is: its opacity, colour, shader, ' +
      'visibility, colorbar and legend, or the options of a tract or connectome. Reports the mesh afterwards.',
    inputSchema: LAYER_SCHEMAS.set_mesh,
    lead: named('mesh', 'Changed'),
  })

  registerSimple(server, context, 'remove_mesh', {
    title: 'Remove a mesh',
    description:
      'Unloads one mesh, by index or name, or every mesh with `all`. Reports the meshes that remain.',
    inputSchema: LAYER_SCHEMAS.remove_mesh,
  })

  registerSimple(server, context, 'add_mesh_layer', {
    title: 'Overlay a layer on a mesh',
    description:
      'Loads a per-vertex overlay (a statistical map, a curvature, an annotation) from an address ' +
      'onto a mesh, with its colormap and window. Reports the mesh with its layers.',
    inputSchema: LAYER_SCHEMAS.add_mesh_layer,
    lead: named('mesh', 'Changed'),
  })

  registerSimple(server, context, 'set_mesh_layer', {
    title: 'Change a mesh layer',
    description:
      'Changes how one layer of a mesh is drawn: its colormap, window, opacity, and the like, or ' +
      'the frame shown of a 4D layer. Reports the mesh with its layers.',
    inputSchema: LAYER_SCHEMAS.set_mesh_layer,
    lead: named('mesh', 'Changed'),
  })

  registerSimple(server, context, 'remove_mesh_layer', {
    title: 'Remove a mesh layer',
    description:
      'Takes one layer off a mesh. Reports the mesh with the layers that remain.',
    inputSchema: LAYER_SCHEMAS.remove_mesh_layer,
    lead: named('mesh', 'Changed'),
  })
}
