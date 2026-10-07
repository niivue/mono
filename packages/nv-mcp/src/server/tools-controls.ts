/**
 * The tools that put controls on the page: a button, a toggle, a slider,
 * a menu, a select, a segmented row, a number or text field, a text
 * area, a dialog, a color control or a file picker, placed on the canvas
 * by id and bound to what the page knows how to drive.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { CONTROL_KINDS } from '../controls'
import { registerSimple } from './args'
import { TAB_ARG, type ToolContext } from './context'

const OPTION = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    checked: z
      .boolean()
      .optional()
      .describe('A menu item with a check mark, and whether it is on.'),
    group: z
      .string()
      .optional()
      .describe(
        'A menu item in a radio group: one of the group is on at a time.',
      ),
    enabled: z.boolean().optional(),
  }),
])

const VALUE = z
  .union([z.boolean(), z.number(), z.string(), z.array(z.number())])
  .describe(
    'What the control holds: true or false for a toggle, a number for a slider or number field, ' +
      "a string for a text field or an option's id for a select or segmented row, " +
      '[r, g, b] or [r, g, b, a] 0 to 1 for a color control.',
  )

/** The fields a control is made with, which set_control may also change. */
const FIELDS = {
  label: z
    .string()
    .optional()
    .describe("The label beside or on the control; a dialog's title."),
  width: z
    .number()
    .positive()
    .optional()
    .describe('The width in canvas pixels; the kind has a default.'),
  value: VALUE.optional(),
  min: z.number().optional().describe('For a slider or number field.'),
  max: z.number().optional().describe('For a slider or number field.'),
  step: z
    .number()
    .positive()
    .optional()
    .describe('For a slider or number field.'),
  options: z
    .array(OPTION)
    .optional()
    .describe(
      'For a select, segmented row or menu: its entries, each an id or {id, label, checked?, group?, enabled?}; for a dialog: its buttons.',
    ),
  placeholder: z
    .string()
    .optional()
    .describe('For a text field or text area: shown while empty.'),
  max_length: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('For a text field or text area.'),
  rows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('For a text area: the rows shown.'),
  accept: z
    .string()
    .optional()
    .describe(
      'For a file picker: the extensions accepted, like ".nii,.nii.gz".',
    ),
  multiple: z
    .boolean()
    .optional()
    .describe('For a file picker: whether several files may be chosen.'),
  alpha: z
    .boolean()
    .optional()
    .describe('For a color control: whether it sets alpha too.'),
  palette: z
    .array(z.string())
    .optional()
    .describe('For a color control: swatch colours offered, as CSS colours.'),
  enabled: z.boolean().optional(),
  bind: z
    .string()
    .optional()
    .describe(
      "What the control drives, in the page's own vocabulary: a NiiVue setting as get_options names " +
        'them (a toggle for a boolean, a slider for a number, a color control for a colour), or an action the page knows.',
    ),
}

export const CONTROL_SCHEMAS = {
  add_control: {
    ...TAB_ARG,
    id: z
      .string()
      .min(1)
      .describe('A name for the control, used to change or remove it later.'),
    kind: z.enum(CONTROL_KINDS).describe('What kind of control to make.'),
    x: z.number().describe('Where it goes, in canvas pixels from the left.'),
    y: z.number().describe('Where it goes, in canvas pixels from the top.'),
    ...FIELDS,
  },
  list_controls: { ...TAB_ARG },
  set_control: {
    ...TAB_ARG,
    id: z.string().min(1).describe('The control, as add_control named it.'),
    x: z.number().optional(),
    y: z.number().optional(),
    ...FIELDS,
  },
  remove_control: {
    ...TAB_ARG,
    id: z.string().min(1).optional().describe('The control to take away.'),
    all: z.boolean().optional().describe('Take every control away.'),
  },
} as const

export function registerControlTools(
  server: McpServer,
  context: ToolContext,
): void {
  registerSimple(server, context, 'add_control', {
    title: 'Add a control',
    description:
      'Puts a control on the canvas: a button, toggle, slider, menu, select, segmented row, number ' +
      'or text field, text area, dialog, color control or file picker, at a position, with a label, ' +
      'a value and the fields its kind takes. bind names what it drives. Reports the control as made. ' +
      'A page without a control surface declines.',
    inputSchema: CONTROL_SCHEMAS.add_control,
    lead: (result) => {
      const control = (result as { control?: { kind?: string; id?: string } })
        ?.control
      return control?.kind && control.id
        ? `Added the ${control.kind} "${control.id}".`
        : undefined
    },
  })

  registerSimple(server, context, 'list_controls', {
    title: 'List the controls',
    description:
      'Lists the controls on the canvas, each with its kind, position, label, value, options and what it is bound to.',
    inputSchema: CONTROL_SCHEMAS.list_controls,
    readOnly: true,
  })

  registerSimple(server, context, 'set_control', {
    title: 'Change a control',
    description:
      'Changes a control that is there: its value, label, position, options, range, enabled state or binding. ' +
      'Only what is given changes. Reports the control afterwards.',
    inputSchema: CONTROL_SCHEMAS.set_control,
  })

  registerSimple(server, context, 'remove_control', {
    title: 'Remove a control',
    description:
      'Takes one control off the canvas by id, or every control with all. Reports the controls that remain.',
    inputSchema: CONTROL_SCHEMAS.remove_control,
  })
}
