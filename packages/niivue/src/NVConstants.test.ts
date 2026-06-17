import { describe, expect, test } from 'bun:test'
import {
  isPaqd,
  NiiDataType,
  NiiIntentCode,
  SLICE_TYPE,
  sliceTypeDim,
} from './NVConstants'

describe('isPaqd', () => {
  test('labelAndRGBA32_returnsTrue', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_LABEL,
        datatypeCode: NiiDataType.DT_RGBA32,
      }),
    ).toBe(true)
  })

  test('wrongIntent_returnsFalse', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_NONE,
        datatypeCode: NiiDataType.DT_RGBA32,
      }),
    ).toBe(false)
  })

  test('wrongDatatype_returnsFalse', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_LABEL,
        datatypeCode: NiiDataType.DT_FLOAT32,
      }),
    ).toBe(false)
  })
})

describe('sliceTypeDim', () => {
  test('axial_returns2', () => {
    expect(sliceTypeDim(SLICE_TYPE.AXIAL)).toBe(2)
  })

  test('coronal_returns1', () => {
    expect(sliceTypeDim(SLICE_TYPE.CORONAL)).toBe(1)
  })

  test('sagittal_returns0', () => {
    expect(sliceTypeDim(SLICE_TYPE.SAGITTAL)).toBe(0)
  })

  test('noneFallsBackToDefault', () => {
    // SLICE_TYPE.NONE hides the spatial view (no slice dim applies); the helper
    // must return its safe default (2) rather than throw or yield NaN.
    expect(sliceTypeDim(SLICE_TYPE.NONE)).toBe(2)
  })

  test('sliceTypeNoneIsDistinct', () => {
    const values = Object.values(SLICE_TYPE)
    expect(SLICE_TYPE.NONE).toBe(5)
    expect(new Set(values).size).toBe(values.length) // all enum values unique
  })
})
