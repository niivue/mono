import { expect, test } from 'bun:test'
import { copyStrided } from './copyStrided'

test('copies a permuted block x-fastest into a zero-padded brick', () => {
  // 3 x 2 x 2 block stored x slowest (C order z fastest): strides [4, 2, 1].
  const data = new Uint16Array(12).map((_, i) => i + 1)
  const out = new Uint16Array(4 * 3 * 2)
  copyStrided(out, data, [3, 2, 2], [4, 2, 1], 4, 12)
  // biome-ignore format: one brick row per line
  expect(Array.from(out)).toEqual([
    1, 5, 9, 0,  3, 7, 11, 0,  0, 0, 0, 0,
    2, 6, 10, 0, 4, 8, 12, 0,  0, 0, 0, 0,
  ])
})

test('long contiguous rows (subarray + set) land at the row pitch', () => {
  const nx = 70
  const data = new Uint16Array(nx * 2).map((_, i) => i + 1)
  const out = new Uint16Array(72 * 2)
  copyStrided(out, data, [nx, 2, 1], [1, nx, nx * 2], 72, 144)
  expect(Array.from(out.subarray(0, 72))).toEqual([
    ...data.subarray(0, nx),
    0,
    0,
  ])
  expect(Array.from(out.subarray(72, 72 + nx))).toEqual([...data.subarray(nx)])
  expect(out[143]).toBe(0)
})
