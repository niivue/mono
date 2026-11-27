import { describe, expect, spyOn, test } from 'bun:test'
import NiiVue from './index'
import * as NVMesh from './mesh/NVMesh'
import NVControlBase from './NVControlBase'
import type { NVMesh as NVMeshType } from './NVTypes'
import { createNiftiArray } from './volume/utils'
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

describe('broadcastTo', () => {
  const peer = () => {
    const nv = new NiiVue()
    nv.model.extentsMin = [0, 0, 0]
    nv.model.extentsMax = [100, 100, 100]
    return nv
  }
  const sync = (nv: NiiVue) => {
    nv['_syncDirty'] = true
    nv['_sync']()
  }
  const link = (a: NiiVue, b: NiiVue) => {
    a.broadcastTo(b, { crosshair: true })
    b.broadcastTo(a, { crosshair: true })
    sync(a)
    sync(b)
  }

  // A linked peer redrawing for another reason (a cine frame, a load) used to
  // push its unchanged crosshair over a newer move made in the other pane.
  test("a peer's redraw does not undo a newer crosshair move", () => {
    const a = peer()
    const b = peer()
    link(a, b)
    a.model.scene.crosshairPos = [0.5, 0.5, 0.6]
    sync(b)
    expect(Array.from(a.model.scene.crosshairPos)).toEqual([0.5, 0.5, 0.6])
    sync(a)
    expect(b.model.scene.crosshairPos[2]).toBeCloseTo(0.6, 6)
  })

  // A peer that received a move must not echo it back: converted through its
  // own grid, the echo lands a little off (here float32 rounding; across CT and
  // PT grids, slices away) and overwrites the move it came from.
  test('a received move is not broadcast back', () => {
    const a = peer()
    const b = peer()
    link(a, b)
    const moved = [0.5, 0.5, 0.6]
    a.model.scene.crosshairPos = moved
    sync(a)
    sync(b)
    expect(a.model.scene.crosshairPos).toBe(moved)
  })

  test('a crosshair-only receipt keeps a pending pan for the next peer', () => {
    const a = peer()
    const b = peer()
    const c = peer()
    a.broadcastTo(b, { crosshair: true })
    b.broadcastTo(c, { '2d': true })
    sync(a)
    sync(b)
    b.model.scene.pan2Dxyzmm = new Float32Array([0, 10, 0, 1])
    // A's own pan changes too, but crosshair-only sync does not send it.
    a.model.scene.pan2Dxyzmm = new Float32Array([0, 20, 0, 1])
    a.model.scene.crosshairPos = [0.5, 0.5, 0.6]
    sync(a)
    sync(b)
    expect(c.model.scene.pan2Dxyzmm[1]).toBe(10)
  })

  // An affine change moves the crosshair in mm without changing its fraction.
  test('an affine change moves the linked crosshair to the same world point', async () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const vol = () =>
      new File(
        [
          createNiftiArray(
            [2, 2, 2],
            [1, 1, 1],
            identity,
            2,
            new Uint8Array(8),
          ),
        ],
        'small.nii',
      )
    const a = new NiiVue()
    const b = new NiiVue()
    await a.loadVolumes([{ url: vol() }])
    await b.loadVolumes([{ url: vol() }])
    a.broadcastTo(b, { crosshair: true })
    sync(a)
    await a.setVolumeAffine(0, [
      [1, 0, 0, 10],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ])
    sync(a)
    expect(Array.from(b.getCrosshairPos())).toEqual(
      Array.from(a.getCrosshairPos()),
    )
  })
})
