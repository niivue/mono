import { describe, expect, test } from 'bun:test'
import { applyHazeRemoval, applyOtsu, findOtsu } from './otsu'

// Raw 0..100 stored with scl_slope 2, scl_inter 10: calibrated 10..210.
const raw = Float32Array.from({ length: 101 }, (_, i) => i)
const slope = 2
const inter = 10
const calibrated = Array.from(raw, (v) => v * slope + inter)

describe('scl_slope != 1', () => {
  test('removeHaze keeps calibrated values above the threshold', () => {
    const out = applyHazeRemoval(raw, inter, slope, 10, 110)
    expect(out[100]).toBe(210)
    expect(out[60]).toBe(130)
    expect(out[40]).toBe(10)
  })

  test('otsu labels match the same data stored calibrated', () => {
    const t = findOtsu(raw, 10, 210, inter, slope, 3)
    expect(Array.from(applyOtsu(raw, t, inter, slope))).toEqual(
      Array.from(applyOtsu(calibrated, t)),
    )
  })
})
