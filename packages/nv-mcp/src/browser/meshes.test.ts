import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import { describeMesh, meshHandlers } from './meshes'
import type {
  MeshLayerToLoad,
  MeshLayerUpdate,
  MeshToLoad,
  MeshUpdate,
  ShownMesh,
  View,
} from './view'

/** A view with meshes NiiVue would keep, loaded, changed and removed as its model would. */
function meshView(overrides: Partial<View> = {}) {
  const meshes: ShownMesh[] = [
    {
      name: 'lh.pial',
      url: 'https://x/lh.pial',
      opacity: 1,
      shaderType: 'Phong',
      visible: true,
      layers: [
        {
          name: 'curv',
          colormap: 'gray',
          calMin: -1,
          calMax: 1,
          opacity: 0.8,
          nFrame4D: 3,
          frame4D: 0,
        },
      ],
    },
    { name: 'tract.trk', kind: 'tract', tractOptions: { dither: 0.1 } },
  ]
  const shown = (mesh: MeshToLoad): ShownMesh => {
    const { url, layers, ...rest } = mesh
    return {
      url,
      ...rest,
      ...(layers ? { layers: layers.map(({ url: _url, ...l }) => l) } : {}),
    }
  }
  const view = baseView({
    meshes,
    meshShaders: ['Phong', 'Matte', 'Outline'],
    addMesh: mock(async (mesh: MeshToLoad) => {
      meshes.push(shown(mesh))
    }),
    removeMesh: mock(async (index: number) => {
      await Promise.resolve()
      meshes.splice(index, 1)
    }),
    removeAllMeshes: mock(async () => {
      await Promise.resolve()
      meshes.splice(0)
    }),
    setMesh: mock(async (index: number, update: MeshUpdate) => {
      Object.assign(meshes[index], update)
    }),
    addMeshLayer: mock(async (index: number, layer: MeshLayerToLoad) => {
      const { url: _url, ...rest } = layer
      meshes[index].layers = [...(meshes[index].layers ?? []), rest]
    }),
    removeMeshLayer: mock(async (index: number, layer: number) => {
      meshes[index].layers = (meshes[index].layers ?? []).filter(
        (_, i) => i !== layer,
      )
    }),
    setMeshLayerProperty: mock(
      async (index: number, layer: number, update: MeshLayerUpdate) => {
        Object.assign((meshes[index].layers ?? [])[layer], update)
      },
    ),
    setMeshLayerFrame4D: mock((index: number, layer: number, frame: number) => {
      ;(meshes[index].layers ?? [])[layer].frame4D = frame
    }),
    setTractOptions: mock(async (index: number, options) => {
      meshes[index].tractOptions = options
    }),
    setConnectomeOptions: mock(async () => {}),
    getTractGroups: () => ['CST', 'AF'],
    ...overrides,
  })
  return view
}

describe('describeMesh', () => {
  it('reports what is set and leaves out what is not', () => {
    expect(describeMesh({}, 2)).toEqual({ index: 2, name: 'mesh 2' })
    expect(
      describeMesh(
        {
          name: 'm',
          kind: 'mesh',
          color: new Float32Array([1, 0, 0, 1]),
          isColorbarVisible: true,
          isLegendVisible: false,
          layers: [{ nFrame4D: 2, isColormapInverted: true }],
        },
        0,
      ),
    ).toEqual({
      index: 0,
      name: 'm',
      kind: 'mesh',
      color: [1, 0, 0, 1],
      colorbar: true,
      layers: [{ index: 0, frame: 0, frames: 2, inverted: true }],
    })
  })
})

