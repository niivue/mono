/**
 * The core tools, and the shape an extension adds its own in.
 *
 * Every tool is answered by a page: the server writes the call to the
 * bridge and turns what comes back into MCP content. The reply is a line
 * to say and then the details as JSON, and when the answering tab has
 * reloaded since the last call the line says so first, with what the scene
 * was showing before, so an agent does not read a fresh scene as the one
 * it left.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { PLANE_ALIASES, PLANE_ANGLES } from '../planes'
import type { TabState } from '../protocol'
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

/** The input schema of each core tool, by name, so a test can read them. */
export const CORE_SCHEMAS = {
  list_tabs: {},
  use_tab: {
    id: z
      .string()
      .min(1)
      .describe('The id of a connected tab, from list_tabs.'),
  },
  load_volume: {
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
  where_am_i: {},
  list_regions: {
    query: z
      .string()
      .optional()
      .describe('Text the label or name must contain.'),
  },
  go_to_region: {
    region: z.string().min(1).describe('An atlas label or spoken region name.'),
    plane: z
      .enum(PLANE_NAMES)
      .optional()
      .describe('The cut to make through the centroid.'),
  },
  go_to_point: {
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
  screenshot: {
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
  /**
   * Puts `method` to the answering tab and shapes the reply: `lead` gives a
   * line to say above the JSON, `image` picks a picture out of the result.
   * A thrown error, from the page or the bridge, becomes an error reply.
   */
  answer(
    method: string,
    params?: Record<string, unknown>,
    shape?: ReplyShape,
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
export function toolContext(bridge: Bridge): ToolContext {
  return {
    bridge,
    reply,
    failure,
    async answer(method, params = {}, shape = {}) {
      try {
        const { result, tab, reloaded } = await bridge.call(method, params)
        const lines: string[] = []
        if (reloaded) lines.push(reloadNotice(tab, reloaded))
        const lead = shape.lead?.(result, tab)
        if (lead) lines.push(lead)
        let payload = result
        if (isRecord(result) && (shape.withTab || reloaded)) {
          payload = {
            ...(shape.withTab ? { tab: { id: tab.id, title: tab.title } } : {}),
            ...result,
            ...(reloaded ? { reloaded } : {}),
          }
        }
        const out = reply(payload, lines.length ? lines.join('\n') : undefined)
        const image = shape.image?.(result)
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

/** Registers the core tools: tabs, the volume, the crosshair and the atlas, the cut and the camera, a picture. */
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
        'with several, use_tab chooses.',
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
        'or another is chosen. A reload of the same tab keeps the choice.',
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
    'load_volume',
    {
      title: 'Load a volume',
      description:
        'Loads a volume into the page from an address it can fetch, replacing what is shown. ' +
        "Reports the volume's name and its extent in millimetres. An atlas only applies when the " +
        'volume is in MNI space; pass `mni` to say so, or leave it to be guessed from the name.',
      inputSchema: CORE_SCHEMAS.load_volume,
    },
    async (params) =>
      context.answer('load_volume', params, {
        lead: (r) =>
          `Loaded ${(r as { name?: string })?.name ?? 'the volume'}.`,
      }),
  )

  server.registerTool(
    'add_overlay',
    {
      title: 'Add an overlay',
      description:
        'Draws a second volume over the loaded one, keeping the base: a statistical map with a ' +
        'colormap, or a segmentation as labels with `labels: freesurfer` (FreeSurfer and SynthSeg ' +
        "label ids, named and coloured as FreeSurfer does). The overlay must share the base volume's " +
        'space. Load the base with load_volume first; loading a new base clears the overlays.',
      inputSchema: CORE_SCHEMAS.add_overlay,
    },
    async (params) =>
      context.answer('add_overlay', params, {
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
        'volume, the atlas region there if any, which plane is cut, where the camera looks from, ' +
        'which tab answered, and the description a listener would hear.',
      inputSchema: CORE_SCHEMAS.where_am_i,
      annotations: { readOnlyHint: true },
    },
    async () => context.answer('where_am_i', {}, { withTab: true }),
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
    async ({ query }) => context.answer('list_regions', { query }),
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
    async ({ region, plane }) =>
      context.answer(
        'go_to_region',
        { region, plane },
        {
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
    async ({ mm, plane, label }) =>
      context.answer(
        'go_to_point',
        { mm, plane, label },
        {
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
    async (params) =>
      context.answer('set_clip_plane', params, {
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
    async (params) => context.answer('set_camera', params),
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
    async ({ max_width }) =>
      context.answer(
        'screenshot',
        { max_width },
        {
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
}): McpServer {
  const server = new McpServer({
    name: options.name ?? 'niivue',
    version: options.version ?? '0.1.0',
  })
  const context = toolContext(options.bridge)
  registerCoreTools(server, context)
  for (const extension of options.extensions ?? [])
    extension.register(server, context)
  return server
}
