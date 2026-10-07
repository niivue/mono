/**
 * The tools that put controls on the page. The page keeps the widgets
 * behind a `ControlSurface`, which these handlers add to, change, list
 * and clear; a page with no surface declines in words. `memoryControls`
 * is a surface that only remembers: what a page without a widget layer
 * uses, and what the tests drive. `uikitControls` (in the `./uikit`
 * entry) draws them on the canvas, and `bindControls` (in `./bindings`)
 * makes a control drive what its `bind` names.
 */

import {
  CONTROL_KINDS,
  type ControlKind,
  type ControlOption,
  type ControlPatch,
  type ControlSpec,
  type ControlState,
  type ControlValue,
} from '../controls'
import {
  choice,
  color,
  flag,
  integer,
  number,
  type Params,
  strings,
  text,
} from './params'
import type { Handlers, NiiVueHost } from './view'

/**
 * What the person did with a control. `input` is a value still moving (a
 * slider being dragged, a field being typed in); `change` is a value
 * committed; `press` is a button clicked, a menu item chosen (`item`), a
 * dialog closed by one of its buttons (`item`, or null when dismissed) or
 * files picked (`files`).
 */
export interface ControlEvent {
  id: string
  type: 'input' | 'change' | 'press'
  value?: ControlValue
  item?: string | null
  files?: readonly File[]
}

export type ControlListener = (event: ControlEvent) => void

/** A target a control can be bound to, as `capabilities` lists them. */
export interface BindingVocabulary {
  /** The forms a `bind` takes, each with what it reaches. */
  forms: Array<{ form: string; description: string }>
  /** The page's own actions, by name. */
  actions: Array<{ name: string; description: string }>
}

/** What a page implements to host the controls an agent asks for. */
export interface ControlSurface {
  /** Makes the control and reports it. Throws when the id is taken or the spec cannot be drawn. */
  add(spec: ControlSpec): ControlState
  /** Changes a control that is there, reporting it afterwards. */
  update(id: string, patch: ControlPatch): ControlState
  /** Takes a control away; nothing happens when there is none by that id. */
  remove(id: string): void
  /** Takes every control away. */
  clear(): void
  /** The controls there now, in the order they were added. */
  list(): ControlState[]
  /**
   * Hears what the person does with the controls; returns the function
   * that stops hearing. A surface nobody can touch has none. The surface
   * keeps its own value current before it tells the listener.
   */
  listen?(listener: ControlListener): () => void
  /** Calls `callback` before each frame the surface draws; returns the function that stops it. */
  onFrame?(callback: () => void): () => void
  /** What a control's `bind` may name here, when the page binds controls. */
  bindings?(): BindingVocabulary
}

/** The kinds whose value is the kind of thing given. */
export const VALUE_KINDS: Record<
  ControlKind,
  'boolean' | 'number' | 'string' | 'color' | 'none'
> = {
  button: 'none',
  toggle: 'boolean',
  slider: 'number',
  menu: 'none',
  select: 'string',
  segmented: 'string',
  number: 'number',
  text: 'string',
  textarea: 'string',
  dialog: 'none',
  color: 'color',
  file: 'none',
}

/** The value a control of `kind` starts with when the agent gives none. */
export function defaultValue(spec: ControlSpec): ControlValue {
  switch (VALUE_KINDS[spec.kind]) {
    case 'boolean':
      return false
    case 'number':
      return spec.min ?? 0
    case 'string':
      return spec.options?.[0]?.id ?? ''
    case 'color':
      return spec.alpha ? [1, 1, 1, 1] : [1, 1, 1]
    default:
      return null
  }
}

/**
 * `value` checked and coerced for a control of `kind`: a number clamped
 * to its range and stepped, a choice that is one of the options, a colour
 * with the channels the control has. Throws in words otherwise.
 */
export function coerceValue(
  spec: Pick<
    ControlSpec,
    'kind' | 'min' | 'max' | 'step' | 'options' | 'alpha'
  >,
  value: unknown,
): ControlValue {
  const kind = VALUE_KINDS[spec.kind]
  if (value === undefined || value === null) {
    if (kind === 'none') return null
    throw new Error(`A ${spec.kind} needs a value.`)
  }
  switch (kind) {
    case 'none':
      throw new Error(`A ${spec.kind} holds no value.`)
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new Error(`A ${spec.kind} takes true or false.`)
      return value
    case 'number': {
      const n = Number(value)
      if (typeof value === 'boolean' || !Number.isFinite(n))
        throw new Error(`A ${spec.kind} takes a number.`)
      return stepped(n, spec.min, spec.max, spec.step)
    }
    case 'string': {
      if (typeof value !== 'string')
        throw new Error(`A ${spec.kind} takes a string.`)
      if (spec.options?.length && !spec.options.some((o) => o.id === value))
        throw new Error(
          `A ${spec.kind} takes one of its options: ${spec.options.map((o) => o.id).join(', ')}.`,
        )
      return value
    }
    case 'color': {
      const rgba = color({ value }, 'value')
      if (!rgba) throw new Error('A color takes [r, g, b] or [r, g, b, a].')
      return spec.alpha ? rgba : rgba.slice(0, 3)
    }
  }
}

