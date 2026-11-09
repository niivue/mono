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

describe('2D rotate and flip state', () => {
  test('constructor options set all three; defaults are unturned and unflipped', () => {
    const state = (nv: NiiVue) => [
      nv.rotation2D,
      nv.isFlipped2DHorizontal,
      nv.isFlipped2DVertical,
    ]
    expect(state(new NiiVue())).toEqual([0, false, false])
    expect(
      state(
        new NiiVue({
          rotation2D: 180,
          isFlipped2DHorizontal: true,
          isFlipped2DVertical: true,
        }),
      ),
    ).toEqual([180, true, true])
    expect(new NiiVue({ rotation2D: 30 }).rotation2D).toBe(0)
  })

  test('setters store, round and emit the bare key', () => {
    const nv = new NiiVue()
    const seen: [string, unknown][] = []
    nv.addEventListener('change', (e) =>
      seen.push([e.detail.property, e.detail.value]),
    )
    nv.rotation2D = -90
    nv.isFlipped2DHorizontal = true
    nv.isFlipped2DVertical = true
    nv.rotation2D = 45
    expect(nv.model.layout).toMatchObject({
      rotation2D: 90,
      isFlipped2DHorizontal: true,
      isFlipped2DVertical: true,
    })
    expect(seen).toEqual([
      ['rotation2D', 270],
      ['isFlipped2DHorizontal', true],
      ['isFlipped2DVertical', true],
      ['rotation2D', 90],
    ])
  })
})
