/**
 * Meshes: surfaces, tracts and connectomes, and the layers over them.
 *
 * A mesh is named on a tool as its index among those on show or by its
 * name, as a volume is; a layer by its index among the mesh's layers or
 * its name. As with volumes, only what was asked for goes to NiiVue.
 */

import { checkFits, fetchValues, isTyped, oneSource } from './liveData'
import {
  clamp,
  clearable,
  color,
  flag,
  integer,
  nameFromUrl,
  nothingIn,
  number,
  numbers,
  type Params,
  put,
  record,
  text,
} from './params'
import { pickIndex } from './pick'
import type {
  Handlers,
  MeshLayerToLoad,
  MeshLayerUpdate,
  MeshToLoad,
  MeshUpdate,
  NiiVueHost,
  ShownMesh,
  ShownMeshLayer,
} from './view'

/** A layer as the tools report it. */
function describeLayer(layer: ShownMeshLayer, index: number) {
  const windowed = layer.calMin !== undefined && layer.calMax !== undefined
  const spanned = layer.globalMin !== undefined && layer.globalMax !== undefined
  const frames = layer.nFrame4D ?? 1
  return {
    index,
    ...(layer.name ? { name: layer.name } : {}),
    ...(layer.colormap ? { colormap: layer.colormap } : {}),
    ...(layer.colormapNegative
      ? { colormapNegative: layer.colormapNegative }
      : {}),
    ...(layer.opacity === undefined ? {} : { opacity: layer.opacity }),
    ...(windowed ? { calMin: layer.calMin, calMax: layer.calMax } : {}),
    ...(layer.calMinNeg !== undefined && layer.calMaxNeg !== undefined
      ? { calMinNeg: layer.calMinNeg, calMaxNeg: layer.calMaxNeg }
      : {}),
    ...(spanned
      ? { globalMin: layer.globalMin, globalMax: layer.globalMax }
      : {}),
    ...(frames > 1 ? { frame: layer.frame4D ?? 0, frames } : {}),
    ...(layer.isColormapInverted ? { inverted: true } : {}),
    ...(layer.isColorbarVisible ? { colorbar: true } : {}),
  }
}

/** A tract's scalars as `colorBy` names them, each with its range when NiiVue knows it. */
export interface TractScalar {
  colorBy: string
  min?: number
  max?: number
}

/** The colour modes every tract takes, as `colorBy` names them; `direction` stands for NiiVue's ''. */
export const TRACT_COLOR_MODES = ['direction', 'global', 'fixed'] as const

/** A tract's `colorBy` as the tools report it: NiiVue's '' and 'local' are both `direction`. */
export function reportedColorBy(value: unknown): unknown {
  return value === '' || value === 'local' ? 'direction' : value
}

/**
 * `colorBy` as NiiVue takes it. NiiVue reads a mode it does not know as a
 * scalar name and draws a scalar it cannot find white, reporting nothing, so
 * `direction` is translated to '' and a scalar must be one the tract has.
 */
function niivueColorBy(value: unknown, mesh: ShownMesh): string {
  if (value === 'direction') return ''
  if (
    value === '' ||
    value === 'local' ||
    value === 'global' ||
    value === 'fixed'
  )
    return value
  // Without the tract's data there is nothing to check a scalar against.
  const scalars = mesh.trx
    ? tractData(mesh).scalars.map((s) => s.colorBy)
    : undefined
  if (
    typeof value === 'string' &&
    /^(dpv|dps):./.test(value) &&
    (!scalars || scalars.includes(value))
  )
    return value
  const choices = [...TRACT_COLOR_MODES, ...(scalars ?? [])]
  throw new Error(
    `${mesh.name ?? 'The tract'} has no colorBy ${JSON.stringify(value)}. One of: ${choices.join(', ')}${
      scalars?.length === 0 ? ' (it has no scalars)' : ''
    }.`,
  )
}

/** A tract's groups and scalars, read off the data it was loaded with. */
export function tractData(mesh: ShownMesh): {
  groups: string[]
  scalars: TractScalar[]
} {
  const trx = mesh.trx
  const scalars = (kind: 'dpv' | 'dps'): TractScalar[] =>
    Object.keys(trx?.[kind] ?? {}).map((name) => {
      const meta = trx?.[`${kind}Meta`]?.[name]
      return {
        colorBy: `${kind}:${name}`,
        ...(Number.isFinite(meta?.globalMin) ? { min: meta?.globalMin } : {}),
        ...(Number.isFinite(meta?.globalMax) ? { max: meta?.globalMax } : {}),
      }
    })
  return {
    groups: Object.keys(trx?.groups ?? {}),
    scalars: [...scalars('dpv'), ...scalars('dps')],
  }
}

