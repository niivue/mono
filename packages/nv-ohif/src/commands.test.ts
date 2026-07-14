import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVueGPU from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import { getNiivueCommandsModule, NIIVUE_SLICE_TYPES } from './commands'
import {
  getNiivueForViewport,
  registerNiivue,
  unregisterNiivue,
} from './niivueRegistry'

// A stub with just the scene properties the commands touch.
function stubNiivue() {
  return {
    sliceType: SLICE_TYPE.MULTIPLANAR as number,
    azimuth: 42,
    elevation: -7,
    scaleMultiplier: 3,
    pan2Dxyzmm: [5, 6, 7, 2],
    renderPan: [1, 2],
    crosshairPos: [0.1, 0.2, 0.3],
  }
}

function services(activeViewportId: string) {
  return {
    services: {
      viewportGridService: { getActiveViewportId: () => activeViewportId },
    },
  }
}

const registered: string[] = []
function register(viewportId: string, nv: ReturnType<typeof stubNiivue>) {
  registerNiivue(viewportId, nv as unknown as NiiVueGPU)
  registered.push(viewportId)
}

afterEach(() => {
  for (const id of registered.splice(0)) unregisterNiivue(id)
})

describe('NIIVUE_SLICE_TYPES', () => {
  it('maps every toolbar name to the matching SLICE_TYPE', () => {
    expect(NIIVUE_SLICE_TYPES).toEqual({
      axial: SLICE_TYPE.AXIAL,
      coronal: SLICE_TYPE.CORONAL,
      sagittal: SLICE_TYPE.SAGITTAL,
      multiplanar: SLICE_TYPE.MULTIPLANAR,
      render: SLICE_TYPE.RENDER,
    })
  })
})

describe('niivueRegistry', () => {
  it('resolves the exact viewport, and falls back to a sole instance', () => {
    const a = stubNiivue()
    register('vp-a', a)
    expect(getNiivueForViewport('vp-a')).toBe(a as unknown as NiiVueGPU)
    // A non-NiiVue viewport id still resolves while only one instance exists.
    expect(getNiivueForViewport('vp-other')).toBe(a as unknown as NiiVueGPU)

    const b = stubNiivue()
    register('vp-b', b)
    // With two instances the fallback is ambiguous: exact matches only.
    expect(getNiivueForViewport('vp-b')).toBe(b as unknown as NiiVueGPU)
    expect(getNiivueForViewport('vp-other')).toBeUndefined()
  })
})

describe('niivueSetSliceType', () => {
  it('sets the mapped slice type on the active viewport instance', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetSliceType({ sliceType: 'render' })
    expect(nv.sliceType).toBe(SLICE_TYPE.RENDER)
    definitions.niivueSetSliceType({ sliceType: 'axial' })
    expect(nv.sliceType).toBe(SLICE_TYPE.AXIAL)
  })

  it('ignores unknown slice types and missing instances', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetSliceType({ sliceType: 'mosaic' })
    definitions.niivueSetSliceType()
    expect(nv.sliceType).toBe(SLICE_TYPE.MULTIPLANAR)
    // No registered instance at all: must not throw.
    unregisterNiivue('vp-1')
    registered.length = 0
    expect(() =>
      definitions.niivueSetSliceType({ sliceType: 'axial' }),
    ).not.toThrow()
  })
})

describe('niivueResetView', () => {
  it('restores camera, zoom, pan, and crosshair defaults', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueResetView()
    expect(nv.azimuth).toBe(110)
    expect(nv.elevation).toBe(10)
    expect(nv.scaleMultiplier).toBe(1)
    expect(nv.pan2Dxyzmm).toEqual([0, 0, 0, 1])
    expect(nv.renderPan).toEqual([0, 0])
    expect(nv.crosshairPos).toEqual([0.5, 0.5, 0.5])
  })
})