describe('load_mesh', () => {
  it('adds a mesh over the others, with its layers, and names it from the url', async () => {
    const view = meshView()
    const { load_mesh } = meshHandlers(hostOf(view))
    const got = (await load_mesh({
      url: 'https://x/rh.pial?v=1',
      opacity: 2,
      color: [1, 0, 0],
      shader: 'Matte',
      layers: [{ url: 'https://x/thick.gii', colormap: 'hot', cal_max: 5 }],
    })) as { mesh: { index: number; name: string }; meshes: unknown[] }
    expect(view.addMesh).toHaveBeenCalledWith({
      url: 'https://x/rh.pial?v=1',
      name: 'rh.pial',
      opacity: 1,
      color: [1, 0, 0, 1],
      shaderType: 'Matte',
      layers: [{ url: 'https://x/thick.gii', colormap: 'hot', calMax: 5 }],
    })
    expect(got.mesh.index).toBe(2)
    expect(got.mesh.name).toBe('rh.pial')
    expect(got.meshes).toHaveLength(3)
    expect(view.drawScene).toHaveBeenCalledTimes(1)
  })

  it('replaces the meshes when asked, dropping the old ones only once the new one is in', async () => {
    const view = meshView()
    const meshes = view.meshes as ShownMesh[]
    const order: string[] = []
    view.addMesh = mock(async (mesh: MeshToLoad) => {
      await Promise.resolve()
      order.push('add')
      meshes.push({ url: mesh.url, name: mesh.name })
    })
    view.removeMesh = mock(async (index: number) => {
      await Promise.resolve()
      order.push(`remove ${index}`)
      meshes.splice(index, 1)
    })
    const { load_mesh } = meshHandlers(hostOf(view))
    const got = (await load_mesh({
      url: 'https://x/a.mz3',
      name: 'A',
      replace: true,
    })) as { meshes: unknown[] }
    expect(view.addMesh).toHaveBeenCalledWith({
      url: 'https://x/a.mz3',
      name: 'A',
    })
    expect(order).toEqual(['add', 'remove 1', 'remove 0'])
    expect(view.removeAllMeshes).not.toHaveBeenCalled()
    expect(got.meshes).toEqual([
      { index: 0, name: 'A', url: 'https://x/a.mz3' },
    ])
    await expect(
      meshHandlers(hostOf(meshView({ removeMesh: undefined }))).load_mesh({
        url: 'https://x/a.mz3',
        replace: true,
      }),
    ).rejects.toThrow("This page's NiiVue cannot replace its meshes.")
  })

  it('keeps the meshes it has when a replacement fails to load', async () => {
    const view = meshView({
      addMesh: mock(async () => {
        await Promise.resolve()
        throw new Error('not a mesh')
      }),
    })
    const { load_mesh } = meshHandlers(hostOf(view))
    await expect(
      load_mesh({ url: 'https://x/a.mz3', replace: true }),
    ).rejects.toThrow(
      'The mesh at https://x/a.mz3 could not be loaded: not a mesh',
    )
    expect(view.meshes?.map((mesh) => mesh.name)).toEqual([
      'lh.pial',
      'tract.trk',
    ])
    expect(view.removeMesh).not.toHaveBeenCalled()
    expect(view.removeAllMeshes).not.toHaveBeenCalled()
  })

  it('refuses a missing url, an unknown shader, a bad layer, and a failed load', async () => {
    const view = meshView({
      addMesh: mock(async () => {
        throw new Error('not a mesh')
      }),
    })
    const { load_mesh } = meshHandlers(hostOf(view))
    await expect(load_mesh({})).rejects.toThrow('load_mesh needs a url.')
    await expect(
      load_mesh({ url: 'https://x/a', shader: 'Glossy' }),
    ).rejects.toThrow(
      'Unknown mesh shader "Glossy". One of: Phong, Matte, Outline.',
    )
    await expect(
      load_mesh({ url: 'https://x/a', layers: [{ colormap: 'hot' }] }),
    ).rejects.toThrow('Layer 0 needs a url.')
    await expect(
      load_mesh({ url: 'https://x/a', layers: 'x' }),
    ).rejects.toThrow('layers must be a list.')
    await expect(load_mesh({ url: 'https://x/a' })).rejects.toThrow(
      'The mesh at https://x/a could not be loaded: not a mesh',
    )
    await expect(
      meshHandlers(hostOf(baseView())).load_mesh({ url: 'https://x/a' }),
    ).rejects.toThrow("This page's NiiVue cannot load a mesh.")
  })
})

