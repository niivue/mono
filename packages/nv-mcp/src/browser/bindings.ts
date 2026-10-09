/**
 * Controls that drive the page. `bindControls(surface, { view, actions })`
 * wraps a surface so a control's `bind` takes effect both ways: what the
 * person does with the control writes what it names, and a change made
 * anywhere else (an agent's `set_options`, a contrast drag) shows on the
 * control. A `bind` names one of:
 *
 * - a NiiVue setting, as `get_options` names it (`gamma`, `crosshairColor`);
 * - part of the view: `view.slice`, `view.layout`, `view.radiological`;
 * - a property of a loaded volume: `volume.0.opacity`, `volume.1.colormap`;
 * - a dialog to open, for a button or menu item: `dialog.<id>`;
 * - an action the page offers: `action.<name>`.
 *
 * Each is checked against the control's kind when it is bound, and fills in
 * what the agent left out: a slider's range, a select's options, the value
 * the control starts at. The values are read again before every frame the
 * surface draws, or before the controls are listed when it draws none.
 */

import type {
  ControlKind,
  ControlOption,
  ControlSpec,
  ControlState,
  ControlValue,
} from '../controls'
import {
  coerceSetting,
  findSetting,
  readSetting,
  type Setting,
  settingChoices,
} from '../settings'
import { LAYOUTS, SLICE_TYPES } from '../views'
import {
  type BindingVocabulary,
  type ControlEvent,
  type ControlSurface,
  coerceValue,
  patched,
  settled,
  VALUE_KINDS,
} from './controls'
import type { ShownVolume, View, VolumeUpdate } from './view'

/** Something the page can do when a control is used, by name. */
export interface PageAction {
  /** What it does, in words, for the agent choosing one. */
  description: string
  /**
   * Does it. Gets the event: a button's press, a menu item chosen, a
   * value committed, files picked, the button that closed a dialog.
   */
  run(event: ControlEvent): unknown
}

export interface BindOptions {
  view: View
  /** The page's own actions, which `action.<name>` binds a control to. */
  actions?: Readonly<Record<string, PageAction>>
  /** Hears an action or a write that failed after the person used a control. */
  onError?(error: Error, event: ControlEvent): void
}

/** A surface whose controls drive what they are bound to. */
export interface BoundControls extends ControlSurface {
  /** Reads every bound value and shows the ones that changed. */
  sync(): void
  /** Stops listening to the surface it wraps. */
  dispose(): void
}

type Shape = 'boolean' | 'number' | 'string' | 'color'

/** What a `bind` resolved to. */
interface Target {
  /** The kind of value it takes, or `action` for one that runs on use. */
  shape: Shape | 'action'
  /** The strings it takes, when it takes only some. */
  choices?: readonly string[]
  min?: number
  max?: number
  step?: number
  /** Its value now; undefined when it cannot be read just now. */
  read?(): ControlValue | undefined
  /** Sets it, throwing in words before changing anything when it cannot; NiiVue may finish later. */
  write?(value: ControlValue): unknown
  action?: PageAction
}

/** The volume properties a control can bind, by the names `set_volume` takes. */
const VOLUME_PROPS: Record<
  string,
  {
    field: keyof VolumeUpdate & keyof ShownVolume
    shape: Shape
    range?: (volume: ShownVolume) => {
      min?: number
      max?: number
      step?: number
    }
    colormaps?: true
  }
> = {
  opacity: {
    field: 'opacity',
    shape: 'number',
    range: () => ({ min: 0, max: 1, step: 0.01 }),
  },
  colormap: { field: 'colormap', shape: 'string', colormaps: true },
  colormap_negative: {
    field: 'colormapNegative',
    shape: 'string',
    colormaps: true,
  },
  cal_min: { field: 'calMin', shape: 'number', range: intensityRange },
  cal_max: { field: 'calMax', shape: 'number', range: intensityRange },
  cal_min_neg: { field: 'calMinNeg', shape: 'number' },
  cal_max_neg: { field: 'calMaxNeg', shape: 'number' },
  frame: {
    field: 'frame4D',
    shape: 'number',
    range: (v) => ({
      min: 0,
      max: Math.max(0, (v.nFrame4D ?? 1) - 1),
      step: 1,
    }),
  },
  invert: { field: 'isColormapInverted', shape: 'boolean' },
  colorbar: { field: 'isColorbarVisible', shape: 'boolean' },
  nearest: { field: 'isNearestInterpolation', shape: 'boolean' },
  transparent_below_cal_min: {
    field: 'isTransparentBelowCalMin',
    shape: 'boolean',
  },
  atlas_outline: {
    field: 'atlasOutline',
    shape: 'number',
    range: () => ({ min: 0, max: 1, step: 0.01 }),
  },
  modulate_alpha: {
    field: 'modulateAlpha',
    shape: 'number',
    range: () => ({ min: 0 }),
  },
}

