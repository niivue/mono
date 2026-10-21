import { describe, expect, test } from 'bun:test'
import { SLICE_TYPE } from '@/NVConstants'
import { hiddenArmAlpha } from '@/view/NVCrosshair'

const OBLIQUE = 6.7

describe('hiddenArmAlpha', () => {
  test('2D tiles of an oblique volume redraw the arms a slice hides', () => {
    for (const sliceType of [
      SLICE_TYPE.AXIAL,
      SLICE_TYPE.CORONAL,
      SLICE_TYPE.SAGITTAL,
    ]) {
      expect(hiddenArmAlpha(0, sliceType, OBLIQUE)).toBe(0.15)
    }
  })

  test('an axis-aligned volume needs no redraw', () => {
    expect(hiddenArmAlpha(0, SLICE_TYPE.AXIAL, 0)).toBe(0)
  })

  test('mesh x-ray, which already redraws them, turns it off', () => {
    expect(hiddenArmAlpha(0.05, SLICE_TYPE.AXIAL, OBLIQUE)).toBe(0)
    expect(hiddenArmAlpha(0.5, SLICE_TYPE.AXIAL, OBLIQUE)).toBe(0)
  })

  test('render tiles never redraw hidden arms', () => {
    expect(hiddenArmAlpha(0, SLICE_TYPE.RENDER, OBLIQUE)).toBe(0)
  })
})
