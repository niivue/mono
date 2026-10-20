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
import type { Bridge } from './bridge'
import {
  type Extension,
  failure,
  reply,
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
} as const

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