function intensityRange(volume: ShownVolume): { min?: number; max?: number } {
  const { globalMin, globalMax } = volume
  if (
    globalMin === undefined ||
    globalMax === undefined ||
    globalMin >= globalMax
  )
    return {}
  return { min: globalMin, max: globalMax }
}

/** The forms a `bind` takes, as `capabilities` reports them. */
const FORMS: BindingVocabulary['forms'] = [
  {
    form: '<setting>',
    description:
      'A NiiVue setting as get_options names it: a toggle for a true-or-false one, a slider or number field for a number, a select or segmented row for one with choices, a color control for a colour, a text field for text.',
  },
  {
    form: 'view.slice',
    description: `What the canvas shows, for a select or segmented row: ${Object.keys(SLICE_TYPES).join(', ')}.`,
  },
  {
    form: 'view.layout',
    description: `How the multiplanar tiles are arranged: ${Object.keys(LAYOUTS).join(', ')}.`,
  },
  {
    form: 'view.radiological',
    description: 'Whether the slices are drawn radiologically, for a toggle.',
  },
  {
    form: 'volume.<index>.<property>',
    description: `A property of a loaded volume, the base being 0: ${Object.keys(VOLUME_PROPS).join(', ')}.`,
  },
  {
    form: 'dialog.<id>',
    description:
      'Opens the dialog with that id, for a button or menu item. Add the dialog first with open: false, so it waits hidden until then.',
  },
  {
    form: 'action.<name>',
    description:
      'One of the actions listed. Any kind of control runs one: a button or menu item when pressed, a value control when its value is committed, a file picker with the files, a dialog with the button that closed it.',
  },
]

/** The kind of value a setting takes, or undefined for one no control holds. */
function settingShape(setting: Setting): Shape | undefined {
  switch (setting.kind) {
    case 'boolean':
      return 'boolean'
    case 'number':
    case 'integer':
      return 'number'
    case 'string':
    case 'enum':
    case 'choice':
      return 'string'
    case 'color':
      return 'color'
    default:
      return undefined
  }
}

/** A colour as plain numbers, so it compares and serializes as a list. */
function plainColor(value: unknown): number[] | undefined {
  if (!value || typeof value !== 'object' || !('length' in value))
    return undefined
  return Array.from(value as ArrayLike<number>, Number)
}

/** A named choice read from NiiVue's number, through a name table. */
function nameOf(
  table: Readonly<Record<string, number>>,
  n: unknown,
): string | undefined {
  for (const [name, value] of Object.entries(table))
    if (value === n) return name
  return undefined
}

