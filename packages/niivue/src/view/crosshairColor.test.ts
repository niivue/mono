import { describe, expect, test } from 'bun:test'
import { getAxisColor } from './crosshairColor'

const RED = [1, 0, 0, 1]
const GREEN = [0, 1, 0, 1]
const BLUE = [0, 0, 1, 1]
const FALLBACK = [0.5, 0.5, 0.5, 1]

describe('getAxisColor', () => {
  test('noPerAxis_returnsFallback', () => {
    expect(getAxisColor(0, FALLBACK)).toEqual(FALLBACK)
  })

  test('emptyPerAxis_returnsFallback', () => {
    expect(getAxisColor(1, FALLBACK, [])).toEqual(FALLBACK)
  })

  test('threeColors_returnsPerAxis', () => {
    const perAxis = [RED, GREEN, BLUE]
    expect(getAxisColor(0, FALLBACK, perAxis)).toEqual(RED)
    expect(getAxisColor(1, FALLBACK, perAxis)).toEqual(GREEN)
    expect(getAxisColor(2, FALLBACK, perAxis)).toEqual(BLUE)
  })

  test('rgbWithoutAlpha_isAccepted', () => {
    const perAxis = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    expect(getAxisColor(2, FALLBACK, perAxis)).toEqual([0, 0, 1])
  })

  test('wrongLengthTriple_fallsBack', () => {
    // Only two entries: not a valid per-axis triple, so fall back.
    expect(getAxisColor(0, FALLBACK, [RED, GREEN])).toEqual(FALLBACK)
  })

  test('outOfRangeAxis_fallsBack', () => {
    const perAxis = [RED, GREEN, BLUE]
    expect(getAxisColor(3, FALLBACK, perAxis)).toEqual(FALLBACK)
    expect(getAxisColor(-1, FALLBACK, perAxis)).toEqual(FALLBACK)
  })

  test('malformedAxisEntry_fallsBack', () => {
    // Z entry too short to be a usable RGB(A) color.
    const perAxis = [RED, GREEN, [0, 0] as number[]]
    expect(getAxisColor(2, FALLBACK, perAxis)).toEqual(FALLBACK)
  })

  test('doesNotMutateInputs', () => {
    const perAxis = [RED, GREEN, BLUE]
    const result = getAxisColor(0, FALLBACK, perAxis)
    expect(result).toBe(RED)
  })
})
