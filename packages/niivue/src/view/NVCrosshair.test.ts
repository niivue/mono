import { describe, expect, test } from 'bun:test'
import { SLICE_TYPE } from '@/NVConstants'
import { crosshairXRayAlpha } from '@/view/NVCrosshair'

describe('crosshairXRayAlpha', () => {
  test('2D tiles draw the arms a slice hides, even with mesh x-ray off', () => {
    for (const sliceType of [
      SLICE_TYPE.AXIAL,
      SLICE_TYPE.CORONAL,
      SLICE_TYPE.SAGITTAL,
    ]) {
      expect(crosshairXRayAlpha(0, sliceType)).toBe(0.15)
    }
  })

  test('a stronger mesh x-ray wins on 2D tiles', () => {
    expect(crosshairXRayAlpha(0.5, SLICE_TYPE.AXIAL)).toBe(0.5)
  })

  test('render tiles keep the mesh x-ray setting', () => {
    expect(crosshairXRayAlpha(0, SLICE_TYPE.RENDER)).toBe(0)
    expect(crosshairXRayAlpha(0.3, SLICE_TYPE.RENDER)).toBe(0.3)
  })
})
