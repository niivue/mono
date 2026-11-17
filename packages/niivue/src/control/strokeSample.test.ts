import { describe, expect, test } from 'bun:test'
import type NiiVue from '@/NVControl'
import type { NVImage } from '@/NVTypes'
import { strokeSample } from './interactions'

describe('strokeSample', () => {
  test('samples the displayed 4D frame', () => {
    const vol = {
      img: Float32Array.from([0, 0, 20, 21]),
      nVox3D: 2,
      frame4D: 1,
      dimsRAS: [3, 2, 1, 1],
      img2RASstep: [1, 2, 2],
      img2RASstart: [0, 0, 0],
    } as unknown as NVImage
    const ctrl = { _draw3DSampleCache: null } as unknown as NiiVue
    expect(Array.from(strokeSample(ctrl, vol) ?? [])).toEqual([20, 21])
  })

  test('a frame change mid-stroke resamples', () => {
    const vol = {
      img: Float32Array.from([1, 2, 20, 21]),
      nVox3D: 2,
      frame4D: 0,
      dimsRAS: [3, 2, 1, 1],
      img2RASstep: [1, 2, 2],
      img2RASstart: [0, 0, 0],
    } as unknown as NVImage
    const ctrl = { _draw3DSampleCache: null } as unknown as NiiVue
    expect(Array.from(strokeSample(ctrl, vol) ?? [])).toEqual([1, 2])
    vol.frame4D = 1
    expect(Array.from(strokeSample(ctrl, vol) ?? [])).toEqual([20, 21])
  })
})
