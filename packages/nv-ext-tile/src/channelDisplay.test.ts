import { describe, expect, test } from 'bun:test'
import { toStored, toValue } from '@niivue/niivue'
import {
  grayInto,
  quantizeRange,
  storedToValue,
  storedWindow,
} from './channelDisplay'

function quantized(
  [p2, p98, min, max]: number[],
  float: boolean,
  data: ArrayLike<number>,
  w: number,
  sy: number,
  sx: number,
) {
  const { quantize: q } = quantizeRange(min, max, float)
  const out = new Uint16Array(data.length)
  grayInto(out, 0, data, sy, sx, w, data.length / w, q)
  return {
    window: storedWindow(q, p2, p98, 16),
    storedToValue: storedToValue(q),
    out: Array.from(out),
    q,
  }
}

describe('channelDisplay', () => {
  test('int16: golden window, inverse and samples, contiguous and strided', () => {
    const range = [-900, 1200, -1000, 1500]
    const data = [-1000, -1, 0, 7, 1500, 2000]
    // The same 2 x 3 tile stored transposed: strides (sy, sx) = (1, 3).
    const t = [-1000, 0, 1500, -1, 7, 2000]
    for (const got of [
      quantized(range, false, data, 2, 2, 1),
      quantized(range, false, t, 2, 1, 3),
    ]) {
      expect(got.out).toEqual([0, 26188, 26214, 26397, 65535, 65535])
      expect(got.storedToValue.offset).toBe(-1000)
      expect(got.storedToValue.scale).toBeCloseTo(2500 / 65535, 15)
      expect(got.window.calMin).toBeCloseTo(2621.4, 9)
      expect(got.window.calMax).toBeCloseTo(57670.8, 9)
    }
  })

  test('flat float centres on its value; NaN and +-Infinity clamp', () => {
    const flat = quantized([-8, -8, -8, -8], true, [-8, -9, -4, NaN], 2, 2, 1)
    expect(flat.storedToValue.offset).toBe(-12)
    expect(flat.window).toEqual({ calMin: 0, calMax: 65535 })
    expect(flat.out).toEqual([32768, 24576, 65535, 0])
    const nan = [NaN, 0, 3, Infinity, -Infinity, 1.5]
    expect(quantized([1, 2, 0, 3], true, nan, 2, 2, 1).out).toEqual([
      0, 0, 65535, 65535, 0, 32768,
    ])
  })

  test('huge and subnormal float64 spans stay finite and spread', () => {
    // hi - lo overflows: k = 1/2 halves both ends first.
    const h = quantized(
      [-1e307, 1e307, -1e308, 1.7e308],
      true,
      [-1e308, 0, 1.7e308],
      3,
      3,
      1,
    )
    expect(h.q.k).toBe(0.5)
    expect(h.out).toEqual([0, Math.round((1 / 2.7) * 65535), 65535])
    expect(h.storedToValue.offset).toBe(-1e308)
    // Subnormal span: scale is Infinity, so the divide path spreads samples.
    const t = quantized(
      [5e-311, 1.5e-310, 0, 2e-310],
      true,
      [0, 1e-310, 2e-310],
      3,
      3,
      1,
    )
    expect(Number.isFinite(t.q.scale)).toBe(false)
    expect(t.out).toEqual([0, 32768, 65535])
    expect(t.window.calMin).toBeCloseTo(16383.75, 6)
    expect(t.window.calMax).toBeCloseTo(49151.25, 6)
  })

  test('all-NaN float sample centres +-32767.5 on 0', () => {
    const none = [Infinity, -Infinity, Infinity, -Infinity]
    const got = quantized(none, true, [NaN, 1], 2, 2, 1)
    expect(got.storedToValue).toEqual({ scale: 1, offset: -32767.5 })
    expect(got.window).toEqual({ calMin: 0, calMax: 65535 })
    expect(got.out).toEqual([0, 32769])
  })

  test('uint8/uint16 pass through unquantized, ', () => {
    for (const [bits, Typed] of [
      [8, Uint8Array],
      [16, Uint16Array],
    ] as const) {
      const max = 2 ** bits - 1
      // Old rule (both sources): the 2-98% range, else the full stored range.
      for (const [p2, p98] of [
        [3, 200],
        [7, 7],
        [Infinity, -Infinity],
      ]) {
        const want =
          p98 > p2 ? { calMin: p2, calMax: p98 } : { calMin: 0, calMax: max }
        expect(storedWindow(null, p2, p98, bits)).toEqual(want)
      }
      // 3 x 2 tile, contiguous and transposed (sy, sx) = (1, 2).
      const data = new Typed([0, 1, 2, max, 4, 5])
      const t = new Typed([0, max, 1, 4, 2, 5])
      for (const [d, sy, sx] of [
        [data, 3, 1],
        [t, 1, 2],
      ] as const) {
        const out = new Typed(8)
        grayInto(out, 2, d, sy, sx, 3, 2, null)
        expect(Array.from(out)).toEqual([0, 0, 0, 1, 2, max, 4, 5])
      }
    }
  })
})

test('grayInto flat quantized loop writes only w * h samples', () => {
  const { quantize: q } = quantizeRange(0, 10, true)
  const out = new Uint16Array(6)
  grayInto(out, 0, new Float32Array(6).fill(10), 2, 1, 2, 2, q)
  expect(Array.from(out)).toEqual([65535, 65535, 65535, 65535, 0, 0])
})

// S8: core toStored inverts toValue exactly over the maps TIFF and Zarr state.
test('S8: toStored(toValue(s, m), m) === s for the quantize maps', () => {
  const ranges: [number, number, boolean][] = [
    [0, 1, true],
    [-1024, 3071, false],
    [-2147483648, 2147483647, false],
    [1e-3, 7.5, true],
    [-3.4e38, 3.4e38, true],
    [Math.PI, 1e5, true],
    [5, 5, true],
  ]
  const bad: string[] = []
  for (const [lo, hi, float] of ranges) {
    const map = storedToValue(quantizeRange(lo, hi, float).quantize)
    for (let s = 0; s <= 65535; s++)
      if (toStored(toValue(s, map), map) !== s) bad.push(`${lo}..${hi}: ${s}`)
  }
  expect(bad).toEqual([])
})
