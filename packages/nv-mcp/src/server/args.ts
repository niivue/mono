/**
 * Schema pieces the tool modules share, and the one-line way most tools
 * are registered: the schema's `tab` goes to the bridge and the rest of
 * the arguments go to the page's handler of the same name.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { ToolContext } from './context'

/** Which volume a tool means: its index as where_am_i lists them, or its name. */
export const VOLUME_ARG = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe(
    'Which volume: its index as where_am_i lists them (0 is the base), or its name.',
  )

/** Which mesh a tool means: its index as list_meshes lists them, or its name. */
export const MESH_ARG = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe('Which mesh: its index as list_meshes lists them, or its name.')

/** Which signal a tool means: its index as list_signals lists them, or its name. */
export const SIGNAL_ARG = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe('Which signal: its index as list_signals lists them, or its name.')

/** A point, three numbers. */
export function triple(description: string) {
  return z.array(z.number()).length(3).describe(description)
}

/** A colour: red, green and blue 0 to 1, and alpha when given. */
export function rgba(description: string) {
  return z
    .array(z.number().min(0).max(1))
    .min(3)
    .max(4)
    .describe(
      `${description} [red, green, blue] or [red, green, blue, alpha], each 0 to 1.`,
    )
}

/** How a simple tool is registered: its words, its schema, and what its reply leads with. */
export interface SimpleTool {
  title: string
  description: string
  inputSchema: z.ZodRawShape
  readOnly?: boolean
  /** A line to say before the JSON, from what the page answered. */
  lead?: (result: unknown) => string | undefined
}

/** Registers a tool whose arguments go to the page's handler of the same name. */
export function registerSimple(
  server: McpServer,
  context: ToolContext,
  name: string,
  tool: SimpleTool,
): void {
  server.registerTool(
    name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
    async (args: { tab?: string } & Record<string, unknown>) => {
      const { tab, ...params } = args
      return context.answer(name, params, { tab, lead: tool.lead })
    },
  )
}

/** A lead that names what a handler reports under `key`, when it has a name. */
export function named(key: string, verb: string) {
  return (result: unknown): string | undefined => {
    const item = (result as Record<string, { name?: unknown }>)?.[key]
    return typeof item?.name === 'string' ? `${verb} ${item.name}.` : undefined
  }
}