/** A mesh as the tools report it. */
export function describeMesh(mesh: ShownMesh, index: number) {
  const tract = mesh.kind === 'tract' && mesh.trx ? tractData(mesh) : undefined
  return {
    index,
    name: mesh.name ?? `mesh ${index}`,
    ...(mesh.kind ? { kind: mesh.kind } : {}),
    ...(mesh.url ? { url: mesh.url } : {}),
    ...(mesh.opacity === undefined ? {} : { opacity: mesh.opacity }),
    ...(mesh.color ? { color: Array.from(mesh.color) } : {}),
    ...(mesh.shaderType ? { shader: mesh.shaderType } : {}),
    ...(mesh.sliceShaderType ? { sliceShader: mesh.sliceShaderType } : {}),
    ...(mesh.visible === undefined ? {} : { visible: mesh.visible }),
    ...(mesh.isColorbarVisible ? { colorbar: true } : {}),
    ...(mesh.isLegendVisible ? { legend: true } : {}),
    ...(mesh.layers?.length ? { layers: mesh.layers.map(describeLayer) } : {}),
    ...(mesh.tractOptions
      ? {
          tract:
            'colorBy' in mesh.tractOptions
              ? {
                  ...mesh.tractOptions,
                  colorBy: reportedColorBy(mesh.tractOptions.colorBy),
                }
              : mesh.tractOptions,
        }
      : {}),
    ...(tract?.groups.length ? { groups: tract.groups } : {}),
    ...(tract?.scalars.length ? { scalars: tract.scalars } : {}),
    ...(mesh.connectomeOptions ? { connectome: mesh.connectomeOptions } : {}),
  }
}

/** The fields a layer takes on loading and on a change alike, read off `params`. */
function layerFields(params: Params): MeshLayerUpdate {
  const update: MeshLayerUpdate = {}
  put(update, 'colormap', text(params, 'colormap'))
  put(update, 'colormapNegative', clearable(params, 'colormap_negative'))
  put(update, 'calMin', number(params, 'cal_min'))
  put(update, 'calMax', number(params, 'cal_max'))
  put(update, 'calMinNeg', number(params, 'cal_min_neg'))
  put(update, 'calMaxNeg', number(params, 'cal_max_neg'))
  const opacity = number(params, 'opacity')
  if (opacity !== undefined) update.opacity = clamp(opacity, 0, 1)
  put(update, 'isColorbarVisible', flag(params, 'colorbar'))
  put(update, 'isColormapInverted', flag(params, 'invert'))
  put(
    update,
    'isTransparentBelowCalMin',
    flag(params, 'transparent_below_cal_min'),
  )
  put(update, 'isAdditiveBlend', flag(params, 'additive'))
  put(update, 'outlineWidth', number(params, 'outline_width'))
  if (
    update.calMin !== undefined &&
    update.calMax !== undefined &&
    update.calMin > update.calMax
  )
    throw new Error(
      `cal_min (${update.calMin}) must not be above cal_max (${update.calMax}).`,
    )
  return update
}

