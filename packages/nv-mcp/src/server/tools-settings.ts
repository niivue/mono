/**
 * The tools on NiiVue itself: its settings, what it can do, its
 * colormaps, its font, and a custom tile layout.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { SLICE_NAMES } from '../views'
import { registerSimple } from './args'
import { TAB_ARG, type ToolContext } from './context'

const COLORMAP_LIST = z
  .array(z.number().min(0).max(255))
  .min(2)
  .describe('A channel of the colormap, one entry per stop, 0 to 255.')

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
  add_colormap: {
    ...TAB_ARG,
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The name the colormap goes by afterwards. Needed unless a url gives one.',
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Fetch the colormap from this address (a NiiVue colormap JSON) instead of R, G and B.',
      ),
    R: COLORMAP_LIST.optional(),
    G: COLORMAP_LIST.optional(),
    B: COLORMAP_LIST.optional(),
    A: z
      .array(z.number().min(0).max(255))
      .optional()
      .describe('Alpha per stop, 0 to 255. Opaque otherwise.'),
    I: z
      .array(z.number())
      .optional()
      .describe('Where each stop sits, 0 to 255. Spread evenly otherwise.'),
    labels: z
      .array(z.string())
      .optional()
      .describe('A name per stop, making the colormap a label table.'),
  },
  set_font: {
    ...TAB_ARG,
    atlas: z.string().min(1).describe("The address of the font's atlas PNG."),
    metrics: z
      .string()
      .min(1)
      .describe("The address of the font's metrics JSON."),
  },
  set_custom_layout: {
    ...TAB_ARG,
    tiles: z
      .array(
        z.object({
          slice: z
            .enum(SLICE_NAMES)
            .describe(
              'What the tile shows: a slice orientation or the render.',
            ),
          position: z
            .array(z.number().min(0).max(1))
            .length(4)
            .describe('[left, top, width, height] as fractions of the canvas.'),
          mm: z
            .number()
            .optional()
            .describe(
              'The slice position in millimetres. The crosshair otherwise.',
            ),
          fill: z
            .boolean()
            .optional()
            .describe(
              'Whether the slice fills the tile rather than keeping its aspect.',
            ),
        }),
      )
      .optional()
      .describe('The tiles, each placed on the canvas by fractions.'),
    clear: z
      .boolean()
      .optional()
      .describe('Drop the custom layout and go back to the ordinary one.'),
  },
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

  registerSimple(server, context, 'add_colormap', {
    title: 'Add a colormap',
    description:
      'Adds a colormap NiiVue can then draw a volume or mesh layer with: given as stops (R, G, B ' +
      'and optionally A, I and labels, all the same length), or fetched from a url as a NiiVue ' +
      'colormap JSON. Reports the name and the colormaps known afterwards.',
    inputSchema: SETTING_SCHEMAS.add_colormap,
  })

  registerSimple(server, context, 'set_font', {
    title: 'Change the font',
    description:
      'Loads the font NiiVue draws its text with, from an atlas PNG and a metrics JSON as ' +
      'msdf-bmfont-xml writes them.',
    inputSchema: SETTING_SCHEMAS.set_font,
  })

  registerSimple(server, context, 'set_custom_layout', {
    title: 'Lay out tiles by hand',
    description:
      'Places tiles on the canvas by hand, each a slice orientation or the render at a position ' +
      'given as fractions of the canvas, in place of the ordinary layout; `clear` goes back to it.',
    inputSchema: SETTING_SCHEMAS.set_custom_layout,
  })
}
