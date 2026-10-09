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

import { TAB_PARAM } from '../protocol'
import {
  LAYOUT_NAMES,
  SHOW_RENDER_NAMES,
  SLICE_NAMES,
  type ViewState,
} from '../views'
import { triple } from './args'
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
  where_am_i: { ...TAB_ARG },
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