/** The handlers for the mesh tools. */
export function meshHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  const meshes = (): ReadonlyArray<ShownMesh> => {
    if (!view.meshes) throw new Error("This page's NiiVue has no meshes.")
    return view.meshes
  }
  const meshesShown = () => meshes().map(describeMesh)
  /** The error for a mesh NiiVue could not read, naming the formats it reads. */
  const unread = (url: string) => {
    const reads = view.meshExtensions?.length
      ? ` NiiVue reads meshes as ${view.meshExtensions.join(', ')}.`
      : ''
    return new Error(
      `The mesh at ${url} could not be loaded: NiiVue could not read it (the browser console says why).${reads}`,
    )
  }
  const meshIndex = (params: Params) =>
    pickIndex(meshes(), params?.mesh, 'mesh', 0)
  const layerIndex = (mesh: ShownMesh, params: Params) => {
    const layers = mesh.layers ?? []
    if (!layers.length)
      throw new Error(`${mesh.name ?? 'The mesh'} has no layers.`)
    return pickIndex(
      layers,
      params?.layer,
      'layer',
      layers.length === 1 ? 0 : undefined,
    )
  }
  const checkShader = (shader: string | undefined) => {
    if (shader === undefined || !view.meshShaders?.length) return
    if (!view.meshShaders.includes(shader)) {
      throw new Error(
        `Unknown mesh shader "${shader}". One of: ${view.meshShaders.join(', ')}.`,
      )
    }
  }

  return {
    async load_mesh(params: Params) {
      host.beforeAnswer?.()
      const url = text(params, 'url')
      if (!url) throw new Error('load_mesh needs a url.')
      const replace = flag(params, 'replace') ?? false
      if (!view.addMesh || !view.meshes)
        throw new Error("This page's NiiVue cannot load a mesh.")
      if (replace && !view.removeMesh)
        throw new Error("This page's NiiVue cannot replace its meshes.")
      const mesh: MeshToLoad = {
        url,
        name: text(params, 'name') ?? nameFromUrl(url),
      }
      const opacity = number(params, 'opacity')
      if (opacity !== undefined) mesh.opacity = clamp(opacity, 0, 1)
      put(mesh, 'color', color(params, 'color'))
      const shader = text(params, 'shader')
      checkShader(shader)
      put(mesh, 'shaderType', shader)
      put(mesh, 'sliceShaderType', clearable(params, 'slice_shader'))
      put(mesh, 'visible', flag(params, 'visible'))
      put(mesh, 'isColorbarVisible', flag(params, 'colorbar'))
      put(mesh, 'isLegendVisible', flag(params, 'legend'))
      const layers = params?.layers
      if (layers !== undefined && layers !== null) {
        if (!Array.isArray(layers)) throw new Error('layers must be a list.')
        mesh.layers = layers.map((layer, i) => {
          const fields = record({ layer }, 'layer') ?? {}
          const at = text(fields, 'url')
          if (!at) throw new Error(`Layer ${i} needs a url.`)
          const made: MeshLayerToLoad = { url: at, ...layerFields(fields) }
          put(made, 'name', text(fields, 'name'))
          return made
        })
      }
      // NiiVue's loadMeshes clears the scene before it fetches, so a
      // replacement adds first and drops the prior meshes only once the
      // new one is in: a failed load leaves the scene as it was.
      const prior = view.meshes.length
      try {
        await view.addMesh(mesh)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The mesh at ${url} could not be loaded: ${why}`)
      }
      // NiiVue logs a mesh it cannot read and adds nothing, rather than
      // failing the call, so the count says whether it loaded.
      if (view.meshes.length === prior) throw unread(url)
      if (replace)
        for (let i = prior - 1; i >= 0; i--) await view.removeMesh?.(i)
      view.drawScene()
      const index = view.meshes.length - 1
      return {
        mesh: describeMesh(view.meshes[index], index),
        meshes: meshesShown(),
      }
    },

    list_meshes() {
      host.beforeAnswer?.()
      return {
        meshes: meshesShown(),
        ...(view.meshShaders ? { shaders: view.meshShaders } : {}),
      }
    },

    async set_mesh(params: Params) {
      host.beforeAnswer?.()
      const index = meshIndex(params)
      const mesh = meshes()[index]
      const update: MeshUpdate = {}
      const opacity = number(params, 'opacity')
      if (opacity !== undefined) update.opacity = clamp(opacity, 0, 1)
      put(update, 'color', color(params, 'color'))
      const shader = text(params, 'shader')
      checkShader(shader)
      put(update, 'shaderType', shader)
      put(update, 'sliceShaderType', clearable(params, 'slice_shader'))
      put(update, 'visible', flag(params, 'visible'))
      put(update, 'isColorbarVisible', flag(params, 'colorbar'))
      put(update, 'isLegendVisible', flag(params, 'legend'))
      put(update, 'name', text(params, 'name'))
      const tract = options(record(params, 'tract'), 'tract', TRACT_OPTIONS)
      const connectome = options(
        record(params, 'connectome'),
        'connectome',
        CONNECTOME_OPTIONS,
      )
      if (nothingIn(update) && !tract && !connectome) {
        throw new Error(
          'set_mesh needs something to set: opacity, color, shader, slice_shader, visible, colorbar, legend, name, tract or connectome.',
        )
      }
      if (!nothingIn(update)) {
        if (!view.setMesh)
          throw new Error(
            "This page's NiiVue cannot change a mesh once loaded.",
          )
        await view.setMesh(index, update)
      }
      if (tract) {
        if (!view.setTractOptions)
          throw new Error(
            "This page's NiiVue cannot change how tracts are drawn.",
          )
        if (mesh.kind && mesh.kind !== 'tract')
          throw new Error(
            `${mesh.name ?? 'The mesh'} is a ${mesh.kind}, not a tract.`,
          )
        await view.setTractOptions(
          index,
          'colorBy' in tract
            ? { ...tract, colorBy: niivueColorBy(tract.colorBy, mesh) }
            : tract,
        )
      }
      if (connectome) {
        if (!view.setConnectomeOptions)
          throw new Error(
            "This page's NiiVue cannot change how connectomes are drawn.",
          )
        if (mesh.kind && mesh.kind !== 'connectome')
          throw new Error(
            `${mesh.name ?? 'The mesh'} is a ${mesh.kind}, not a connectome.`,
          )
        await view.setConnectomeOptions(index, connectome)
      }
      view.drawScene()
      return {
        mesh: describeMesh(meshes()[index], index),
        ...(mesh.kind === 'tract' && view.getTractGroups
          ? { tractGroups: view.getTractGroups(index) }
          : {}),
      }
    },

    async update_mesh_positions(params: Params) {
      host.beforeAnswer?.()
      if (!view.updateMeshPositions)
        throw new Error("This page's NiiVue cannot move a mesh's vertices.")
      const index = meshIndex(params)
      const mesh = meshes()[index]
      const name = mesh.name ?? 'The mesh'
      // NiiVue only logs and returns for each of these, so they are
      // refused here, before anything is fetched or written.
      if (mesh.kind && mesh.kind !== 'mesh')
        throw new Error(
          `${name} is a ${mesh.kind}; only a triangulated mesh's vertices can be moved.`,
        )
      const positions = mesh.positions
      if (!positions)
        throw new Error(`${name} holds no vertex positions to write over.`)
      const source = oneSource(
        params,
        ['values', 'url', 'from_mesh'],
        'update_mesh_positions',
      )
      let data: ArrayLike<number>
      if (source === 'url') {
        const like = isTyped(positions) ? positions : new Float32Array(0)
        data = await fetchValues(params, 'url', like)
      } else if (source === 'from_mesh') {
        const from =
          meshes()[pickIndex(meshes(), params?.from_mesh, 'from_mesh')]
        if (!from.positions)
          throw new Error(
            `${from.name ?? 'That mesh'} holds no vertex positions to copy.`,
          )
        data = from.positions
      } else {
        data = numbers(params, 'values') ?? []
      }
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i]))
          throw new Error(`Value ${i} is ${data[i]}, not a finite position.`)
      }
      if (isTyped(positions)) checkFits(data, positions, name)
      if (data.length !== positions.length) {
        throw new Error(
          `${name} has ${positions.length / 3} vertices and takes ${positions.length} values, x, y and z for each; got ${data.length}.`,
        )
      }
      // The person may have removed or replaced the mesh during a fetch;
      // its index could now hold another with as many vertices.
      const at = meshes().indexOf(mesh)
      if (at < 0 || mesh.positions !== positions)
        throw new Error(
          `${name} was removed or replaced while its values were fetched; nothing was written.`,
        )
      view.updateMeshPositions(at, data)
      view.drawScene()
      return {
        vertices: data.length / 3,
        mesh: describeMesh(meshes()[at], at),
      }
    },

    async remove_mesh(params: Params) {
      host.beforeAnswer?.()
      if (flag(params, 'all')) {
        if (!view.removeAllMeshes)
          throw new Error("This page's NiiVue cannot remove its meshes.")
        await view.removeAllMeshes()
        view.drawScene()
        return { meshes: [] }
      }
      if (!view.removeMesh)
        throw new Error("This page's NiiVue cannot remove a mesh.")
      const index = pickIndex(meshes(), params?.mesh, 'mesh')
      const removed = meshes()[index].name ?? index
      await view.removeMesh(index)
      view.drawScene()
      return { removed, meshes: meshesShown() }
    },

    async add_mesh_layer(params: Params) {
      host.beforeAnswer?.()
      if (!view.addMeshLayer)
        throw new Error("This page's NiiVue cannot add a layer to a mesh.")
      const index = meshIndex(params)
      const url = text(params, 'url')
      if (!url) throw new Error('add_mesh_layer needs a url.')
      const layer: MeshLayerToLoad = { url, ...layerFields(params) }
      put(layer, 'name', text(params, 'name') ?? nameFromUrl(url))
      try {
        await view.addMeshLayer(index, layer)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The layer at ${url} could not be loaded: ${why}`)
      }
      view.drawScene()
      return { mesh: describeMesh(meshes()[index], index) }
    },

    async set_mesh_layer(params: Params) {
      host.beforeAnswer?.()
      const index = meshIndex(params)
      const mesh = meshes()[index]
      const layerAt = layerIndex(mesh, params)
      const layer = (mesh.layers ?? [])[layerAt]
      const update = layerFields(params)
      const frame = integer(params, 'frame')
      if (nothingIn(update) && frame === undefined) {
        throw new Error(
          'set_mesh_layer needs something to set: colormap, cal_min, cal_max, opacity, invert, colorbar, frame, or one of the others its schema lists.',
        )
      }
      if (!nothingIn(update)) {
        if (!view.setMeshLayerProperty)
          throw new Error("This page's NiiVue cannot change a mesh layer.")
        await view.setMeshLayerProperty(index, layerAt, update)
      }
      if (frame !== undefined) {
        if (!view.setMeshLayerFrame4D)
          throw new Error(
            "This page's NiiVue cannot change a mesh layer's frame.",
          )
        const frames = layer.nFrame4D ?? 1
        if (frame >= frames) {
          throw new Error(
            frames > 1
              ? `The layer has ${frames} frames, numbered 0 to ${frames - 1}.`
              : 'The layer has one frame only.',
          )
        }
        await view.setMeshLayerFrame4D(index, layerAt, frame)
      }
      view.drawScene()
      return { mesh: describeMesh(meshes()[index], index), layer: layerAt }
    },

    async remove_mesh_layer(params: Params) {
      host.beforeAnswer?.()
      if (!view.removeMeshLayer)
        throw new Error("This page's NiiVue cannot remove a mesh layer.")
      const index = meshIndex(params)
      const mesh = meshes()[index]
      const layerAt = layerIndex(mesh, params)
      await view.removeMeshLayer(index, layerAt)
      view.drawScene()
      return { mesh: describeMesh(meshes()[index], index), removed: layerAt }
    },
  }
}

/** NiiVue 1.0's `NVTractOptions` keys: how a tract's fibres are drawn and coloured. */
const TRACT_OPTIONS = [
  'fiberRadius',
  'fiberSides',
  'minLength',
  'decimation',
  'colormap',
  'colormapNegative',
  'colorBy',
  'calMin',
  'calMax',
  'calMinNeg',
  'calMaxNeg',
  'fixedColor',
  'groupColors',
] as const

/** NiiVue 1.0's `NVConnectomeOptions` keys: how a connectome's nodes and edges are drawn. */
const CONNECTOME_OPTIONS = [
  'nodeColormap',
  'nodeColormapNegative',
  'nodeMinColor',
  'nodeMaxColor',
  'nodeScale',
  'edgeColormap',
  'edgeColormapNegative',
  'edgeMin',
  'edgeMax',
  'edgeScale',
] as const

/**
 * `given` once every key is one NiiVue knows. NiiVue 1.0 merges the object
 * as it is, so a misspelt key would sit on the mesh as a field that changes
 * nothing, and the agent would read success.
 */
function options(
  given: Record<string, unknown> | undefined,
  kind: string,
  known: readonly string[],
): Record<string, unknown> | undefined {
  if (!given) return undefined
  const keys = Object.keys(given)
  if (keys.length === 0)
    throw new Error(`${kind} needs at least one option: ${known.join(', ')}.`)
  const unknown = keys.filter((key) => !known.includes(key))
  if (unknown.length)
    throw new Error(
      `Unknown ${kind} option${unknown.length > 1 ? 's' : ''} ${unknown
        .map((key) => `"${key}"`)
        .join(', ')}. One of: ${known.join(', ')}.`,
    )
  return given
}
