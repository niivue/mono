import { describe, expect, test } from 'bun:test'
import { SLICE_TYPE } from '@/NVConstants'
import { isOnSlice, mmToSlice2D, slice2DToMM } from './sliceProjection'

describe('mmToSlice2D', () => {
  test('axial_usesXY', () => {
    const pt = mmToSlice2D([10, 20, 30], SLICE_TYPE.AXIAL)
    expect(pt.x).toBe(10)
    expect(pt.y).toBe(20)
  })

  test('coronal_usesXZ', () => {
    const pt = mmToSlice2D([10, 20, 30], SLICE_TYPE.CORONAL)
    expect(pt.x).toBe(10)
    expect(pt.y).toBe(30)
  })

  test('sagittal_usesYZ', () => {
    const pt = mmToSlice2D([10, 20, 30], SLICE_TYPE.SAGITTAL)
    expect(pt.x).toBe(20)
    expect(pt.y).toBe(30)
  })
})

describe('slice2DToMM', () => {
  test('axial_reconstructsMMWithDepth', () => {
    const mm = slice2DToMM({ x: 10, y: 20 }, 30, SLICE_TYPE.AXIAL)
    expect(mm).toEqual([10, 20, 30])
  })

  test('coronal_reconstructsMMWithDepth', () => {
    const mm = slice2DToMM({ x: 10, y: 30 }, 20, SLICE_TYPE.CORONAL)
    expect(mm).toEqual([10, 20, 30])
  })

  test('sagittal_reconstructsMMWithDepth', () => {
    const mm = slice2DToMM({ x: 20, y: 30 }, 10, SLICE_TYPE.SAGITTAL)
    expect(mm).toEqual([10, 20, 30])
  })
})

describe('isOnSlice', () => {
  // Plane: z = 50 → normal = [0,0,1], point = [0,0,50]
  const normal = [0, 0, 1]
  const planePoint = [0, 0, 50]

  test('pointOnPlane_returnsTrue', () => {
    expect(isOnSlice([10, 20, 50], normal, planePoint, 0.5)).toBe(true)
  })

  test('pointOffPlane_returnsFalse', () => {
    expect(isOnSlice([10, 20, 60], normal, planePoint, 0.5)).toBe(false)
  })

  test('pointWithinTolerance_returnsTrue', () => {
    expect(isOnSlice([10, 20, 50.3], normal, planePoint, 0.5)).toBe(true)
  })

  test('pointJustOutsideTolerance_returnsFalse', () => {
    expect(isOnSlice([10, 20, 50.6], normal, planePoint, 0.5)).toBe(false)
  })
})