/** What `bind` names on this page, or a throw in words saying what it may name. */
export function resolveBinding(
  bind: string,
  view: View,
  actions: Readonly<Record<string, PageAction>> = {},
): Target {
  const bag = view as unknown as Record<string, unknown>

  if (bind.startsWith('action.')) {
    const name = bind.slice('action.'.length)
    if (!Object.hasOwn(actions, name)) {
      const known = Object.keys(actions)
      throw new Error(
        known.length
          ? `This page has no action "${name}". It has: ${known.join(', ')}.`
          : 'This page offers no actions to bind a control to.',
      )
    }
    return { shape: 'action', action: actions[name] }
  }

  if (bind.startsWith('view.')) {
    const part = bind.slice('view.'.length)
    const table =
      part === 'slice' ? SLICE_TYPES : part === 'layout' ? LAYOUTS : undefined
    const key =
      part === 'slice'
        ? 'sliceType'
        : part === 'layout'
          ? 'multiplanarType'
          : part === 'radiological'
            ? 'isRadiological'
            : undefined
    if (!key)
      throw new Error(
        `There is no "${bind}": the view parts a control binds are view.slice, view.layout and view.radiological.`,
      )
    if (!(key in bag))
      throw new Error(`This page's NiiVue has no ${key} to bind a control to.`)
    if (!table)
      return {
        shape: 'boolean',
        read: () => Boolean(bag[key]),
        write: (value) => {
          if (typeof value !== 'boolean')
            throw new Error(`${bind} takes true or false.`)
          bag[key] = value
        },
      }
    return {
      shape: 'string',
      choices: Object.keys(table),
      read: () => nameOf(table, bag[key]),
      write: (value) => {
        if (typeof value !== 'string' || !Object.hasOwn(table, value))
          throw new Error(
            `${bind} takes one of ${Object.keys(table).join(', ')}.`,
          )
        bag[key] = table[value as keyof typeof table]
      },
    }
  }

  if (bind.startsWith('volume.')) {
    const [, which, prop, ...rest] = bind.split('.')
    const index = Number(which)
    const known = prop !== undefined && Object.hasOwn(VOLUME_PROPS, prop)
    if (!Number.isInteger(index) || index < 0 || !known || rest.length)
      throw new Error(
        `"${bind}" is not a volume binding: it takes the form volume.<index>.<property>, the property one of ${Object.keys(VOLUME_PROPS).join(', ')}.`,
      )
    const volume = view.volumes[index]
    if (!volume)
      throw new Error(
        `There is no volume ${index}: ${view.volumes.length} ${view.volumes.length === 1 ? 'is' : 'are'} loaded.`,
      )
    if (!view.setVolume)
      throw new Error("This page's NiiVue cannot change a volume's properties.")
    const setVolume = view.setVolume.bind(view)
    const { field, shape, range, colormaps } = VOLUME_PROPS[prop]
    const choices =
      colormaps && view.colormaps ? [...view.colormaps] : undefined
    return {
      shape,
      ...(choices ? { choices } : {}),
      ...(range ? range(volume) : {}),
      read: () => {
        const value = view.volumes[index]?.[field]
        return value === undefined ? undefined : (value as ControlValue)
      },
      write: (value) => {
        if (!view.volumes[index])
          throw new Error(`Volume ${index} is no longer loaded.`)
        check(bind, shape, value)
        if (choices && !choices.includes(value as string))
          throw new Error(
            `${bind} takes one of the colormaps: ${choices.join(', ')}.`,
          )
        return setVolume(index, { [field]: value } as VolumeUpdate)
      },
    }
  }

  if (bind.startsWith('dialog.'))
    throw new Error(
      `${bind} opens a dialog, which only bindControls can do: it needs the controls.`,
    )

  const setting = findSetting(bind)
  if (!setting)
    throw new Error(
      `There is nothing called "${bind}" to bind. A bind is a setting as get_options names it, view.slice, view.layout, view.radiological, volume.<index>.<property>, dialog.<id>, or action.<name>.`,
    )
  if (!(setting.name in bag))
    throw new Error(`This page's NiiVue has no ${setting.name} setting.`)
  const shape = settingShape(setting)
  if (!shape)
    throw new Error(
      `${setting.name} takes ${setting.kind === 'colors' ? 'a list of colours' : 'several numbers'}, which no control holds.`,
    )
  const name = setting.name
  const choices =
    setting.kind === 'enum' || setting.kind === 'choice'
      ? settingChoices(setting)
      : undefined
  return {
    shape,
    ...(choices ? { choices } : {}),
    ...(setting.min === undefined ? {} : { min: setting.min }),
    ...(setting.max === undefined ? {} : { max: setting.max }),
    ...(setting.kind === 'integer' ? { step: 1 } : {}),
    read: () => {
      const value = readSetting(setting, bag[name])
      if (shape === 'color') return plainColor(value)
      return value as ControlValue
    },
    write: (value) => {
      let given: unknown = value
      // A colour control without alpha keeps the alpha the setting has.
      if (shape === 'color' && Array.isArray(value) && value.length === 3) {
        const alpha = plainColor(bag[name])?.[3] ?? 1
        given = [...value, alpha]
      }
      bag[name] = coerceSetting(setting, given)
    },
  }
}

