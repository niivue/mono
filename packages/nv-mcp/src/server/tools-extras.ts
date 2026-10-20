/**
 * The tools on the canvas as a whole: its 2D pan and zoom, mapping
 * points between pixels, millimetres and voxels, the slide plane of a
 * whole-slide image, the statistics of chunked streaming, and saving or
 * loading the scene and its parts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { MESH_ARG, registerSimple, triple, VOLUME_ARG } from './args'
import { TAB_ARG, type ToolContext } from './context'

export const EXTRA_SCHEMAS = {
  set_viewport: {
    ...TAB_ARG,
    pan: z
      .array(z.number())
      .length(2)
      .optional()
      .describe('The 2D pan, [x, y] in pixels.'),
    zoom: z.number().positive().optional().describe('The 2D zoom, 1 for none.'),
    bounds: z
      .array(z.number().min(0).max(1))
      .length(4)
      .nullable()
      .optional()
      .describe(
        'Confine drawing to [x1, y1, x2, y2] as fractions of the canvas; null lifts the bounds.',
      ),
    reset: z
      .boolean()
      .optional()
      .describe('Put the pan and zoom back to their defaults.'),
  },
  map_point: {
    ...TAB_ARG,
    canvas: z
      .array(z.number())
      .length(2)
      .optional()
      .describe(
        'A pixel on the canvas, [x, y]: says what tile is there and where it is in millimetres.',
      ),
    mm: triple(
      'A point in millimetres: says where it lands on the canvas.',
    ).optional(),
    vox: triple(
      'A voxel of the base volume, [i, j, k]: says where it is in millimetres and on the canvas.',
    ).optional(),
  },
  set_slide: {
    ...TAB_ARG,
    level: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        'The resolution level of the slide plane to show; null lets NiiVue choose.',
      ),
    clear_plane: z.boolean().optional().describe('Take the slide plane away.'),
    drawing: z
      .enum(['create', 'clear', 'undo', 'end'])
      .optional()
      .describe(
        'Work on the slide drawing: create one, clear it, undo a stroke, or end the current stroke.',
      ),
    max_raster: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('For create: the widest raster the drawing is kept at.'),
  },
  chunk_stats: {
    ...TAB_ARG,
    reset_timing: z
      .boolean()
      .optional()
      .describe('Reset the timing counters after reading them.'),
    rebake: z
      .boolean()
      .optional()
      .describe('Rebake the chunked overlays first.'),
  },
  save: {
    ...TAB_ARG,
    what: z
      .enum(['document', 'volume', 'mesh', 'bitmap', 'drawing'])
      .describe(
        'document: the whole scene as a NiiVue document; volume: one volume as NIfTI; mesh: one ' +
          'mesh; bitmap: the canvas as a PNG; drawing: the drawing as NIfTI.',
      ),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe('What the file is called. A default otherwise.'),
    volume: VOLUME_ARG.optional().describe(
      'For volume: which one. The base otherwise.',
    ),
    drawing: z
      .boolean()
      .optional()
      .describe('For volume: save the drawing over it instead.'),
    mesh: MESH_ARG.optional().describe(
      'For mesh: which one. The first otherwise.',
    ),
    quality: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('For bitmap: the image quality.'),
    format: z
      .enum(['json', 'cbor'])
      .optional()
      .describe('For document: the encoding. json otherwise.'),
    settings_never_saved: z
      .array(z.string())
      .optional()
      .describe('For document: settings to leave out.'),
    settings_always_saved: z
      .array(z.string())
      .optional()
      .describe('For document: settings to put in even at their defaults.'),
  },
  load_document: {
    ...TAB_ARG,
    url: z.string().min(1).describe('Where the NiiVue document is.'),
    fill: z
      .enum(['default', 'current'])
      .optional()
      .describe(
        'What fills the settings the document leaves out: the defaults, or what the page has now.',
      ),
  },
} as const

export function registerExtraTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'set_viewport', {
    title: 'Pan and zoom the canvas',
    description:
      'Pans and zooms the 2D slices, confines drawing to part of the canvas, or resets both. Reports the viewport afterwards.',
    inputSchema: EXTRA_SCHEMAS.set_viewport,
  })

  registerSimple(server, context, 'map_point', {
    title: 'Map a point',
    description:
      'Maps a point between the canvas, millimetres and voxels: a pixel says what tile is under ' +
      'it and where that is in the volume; a point in millimetres or a voxel says where it lands ' +
      'on the canvas.',
    inputSchema: EXTRA_SCHEMAS.map_point,
    readOnly: true,
  })

  registerSimple(server, context, 'set_slide', {
    title: 'Work the slide plane',
    description:
      'For a whole-slide image: picks the resolution level of the slide plane, clears the plane, ' +
      'or works on the slide drawing.',
    inputSchema: EXTRA_SCHEMAS.set_slide,
  })

  registerSimple(server, context, 'chunk_stats', {
    title: 'Chunk streaming statistics',
    description:
      'Reports how the chunked volumes stream: what is loading, the timing so far, and the ' +
      'level-of-detail compensation; can reset the timing or rebake the chunked overlays.',
    inputSchema: EXTRA_SCHEMAS.chunk_stats,
  })

  registerSimple(server, context, 'save', {
    title: 'Save a file',
    description:
      "Has the page save a file the browser's way, as a download: the whole scene as a NiiVue " +
      'document, one volume or the drawing as NIfTI, one mesh, or the canvas as a PNG.',
    inputSchema: EXTRA_SCHEMAS.save,
  })

  registerSimple(server, context, 'load_document', {
    title: 'Load a document',
    description:
      'Loads a NiiVue document from an address: its volumes, meshes, drawing and settings replace ' +
      'the scene. Reports what is loaded afterwards.',
    inputSchema: EXTRA_SCHEMAS.load_document,
  })
}
