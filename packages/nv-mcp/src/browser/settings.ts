/**
 * NiiVue's settings, and what the page's NiiVue can do.
 *
 * `set_options` and `get_options` reach the hundred or so plain settings
 * the `SETTINGS` table names, by NiiVue's own property names, with an
 * agent's words turned into NiiVue's numbers and back. `capabilities`
 * says which of the optional `View` members this page's NiiVue has, so
 * an agent knows what to ask for before it asks.
 */

import {
  coerceSetting,
  findSetting,
  readSetting,
  SETTINGS,
  type Setting,
  settingChoices,
} from '../settings'
import { flag, nothingIn, type Params, record, strings } from './params'
import type { Handlers, NiiVueHost, View } from './view'

/** A setting as `get_options` reports it. */
function describeSetting(setting: Setting): Record<string, unknown> {
  const choices =
    setting.kind === 'enum' || setting.kind === 'choice'
      ? { choices: settingChoices(setting) }
      : {}
  const bounds = {
    ...(setting.min === undefined ? {} : { min: setting.min }),
    ...(setting.max === undefined ? {} : { max: setting.max }),
  }
  return {
    kind: setting.kind,
    ...choices,
    ...bounds,
    description: setting.description,
  }
}

/** The optional `View` members, grouped as the tools are, so `capabilities` can say which are there. */
const FEATURES: Record<string, ReadonlyArray<keyof View>> = {
  volumes: [
    'setVolume',
    'setColormapLabel',
    'removeVolume',
    'removeAllVolumes',
    'moveVolumeUp',
    'getDescriptives',
    'recalculateCalMinMax',
    'loadDeferred4DVolumes',
    'setModulationImage',
    'getVolumeAffine',
    'setVolumeAffine',
    'applyVolumeTransform',
    'volumeTransform',
    'vox2frac',
    'moveCrosshairInVox',
  ],
  view: ['sliceType', 'customLayout'],
  camera: [
    'setClipPlanes',
    'setClipPlaneDepthAziElev',
    'setGlobalCamera',
    'centerRenderOnMM',
    'pan2Dxyzmm',
    'renderPan',
    'renderPivotMM',
  ],
  colormaps: [
    'colormaps',
    'addColormap',
    'addColormapFromUrl',
    'setFontFromUrl',
  ],
}

/** The handlers for the settings and capability tools. */
export function settingHandlers(host: NiiVueHost): Handlers {
  const { view } = host
  // The settings are plain properties of the instance; the table says
  // which names are settings, so nothing else on it can be reached.
  const bag = view as unknown as Record<string, unknown>

  const readAll = (names: readonly Setting[]) => {
    const out: Record<string, unknown> = {}
    for (const setting of names) {
      if (!(setting.name in bag)) continue
      out[setting.name] = readSetting(setting, bag[setting.name])
    }
    return out
  }

  return {
    get_options(params: Params) {
      host.beforeAnswer?.()
      const wanted = strings(params, 'names')
      const describe = flag(params, 'describe') ?? !wanted
      const chosen = wanted
        ? wanted.map((name) => {
            const setting = findSetting(name)
            if (!setting) throw new Error(unknownSetting(name))
            return setting
          })
        : SETTINGS
      const values = readAll(chosen)
      if (!describe) return { options: values }
      const settings: Record<string, unknown> = {}
      for (const setting of chosen) {
        if (!(setting.name in values) && wanted)
          throw new Error(`This page's NiiVue has no ${setting.name} setting.`)
        settings[setting.name] = {
          ...(setting.name in values ? { value: values[setting.name] } : {}),
          ...describeSetting(setting),
        }
      }
      return { options: settings }
    },

    set_options(params: Params) {
      host.beforeAnswer?.()
      const wanted = record(params, 'options')
      if (!wanted || nothingIn(wanted))
        throw new Error(
          'set_options needs options: a setting name to a value each.',
        )
      // Every value is checked before any is set, so a bad one changes nothing.
      const checked: Array<[Setting, unknown]> = []
      for (const [name, value] of Object.entries(wanted)) {
        const setting = findSetting(name)
        if (!setting) throw new Error(unknownSetting(name))
        if (!(name in bag))
          throw new Error(`This page's NiiVue has no ${name} setting.`)
        checked.push([setting, coerceSetting(setting, value)])
      }
      for (const [setting, value] of checked) bag[setting.name] = value
      view.drawScene()
      return { options: readAll(checked.map(([setting]) => setting)) }
    },

    capabilities() {
      host.beforeAnswer?.()
      const features: Record<string, string[]> = {}
      for (const [group, members] of Object.entries(FEATURES)) {
        const present = members.filter((m) => view[m] !== undefined)
        features[group] = present.map(String)
      }
      const transforms = (view.volumeTransforms ?? []).map((name) => {
        const info = view.getVolumeTransformInfo?.(name)
        return info
          ? { name, description: info.description, options: info.options }
          : { name }
      })
      return {
        ...(view.backend ? { backend: view.backend } : {}),
        features,
        settings: SETTINGS.filter((s) => s.name in bag).map((s) => s.name),
        ...(view.colormaps ? { colormaps: view.colormaps } : {}),
        ...(view.drawingColormaps
          ? { drawingColormaps: view.drawingColormaps }
          : {}),
        ...(transforms.length ? { volumeTransforms: transforms } : {}),
        ...(view.volumeExtensions
          ? { volumeExtensions: view.volumeExtensions }
          : {}),
        ...(view.meshExtensions ? { meshExtensions: view.meshExtensions } : {}),
        ...(view.volumeWriteExtensions
          ? { volumeWriteExtensions: view.volumeWriteExtensions }
          : {}),
        ...(view.meshWriteExtensions
          ? { meshWriteExtensions: view.meshWriteExtensions }
          : {}),
      }
    },
  }
}

function unknownSetting(name: string): string {
  return `There is no setting called "${name}". get_options lists them, with what each one takes.`
}
