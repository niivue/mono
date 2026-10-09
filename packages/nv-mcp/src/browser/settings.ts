/**
 * NiiVue's settings, colormaps and fonts, and what the page's NiiVue can do.
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
import { SLICE_TYPES } from '../views'
import {
  flag,
  nothingIn,
  numbers,
  type Params,
  record,
  strings,
  text,
} from './params'
import type {
  ColormapToAdd,
  Handlers,
  LayoutTile,
  NiiVueHost,
  View,
} from './view'

/** The slice types a layout tile can show: every one but `none`. */
const TILE_SLICES = Object.keys(SLICE_TYPES).filter((name) => name !== 'none')

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
  view: [
    'sliceType',
    'customLayout',
    'setViewport',
    'setBounds',
    'hitTest',
    'canvasToMM',
    'mmToCanvas',
  ],
  camera: [
    'setClipPlanes',
    'setClipPlaneDepthAziElev',
    'setGlobalCamera',
    'centerRenderOnMM',
    'pan2Dxyzmm',
    'renderPan',
    'renderPivotMM',
  ],
  meshes: [
    'meshes',
    'addMesh',
    'setMesh',
    'removeMesh',
    'addMeshLayer',
    'setMeshLayerProperty',
    'setTractOptions',
    'setConnectomeOptions',
  ],
  signals: [
    'signals',
    'loadSignals',
    'addSignal',
    'setSignal',
    'removeSignal',
    'setSignalCursorFraction',
    'graphZoom',
    'setGraphRange',
  ],
  colormaps: [
    'colormaps',
    'addColormap',
    'addColormapFromUrl',
    'setFontFromUrl',
  ],
  drawing: [
    'createEmptyDrawing',
    'drawUndo',
    'closeDrawing',
    'loadDrawing',
    'saveDrawing',
    'drawingToSVG',
  ],
  annotations: [
    'annotations',
    'addAnnotation',
    'removeAnnotation',
    'selectAnnotation',
    'setAnnotationText',
    'annotationUndo',
    'getAnnotationsJSON',
    'loadAnnotationsJSON',
    'annotationsToSVG',
  ],
  measurements: [
    'getMeasurements',
    'addMeasurement',
    'removeMeasurement',
    'clearMeasurements',
  ],
  documents: [
    'saveDocument',
    'loadDocument',
    'saveVolume',
    'saveMesh',
    'saveBitmap',
  ],
  slide: [
    'setSlidePlaneLevel',
    'clearSlidePlane',
    'createSlideDrawing',
    'slideDrawUndo',
  ],
  chunks: [
    'chunkStreamStats',
    'chunkTimingStats',
    'lodCompensation',
    'rebakeChunkedOverlays',
  ],
}

/** The handlers for the settings, capability, colormap, font and layout tools. */
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
        ...(view.meshShaders ? { meshShaders: view.meshShaders } : {}),
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

    async add_colormap(params: Params) {
      host.beforeAnswer?.()
      const name = text(params, 'name')
      const url = text(params, 'url')
      if (url) {
        if (!view.addColormapFromUrl)
          throw new Error("This page's NiiVue cannot fetch a colormap.")
        try {
          await view.addColormapFromUrl(url, name)
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          throw new Error(`The colormap at ${url} could not be loaded: ${why}`)
        }
        return {
          name: name ?? url,
          ...(view.colormaps ? { colormaps: view.colormaps } : {}),
        }
      }
      if (!name)
        throw new Error('add_colormap needs a name, and R, G and B or a url.')
      if (!view.addColormap)
        throw new Error("This page's NiiVue cannot add a colormap.")
      const R = numbers(params, 'R')
      const G = numbers(params, 'G')
      const B = numbers(params, 'B')
      if (!R || !G || !B || R.length !== G.length || G.length !== B.length)
        throw new Error(
          'add_colormap needs R, G and B: lists of the same length, 0 to 255 each.',
        )
      const colormap: ColormapToAdd = { R, G, B }
      const A = numbers(params, 'A')
      const I = numbers(params, 'I')
      const labels = strings(params, 'labels')
      for (const [key, list] of [
        ['A', A],
        ['I', I],
        ['labels', labels],
      ] as const) {
        if (list && list.length !== R.length)
          throw new Error(`${key} must be as long as R, G and B (${R.length}).`)
      }
      if (A) colormap.A = A
      if (I) colormap.I = I
      if (labels) colormap.labels = labels
      const added = view.addColormap(name, colormap)
      return {
        name: added,
        ...(view.colormaps ? { colormaps: view.colormaps } : {}),
      }
    },

    async set_font(params: Params) {
      host.beforeAnswer?.()
      if (!view.setFontFromUrl)
        throw new Error("This page's NiiVue cannot change its font.")
      const atlas = text(params, 'atlas')
      const metrics = text(params, 'metrics')
      if (!atlas || !metrics)
        throw new Error(
          'set_font needs atlas and metrics: the addresses of the font atlas PNG and its metrics JSON.',
        )
      const ok = await view.setFontFromUrl({ atlas, metrics })
      if (!ok) throw new Error(`The font at ${atlas} could not be loaded.`)
      view.drawScene()
      return { atlas, metrics }
    },

    set_custom_layout(params: Params) {
      host.beforeAnswer?.()
      if (!('customLayout' in view))
        throw new Error("This page's NiiVue has no custom layout.")
      if (flag(params, 'clear')) {
        if (view.clearCustomLayout) view.clearCustomLayout()
        else view.customLayout = null
        view.drawScene()
        return { layout: null }
      }
      const tiles = params?.tiles
      if (!Array.isArray(tiles) || !tiles.length)
        throw new Error('set_custom_layout needs tiles, or clear: true.')
      const layout: LayoutTile[] = tiles.map((tile, i) => {
        const t = record({ tile }, 'tile') ?? {}
        // A tile draws something, so `none` is not a tile.
        const slice = text(t, 'slice')?.toLowerCase()
        if (!slice || slice === 'none' || !Object.hasOwn(SLICE_TYPES, slice)) {
          throw new Error(
            `Tile ${i} needs a slice: one of ${TILE_SLICES.join(', ')}.`,
          )
        }
        const position = numbers(t, 'position', 4)
        if (!position || position.some((v) => v < 0 || v > 1))
          throw new Error(
            `Tile ${i} needs a position: [left, top, width, height], each 0 to 1.`,
          )
        const made: LayoutTile = {
          sliceType: SLICE_TYPES[slice as keyof typeof SLICE_TYPES],
          position: [position[0], position[1], position[2], position[3]],
        }
        const mm = t.mm
        if (mm !== undefined && mm !== null) {
          const n = Number(mm)
          if (!Number.isFinite(n))
            throw new Error(`Tile ${i}: mm must be a number.`)
          made.sliceMM = n
        }
        const fill = flag(t, 'fill')
        if (fill !== undefined) made.fill = fill
        return made
      })
      view.customLayout = layout
      view.drawScene()
      return { layout }
    },
  }
}

function unknownSetting(name: string): string {
  return `There is no setting called "${name}". get_options lists them, with what each one takes.`
}
