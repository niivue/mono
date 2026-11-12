import { describe, expect, test } from 'bun:test'
import { SLICE_TYPE } from '@/NVConstants'
import { calculateCrosshairSegments, hiddenArmAlpha } from '@/view/NVCrosshair'

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

describe('calculateCrosshairSegments', () => {
  test('a crosshair past the extents stretches the arms; none runs backward', () => {
    // Volume 0..100 mm; a slide plane let the crosshair reach 250 mm (frac 2.5).
    const segs = calculateCrosshairSegments(
      [0, 0, 0],
      [100, 100, 100],
      [2.5, 0.5, 0.5],
      2,
    )
    const x = segs.slice(0, 2).map(([a, b]) => [a[0], b[0]])
    expect(x).toEqual([
      [0, 249],
      [251, 251],
    ])
    for (const [a, b] of segs)
      for (let i = 0; i < 3; i++) expect(b[i]).toBeGreaterThanOrEqual(a[i])
  })

  test('inside the extents the arms end at them', () => {
    const segs = calculateCrosshairSegments(
      [0, 0, 0],
      [100, 100, 100],
      [0.5, 0.5, 0.5],
      2,
    )
    expect(segs.slice(0, 2).map(([a, b]) => [a[0], b[0]])).toEqual([
      [0, 49],
      [51, 100],
    ])
  })
})