/** Throws in words unless `value` is of the shape `bind` takes. */
function check(bind: string, shape: Shape, value: ControlValue): void {
  const ok =
    shape === 'boolean'
      ? typeof value === 'boolean'
      : shape === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : shape === 'color'
          ? Array.isArray(value) && value.length >= 3
          : typeof value === 'string'
  if (!ok) throw new Error(`${bind} takes ${article(shape)}.`)
}

function article(shape: Shape): string {
  return shape === 'boolean'
    ? 'true or false'
    : shape === 'number'
      ? 'a number'
      : shape === 'color'
        ? 'a colour'
        : 'a string'
}

/** The kinds that write while their value is still moving, not only once it is committed. */
const LIVE: ReadonlySet<ControlKind> = new Set(['slider', 'color'])

/**
 * The spec with what the target fills in, after checking the kind can hold
 * what it takes. Throws in words when it cannot.
 */
function fitted(spec: ControlSpec, target: Target, bind: string): ControlSpec {
  if (target.shape === 'action') return spec
  const holds = VALUE_KINDS[spec.kind]
  if (holds === 'none')
    throw new Error(
      `A ${spec.kind} holds no value, so it can only be bound to an action: action.<name>.`,
    )
  if (holds !== target.shape)
    throw new Error(
      `${bind} takes ${article(target.shape)}, which a ${spec.kind} does not hold.`,
    )
  const out: ControlSpec = { ...spec }
  if (holds === 'number') {
    if (out.min === undefined && target.min !== undefined) out.min = target.min
    if (out.max === undefined && target.max !== undefined) out.max = target.max
    if (out.step === undefined && target.step !== undefined)
      out.step = target.step
  }
  if (target.choices && (spec.kind === 'select' || spec.kind === 'segmented')) {
    if (!out.options?.length)
      out.options = target.choices.map(
        (id): ControlOption => ({ id, label: id }),
      )
    else {
      const stray = out.options.filter((o) => !target.choices?.includes(o.id))
      if (stray.length)
        throw new Error(
          `${bind} takes ${target.choices.join(', ')}; ${stray.map((o) => o.id).join(', ')} ${stray.length === 1 ? 'is' : 'are'} not among them.`,
        )
    }
  }
  return out
}

/** Whether two values are the same, colours channel by channel. */
function same(
  a: ControlValue | undefined,
  b: ControlValue | undefined,
): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) < 1e-9
  return a === b
}

/** A value read from a target, as the control can show it, or undefined when it cannot. */
function shown(
  spec: ControlSpec,
  value: ControlValue | undefined,
): ControlValue | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return coerceValue(spec, value)
  } catch {
    return undefined
  }
}

interface Bound {
  bind: string
  target: Target
  /** The target's value as last read, so only a change is shown. */
  last: ControlValue | undefined
}

/**
 * `surface` with its controls' `bind` acted on, over `options.view` and
 * the page's `options.actions`. See the module comment for what a bind names.
 */
