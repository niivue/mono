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
 * - a property of a loaded mesh, or an option of a tract or connectome:
 *   `mesh.0.opacity`, `mesh.0.tract.fiberRadius`, `mesh.1.connectome.nodeScale`;
 * - a dialog to open, for a button or menu item: `dialog.<id>`;
 * - data to load from the page's palette: `data.<id>`;
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
  VALUE_KINDS,
} from './controls'
import type { DataPalette } from './data'
import type {
  MeshUpdate,
  ShownMesh,
  ShownVolume,
  View,
  VolumeUpdate,
} from './view'

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
  /** The page's data palette, which `data.<id>` loads from. */
  data?: DataPalette
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
  /** Sets it, throwing in words before changing anything when it cannot. */
  write?(value: ControlValue): void
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

/** The mesh properties a control can bind, by the names `set_mesh` takes. */
const MESH_PROPS: Record<
  string,
  {
    field: keyof MeshUpdate & keyof ShownMesh
    shape: Shape
    range?: { min?: number; max?: number; step?: number }
    shaders?: true
    /** What NiiVue takes the property to be while it is unset. */
    unset?: ControlValue
  }
> = {
  opacity: {
    field: 'opacity',
    shape: 'number',
    range: { min: 0, max: 1, step: 0.01 },
  },
  shader: { field: 'shaderType', shape: 'string', shaders: true },
  // NiiVue draws a mesh unless visible is false.
  visible: { field: 'visible', shape: 'boolean', unset: true },
  colorbar: { field: 'isColorbarVisible', shape: 'boolean' },
  legend: { field: 'isLegendVisible', shape: 'boolean' },
}

/** One option of a tract or connectome, as a control holds it. */
interface MeshOption {
  shape: Shape
  min?: number
  /** A slider's end when it is left without one: the range NiiVue's own examples give. */
  max?: number
  step?: number
  colormaps?: true
  /** A colour NiiVue keeps as channels 0 to 255, which a control holds 0 to 1. */
  bytes?: true
}

/** NiiVue's `NVTractOptions` a control can hold, by the names `set_mesh` takes. */
const TRACT_PROPS: Record<string, MeshOption> = {
  fiberRadius: { shape: 'number', min: 0, max: 3, step: 0.1 },
  fiberSides: { shape: 'number', min: 3, max: 20, step: 1 },
  minLength: { shape: 'number', min: 0 },
  decimation: { shape: 'number', min: 1, max: 20, step: 1 },
  colormap: { shape: 'string', colormaps: true },
  colormapNegative: { shape: 'string', colormaps: true },
  colorBy: { shape: 'string' },
  calMin: { shape: 'number' },
  calMax: { shape: 'number' },
  calMinNeg: { shape: 'number' },
  calMaxNeg: { shape: 'number' },
  fixedColor: { shape: 'color', bytes: true },
}

