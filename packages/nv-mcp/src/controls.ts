/**
 * The controls an agent can put on the page: the vocabulary both ends
 * share. A control is a widget of one of the kinds the UIKit control
 * layer draws (a button, a toggle, a slider, a menu, a select, a
 * segmented row, a number or text field, a text area, a dialog, a color
 * control, a file picker), placed on the canvas by id. The server turns
 * the tool arguments into a `ControlSpec`; the page's `ControlSurface`
 * makes the widget and reports its `ControlState`.
 */

/** The kinds of control a page can host, as the UIKit widgets name them. */
export const CONTROL_KINDS = [
  'button',
  'toggle',
  'slider',
  'menu',
  'select',
  'segmented',
  'number',
  'text',
  'textarea',
  'dialog',
  'color',
  'file',
] as const

export type ControlKind = (typeof CONTROL_KINDS)[number]

/**
 * What a control holds: a toggle's checked state, a slider's or number
 * field's number, a text field's or select's string, a color's channels,
 * or nothing for a button, menu, dialog or file picker.
 */
export type ControlValue = boolean | number | string | number[] | null

/** An entry of a select, a segmented row, a menu, or a dialog's button row. */
export interface ControlOption {
  id: string
  label: string
  /** A menu item that shows a check mark, and whether it is on. */
  checked?: boolean
  /** A menu item in a radio group: one of the group is on at a time. */
  group?: string
  enabled?: boolean
}

/** A control as an agent asks for it. */
export interface ControlSpec {
  id: string
  kind: ControlKind
  /** The label beside or on the control; a dialog's title. */
  label?: string
  /** Where it goes, in canvas pixels from the top left. */
  x: number
  y: number
  width?: number
  value?: ControlValue
  /** For a slider or number field. */
  min?: number
  max?: number
  step?: number
  /** For a select, segmented row or menu: its entries; for a dialog: its buttons. */
  options?: ControlOption[]
  /** For a dialog: the text under its title. */
  message?: string
  /** For a text field or text area. */
  placeholder?: string
  maxLength?: number
  /** For a text area: the rows shown. */
  rows?: number
  /** For a file picker: the extensions it accepts, and whether several files may be chosen. */
  accept?: string
  multiple?: boolean
  /** For a color control: whether alpha is set too, and the palette swatches offered. */
  alpha?: boolean
  palette?: string[]
  enabled?: boolean
  /**
   * What the control drives, in the page's own vocabulary: a NiiVue
   * setting as get_options names them, or an action the page knows.
   */
  bind?: string
}

/** What `set_control` may change on a control that is already there. */
export type ControlPatch = Partial<Omit<ControlSpec, 'id' | 'kind'>>

/** A control as the page reports it: its spec, with the value it holds now. */
export interface ControlState extends ControlSpec {
  value: ControlValue
  enabled: boolean
}