describe('list_meshes and remove_mesh', () => {
  it('lists the meshes with their layers and the shaders', () => {
    const { list_meshes } = meshHandlers(hostOf(meshView()))
    expect(list_meshes({})).toEqual({
      meshes: [
        {
          index: 0,
          name: 'lh.pial',
          url: 'https://x/lh.pial',
          opacity: 1,
          shader: 'Phong',
          visible: true,
          layers: [
            {
              index: 0,
              name: 'curv',
              colormap: 'gray',
              opacity: 0.8,
              calMin: -1,
              calMax: 1,
              frame: 0,
              frames: 3,
            },
          ],
        },
        { index: 1, name: 'tract.trk', kind: 'tract', tract: { dither: 0.1 } },
      ],
      shaders: ['Phong', 'Matte', 'Outline'],
    })
    expect(() => meshHandlers(hostOf(baseView())).list_meshes({})).toThrow(
      "This page's NiiVue has no meshes.",
    )
  })

  it('removes one mesh by name or index, or all of them, once NiiVue has', async () => {
    const view = meshView()
    const { remove_mesh } = meshHandlers(hostOf(view))
    expect(await remove_mesh({ mesh: 'tract' })).toEqual({
      removed: 'tract.trk',
      meshes: [expect.objectContaining({ name: 'lh.pial' })],
    })
    await expect(remove_mesh({})).rejects.toThrow(
      'Say which mesh: an index from 0, or a name (lh.pial).',
    )
    await expect(remove_mesh({ mesh: 5 })).rejects.toThrow('There is no mesh 5')
    expect(await remove_mesh({ all: true })).toEqual({ meshes: [] })
    expect(view.removeAllMeshes).toHaveBeenCalledTimes(1)
    const bare = meshHandlers(hostOf(baseView({ meshes: [{ name: 'a' }] })))
    await expect(bare.remove_mesh({ mesh: 0 })).rejects.toThrow(
      "This page's NiiVue cannot remove a mesh.",
    )
    await expect(bare.remove_mesh({ all: true })).rejects.toThrow(
      "This page's NiiVue cannot remove its meshes.",
    )
  })
})

describe('set_mesh', () => {
  it('changes only what was asked, on the first mesh by default', async () => {
    const view = meshView()
    const { set_mesh } = meshHandlers(hostOf(view))
    const got = (await set_mesh({
      opacity: 0.5,
      visible: false,
      shader: 'Outline',
      name: 'left',
    })) as { mesh: Record<string, unknown> }
    expect(view.setMesh).toHaveBeenCalledWith(0, {
      opacity: 0.5,
      visible: false,
      shaderType: 'Outline',
      name: 'left',
    })
    expect(got.mesh).toMatchObject({
      index: 0,
      name: 'left',
      opacity: 0.5,
      visible: false,
      shader: 'Outline',
    })
    expect(view.drawScene).toHaveBeenCalledTimes(1)
  })

  it('sets tract options on a tract and reports its groups, refusing them on a surface', async () => {
    const view = meshView()
    const { set_mesh } = meshHandlers(hostOf(view))
    const got = (await set_mesh({ mesh: 1, tract: { dither: 0.5 } })) as {
      mesh: Record<string, unknown>
      tractGroups: string[]
    }
    expect(view.setTractOptions).toHaveBeenCalledWith(1, { dither: 0.5 })
    expect(view.setMesh).not.toHaveBeenCalled()
    expect(got.mesh.tract).toEqual({ dither: 0.5 })
    expect(got.tractGroups).toEqual(['CST', 'AF'])
    await expect(
      set_mesh({ mesh: 1, connectome: { nodeScale: 2 } }),
    ).rejects.toThrow('tract.trk is a tract, not a connectome.')
    await expect(
      set_mesh({ mesh: 'lh', connectome: { nodeScale: 2 } }),
    ).resolves.toBeDefined()
    expect(view.setConnectomeOptions).toHaveBeenCalledWith(0, { nodeScale: 2 })
  })

  it('refuses nothing to set, an unknown shader, and a page that cannot', async () => {
    const { set_mesh } = meshHandlers(hostOf(meshView()))
    await expect(set_mesh({})).rejects.toThrow(
      'set_mesh needs something to set',
    )
    await expect(set_mesh({ shader: 'Glossy' })).rejects.toThrow(
      'Unknown mesh shader "Glossy"',
    )
    const bare = meshHandlers(hostOf(baseView({ meshes: [{ name: 'a' }] })))
    await expect(bare.set_mesh({ opacity: 1 })).rejects.toThrow(
      "This page's NiiVue cannot change a mesh once loaded.",
    )
    await expect(bare.set_mesh({ tract: {} })).rejects.toThrow(
      "This page's NiiVue cannot change how tracts are drawn.",
    )
  })
})

