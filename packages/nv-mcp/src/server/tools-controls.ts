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
  row: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Its row in the grid, from 0 at the top. Rows are as tall as their tallest control, so ' +
        'controls in the grid never overlap, and a cell holds one control. Defaults to the row under ' +
        'the last control in its column.',
    ),
  col: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Its column in the grid, from 0 at the left; defaults to 0. Columns are as wide as their widest control.',
    ),
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
  message: z
    .string()
    .optional()
    .describe('For a dialog: the text under its title.'),
  open: z
    .boolean()
    .optional()
    .describe(
      'For a dialog: whether it shows. A dialog is added open unless this is false, and closes when ' +
        'the person picks one of its buttons. Set it true to show the dialog again, or bind a button to ' +
        'dialog.<id> so the person can open it.',
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
      'What the control drives, both ways: a NiiVue setting as get_options names it (a toggle for a ' +
        'boolean, a slider or number field for a number, a select or segmented row for one with choices, ' +
        'a color control for a colour); view.slice, view.layout or view.radiological; ' +
        'volume.<index>.<property> (opacity, colormap, cal_min, cal_max, frame, invert, ...); ' +
        'mesh.<index>.<property> (opacity, shader, visible, colorbar, legend); ' +
        'mesh.<index>.tract.<option> or mesh.<index>.connectome.<option>, the options set_mesh takes ' +
        '(fiberRadius, colorBy, nodeScale, ...), and mesh.<index>.tract.group for a select of the groups ' +
        'list_meshes reports (all, or one shown alone); dialog.<id>, for a button or menu item that opens ' +
        'that dialog; data.<id>, for a button or menu item that loads that entry of list_data; or action.<name>, one of the actions the page offers, which any kind of control can run. ' +
        'capabilities lists the forms and the actions under controlBindings. A bound control left ' +
        'without a range, options or value takes them from what it drives. An empty string unbinds it.',
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
    x: z
      .number()
      .optional()
      .describe(
        'An exact spot instead of the grid, in canvas pixels from the left; give y with it. ' +
          'Prefer row and col: the page knows the sizes of its widgets and you do not.',
      ),
    y: z
      .number()
      .optional()
      .describe(
        'An exact spot, in canvas pixels from the top; give x with it.',
      ),
    ...FIELDS,
  },
  list_controls: { ...TAB_ARG },
  set_control: {
    ...TAB_ARG,
    id: z.string().min(1).describe('The control, as add_control named it.'),
    x: z
      .number()
      .optional()
      .describe('Moves it to an exact spot, out of the grid; give y with it.'),
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
      'or text field, text area, dialog, color control or file picker, with a label, a value and the ' +
      'fields its kind takes. Place it in the grid with row and col (both optional: left out, it goes ' +
      'under the rest of column 0); the page sizes rows and columns to the widgets, so nothing overlaps. ' +
      'x and y place it at an exact spot instead. A dialog is centred and takes neither. ' +
      'bind names what it drives: when the person uses the control it sets what it names or runs the ' +
      'action, and a change made anywhere else shows on it. ' +
      'Reports the control as made, with the box it was drawn in, in canvas pixels. ' +
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
      'Lists the controls on the canvas, each with its kind, grid cell or position, the box it was ' +
      'drawn in (canvas pixels), label, value, options and what it is bound to.',
    inputSchema: CONTROL_SCHEMAS.list_controls,
    readOnly: true,
  })

  registerSimple(server, context, 'set_control', {
    title: 'Change a control',
    description:
      'Changes a control that is there: its value, label, grid cell or position, options, range, enabled state, binding, or whether a dialog shows. ' +
      'A row or col moves it into the grid; x and y move it out. ' +
      'Only what is given changes; a value given to a bound control sets what it drives too. ' +
      'Reports the control afterwards.',
    inputSchema: CONTROL_SCHEMAS.set_control,
  })

  registerSimple(server, context, 'remove_control', {
    title: 'Remove a control',
    description:
      'Takes one control off the canvas by id, or every control with all. Reports the controls that remain.',
    inputSchema: CONTROL_SCHEMAS.remove_control,
  })
}