function stepped(n: number, min?: number, max?: number, step?: number): number {
  let v = n
  if (step !== undefined && step > 0) {
    const base = min ?? 0
    v = base + Math.round((v - base) / step) * step
    // Keep the decimals the step has, so 0.1 steps do not drift.
    const decimals = (step.toString().split('.')[1] ?? '').length
    v = Number(v.toFixed(decimals))
  }
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

/** The options of a select, segmented row, menu or dialog as the tools take them. */
function options(params: Params, key = 'options'): ControlOption[] | undefined {
  const given = params?.[key]
  if (given === undefined || given === null) return undefined
  if (!Array.isArray(given)) throw new Error(`${key} must be a list.`)
  return given.map((item, i) => {
    if (typeof item === 'string') return { id: item, label: item }
    if (typeof item !== 'object' || item === null)
      throw new Error(
        `${key}[${i}] must be a string or an object with id and label.`,
      )
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : undefined
    const label = typeof record.label === 'string' ? record.label : id
    if (!id || !label)
      throw new Error(`${key}[${i}] needs an id (its label defaults to it).`)
    const out: ControlOption = { id, label }
    if (typeof record.checked === 'boolean') out.checked = record.checked
    if (typeof record.group === 'string') out.group = record.group
    if (typeof record.enabled === 'boolean') out.enabled = record.enabled
    return out
  })
}

/** The fields of a spec or a patch the tools take, from the params given. */
function fields(params: Params): ControlPatch {
  const out: ControlPatch = {}
  const label = text(params, 'label')
  if (label !== undefined) out.label = label
  for (const key of ['x', 'y', 'width', 'min', 'max', 'step'] as const) {
    const n = number(params, key)
    if (n !== undefined) out[key] = n
  }
  for (const key of ['row', 'col'] as const) {
    const n = integer(params, key)
    if (n !== undefined) out[key] = n
  }
  const opts = options(params)
  if (opts) out.options = opts
  const message = text(params, 'message')
  if (message !== undefined) out.message = message
  const placeholder = text(params, 'placeholder')
  if (placeholder !== undefined) out.placeholder = placeholder
  const maxLength = integer(params, 'max_length')
  if (maxLength !== undefined) out.maxLength = maxLength
  const rows = integer(params, 'rows')
  if (rows !== undefined) out.rows = rows
  const accept = text(params, 'accept')
  if (accept !== undefined) out.accept = accept
  const multiple = flag(params, 'multiple')
  if (multiple !== undefined) out.multiple = multiple
  const alpha = flag(params, 'alpha')
  if (alpha !== undefined) out.alpha = alpha
  const palette = strings(params, 'palette')
  if (palette) out.palette = palette
  const enabled = flag(params, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  const open = flag(params, 'open')
  if (open !== undefined) out.open = open
  // An empty bind unbinds the control.
  const bind = params?.bind === '' ? '' : text(params, 'bind')
  if (bind !== undefined) out.bind = bind
  return out
}

/** A surface in memory, with the person's side played by the caller. */
export interface MemoryControls extends ControlSurface {
  listen(listener: ControlListener): () => void
  onFrame(callback: () => void): () => void
  /** Acts as the person would: sets the control's value when the event has one, then tells the listeners. */
  simulate(event: ControlEvent): void
  /** Runs the frame callbacks, as a surface does before it draws. */
  frame(): void
}

/**
 * A surface that keeps the controls in memory and draws nothing: what a
 * page without a widget layer uses, and what the tests drive.
 * `onChange` hears every change with the controls as they are.
 */
export function memoryControls(
  options: { onChange?: (controls: ControlState[]) => void } = {},
): MemoryControls {
  const controls = new Map<string, ControlState>()
  const listeners = new Set<ControlListener>()
  const frames = new Set<() => void>()
  const changed = () => options.onChange?.([...controls.values()])
  const get = (id: string) => {
    const control = controls.get(id)
    if (!control) throw new Error(`There is no control with the id "${id}".`)
    return control
  }
  return {
    add(spec) {
      if (controls.has(spec.id))
        throw new Error(
          `There is already a control with the id "${spec.id}". Use set_control to change it or remove_control first.`,
        )
      const value =
        spec.value === undefined || spec.value === null
          ? defaultValue(spec)
          : coerceValue(spec, spec.value)
      const { open, ...rest } = spec
      const control: ControlState = settled(
        {
          ...rest,
          value,
          enabled: spec.enabled ?? true,
          // Only a dialog shows and hides; it is added open unless told not to be.
          ...(spec.kind === 'dialog' ? { open: open ?? true } : {}),
        },
        [...controls.values()],
      )
      controls.set(spec.id, control)
      changed()
      return control
    },
    update(id, patch) {
      const others = [...controls.values()].filter((c) => c.id !== id)
      const next = settled(patched(get(id), patch), others)
      controls.set(id, next)
      changed()
      return next
    },
    remove(id) {
      if (controls.delete(id)) changed()
    },
    clear() {
      if (controls.size === 0) return
      controls.clear()
      changed()
    },
    list() {
      return [...controls.values()]
    },
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onFrame(callback) {
      frames.add(callback)
      return () => frames.delete(callback)
    },
    simulate(event) {
      const control = get(event.id)
      if (event.value !== undefined) {
        controls.set(event.id, {
          ...control,
          value: coerceValue(control, event.value),
        })
        changed()
      } else if (control.kind === 'dialog' && event.type === 'press') {
        // A dialog is closed by the button the person picked, or dismissed.
        controls.set(event.id, { ...control, open: false })
        changed()
      }
      for (const listener of [...listeners]) listener(event)
    },
    frame() {
      for (const callback of [...frames]) callback()
    },
  }
}

/**
 * A control with a patch applied: a new value coerced to it, or the value
 * it holds coerced again when its options or range changed under it.
 */
export function patched(was: ControlState, patch: ControlPatch): ControlState {
  const { value, ...rest } = patch
  const next: ControlState = { ...was, ...rest }
  if (next.bind === '') delete next.bind
  if (next.kind !== 'dialog') delete next.open
  delete next.box
  // A move to a point leaves the grid, and a move to a cell joins it.
  if (patch.x !== undefined || patch.y !== undefined) {
    delete next.row
    delete next.col
  } else if (patch.row !== undefined || patch.col !== undefined) {
    delete next.x
    delete next.y
  }
  if (value !== undefined) next.value = coerceValue(next, value)
  else if (rest.options || rest.min !== undefined || rest.max !== undefined)
    next.value =
      VALUE_KINDS[next.kind] === 'none' ? null : coerceValue(next, was.value)
  return next
}

/** Whether a control goes in the grid: one placed at no point that is not a dialog. */
export function inGrid(c: ControlSpec): boolean {
  return c.kind !== 'dialog' && c.x === undefined && c.y === undefined
}

/**
 * A control's placement checked and completed: x and y together, or a
 * cell in the grid, whose column defaults to 0 and whose row to the one
 * under the last of `others` in that column. A dialog takes no cell.
 */
export function settled<T extends ControlSpec>(
  control: T,
  others: readonly ControlSpec[],
): T {
  const cell = control.row !== undefined || control.col !== undefined
  const point = control.x !== undefined || control.y !== undefined
  if (control.kind === 'dialog') {
    if (cell)
      throw new Error(
        'A dialog is centred, or placed with x and y; it takes no row or col.',
      )
  } else if (point && cell) {
    throw new Error(
      'Place a control with x and y, or with a row and col in the grid, not both.',
    )
  }
  if (point && (control.x === undefined || control.y === undefined))
    throw new Error('Give x and y together, or a row and col for the grid.')
  if (!inGrid(control)) return control
  const col = control.col ?? 0
  let row = control.row
  if (row === undefined) {
    row = 0
    for (const c of others)
      if (inGrid(c) && (c.col ?? 0) === col)
        row = Math.max(row, (c.row ?? 0) + 1)
  }
  return { ...control, row, col }
}

/** The handlers for the control tools, over the host's surface. */
export function controlHandlers(host: NiiVueHost): Handlers {
  const surface = () => {
    if (!host.controls)
      throw new Error('This page hosts no controls: it has no control surface.')
    return host.controls
  }
  const report = (control: ControlState) => ({ control })

  return {
    add_control(params: Params) {
      host.beforeAnswer?.()
      const kind = choice(params, 'kind', CONTROL_KINDS)
      if (!kind)
        throw new Error(
          `add_control needs a kind: one of ${CONTROL_KINDS.join(', ')}.`,
        )
      const id = text(params, 'id')
      if (!id) throw new Error('add_control needs an id for the control.')
      const spec: ControlSpec = { id, kind, ...fields(params) }
      if (params?.value !== undefined && params.value !== null)
        spec.value = coerceValue(spec, params.value)
      const control = surface().add(spec)
      host.view.drawScene()
      return report(control)
    },

    list_controls() {
      host.beforeAnswer?.()
      return { controls: surface().list() }
    },

    set_control(params: Params) {
      host.beforeAnswer?.()
      const id = text(params, 'id')
      if (!id) throw new Error('set_control needs the id of a control.')
      const patch = fields(params)
      if (params?.value !== undefined)
        patch.value = params.value as ControlValue
      if (Object.keys(patch).length === 0)
        throw new Error('set_control was given nothing to change.')
      const control = surface().update(id, patch)
      host.view.drawScene()
      return report(control)
    },

    remove_control(params: Params) {
      host.beforeAnswer?.()
      const all = flag(params, 'all') ?? false
      const id = text(params, 'id')
      if (!id && !all)
        throw new Error('remove_control needs an id, or all: true.')
      const controls = surface()
      if (all) controls.clear()
      else if (id) {
        if (!controls.list().some((c) => c.id === id))
          throw new Error(`There is no control with the id "${id}".`)
        controls.remove(id)
      }
      host.view.drawScene()
      return {
        ...(all ? { all: true } : { removed: id }),
        controls: controls.list(),
      }
    },
  }
}
