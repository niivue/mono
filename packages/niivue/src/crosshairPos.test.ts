import { describe, expect, mock, test } from 'bun:test'
import { vec3 } from 'gl-matrix'
import type NiiVue from '@/NVControlBase'

// NVControlBase transitively imports Vite `?worker&inline` entries that only a
// bundler can resolve. Stub the three modules that import them so the real
// class (and its real setCrosshairPos / getCrosshairPos) loads under bun test.
// Nothing here spawns a worker.
mock.module('@/volume/loadBridge', () => ({
  loadVolumePrepared: async () => {
    throw new Error('stubbed in crosshairPos.test.ts')
  },
  terminateLoadWorker: () => {},
}))
mock.module('@/volume/omeZarrChunkWorkerPool', () => ({
  OmeZarrChunkWorkerPool: class {},
}))
mock.module('@/volume/transforms/index', () => ({
  transformNames: () => [],
  getTransform: () => undefined,
  getTransformInfo: () => undefined,
  getTransformInfos: () => [],
  applyTransform: async () => {
    throw new Error('stubbed in crosshairPos.test.ts')
  },
  registerTransform: () => {},
  terminate: () => {},
}))
const { default: NiiVueClass } = await import('@/NVControlBase')
const { default: NVModel } = await import('@/NVModel')

/**
 * A controller with the real NiiVue prototype and a real NVModel whose scene
 * extents are asymmetric, so a scene fraction and a millimetre coordinate can
 * never be confused. No renderer: drawing and the location readout are stubbed.
 */
function fakeCtrl(): NiiVue {
  const model = new NVModel()
  model.extentsMin = vec3.fromValues(-100, -50, -20)
  model.extentsMax = vec3.fromValues(100, 150, 60)
  const ctrl = {
    model,
    volumes: [],
    drawScene: () => {},
    createOnLocationChange: () => {},
  }
  Object.setPrototypeOf(ctrl, NiiVueClass.prototype)
  return ctrl as unknown as NiiVue
}

describe('crosshair position units', () => {
  test('NiiVueOptions.crosshairPos is a scene fraction, not mm', () => {
    const m = new NVModel({ crosshairPos: [0, 1, 0.25] })
    expect(Array.from(m.scene.crosshairPos)).toEqual([0, 1, 0.25])
  })

  test('setCrosshairPos takes world mm and stores a scene fraction', () => {
    const nv = fakeCtrl()
    nv.setCrosshairPos([0, 50, 20])
    const frac = nv.model.scene.crosshairPos
    expect(frac[0]).toBeCloseTo(0.5)
    expect(frac[1]).toBeCloseTo(0.5)
    expect(frac[2]).toBeCloseTo(0.5)
  })

  test('mm round-trips through setCrosshairPos / getCrosshairPos', () => {
    const nv = fakeCtrl()
    const mm: [number, number, number] = [-37.5, 12.25, 41]
    nv.setCrosshairPos(mm)
    const out = nv.getCrosshairPos()
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(mm[i], 4)
    // A second pass is stable (no drift).
    nv.setCrosshairPos(out)
    const again = nv.getCrosshairPos()
    for (let i = 0; i < 3; i++) expect(again[i]).toBeCloseTo(mm[i], 4)
  })

  test('setCrosshairPos clamps to the scene extents', () => {
    const nv = fakeCtrl()
    nv.setCrosshairPos([500, -500, 20])
    const out = nv.getCrosshairPos()
    expect(out[0]).toBeCloseTo(100)
    expect(out[1]).toBeCloseTo(-50)
    expect(out[2]).toBeCloseTo(20)
  })
})
