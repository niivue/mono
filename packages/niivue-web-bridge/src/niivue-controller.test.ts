import { describe, expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import type { NVImage, NVMesh } from '@niivue/niivue'
import { loadFile, meshSummaries, volumeSummaries } from './niivue-controller'

describe('volumeSummaries', () => {
  test('reports RAS geometry and fills display defaults', () => {
    const vol = {
      name: 'mni152.nii.gz',
      calMin: 40,
      calMax: 80,
      globalMin: 0,
      globalMax: 91,
      dimsRAS: [3, 207, 256, 215, 1],
      pixDimsRAS: [1, 0.74, 0.74, 0.74, 0],
      hdr: { dims: [3, 215, 256, 207], pixDims: [1, 2, 2, 2] },
    } as unknown as NVImage
    expect(volumeSummaries([vol])).toEqual([
      {
        name: 'mni152.nii.gz',
        colormap: 'gray',
        colormapStops: [
          [0, 0, 0, 0],
          [1, 1, 1, 1],
        ],
        calMin: 40,
        calMax: 80,
        globalMin: 0,
        globalMax: 91,
        opacity: 1,
        dims: [207, 256, 215],
        pixDims: [0.74, 0.74, 0.74],
      },
    ])
  })
})

describe('meshSummaries', () => {
  test('reports each mesh name in load order', () => {
    const meshes = [{ name: 'lh.pial' }, { name: 'rh.pial' }] as NVMesh[]
    expect(meshSummaries(meshes)).toEqual([
      { name: 'lh.pial' },
      { name: 'rh.pial' },
    ])
  })
})

describe('loadFile', () => {
  // Minimal scene: addImage appends unless the file is named 'bad', which
  // mimics NiiVue logging a mesh failure instead of throwing.
  const scene = (names: string[]) => {
    const meshes = names.map((name) => ({ name }))
    const nv = {
      volumes: [],
      signals: [],
      meshes,
      addImage: async (f: File) => {
        if (f.name !== 'bad') meshes.push({ name: f.name })
      },
      removeMesh: async (i: number) => {
        meshes.splice(i, 1)
      },
    } as unknown as InstanceType<typeof NiiVue>
    return { nv, names: () => meshes.map((m) => m.name) }
  }

  test('replace removes the old scene after the new file loads', async () => {
    const s = scene(['lh.pial', 'rh.pial'])
    await loadFile(s.nv, new File([], 'brain.mz3'), false)
    expect(s.names()).toEqual(['brain.mz3'])
  })

  test('add keeps the scene', async () => {
    const s = scene(['lh.pial'])
    await loadFile(s.nv, new File([], 'rh.pial'), true)
    expect(s.names()).toEqual(['lh.pial', 'rh.pial'])
  })

  test('a load that adds nothing throws and keeps the scene', async () => {
    const s = scene(['lh.pial'])
    await expect(loadFile(s.nv, new File([], 'bad'), false)).rejects.toThrow(
      'could not load bad',
    )
    expect(s.names()).toEqual(['lh.pial'])
  })
})