describe('the mesh layers', () => {
  it('adds a layer to a mesh, named from its url', async () => {
    const view = meshView()
    const { add_mesh_layer } = meshHandlers(hostOf(view))
    const got = (await add_mesh_layer({
      mesh: 'lh',
      url: 'https://x/thick.gii',
      colormap: 'hot',
      cal_min: 0,
      cal_max: 5,
      opacity: 3,
      invert: true,
      additive: true,
      outline_width: 2,
    })) as { mesh: { layers: unknown[] } }
    expect(view.addMeshLayer).toHaveBeenCalledWith(0, {
      url: 'https://x/thick.gii',
      name: 'thick.gii',
      colormap: 'hot',
      calMin: 0,
      calMax: 5,
      opacity: 1,
      isColormapInverted: true,
      isAdditiveBlend: true,
      outlineWidth: 2,
    })
    expect(got.mesh.layers).toHaveLength(2)
    await expect(add_mesh_layer({ mesh: 0 })).rejects.toThrow(
      'add_mesh_layer needs a url.',
    )
    await expect(
      add_mesh_layer({ url: 'https://x/a', cal_min: 2, cal_max: 1 }),
    ).rejects.toThrow('cal_min (2) must not be above cal_max (1).')
    await expect(
      meshHandlers(hostOf(baseView({ meshes: [] }))).add_mesh_layer({
        url: 'https://x/a',
      }),
    ).rejects.toThrow("This page's NiiVue cannot add a layer to a mesh.")
  })

  it('changes a layer and its frame, on the only layer by default', async () => {
    const view = meshView()
    const { set_mesh_layer } = meshHandlers(hostOf(view))
    const got = (await set_mesh_layer({
      colormap: 'hot',
      cal_max: 2,
      frame: 2,
    })) as { mesh: { layers: Array<Record<string, unknown>> }; layer: number }
    expect(view.setMeshLayerProperty).toHaveBeenCalledWith(0, 0, {
      colormap: 'hot',
      calMax: 2,
    })
    expect(view.setMeshLayerFrame4D).toHaveBeenCalledWith(0, 0, 2)
    expect(got.layer).toBe(0)
    expect(got.mesh.layers[0]).toMatchObject({
      colormap: 'hot',
      calMax: 2,
      frame: 2,
    })
    await expect(set_mesh_layer({ frame: 3 })).rejects.toThrow(
      'The layer has 3 frames, numbered 0 to 2.',
    )
    await expect(set_mesh_layer({})).rejects.toThrow(
      'set_mesh_layer needs something to set',
    )
    await expect(set_mesh_layer({ mesh: 1, colormap: 'hot' })).rejects.toThrow(
      'tract.trk has no layers.',
    )
    await expect(
      set_mesh_layer({ layer: 'thick', colormap: 'hot' }),
    ).rejects.toThrow('No layer is named "thick". Shown: curv.')
  })

  it('removes a layer by name or index', async () => {
    const view = meshView()
    const { remove_mesh_layer } = meshHandlers(hostOf(view))
    expect(await remove_mesh_layer({ mesh: 0, layer: 'curv' })).toEqual({
      mesh: expect.objectContaining({ name: 'lh.pial' }),
      removed: 0,
    })
    expect(view.removeMeshLayer).toHaveBeenCalledWith(0, 0)
    expect(view.meshes?.[0].layers).toEqual([])
    await expect(remove_mesh_layer({ mesh: 0 })).rejects.toThrow(
      'lh.pial has no layers.',
    )
    await expect(
      meshHandlers(hostOf(baseView({ meshes: [] }))).remove_mesh_layer({}),
    ).rejects.toThrow("This page's NiiVue cannot remove a mesh layer.")
  })
})
