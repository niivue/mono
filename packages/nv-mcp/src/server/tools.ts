/**
 * The core tools, and the shape an extension adds its own in.
 *
 * Every tool is answered by a page: the server writes the call to the
 * bridge and turns what comes back into MCP content. The reply is a line
 * to say and then the details as JSON, and when the answering tab has
 * reloaded since the last call the line says so first, with what the scene
 * was showing before, so an agent does not read a fresh scene as the one
 * it left. Each tool that asks a page takes an optional `tab`, the id of
 * the tab to ask; without it the bridge's answering tab is asked. The ids
 * come from `list_tabs`, or from `new_tab`, which makes one up and gives
 * the address that opens the page as that tab, so an agent can name the
 * tab it means across a whole conversation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { PLANE_ALIASES, PLANE_ANGLES } from '../planes'
import { TAB_PARAM } from '../protocol'
import {
  LAYOUT_NAMES,
  SHOW_RENDER_NAMES,
  SLICE_NAMES,
  type ViewState,
} from '../views'
import { triple, VOLUME_ARG } from './args'
import type { Bridge } from './bridge'
import {
  type Extension,
  failure,
  reply,
  TAB_ARG,
  type ToolContext,
  tabAddress,
  toolContext,
} from './context'
import { EXTRA_SCHEMAS, registerExtraTools } from './tools-extras'
import { LAYER_SCHEMAS, registerLayerTools } from './tools-layers'
import { MARK_SCHEMAS, registerMarkTools } from './tools-marks'
import { registerSettingTools, SETTING_SCHEMAS } from './tools-settings'
import { registerVolumeTools, VOLUME_SCHEMAS } from './tools-volumes'

/** The sides a plane can be named for, the slice names, and `current`. */
export const PLANE_NAMES = [
  'current',
  ...PLANE_ANGLES.map((plane) => plane.name),
  ...Object.keys(PLANE_ALIASES),
] as [string, ...string[]]

/** The same without `current` and with `off`, for setting a plane outright. */
export const CUT_NAMES = [
  'off',
  ...PLANE_NAMES.filter((name) => name !== 'current'),
] as [string, ...string[]]

