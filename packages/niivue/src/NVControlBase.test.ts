import { describe, expect, spyOn, test } from 'bun:test'
import NiiVue from './index'
import * as NVMesh from './mesh/NVMesh'
import NVControlBase from './NVControlBase'
import type { NVMesh as NVMeshType } from './NVTypes'
import { NVWorker } from './workers/NVWorker'

describe('NVControlBase under bun test', () => {
  test('the package entry loads and constructs without a canvas', () => {
    const nv = new NiiVue()
    expect(nv).toBeInstanceOf(NVControlBase)
    expect(nv.volumes).toEqual([])
  })

  test('worker bridges take their main-thread path', () => {
    expect(NVWorker.isSupported()).toBe(false)
  })

  test('loadMeshes emits meshLoaded only for meshes the model accepts', async () => {
    // A loaded mesh without positions makes model.addMesh retry it as a URL
    // load, which throws, so the model logs it and returns null.
    const load = spyOn(NVMesh, 'loadMesh').mockImplementation(async (opts) => {
      if ('positions' in opts) throw new Error('unreadable')
      return {
        url: opts.url,
        positions: opts.url === 'bad' ? null : new Float32Array(3),
        extentsMin: [0, 0, 0],
        extentsMax: [1, 1, 1],
      } as unknown as NVMeshType
    })
    const nv = new NiiVue()
    const emitted: NVMeshType[] = []
    nv.addEventListener('meshLoaded', (e) => emitted.push(e.detail.mesh))
    try {
      await nv.loadMeshes([{ url: 'a' }, { url: 'bad' }, { url: 'b' }])
    } finally {
      load.mockRestore()
    }
    const [a, b] = nv.model.getMeshes()
    expect(emitted.map((m) => m.url)).toEqual(['a', 'b'])
    expect(emitted[0]).toBe(a)
    expect(emitted[1]).toBe(b)
  })
})