export function bindControls(
  surface: ControlSurface,
  options: BindOptions,
): BoundControls {
  const { view } = options
  const actions = options.actions ?? {}
  const bound = new Map<string, Bound>()
  const fail = (error: unknown, event: ControlEvent) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (options.onError) options.onError(err, event)
    else console.error(`Control ${event.id}:`, err)
  }
  /** Hears a write NiiVue finishes later failing, as `fail` hears one that throws now. */
  const settle = (done: unknown, event: ControlEvent) => {
    if (done instanceof Promise) done.catch((error) => fail(error, event))
  }
  const find = (id: string) => surface.list().find((c) => c.id === id)

  /** The dialog `id` names, or a throw in words when there is none. */
  const dialogOf = (id: string) => {
    const control = find(id)
    if (control?.kind === 'dialog') return control
    throw new Error(
      control
        ? `"${id}" is a ${control.kind}, not a dialog.`
        : `There is no dialog "${id}". Add it first, with open: false to keep it hidden until the control opens it.`,
    )
  }

  /** What `bind` names: a dialog to open here, anything else as `resolveBinding` finds it. */
  const resolve = (bind: string): Target => {
    if (!bind.startsWith('dialog.')) return resolveBinding(bind, view, actions)
    const id = bind.slice('dialog.'.length).trim()
    dialogOf(id)
    return {
      shape: 'action',
      action: {
        description: `Opens the dialog "${id}".`,
        run() {
          dialogOf(id)
          surface.update(id, { open: true })
          view.drawScene()
        },
      },
    }
  }

  const sync = () => {
    for (const [id, entry] of bound) {
      const now = entry.target.read?.()
      if (now === undefined || same(now, entry.last)) continue
      entry.last = now
      const control = find(id)
      if (!control) continue
      const value = shown(control, now)
      if (value === undefined || same(value, control.value)) continue
      surface.update(id, { value })
    }
  }

  const heard = (event: ControlEvent) => {
    const entry = bound.get(event.id)
    if (!entry) return
    const { target } = entry
    if (target.action) {
      if (event.type === 'input') return
      try {
        settle(target.action.run(event), event)
      } catch (error) {
        fail(error, event)
      }
      return
    }
    if (event.value === undefined || !target.write) return
    const control = find(event.id)
    if (event.type === 'input' && !(control && LIVE.has(control.kind))) return
    try {
      settle(target.write(control ? control.value : event.value), event)
      entry.last = target.read?.()
      view.drawScene()
    } catch (error) {
      fail(error, event)
    }
  }

  const unlisten = surface.listen?.(heard)
  const unframe = surface.onFrame?.(sync)

  const remember = (id: string, bind: string, target: Target) => {
    bound.set(id, { bind, target, last: target.read?.() })
  }

  return {
    add(spec) {
      if (!spec.bind) return surface.add(spec)
      if (find(spec.id))
        throw new Error(
          `There is already a control with the id "${spec.id}". Use set_control to change it or remove_control first.`,
        )
      const target = resolve(spec.bind)
      const filled = fitted(spec, target, spec.bind)
      // Placed first: a refused cell must leave what it drives untouched.
      settled(filled, surface.list())
      const given = spec.value
      if (given !== undefined && given !== null) {
        // The agent's value is set on what the control drives first, so a
        // bad one leaves nothing behind.
        const value = coerceValue(filled, given)
        settle(target.write?.(value), { id: spec.id, type: 'change', value })
        filled.value = value
      } else {
        const now = shown(filled, target.read?.())
        if (now !== undefined) filled.value = now
      }
      const control = surface.add(filled)
      remember(control.id, spec.bind, target)
      if (given !== undefined && given !== null) view.drawScene()
      return control
    },

    update(id, patch) {
      const was = find(id)
      if (!was) throw new Error(`There is no control with the id "${id}".`)
      let entry = bound.get(id)
      const next = { ...patch }
      const rebinding = patch.bind !== undefined && patch.bind !== entry?.bind
      let target = entry?.target
      if (rebinding) {
        if (patch.bind) {
          target = resolve(patch.bind)
          const merged = fitted({ ...was, ...patch }, target, patch.bind)
          for (const key of ['min', 'max', 'step'] as const)
            if (merged[key] !== undefined) next[key] = merged[key]
          if (merged.options && !patch.options) next.options = merged.options
        } else {
          target = undefined
        }
      }
      const after = patched(was, next)
      settled(
        after,
        surface.list().filter((c) => c.id !== id),
      )
      if (target?.write && patch.value !== undefined)
        settle(target.write(after.value), {
          id,
          type: 'change',
          value: after.value,
        })
      if (rebinding && target && patch.value === undefined) {
        const now = shown(after, target.read?.())
        if (now !== undefined) next.value = now
      }
      const control = surface.update(id, next)
      if (rebinding) {
        if (target && patch.bind) remember(id, patch.bind, target)
        else bound.delete(id)
        entry = bound.get(id)
      }
      if (entry && patch.value !== undefined) {
        entry.last = entry.target.read?.()
        view.drawScene()
      }
      return control
    },

    remove(id) {
      bound.delete(id)
      surface.remove(id)
    },

    clear() {
      bound.clear()
      surface.clear()
    },

    list(): ControlState[] {
      // Read again here too: a surface nobody draws has no frames.
      sync()
      return surface.list()
    },

    ...(surface.listen ? { listen: surface.listen.bind(surface) } : {}),
    ...(surface.onFrame ? { onFrame: surface.onFrame.bind(surface) } : {}),

    bindings() {
      return {
        forms: FORMS,
        actions: Object.entries(actions).map(([name, action]) => ({
          name,
          description: action.description,
        })),
      }
    },

    sync,

    dispose() {
      unlisten?.()
      unframe?.()
    },
  }
}