/** The input schema of each core tool, by name, so a test can read them. */
export const CORE_SCHEMAS = {
  list_tabs: {},
  use_tab: {
    id: z
      .string()
      .min(1)
      .describe('The id of a connected tab, from list_tabs.'),
  },
  new_tab: {},
  load_volume: {
    ...TAB_ARG,
    url: z
      .string()
      .min(1)
      .describe('Where the volume is: an http(s) address the page can fetch.'),
    name: z
      .string()
      .optional()
      .describe('A name for it; the file name otherwise.'),
    colormap: z
      .string()
      .optional()
      .describe('A NiiVue colormap name; gray otherwise.'),
    mni: z
      .boolean()
      .optional()
      .describe(
        'Whether the volume is in MNI space, so an atlas applies. Guessed from the name otherwise.',
      ),
  },
  add_overlay: {
    ...TAB_ARG,
    url: z
      .string()
      .min(1)
      .describe('Where the overlay is: an http(s) address the page can fetch.'),
    name: z
      .string()
      .optional()
      .describe('A name for it; the file name otherwise.'),
    labels: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Draw it as a label map: freesurfer for FreeSurfer or SynthSeg ids, or, for any other atlas, the address of a label table JSON the page can fetch (R, G, B and labels arrays, as NiiVue reads them).',
      ),
    colormap: z
      .string()
      .optional()
      .describe(
        'A NiiVue colormap name for a non-label overlay; warm otherwise.',
      ),
    opacity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('0 to 1; 0.5 for labels and 0.7 otherwise.'),
  },
  where_am_i: { ...TAB_ARG },
  list_regions: {
    ...TAB_ARG,
    query: z
      .string()
      .optional()
      .describe('Text the label or name must contain.'),
  },
  go_to_region: {
    ...TAB_ARG,
    region: z.string().min(1).describe('An atlas label or spoken region name.'),
    plane: z
      .enum(PLANE_NAMES)
      .optional()
      .describe('The cut to make through the centroid.'),
  },
  go_to_point: {
    ...TAB_ARG,
    mm: triple(
      "The point, [x, y, z] in the loaded volume's world millimetres.",
    ).optional(),
    vox: z
      .array(z.number().int())
      .length(3)
      .optional()
      .describe(
        'The point as a voxel of the base volume, [i, j, k], instead of mm.',
      ),
    plane: z
      .enum(PLANE_NAMES)
      .optional()
      .describe('The cut to make through the point.'),
    label: z
      .string()
      .optional()
      .describe(
        "What is there, said before the page's own description, e.g. left hippocampus.",
      ),
  },
  set_clip_plane: {
    ...TAB_ARG,
    plane: z
      .enum(CUT_NAMES)
      .optional()
      .describe('The side to take off, a slice name, or off.'),
    azimuth: z
      .number()
      .optional()
      .describe(
        "Instead of a plane name: the normal's azimuth in degrees, with elevation. The plane is named by the nearest side.",
      ),
    elevation: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        "Instead of a plane name: the normal's elevation in degrees, with azimuth.",
      ),
    index: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Which of the six clip planes to set. The first otherwise.'),
    planes: z
      .array(z.array(z.number()).length(3))
      .min(1)
      .max(6)
      .optional()
      .describe(
        'Set several clip planes at once, [depth, azimuth, elevation] each, in place of the rest.',
      ),
    depth: z
      .number()
      .min(-1.5)
      .max(1.5)
      .optional()
      .describe(
        "Where along the normal, in NiiVue's fraction units: 0 through the middle, positive towards the side taken off. 0 otherwise.",
      ),
    face: z
      .boolean()
      .optional()
      .describe('Turn the render camera to face the cut. On otherwise.'),
  },
  set_camera: {
    ...TAB_ARG,
    azimuth: z
      .number()
      .optional()
      .describe(
        'Degrees round the vertical: 0 from behind, 90 from the right, 180 from the front, 270 from the left.',
      ),
    elevation: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Degrees above the horizontal, from -90 (below) to 90 (above).',
      ),
    pan_2d: z
      .array(z.number())
      .length(4)
      .optional()
      .describe('The 2D pan and zoom, [x, y, z, zoom] as NiiVue keeps them.'),
    render_pan: z
      .array(z.number())
      .length(2)
      .optional()
      .describe('The render pan, [x, y].'),
    pivot: triple('The point in millimetres the render turns about.')
      .nullable()
      .optional()
      .describe(
        'The point in millimetres the render turns about; null for the centre.',
      ),
    center_on: triple(
      'Centre the render on this point in millimetres.',
    ).optional(),
    global: z
      .object({
        position: triple('Where the camera is, in millimetres.'),
        yaw: z.number().optional().describe('Degrees.'),
        pitch: z.number().optional().describe('Degrees.'),
        fov: z.number().optional().describe('The field of view, degrees.'),
        near: z.number().optional(),
        far: z.number().optional(),
      })
      .optional()
      .describe('Place a free camera in the world instead of orbiting.'),
  },
  set_volume: {
    ...TAB_ARG,
    volume: VOLUME_ARG.optional().describe(
      'Which volume: its index as where_am_i and add_overlay list them (0 is the base), or its name. The base otherwise.',
    ),
    colormap: z.string().optional().describe('A NiiVue colormap name.'),
    colormap_negative: z
      .string()
      .optional()
      .describe(
        'The colormap for values below zero, when they get their own; the empty string drops it.',
      ),
    opacity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('0 (hidden) to 1 (opaque).'),
    cal_min: z
      .number()
      .optional()
      .describe(
        "The low end of the display window: the intensity drawn as the colormap's darkest colour.",
      ),
    cal_max: z
      .number()
      .optional()
      .describe(
        "The high end of the display window: the intensity drawn as the colormap's brightest colour.",
      ),
    cal_min_neg: z
      .number()
      .optional()
      .describe('The low end of the negative window.'),
    cal_max_neg: z
      .number()
      .optional()
      .describe('The high end of the negative window.'),
    colormap_type: z
      .enum([
        'min_to_max',
        'zero_to_max_transparent_below_min',
        'zero_to_max_translucent_below_min',
      ])
      .optional()
      .describe(
        'How the colormap spans the window and treats values under cal_min.',
      ),
    transparent_below_cal_min: z
      .boolean()
      .optional()
      .describe('Whether values under cal_min are left unpainted.'),
    frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The frame of a 4D volume to show, counted from 0.'),
    invert: z
      .boolean()
      .optional()
      .describe('Whether the colormap runs backwards.'),
    colorbar: z
      .boolean()
      .optional()
      .describe('Whether a colorbar is drawn for it.'),
    nearest: z
      .boolean()
      .optional()
      .describe(
        'Nearest-neighbour sampling instead of linear, for label maps.',
      ),
    atlas_outline: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'For a label map: how strongly region outlines are drawn, 0 for none.',
      ),
    modulate_alpha: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'How much the modulation volume, if any, also fades the opacity.',
      ),
    labels: z
      .string()
      .optional()
      .describe(
        'A label table for it: the address of a NiiVue label JSON, or a table the server knows (freesurfer).',
      ),
    modulate: z
      .object({
        volume: VOLUME_ARG.describe(
          'The volume whose intensity modulates this one.',
        ),
        alpha: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('How much it fades the opacity too. 0 otherwise.'),
      })
      .optional()
      .describe("Modulate this volume's colours by another's intensity."),
    load_all_frames: z
      .boolean()
      .optional()
      .describe(
        'Fetch the remaining frames of a 4D volume that loaded its first only.',
      ),
    auto_window: z
      .boolean()
      .optional()
      .describe('Recompute cal_min and cal_max from the intensities.'),
    affine: z
      .union([
        z.array(z.array(z.number()).length(4)).length(4),
        z.array(z.number()).length(16),
      ])
      .optional()
      .describe(
        'Set its voxel-to-world matrix outright: 4 rows of 4, or 16 numbers row by row.',
      ),
    reset_affine: z
      .boolean()
      .optional()
      .describe("Put its affine back to the file's."),
    transform: z
      .object({
        translation: triple('Millimetres along x, y and z.').optional(),
        rotation: triple('Degrees about x, y and z.').optional(),
        scale: triple('Factors along x, y and z.').optional(),
      })
      .optional()
      .describe('Move, turn or scale it in the world, applied to its affine.'),
  },
  set_view: {
    ...TAB_ARG,
    slice: z
      .enum(SLICE_NAMES)
      .optional()
      .describe(
        'What the canvas shows: one slice orientation, all three with the render (multiplanar), or the render alone.',
      ),
    layout: z
      .enum(LAYOUT_NAMES)
      .optional()
      .describe(
        'How the multiplanar tiles are arranged; auto picks by the shape of the canvas.',
      ),
    mosaic: z
      .string()
      .optional()
      .describe(
        'A NiiVue mosaic string, e.g. "A 0 20 40; C -10 0 10" for three axial and three coronal slices ' +
          'in a grid; the empty string clears the mosaic.',
      ),
    show_render: z
      .enum(SHOW_RENDER_NAMES)
      .optional()
      .describe(
        'Whether the multiplanar view includes the render tile; auto adds it when there is room.',
      ),
    radiological: z
      .boolean()
      .optional()
      .describe(
        "Radiological convention: the subject's left on the right of the picture.",
      ),
    colorbar: z.boolean().optional().describe('Whether a colorbar is drawn.'),
  },
  screenshot: {
    ...TAB_ARG,
    max_width: z
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe(
        'Scale the picture down to at most this many pixels wide. 1024 otherwise.',
      ),
  },
  ...VOLUME_SCHEMAS,
  ...SETTING_SCHEMAS,
  ...LAYER_SCHEMAS,
  ...MARK_SCHEMAS,
  ...EXTRA_SCHEMAS,
} as const

