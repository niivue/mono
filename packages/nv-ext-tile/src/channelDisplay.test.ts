import { describe, expect, test } from 'bun:test'
import { toStored, toValue } from '@niivue/niivue'
import {
  grayInto,
  type Quantize,
  quantizeRange,
  storedToValue,
  storedWindow,
} from './channelDisplay'

// Frozen copies of the pre-extraction code, the parity reference.
type OldTiffQ = { lo: number; scale: number }
function oldTiff(
  [p2, p98, min, max]: number[],
  float: boolean,
  data: ArrayLike<number>,
) {
  let window = { calMin: 0, calMax: 65535 }
  let [calMin, calMax] = [p2, p98]
  let [lo, hi] = [min, max]
  if (!(hi > lo)) {
    const mid = Number.isFinite(lo) ? lo : 0
    const half = float ? Math.max(Math.abs(mid) / 2, 1) : 32767.5
    ;[lo, hi] = [mid - half, mid + half]
  }
  const q: OldTiffQ = { lo, scale: 65535 / (hi - lo) }
  ;[calMin, calMax] = [(p2 - lo) * q.scale, (p98 - lo) * q.scale]
  if (calMax > calMin) window = { calMin, calMax }
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++)
    out[i] = Math.min(65535, Math.max(0, (data[i] - lo) * q.scale + 0.5))
  return {
    window,
    storedToValue: { scale: 1 / q.scale, offset: q.lo },
    out,
  }
}
function oldZarr(
  [p2, p98, min, max]: number[],
  float: boolean,
  data: ArrayLike<number>,
  w: number,
  sy: number,
  sx: number,
) {
  let [lo, hi] = [min, max]
  let noData = false
  if (!(hi > lo)) {
    noData = !Number.isFinite(lo)
    const mid = noData ? 0 : lo
    const half = !noData && float ? Math.max(Math.abs(mid) / 2, 1) : 32767.5
    ;[lo, hi] = [mid - half, mid + half]
  }
  const k = Number.isFinite(hi - lo) ? 1 : 0.5
  const span = hi * k - lo * k
  const q: Quantize = { k, lo: lo * k, span, scale: 65535 / span }
  const toStored = (v: number) => ((v * q.k - q.lo) / q.span) * 65535
  const [calMin, calMax] = [toStored(p2), toStored(p98)]
  const window =
    calMax > calMin ? { calMin, calMax } : { calMin: 0, calMax: 65535 }
  const h = data.length / w
  const out = new Uint16Array(data.length)
  for (let y = 0, o = 0; y < h; y++)
    for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
      out[o] = Number.isFinite(q.scale)
        ? Math.min(65535, Math.max(0, (data[i] * k - q.lo) * q.scale + 0.5))
        : Math.min(
            65535,
            Math.max(0, ((data[i] * k - q.lo) / span) * 65535 + 0.5),
          )
  return {
    window,
    storedToValue: { scale: q.span / (65535 * q.k), offset: q.lo / q.k },
    out,
    q,
  }
}

function now(
  range: number[],
  float: boolean,
  data: ArrayLike<number>,
  w: number,
  sy: number,
  sx: number,
) {
  const [p2, p98, min, max] = range
  const { quantize: q } = quantizeRange(min, max, float)
  const out = new Uint16Array(data.length)
  grayInto(out, 0, data, sy, sx, w, data.length / w, q)
  return {
    window: storedWindow(q, p2, p98, 16),
    storedToValue: storedToValue(q),
    out,
    q,
  }
}

// [name, [p2, p98, min, max], float, samples]; numerically safe for old TIFF.
const safe: [string, number[], boolean, number[]][] = [
  ['int16', [-900, 1200, -1000, 1500], false, [-1000, -1, 0, 7, 1500, 2000]],
  ['int32 wide', [-2e9, 2e9, -2.1e9, 2.1e9], false, [-2.1e9, 0, 3, 2.1e9]],
  ['float32', [0.1, 0.9, 0, 1], true, [0, 0.25, 0.5, Math.fround(0.7), 1, NaN]],
  ['float32 huge', [-1e37, 1e37, -3e38, 3e38], true, [-3e38, 0, 1e38, 3e38]],
  ['float32 tiny', [1e-30, 2e-30, 0, 3e-30], true, [0, 1e-30, 3e-30, -1]],
  ['flat int', [5, 5, 5, 5], false, [5, 4, 6, 70000]],
  ['flat float', [-8, -8, -8, -8], true, [-8, -9, -4, NaN]],
  ['some NaN', [1, 2, 0, 3], true, [NaN, 0, 3, Infinity, -Infinity]],
]

