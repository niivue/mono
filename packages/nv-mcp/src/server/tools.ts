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
import { TAB_PARAM, type TabState } from '../protocol'
import {
  LAYOUT_NAMES,
  SHOW_RENDER_NAMES,
  SLICE_NAMES,
  type ViewState,
} from '../views'
import type { Bridge, ResetReport, TabInfo } from './bridge'

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolReply {
  content: Content[]
  isError?: boolean
  [key: string]: unknown
}

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

/**
 * The argument that names the tab a call goes to, for every tool a page
 * answers. An extension spreads it into its own schemas and passes the
 * value as `tab` to `context.answer`.
 */
export const TAB_ARG = {
  tab: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The id of the tab to ask, from list_tabs or new_tab. Without it, the tab chosen with ' +
        'use_tab answers, or the only one, or the one that answered last.',
    ),
}

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
      .enum(['freesurfer'])
      .optional()
      .describe(
        'Draw it as a label map with this lookup table, e.g. freesurfer for FreeSurfer or SynthSeg segmentations.',
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
    mm: z
      .array(z.number())
      .length(3)
      .describe(
        "The point, [x, y, z] in the loaded volume's world millimetres.",
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
      .describe('The side to take off, a slice name, or off.'),
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
      .describe(
        'Degrees round the vertical: 0 from behind, 90 from the right, 180 from the front, 270 from the left.',
      ),
    elevation: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Degrees above the horizontal, from -90 (below) to 90 (above).',
      ),
  },
  set_volume: {
    ...TAB_ARG,
    volume: z
      .union([z.number().int().min(0), z.string().min(1)])
      .optional()
      .describe(
        'Which volume: its index as where_am_i and add_overlay list them (0 is the base), or its name. The base otherwise.',
      ),
    colormap: z.string().optional().describe('A NiiVue colormap name.'),
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

/** What a tool handler has to work with. */
export interface ToolContext {
  bridge: Bridge
  /** Where the page is, for `new_tab` to give an address that opens one; unset when not known. */
  pageUrl?: string
  /**
   * Puts `method` to the answering tab, or to the tab `options.tab` names,
   * and shapes the reply: `lead` gives a line to say above the JSON,
   * `image` picks a picture out of the result. A thrown error, from the
   * page or the bridge, becomes an error reply.
   */
  answer(
    method: string,
    params?: Record<string, unknown>,
    options?: AnswerOptions,
  ): Promise<ToolReply>
  reply(result: unknown, lead?: string): ToolReply
  failure(error: unknown): ToolReply
}

export interface ReplyShape {
  lead?: (result: unknown, tab: TabInfo) => string | undefined
  image?: (result: unknown) => { data: string; mimeType: string } | undefined
  /** Put the answering tab into the JSON. */
  withTab?: boolean
}

export interface AnswerOptions extends ReplyShape {
  /** The id of the tab to ask, as `TAB_ARG` takes it; the answering tab otherwise. */
  tab?: string
}

/** Something that adds tools to the server: the app's own, over the core's. */
export interface Extension {
  name: string
  register(server: McpServer, context: ToolContext): void
}

export function reply(result: unknown, lead?: string): ToolReply {
  const text = JSON.stringify(result, null, 2)
  return { content: [{ type: 'text', text: lead ? `${lead}\n${text}` : text }] }
}

export function failure(error: unknown): ToolReply {
  const text = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text }] }
}

