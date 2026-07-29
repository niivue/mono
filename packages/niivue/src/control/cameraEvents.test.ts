import { describe, expect, mock, test } from 'bun:test'
import type NiiVueGPU from '@/NVControlBase'
import {
  emitOrientationChange,
  emitPan2DChange,
  emitScaleMultiplierChange,
} from './cameraEvents'

type Scene = {
  azimuth?: number
  elevation?: number
  scaleMultiplier?: number
  pan2Dxyzmm?: [number, number, number, number]
}

function fakeCtrl(scene: Scene) {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const ctrl = { model: { scene }, emit } as unknown as NiiVueGPU
  return { ctrl, emit }
}

describe('camera interaction events', () => {
  test('emitOrientationChange mirrors the azimuth/elevation setters', () => {
    const { ctrl, emit } = fakeCtrl({ azimuth: 110, elevation: 10 })
    emitOrientationChange(ctrl)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(1, 'azimuthElevationChange', {
      azimuth: 110,
      elevation: 10,
    })
    expect(emit).toHaveBeenNthCalledWith(2, 'change', {
      property: 'azimuth',
      value: 110,
    })
    expect(emit).toHaveBeenNthCalledWith(3, 'change', {
      property: 'elevation',
      value: 10,
    })
  })

  test('emitScaleMultiplierChange emits a scaleMultiplier change', () => {
    const { ctrl, emit } = fakeCtrl({ scaleMultiplier: 1.5 })
    emitScaleMultiplierChange(ctrl)
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'scaleMultiplier',
      value: 1.5,
    })
  })

  test('emitPan2DChange emits a pan2Dxyzmm change', () => {
    const { ctrl, emit } = fakeCtrl({ pan2Dxyzmm: [1, 2, 3, 4] })
    emitPan2DChange(ctrl)
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'pan2Dxyzmm',
      value: [1, 2, 3, 4],
    })
  })
})