/** A line that says what the view shows: the slice type, and the mosaic when one is drawn. */
function describeView(state: ViewState): string {
  if (state.mosaic) return `View: mosaic "${state.mosaic}".`
  const layout = state.slice === 'multiplanar' ? `, ${state.layout} layout` : ''
  return `View: ${state.slice}${layout}.`
}

/** Registers the core tools: tabs, the volume, the crosshair and the atlas, the cut and the camera, how each volume and the view are drawn, a picture. */
export function registerCoreTools(
  server: McpServer,
  context: ToolContext,
): void {
  const { bridge } = context

  server.registerTool(
    'list_tabs',
    {
      title: 'List connected tabs',
      description:
        "Lists the NiiVue tabs connected to this server: each one's id, title, address, when it " +
        'connected, where its scene stands, and which one answers calls now. With one tab it answers; ' +
        'with several, use_tab chooses, or each call names its tab with `tab`.',
      inputSchema: CORE_SCHEMAS.list_tabs,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tabs = bridge.list()
      const lead = tabs.length ? undefined : bridge.noApp
      return reply({ tabs }, lead)
    },
  )

  server.registerTool(
    'use_tab',
    {
      title: 'Choose the tab to drive',
      description:
        'Makes one connected tab the one that answers every later call, until it is closed for good ' +
        'or another is chosen. A reload of the same tab keeps the choice. A call that names a `tab` ' +
        'goes there instead, without changing the choice.',
      inputSchema: CORE_SCHEMAS.use_tab,
    },
    async ({ id }) => {
      try {
        const tab = bridge.use(id)
        return reply({ tab }, `Driving "${tab.title}".`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'new_tab',
    {
      title: 'Name a tab before it opens',
      description:
        'Makes up an id for a tab that is not open yet and gives the address that opens the page ' +
        'as that tab. Give the address to the person to open, then pass the id as `tab` on later ' +
        'calls to reach that tab whatever else is connected; the page keeps the id across reloads. ' +
        'Any id works the same way when put in the address as `?tab=<id>`, so an agent may make ' +
        'its own; this tool only spares it the guessing and the address.',
      inputSchema: CORE_SCHEMAS.new_tab,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const id = crypto.randomUUID()
      const url = tabAddress(context.pageUrl, id)
      return reply(
        { id, ...(url ? { url } : {}) },
        url
          ? `Open ${url} to connect a tab with the id ${id}.`
          : `Open the page with ?${TAB_PARAM}=${id} in its address to connect a tab with that id.`,
      )
    },
  )

  server.registerTool(
    'load_volume',
    {
      title: 'Load a volume',
      description:
        'Loads a volume into the page from an address it can fetch, replacing what is shown. ' +
        "Reports the volume's name and its extent in millimetres. An atlas only applies when the " +
        'volume is in MNI space; pass `mni` to say so, or leave it to be guessed from the name.',
      inputSchema: CORE_SCHEMAS.load_volume,
    },
    async ({ tab, ...params }) =>
      context.answer('load_volume', params, {
        tab,
        lead: (r) =>
          `Loaded ${(r as { name?: string })?.name ?? 'the volume'}.`,
      }),
  )

  server.registerTool(
    'add_overlay',
    {
      title: 'Add an overlay',
      description:
        'Draws another volume over whatever the page shows, keeping it: a statistical map with a ' +
        'colormap, or a segmentation as labels. `labels: freesurfer` fits FreeSurfer and SynthSeg ' +
        'label ids, named and coloured as FreeSurfer does; any other atlas needs its own table, ' +
        'passed as the address of a label table JSON the page can fetch. The overlay must share ' +
        "the base volume's space. The base may be what the page opened with or one from " +
        'load_volume; loading a new base clears the overlays.',
      inputSchema: CORE_SCHEMAS.add_overlay,
    },
    async ({ tab, ...params }) =>
      context.answer('add_overlay', params, {
        tab,
        lead: (r) => {
          const volumes = (r as { volumes?: Array<{ name?: string }> })?.volumes
          return volumes?.length
            ? `Showing ${volumes.map((v) => v.name).join(' with ')}.`
            : undefined
        },
      }),
  )

  server.registerTool(
    'where_am_i',
    {
      title: 'Where the crosshair is',
      description:
        'Reports where the crosshair is now: its position in millimetres and as fractions of the ' +
        'volume, the volumes shown and how each is drawn, the atlas region there if any, which ' +
        'plane is cut, where the camera looks from, the view layout, which tab answered, and the ' +
        'description a listener would hear.',
      inputSchema: CORE_SCHEMAS.where_am_i,
      annotations: { readOnlyHint: true },
    },
    async ({ tab }) => context.answer('where_am_i', {}, { tab, withTab: true }),
  )

  server.registerTool(
    'list_regions',
    {
      title: 'List atlas regions',
      description:
        "Lists the regions of the atlas the page can navigate to, with each one's label as the " +
        'atlas spells it, its spoken name, its centroid in MNI millimetres, and its size in voxels. ' +
        'Pass `query` to keep only regions whose label or name contains it.',
      inputSchema: CORE_SCHEMAS.list_regions,
      annotations: { readOnlyHint: true },
    },
    async ({ tab, query }) =>
      context.answer('list_regions', { query }, { tab }),
  )

  server.registerTool(
    'go_to_region',
    {
      title: 'Go to a region',
      description:
        'Moves the crosshair to the centroid of an atlas region and cuts the volume with a plane ' +
        'through that point, so the region is on the exposed face under the crosshair, with the ' +
        'render camera turned to face it. `region` is a label (Precentral_L) or a spoken name ' +
        '(left precentral gyrus); a name that fits several regions is refused with the choices. ' +
        '`plane` names the side the cut takes off, or a slice orientation; `current` keeps whatever ' +
        'plane is cut now, and cuts coronal when none is. When the centroid falls outside its own ' +
        'region (a curved one), the nearest voxel of the region is used instead and `snapped` says so. ' +
        'Only works when the loaded volume is in MNI space.',
      inputSchema: CORE_SCHEMAS.go_to_region,
    },
    async ({ tab, region, plane }) =>
      context.answer(
        'go_to_region',
        { region, plane },
        {
          tab,
          lead: (r) => {
            const said = (r as { description?: string })?.description
            return said ? `Moved to ${said}` : undefined
          },
        },
      ),
  )

  server.registerTool(
    'go_to_point',
    {
      title: 'Go to a point',
      description:
        "Moves the crosshair to a point given in the loaded volume's world millimetres, or as a " +
        'voxel of the base volume, and cuts the ' +
        'volume with a plane through it, facing the render camera at the cut, as go_to_region does ' +
        "for an atlas region. Works in any space, so it reaches structures of a subject's own scan, " +
        "for example a segmentation label's centroid. `label` names what is there for the listener. " +
        '`plane` names the side the cut takes off, or a slice orientation; `current` keeps the cut.',
      inputSchema: CORE_SCHEMAS.go_to_point,
    },
    async ({ tab, mm, vox, plane, label }) =>
      context.answer(
        'go_to_point',
        { mm, vox, plane, label },
        {
          tab,
          lead: (r) => {
            const said = (r as { description?: string })?.description
            return said ? `Moved to ${said}` : undefined
          },
        },
      ),
  )

  server.registerTool(
    'set_clip_plane',
    {
      title: 'Cut the volume',
      description:
        'Cuts the volume with a whole plane named for the side it takes off (left, right, anterior, ' +
        'posterior, superior, inferior) or a slice orientation (sagittal, coronal, axial), at a depth ' +
        'along its normal, and turns the render camera to face the cut unless told not to. `off` ' +
        'removes the cut and leaves the camera where it is. A plane can instead be given by the ' +
        'azimuth and elevation of its normal; `index` picks one of the six planes NiiVue keeps, ' +
        'and `planes` sets several at once.',
      inputSchema: CORE_SCHEMAS.set_clip_plane,
    },
    async ({ tab, ...params }) =>
      context.answer('set_clip_plane', params, {
        tab,
        lead: (r) =>
          `Cut plane: ${(r as { plane?: { name?: string } })?.plane?.name ?? 'set'}.`,
      }),
  )

  server.registerTool(
    'set_camera',
    {
      title: 'Turn the render camera',
      description:
        'Points the render camera from the given azimuth and elevation, pans the 2D view or the ' +
        'render, sets the point the render turns about or centres it on one, or places a free ' +
        'camera with `global`. Only what is given changes. Note that when the page ' +
        "ties its clip plane to the camera, a turn re-cuts the plane the page's way.",
      inputSchema: CORE_SCHEMAS.set_camera,
    },
    async ({ tab, ...params }) => context.answer('set_camera', params, { tab }),
  )

  server.registerTool(
    'set_volume',
    {
      title: 'Change how a volume is drawn',
      description:
        'Changes how one loaded volume is drawn, leaving the rest as it is: its colormap (and ' +
        'one for negative values), its opacity, its display window (`cal_min` and `cal_max`, the ' +
        "intensities drawn as the colormap's darkest and brightest colours), how the colormap " +
        'spans it, the frame shown of a 4D volume, the colorbar, sampling, atlas outline, a label ' +
        'table, modulation by another volume, and its place in the world (an affine outright, a ' +
        'translation, rotation and scale, or a reset). `volume` is an index as where_am_i lists ' +
        'them, or a name; the base volume otherwise. Reports the volume as it is drawn now.',
      inputSchema: CORE_SCHEMAS.set_volume,
    },
    async ({ tab, ...params }) =>
      context.answer('set_volume', params, {
        tab,
        lead: (r) => {
          const volume = (r as { volume?: { name?: string } })?.volume
          return volume?.name ? `Changed ${volume.name}.` : undefined
        },
      }),
  )

  server.registerTool(
    'set_view',
    {
      title: 'Set the view layout',
      description:
        'Sets what the canvas shows: `slice` picks one slice orientation, the multiplanar view of ' +
        'all three with the render, or the render alone; `layout` arranges the multiplanar tiles ' +
        'and `show_render` says whether the render tile joins them; `mosaic` draws the slices a ' +
        'NiiVue mosaic string names; `radiological` and `colorbar` are switches. Each is optional ' +
        'and only what is given changes. Reports the whole layout afterwards.',
      inputSchema: CORE_SCHEMAS.set_view,
    },
    async ({ tab, ...params }) =>
      context.answer('set_view', params, {
        tab,
        lead: (r) => {
          const view = (r as { view?: ViewState })?.view
          return view ? describeView(view) : undefined
        },
      }),
  )

  server.registerTool(
    'screenshot',
    {
      title: 'Picture of the canvas',
      description:
        "Draws the scene and returns NiiVue's canvas as a PNG, scaled down to `max_width` pixels " +
        "wide at most. The picture is NiiVue's alone: anything the page draws over its canvas is " +
        'not in it.',
      inputSchema: CORE_SCHEMAS.screenshot,
      annotations: { readOnlyHint: true },
    },
    async ({ tab, max_width }) =>
      context.answer(
        'screenshot',
        { max_width },
        {
          tab,
          image: (r) => {
            const shot = r as { data?: string; mimeType?: string }
            return shot?.data && shot.mimeType
              ? { data: shot.data, mimeType: shot.mimeType }
              : undefined
          },
          lead: (r) => {
            const shot = r as { width?: number; height?: number }
            return shot?.width
              ? `${shot.width}×${shot.height} pixels.`
              : undefined
          },
        },
      ),
  )

  registerVolumeTools(server, context)
  registerSettingTools(server, context)
  registerLayerTools(server, context)
  registerMarkTools(server, context)
  registerExtraTools(server, context)
}

/** An MCP server with the core tools and each extension's, over one bridge. */
export function buildServer(options: {
  bridge: Bridge
  extensions?: readonly Extension[]
  name?: string
  version?: string
  /** Where the page is, for `new_tab`. */
  pageUrl?: string
  /** What an agent reads on connecting: what the page shows and can fetch. */
  instructions?: string
}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? 'niivue',
      version: options.version ?? '0.1.0',
    },
    options.instructions === undefined
      ? {}
      : { instructions: options.instructions },
  )
  const context = toolContext(options.bridge, { pageUrl: options.pageUrl })
  registerCoreTools(server, context)
  for (const extension of options.extensions ?? [])
    extension.register(server, context)
  return server
}