/** A context over this bridge. */
export function toolContext(
  bridge: Bridge,
  options: { pageUrl?: string } = {},
): ToolContext {
  return {
    bridge,
    ...(options.pageUrl === undefined ? {} : { pageUrl: options.pageUrl }),
    reply,
    failure,
    async answer(method, params = {}, options = {}) {
      try {
        const { result, tab, reloaded } = await bridge.call(
          method,
          params,
          options.tab,
        )
        const lines: string[] = []
        if (reloaded) lines.push(reloadNotice(tab, reloaded))
        const lead = options.lead?.(result, tab)
        if (lead) lines.push(lead)
        let payload = result
        if (isRecord(result) && (options.withTab || reloaded)) {
          payload = {
            ...(options.withTab
              ? { tab: { id: tab.id, title: tab.title } }
              : {}),
            ...result,
            ...(reloaded ? { reloaded } : {}),
          }
        }
        const out = reply(payload, lines.length ? lines.join('\n') : undefined)
        const image = options.image?.(result)
        if (image)
          out.content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          })
        return out
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/** The line that says a tab started over, and what changed. */
export function reloadNotice(tab: TabInfo, reset: ResetReport): string {
  const changes = describeChanges(reset.before, reset.after)
  const when = new Date(reset.reloadedAt).toISOString()
  const head = `Note: the tab "${tab.title}" reloaded at ${when}, since the last call, so its scene started over.`
  return changes.length
    ? `${head} Changed: ${changes.join('; ')}.`
    : `${head} Nothing it reported has changed.`
}

function describeChanges(
  before: TabState | null,
  after: TabState | null,
): string[] {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])
  const changes: string[] = []
  for (const key of keys) {
    const was = brief(key, before?.[key])
    const now = brief(key, after?.[key])
    if (was !== now) changes.push(`${key} was ${was}, now ${now}`)
  }
  return changes
}

function brief(key: string, value: unknown): string {
  if (value === undefined || value === null) return 'unset'
  if (key === 'plane' && isRecord(value) && typeof value.name === 'string')
    return value.name
  if (key === 'crosshair' && isRecord(value) && Array.isArray(value.mm)) {
    return `[${(value.mm as number[]).map((n) => Math.round(n)).join(', ')}] mm`
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The address that opens the page as the tab `id`, or null without a page address. */
export function tabAddress(
  pageUrl: string | undefined,
  id: string,
): string | null {
  if (!pageUrl) return null
  try {
    const url = new URL(pageUrl)
    url.searchParams.set(TAB_PARAM, id)
    return url.href
  } catch {
    return null
  }
}

/** A line that says what the view shows: the slice type, and the mosaic when one is drawn. */
export function describeView(state: ViewState): string {
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
        'colormap, or a segmentation as labels with `labels: freesurfer` (FreeSurfer and SynthSeg ' +
        "label ids, named and coloured as FreeSurfer does). The overlay must share the base volume's " +
        'space. The base may be what the page opened with or one from load_volume; loading a new ' +
        'base clears the overlays.',
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
        "Moves the crosshair to a point given in the loaded volume's world millimetres and cuts the " +
        'volume with a plane through it, facing the render camera at the cut, as go_to_region does ' +
        "for an atlas region. Works in any space, so it reaches structures of a subject's own scan, " +
        "for example a segmentation label's centroid. `label` names what is there for the listener. " +
        '`plane` names the side the cut takes off, or a slice orientation; `current` keeps the cut.',
      inputSchema: CORE_SCHEMAS.go_to_point,
    },
    async ({ tab, mm, plane, label }) =>
      context.answer(
        'go_to_point',
        { mm, plane, label },
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
        'removes the cut and leaves the camera where it is.',
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
        'Points the render camera from the given azimuth and elevation. Note that when the page ' +
        "ties its clip plane to the camera, the turn re-cuts the plane the page's way.",
      inputSchema: CORE_SCHEMAS.set_camera,
    },
    async ({ tab, ...params }) => context.answer('set_camera', params, { tab }),
  )

  server.registerTool(
    'set_volume',
    {
      title: 'Change how a volume is drawn',
      description:
        'Changes how one loaded volume is drawn, leaving the rest as it is: its colormap, its ' +
        'opacity, its display window (`cal_min` and `cal_max`, the intensities drawn as the ' +
        "colormap's darkest and brightest colours), the frame shown of a 4D volume, or whether the " +
        'colormap is inverted. `volume` is an index as where_am_i lists them, or a name; the base ' +
        'volume otherwise. Reports the volume as it is drawn now, with the intensities it spans.',
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
}

/** An MCP server with the core tools and each extension's, over one bridge. */
export function buildServer(options: {
  bridge: Bridge
  extensions?: readonly Extension[]
  name?: string
  version?: string
  /** Where the page is, for `new_tab`. */
  pageUrl?: string
}): McpServer {
  const server = new McpServer({
    name: options.name ?? 'niivue',
    version: options.version ?? '0.1.0',
  })
  const context = toolContext(options.bridge, { pageUrl: options.pageUrl })
  registerCoreTools(server, context)
  for (const extension of options.extensions ?? [])
    extension.register(server, context)
  return server
}
