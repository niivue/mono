/**
 * The tools on NiiVue itself: its settings and what it can do.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { registerSimple } from './args'
import { TAB_ARG, type ToolContext } from './context'

export const SETTING_SCHEMAS = {
  get_options: {
    ...TAB_ARG,
    names: z
      .array(z.string().min(1))
      .optional()
      .describe('Which settings to read, by name. All of them otherwise.'),
    describe: z
      .boolean()
      .optional()
      .describe(
        'Whether each setting comes with its kind, choices or bounds, and a description. ' +
          'On when no names are given, off otherwise.',
      ),
  },
  set_options: {
    ...TAB_ARG,
    options: z
      .record(z.string(), z.unknown())
      .describe(
        'The settings to change, each by its NiiVue name (get_options lists them): a number, a ' +
          'switch, a colour as [red, green, blue, alpha] 0 to 1, or a choice by its word.',
      ),
  },
  capabilities: { ...TAB_ARG },
} as const

export function registerSettingTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'get_options', {
    title: 'Read the settings',
    description:
      "Reads NiiVue's settings: crosshair, colours, fonts, 3D rendering, drawing pen, drag " +
      'behaviour and the rest. Without `names` it lists every setting the page has, with its ' +
      'kind, the choices or bounds it takes, and what it does; with names it gives the values ' +
      'asked for.',
    inputSchema: SETTING_SCHEMAS.get_options,
    readOnly: true,
  })

  registerSimple(server, context, 'set_options', {
    title: 'Change the settings',
    description:
      'Changes any of the settings get_options lists, several at once, each by its NiiVue name. ' +
      'A choice is given by its word (a drag mode, a pen shape, a render mode), a colour as ' +
      '[red, green, blue, alpha] 0 to 1. Every value is checked before any is set, so a bad one ' +
      'changes nothing. Reports the settings as they are afterwards.',
    inputSchema: SETTING_SCHEMAS.set_options,
  })

  registerSimple(server, context, 'capabilities', {
    title: "What the page's NiiVue can do",
    description:
      "Reports what this page's NiiVue offers: its backend, which tool features it supports " +
      '(by group), which settings it has, the colormaps and drawing colormaps it knows, its mesh ' +
      'shaders, the volume transforms it can run with their options, and the file types it ' +
      'reads and writes. Ask before using a tool a page may lack.',
    inputSchema: SETTING_SCHEMAS.capabilities,
    readOnly: true,
  })
}
