/**
 * The tools on the canvas as a whole: its 2D pan and zoom, mapping
 * points between pixels, world units and voxels, the slide plane of a
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
        'A pixel on the canvas, [x, y]: says what tile is there and where it is in world units.',
      ),
    mm: triple(
      'A point in world units: says where it lands on the canvas.',
    ).optional(),
    vox: triple(
      'A voxel of the base volume, [i, j, k]: says where it is in world units and on the canvas.',
    ).optional(),
  },
  pick_point: {
    ...TAB_ARG,
    canvas: z
      .array(z.number())
      .length(2)
      .describe(
        "A canvas pixel, [x, y]: the drawing buffer's (device) pixels, as map_point and screenshot's origin and region count them.",
      ),
    move_crosshair: z
      .boolean()
      .optional()
      .describe(
        'Move the crosshair to the point picked, as a double-click does. Left where it is otherwise.',
      ),
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
    plane: z
      .object({ z: z.number().int().min(0), t: z.number().int().min(0) })
      .optional()
      .describe(
        'The focal plane z and time point t to show (both from 0); the reported planes give the counts and planeIndex the current one. The old plane stays on screen until the new one is ready.',
      ),
    nearest: z
      .boolean()
      .optional()
      .describe(
        'Sample the slide plane nearest-neighbour (true, crisp pixels) or linear (false).',
      ),
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
    channel: z
      .union([z.number().int().min(0), z.string().min(1)])
      .optional()
      .describe(
        'The slide channel to change with visible, colormap, cal_min and cal_max: its index from 0, or its exact name (case ignored) as the reported channels list it. A name two channels share is refused; give the index.',
      ),
    visible: z.boolean().optional().describe('Show or hide the channel.'),
    colormap: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "The channel's colormap, by its lowercase name, such as gray, red or green.",
      ),
    color: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/)
      .optional()
      .describe(
        'An exact channel colour as hex (#rrggbb), such as an OME-Zarr omero colour: the channel gets a black-to-colour ramp named after it. Instead of colormap.',
      ),
    cal_min: z
      .number()
      .nullable()
      .optional()
      .describe(
        "The low end of the channel's window, in stored sample values; null for the stored range's low end.",
      ),
    cal_max: z
      .number()
      .nullable()
      .optional()
      .describe(
        "The high end of the channel's window, in stored sample values; null for the stored range's high end.",
      ),
    channel_blend: z
      .enum(['max', 'additive'])
      .optional()
      .describe(
        'How the visible channels combine: the brighter of each (max) or their sum. An RGB slide is always additive.',
      ),
    color_management: z
      .boolean()
      .optional()
      .describe(
        "Apply the slide's ICC colour profile (true) or show the decoded colours as stored (false).",
      ),
  },
  sample_slide: {
    ...TAB_ARG,
    x: z
      .number()
      .describe('Slide base-level pixel column, from 0 at the left.'),
    y: z.number().describe('Slide base-level pixel row, from 0 at the top.'),
    fetch: z
      .boolean()
      .optional()
      .describe(
        'Fetch the full-resolution tile first when it is not cached (slower); otherwise read only what is cached.',
      ),
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
      'Maps a point between the canvas, world units and voxels: a pixel says what tile is under ' +
      'it and where that is in the volume; a point in world units or a voxel says where it lands ' +
      'on the canvas.',
    inputSchema: EXTRA_SCHEMAS.map_point,
    readOnly: true,
  })

  registerSimple(server, context, 'pick_point', {
    title: 'Pick the point under a pixel',
    description:
      'Depth-picks a canvas pixel as a double-click does: the world point of the first drawn volume ' +
      'voxel or mesh under it, on a slice or the 3D render (on a channel stack any drawn channel ' +
      'answers). `mm` is null when nothing is drawn there. With move_crosshair the crosshair goes ' +
      'there and `where` is the where_am_i reply, whose crosshair may be snapped to a voxel centre.',
    inputSchema: EXTRA_SCHEMAS.pick_point,
    lead: (r) => {
      const { mm, unit, where } = (r ?? {}) as {
        mm?: number[] | null
        unit?: string
        where?: { description?: string }
      }
      if (mm === null) return 'Nothing is drawn under that pixel.'
      if (!mm) return undefined
      const at = `Picked ${mm.map((v) => Math.round(v)).join(', ')} ${unit}.`
      return where?.description ? `${at} ${where.description}` : at
    },
  })

  registerSimple(server, context, 'set_slide', {
    title: 'Work the slide plane',
    description:
      'For a whole-slide image: picks the resolution level, focal plane / time point and ' +
      'interpolation of the slide plane, clears the plane, ' +
      'works on the slide drawing, or sets a channel (visible, colormap or an exact #rrggbb color, window) and how the ' +
      "channels blend, and turns colour management (the slide's ICC profile) on or off. Reports " +
      'the channels, blend and colour management afterwards when a slide plane is set; ' +
      'where_am_i reports them too. A null cal_min or cal_max in the report is the stored range end.',
    inputSchema: EXTRA_SCHEMAS.set_slide,
  })

  registerSimple(server, context, 'sample_slide', {
    title: 'Read slide pixel values',
    description:
      "Reads each channel's value at a pixel of the slide plane, from the cached tiles " +
      '(the finest level held) or, with fetch, the full-resolution tile. Each sample: value ' +
      '(data units; null = unavailable, see missing: outside, hole, uncached or hidden), ' +
      'stored, level, and exact (false = a coarser level or quantized data). where_am_i ' +
      'reports the same at the crosshair as slide.',
    inputSchema: EXTRA_SCHEMAS.sample_slide,
    readOnly: true,
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
