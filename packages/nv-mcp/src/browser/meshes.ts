/**
 * Meshes: surfaces, tracts and connectomes, and the layers over them.
 *
 * A mesh is named on a tool as its index among those on show or by its
 * name, as a volume is; a layer by its index among the mesh's layers or
 * its name. As with volumes, only what was asked for goes to NiiVue.
 */

import {
  clamp,
  color,
  flag,
  integer,
  nameFromUrl,
  nothingIn,
  number,
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

/** A mesh as the tools report it. */
export function describeMesh(mesh: ShownMesh, index: number) {
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
    ...(mesh.tractOptions ? { tract: mesh.tractOptions } : {}),
    ...(mesh.connectomeOptions ? { connectome: mesh.connectomeOptions } : {}),
  }
}

/** The fields a layer takes on loading and on a change alike, read off `params`. */
function layerFields(params: Params): MeshLayerUpdate {
  const update: MeshLayerUpdate = {}
  put(update, 'colormap', text(params, 'colormap'))
  put(update, 'colormapNegative', text(params, 'colormap_negative'))
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
      const loader = replace ? view.loadMeshes : view.addMesh
      if (!loader || !view.meshes)
        throw new Error("This page's NiiVue cannot load a mesh.")
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
      put(mesh, 'sliceShaderType', text(params, 'slice_shader'))
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
      try {
        if (replace) await view.loadMeshes?.([mesh])
        else await view.addMesh?.(mesh)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The mesh at ${url} could not be loaded: ${why}`)
      }
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
      put(update, 'sliceShaderType', text(params, 'slice_shader'))
      put(update, 'visible', flag(params, 'visible'))
      put(update, 'isColorbarVisible', flag(params, 'colorbar'))
      put(update, 'isLegendVisible', flag(params, 'legend'))
      put(update, 'name', text(params, 'name'))
      const tract = record(params, 'tract')
      const connectome = record(params, 'connectome')
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
        await view.setTractOptions(index, tract)
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

    remove_mesh(params: Params) {
      host.beforeAnswer?.()
      if (flag(params, 'all')) {
        if (!view.removeAllMeshes)
          throw new Error("This page's NiiVue cannot remove its meshes.")
        view.removeAllMeshes()
        view.drawScene()
        return { meshes: [] }
      }
      if (!view.removeMesh)
        throw new Error("This page's NiiVue cannot remove a mesh.")
      const index = pickIndex(meshes(), params?.mesh, 'mesh')
      const removed = meshes()[index].name ?? index
      view.removeMesh(index)
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