/** NiiVue's `NVConnectomeOptions` a control can hold, by the names `set_mesh` takes. */
const CONNECTOME_PROPS: Record<string, MeshOption> = {
  nodeColormap: { shape: 'string', colormaps: true },
  nodeColormapNegative: { shape: 'string', colormaps: true },
  nodeMinColor: { shape: 'number' },
  nodeMaxColor: { shape: 'number' },
  nodeScale: { shape: 'number', min: 0, max: 10, step: 0.5 },
  edgeColormap: { shape: 'string', colormaps: true },
  edgeColormapNegative: { shape: 'string', colormaps: true },
  edgeMin: { shape: 'number' },
  edgeMax: { shape: 'number' },
  edgeScale: { shape: 'number', min: 0, max: 5, step: 0.1 },
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
    form: 'mesh.<index>.<property>',
    description: `A property of a loaded mesh, the base being 0: ${Object.keys(MESH_PROPS).join(', ')}.`,
  },
  {
    form: 'mesh.<index>.tract.<option>',
    description: `An option of a loaded tract, as set_mesh names it: ${Object.keys(TRACT_PROPS).join(', ')}.`,
  },
  {
    form: 'mesh.<index>.connectome.<option>',
    description: `An option of a loaded connectome, as set_mesh names it: ${Object.keys(CONNECTOME_PROPS).join(', ')}.`,
  },
  {
    form: 'dialog.<id>',
    description:
      'Opens the dialog with that id, for a button or menu item. Add the dialog first with open: false, so it waits hidden until then.',
  },
  {
    form: 'data.<id>',
    description:
      'Loads that entry of the data palette (list_data), for a button or menu item. add_data puts more there.',
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
        void setVolume(index, { [field]: value } as VolumeUpdate)
      },
    }
  }

  if (bind.startsWith('mesh.')) return meshTarget(bind, view)

  if (bind.startsWith('dialog.'))
    throw new Error(
      `${bind} opens a dialog, which only bindControls can do: it needs the controls.`,
    )

  if (bind.startsWith('data.'))
    throw new Error(
      `${bind} loads from the data palette, which only bindControls can do: it needs the palette.`,
    )

  const setting = findSetting(bind)
  if (!setting)
    throw new Error(
      `There is nothing called "${bind}" to bind. A bind is a setting as get_options names it, view.slice, view.layout, view.radiological, volume.<index>.<property>, mesh.<index>.<property>, mesh.<index>.tract.<option>, mesh.<index>.connectome.<option>, dialog.<id>, data.<id>, or action.<name>.`,
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

/** What a `mesh.` bind names, or a throw in words saying what it may name. */
function meshTarget(bind: string, view: View): Target {
  const [, which, part, option, ...rest] = bind.split('.')
  const index = Number(which)
  const group = part === 'tract' || part === 'connectome' ? part : undefined
  const table =
    group === 'tract'
      ? TRACT_PROPS
      : group === 'connectome'
        ? CONNECTOME_PROPS
        : undefined
  const name = group ? option : part
  const known =
    name !== undefined &&
    (table
      ? Object.hasOwn(table, name) && rest.length === 0
      : Object.hasOwn(MESH_PROPS, name) && option === undefined)
  if (!Number.isInteger(index) || index < 0 || !known)
    throw new Error(
      `"${bind}" is not a mesh binding: it takes the form mesh.<index>.<property> (${Object.keys(MESH_PROPS).join(', ')}), ` +
        `mesh.<index>.tract.<option> (${Object.keys(TRACT_PROPS).join(', ')}) or ` +
        `mesh.<index>.connectome.<option> (${Object.keys(CONNECTOME_PROPS).join(', ')}).`,
    )
  const meshes = view.meshes ?? []
  const mesh = meshes[index]
  if (!mesh)
    throw new Error(
      `There is no mesh ${index}: ${meshes.length} ${meshes.length === 1 ? 'is' : 'are'} loaded.`,
    )
  const gone = () => {
    if (!view.meshes?.[index])
      throw new Error(`Mesh ${index} is no longer loaded.`)
  }

  if (!group || !table) {
    if (!view.setMesh)
      throw new Error("This page's NiiVue cannot change a mesh once loaded.")
    const setMesh = view.setMesh.bind(view)
    const { field, shape, range, shaders, unset } = MESH_PROPS[name]
    const choices =
      shaders && view.meshShaders ? [...view.meshShaders] : undefined
    return {
      shape,
      ...(choices ? { choices } : {}),
      ...range,
      read: () => {
        const value = view.meshes?.[index]?.[field]
        return value === undefined ? unset : (value as ControlValue)
      },
      write: (value) => {
        gone()
        check(bind, shape, value)
        if (choices && !choices.includes(value as string))
          throw new Error(
            `${bind} takes one of the mesh shaders: ${choices.join(', ')}.`,
          )
        void setMesh(index, { [field]: value } as MeshUpdate)
      },
    }
  }

  if (mesh.kind && mesh.kind !== group)
    throw new Error(
      `${mesh.name ?? `Mesh ${index}`} is a ${mesh.kind}, not a ${group}.`,
    )
  const set =
    group === 'tract' ? view.setTractOptions : view.setConnectomeOptions
  if (!set)
    throw new Error(`This page's NiiVue cannot change how ${group}s are drawn.`)
  const setOptions = set.bind(view)
  const key = group === 'tract' ? 'tractOptions' : 'connectomeOptions'
  const { shape, min, max, step, colormaps, bytes } = table[name]
  const choices = colormaps && view.colormaps ? [...view.colormaps] : undefined
  return {
    shape,
    ...(choices ? { choices } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
    read: () => {
      const value = view.meshes?.[index]?.[key]?.[name]
      if (value === undefined || value === null) return undefined
      if (shape === 'color') {
        const channels = plainColor(value)
        return bytes ? channels?.map((c) => c / 255) : channels
      }
      return value as ControlValue
    },
    write: (value) => {
      gone()
      check(bind, shape, value)
      if (choices && !choices.includes(value as string))
        throw new Error(
          `${bind} takes one of the colormaps: ${choices.join(', ')}.`,
        )
      let given: unknown = value
      if (shape === 'color' && Array.isArray(value)) {
        // A colour control without alpha keeps the alpha the option has.
        const had = plainColor(view.meshes?.[index]?.[key]?.[name])
        const rgba = [...value.slice(0, 3), value[3] ?? (had?.[3] ?? 255) / 255]
        given = bytes ? rgba.map((c) => Math.round(c * 255)) : rgba
      }
      void setOptions(index, { [name]: given })
    },
  }
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

  /** The palette entry `id` names, or a throw in words when there is none. */
  const entryOf = (id: string) => {
    if (!options.data)
      throw new Error('This page has no data palette to load from.')
    const entry = options.data.get(id)
    if (entry) return { palette: options.data, entry }
    const known = options.data.list().map((e) => e.id)
    throw new Error(
      known.length
        ? `There is no data "${id}". There is: ${known.join(', ')}. add_data puts more there.`
        : `There is no data "${id}": the palette is empty. add_data puts an entry there.`,
    )
  }

  /** What `bind` names: a dialog to open or data to load here, anything else as `resolveBinding` finds it. */
  const resolve = (bind: string): Target => {
    if (bind.startsWith('data.')) {
      const id = bind.slice('data.'.length)
      const { entry } = entryOf(id)
      return {
        shape: 'action',
        action: {
          description: `Loads ${entry.label}.`,
          run: () => entryOf(id).palette.load(id),
        },
      }
    }
    if (!bind.startsWith('dialog.')) return resolveBinding(bind, view, actions)
    const id = bind.slice('dialog.'.length)
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
        const done = target.action.run(event)
        if (done instanceof Promise) done.catch((error) => fail(error, event))
      } catch (error) {
        fail(error, event)
      }
      return
    }
    if (event.value === undefined || !target.write) return
    const control = find(event.id)
    if (event.type === 'input' && !(control && LIVE.has(control.kind))) return
    try {
      target.write(control ? control.value : event.value)
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
      const given = spec.value
      if (given !== undefined && given !== null) {
        // The agent's value is set on what the control drives first, so a
        // bad one leaves nothing behind.
        const value = coerceValue(filled, given)
        target.write?.(value)
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
      if (target?.write && patch.value !== undefined) target.write(after.value)
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