describe('channelDisplay parity', () => {
  test('reproduces the old Zarr outputs exactly, contiguous and strided', () => {
    for (const [name, range, float, data] of [
      ...safe,
      [
        'float64 overflow',
        [-1e307, 1e307, -1e308, 1.7e308],
        true,
        [-1e308, 0, 1.7e308, 1],
      ],
      [
        'float64 subnormal',
        [0, 1e-310, 0, 2e-310],
        true,
        [0, 1e-310, 2e-310, 3e-310],
      ],
      [
        'all NaN float',
        [Infinity, -Infinity, Infinity, -Infinity],
        true,
        [NaN, 1, -1, 4e4],
      ],
    ] as typeof safe) {
      // Transposed 2 x (n/2): read with strides (sy, sx) = (1, h).
      const tw = 2
      const th = data.length / tw
      const t = Array.from(
        { length: data.length },
        (_, i) => data[(i % th) * tw + Math.floor(i / th)],
      )
      for (const [d, sy, sx] of [
        [data, tw, 1],
        [t, 1, th],
      ] as const) {
        const want = oldZarr(range, float, d, tw, sy, sx)
        expect(now(range, float, d, tw, sy, sx), name).toEqual(want)
      }
    }
  })

  test('reproduces the old TIFF samples exactly where its form was safe', () => {
    for (const [name, range, float, data] of safe) {
      const old = oldTiff(range, float, data)
      const got = now(range, float, data, data.length, data.length, 1)
      expect(got.out, name).toEqual(old.out)
      // Window and inverse: Zarr's divide-first form, within an ulp or two.
      for (const [a, b] of [
        [got.window.calMin, old.window.calMin],
        [got.window.calMax, old.window.calMax],
        [got.storedToValue.scale, old.storedToValue.scale],
        [got.storedToValue.offset, old.storedToValue.offset],
      ])
        expect(Math.abs(a - b), name).toBeLessThanOrEqual(4e-16 * Math.abs(b))
    }
  })

  test('fixes old TIFF overflow: huge and subnormal float64 spans', () => {
    // hi - lo overflows: old scale was 0, every sample stored 0.
    const huge = [-1e307, 1e307, -1e308, 1.7e308]
    const hd = [-1e308, 0, 1.7e308]
    const h = now(huge, true, hd, 3, 3, 1)
    expect(h.q.k).toBe(0.5)
    expect(oldTiff(huge, true, hd).out).toEqual(new Uint16Array([0, 0, 0]))
    expect(Array.from(h.out)).toEqual([0, Math.round((1 / 2.7) * 65535), 65535])
    expect(h.storedToValue.offset).toBe(-1e308)
    // Subnormal span: old scale was Infinity, so the window fell back to
    // full, lo stored 0 and the rest 65535; the divide path spreads them.
    const tiny = [5e-311, 1.5e-310, 0, 2e-310]
    const td = [0, 1e-310, 2e-310]
    const t = now(tiny, true, td, 3, 3, 1)
    expect(Number.isFinite(t.q.scale)).toBe(false)
    expect(oldTiff(tiny, true, td).window).toEqual({ calMin: 0, calMax: 65535 })
    expect(Array.from(t.out)).toEqual([0, 32768, 65535])
    expect(t.window.calMin).toBeCloseTo(16383.75, 6)
    expect(t.window.calMax).toBeCloseTo(49151.25, 6)
  })

  test('all-NaN float sample: TIFF now centres +-32767.5 on 0 as Zarr', () => {
    const none = [Infinity, -Infinity, Infinity, -Infinity]
    expect(oldTiff(none, true, [NaN]).storedToValue.offset).toBe(-1)
    const got = now(none, true, [NaN, 1], 2, 2, 1)
    expect(got.storedToValue).toEqual({ scale: 1, offset: -32767.5 })
    expect(got.window).toEqual({ calMin: 0, calMax: 65535 })
    expect(Array.from(got.out)).toEqual([0, 32769])
  })

  test('uint8/uint16 pass through unquantized, as before', () => {
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
