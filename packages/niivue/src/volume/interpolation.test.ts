import { describe, expect, test } from 'bun:test'
import { NiiDataType, NiiIntentCode } from '@/NVConstants'
import type { NVImage } from '@/NVTypes'
import { isNearestVolume, sliceInterpolation } from './interpolation'

function vol(opts: {
  intent?: number
  datatype?: number
  label?: boolean
  nearest?: boolean
  opacity?: number
}): NVImage {
  return {
    hdr: {
      intent_code: opts.intent ?? 0,
      datatypeCode: opts.datatype ?? NiiDataType.DT_FLOAT32,
    },
    colormapLabel: opts.label ? { lut: new Uint8ClampedArray(4) } : null,
    isNearestInterpolation: opts.nearest,
    opacity: opts.opacity,
  } as unknown as NVImage
}

const LABEL = NiiIntentCode.NIFTI_INTENT_LABEL

describe('isNearestVolume', () => {
  test('continuous data is linear', () => {
    expect(isNearestVolume(vol({}))).toBe(false)
  })
  test('label intent is nearest', () => {
    expect(isNearestVolume(vol({ intent: LABEL }))).toBe(true)
  })
  test('label colormap is nearest', () => {
    expect(isNearestVolume(vol({ label: true }))).toBe(true)
  })
  test('explicit setting overrides the header', () => {
    expect(isNearestVolume(vol({ intent: LABEL, nearest: false }))).toBe(false)
    expect(isNearestVolume(vol({ nearest: true }))).toBe(true)
  })
})

describe('sliceInterpolation', () => {
  test('resolves background and overlays independently', () => {
    expect(
      sliceInterpolation([vol({}), vol({ intent: LABEL })], false),
    ).toEqual({ background: false, overlay: true })
  })
  test('any visible categorical overlay makes the shared overlay nearest', () => {
    const overlays = [vol({}), vol({ label: true })]
    expect(sliceInterpolation([vol({}), ...overlays], false).overlay).toBe(true)
  })
  test('hidden overlays and PAQD volumes do not count', () => {
    const hidden = vol({ intent: LABEL, opacity: 0 })
    const paqd = vol({ intent: LABEL, datatype: NiiDataType.DT_RGBA32 })
    expect(sliceInterpolation([vol({}), hidden, paqd], false).overlay).toBe(
      false,
    )
  })
  test('the scene-wide flag forces nearest', () => {
    expect(sliceInterpolation([vol({})], true)).toEqual({
      background: true,
      overlay: true,
    })
  })
})
