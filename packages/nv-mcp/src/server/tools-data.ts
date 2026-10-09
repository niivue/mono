/**
 * The tools over the page's data palette: the data it can load, by id.
 * Each entry holds a call to one of the loading tools, so a button bound
 * to `data.<id>` loads exactly what that call would.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { DATA_LOADERS } from '../data'
import { registerSimple } from './args'
import { TAB_ARG, type ToolContext } from './context'

const ID = z.string().min(1)

export const DATA_SCHEMAS = {
  list_data: { ...TAB_ARG },
  add_data: {
    ...TAB_ARG,
    id: ID.describe(
      'A name for the entry: load_data takes it, and a control bound to data.<id> loads it.',
    ),
    label: z
      .string()
      .optional()
      .describe('What a person would call it; the id otherwise.'),
    description: z
      .string()
      .optional()
      .describe('What it is, for choosing among entries later.'),
    tool: z
      .enum(DATA_LOADERS)
      .optional()
      .describe(
        'The loading tool the entry calls. Needed unless from names an entry to start from.',
      ),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'The arguments that tool takes, exactly as you would give them to it: at least url ' +
          '(and mesh, for add_mesh_layer), plus any of its options, like colormap, cal_min or opacity.',
      ),
    from: ID.optional().describe(
      'An entry to start from: its tool, arguments and description, with what is given here laid over them. ' +
        'A tool naming another loader starts its arguments and description afresh.',
    ),
  },
  remove_data: {
    ...TAB_ARG,
    id: ID.describe(
      'The entry to take away. The page keeps its own sample data.',
    ),
  },
  load_data: {
    ...TAB_ARG,
    id: ID.describe('The entry to load, as list_data names it.'),
  },
} as const

export function registerDataTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'list_data', {
    title: 'List the data palette',
    description:
      'Lists the data the page can load by id: the sample data the page offers (source page) and the ' +
      'entries added with add_data (source agent). Each is a held call to a loading tool, with its arguments. ' +
      'A button or menu item bound to data.<id> loads the entry when pressed.',
    inputSchema: DATA_SCHEMAS.list_data,
    readOnly: true,
  })

  registerSimple(server, context, 'add_data', {
    title: 'Add to the data palette',
    description:
      `Adds data the page can load by id, as a call to one of the loading tools (${DATA_LOADERS.join(', ')}) ` +
      'with the arguments it takes, held for later; nothing loads now. Bind a button or menu item to ' +
      'data.<id> so the person can load it, or call load_data. from starts from an entry already there, ' +
      'such as a sample with another colormap. Reports the entry.',
    inputSchema: DATA_SCHEMAS.add_data,
    lead: (result) => {
      const data = (result as { data?: { id?: string } })?.data
      return data?.id ? `Added "${data.id}" to the data palette.` : undefined
    },
  })

  registerSimple(server, context, 'remove_data', {
    title: 'Remove from the data palette',
    description:
      'Takes an entry added with add_data out of the palette. Reports the ids that remain.',
    inputSchema: DATA_SCHEMAS.remove_data,
  })

  registerSimple(server, context, 'load_data', {
    title: 'Load from the data palette',
    description:
      'Loads an entry of the data palette, as its loading tool would with its arguments, and reports ' +
      'what that tool reports.',
    inputSchema: DATA_SCHEMAS.load_data,
    lead: (result) => {
      const id = (result as { loaded?: string })?.loaded
      return id ? `Loaded "${id}".` : undefined
    },
  })
}
