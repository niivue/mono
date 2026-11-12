import { expect, test } from 'bun:test'
import { sampleLevel } from './levelSample'

test('the grid spreads past a background centre, so the window does not collapse', async () => {
  // 8192 x 1 in 512-wide tiles: 4 spread tiles, none in the middle 1024
  // (3584..4608). The edge tiles hold 100..611, the others background (10).
  const cells: [number, number][] = []
  const range = await sampleLevel(8192, 1, 512, 1, async (_y, x) => {
    cells.push(x)
    const edge = x[0] === 0 || x[1] === 8192
    return Float32Array.from({ length: x[1] - x[0] }, (_, i) =>
      edge ? 100 + i : 10,
    )
  })
  expect(cells.sort((a, b) => a[0] - b[0])).toEqual([
    [0, 512],
    [2560, 3072],
    [5120, 5632],
    [7680, 8192],
  ])
  // Half the samples are background at 10: p2 is 10, p98 high in 100..611.
  expect(range[0]).toBe(10)
  expect(range[1]).toBeGreaterThan(590)
  expect(range.slice(2)).toEqual([10, 611])
})

test('percentiles come from a bounded stride; min and max from every sample', async () => {
  // 16 cells of 1024^2 (16M samples): a stride of 16 keeps 1M.
  const n = 1 << 20
  const cell = Float32Array.from({ length: n }, (_, i) => i + 1)
  const [p2, p98, min, max] = await sampleLevel(
    4096,
    4096,
    1024,
    1024,
    async () => cell,
  )
  expect([min, max]).toEqual([1, n])
  // Within a 1/1000 bin of the exact 2% and 98% points.
  expect(Math.abs(p2 - 0.02 * n)).toBeLessThan(n / 1000)
  expect(Math.abs(p98 - 0.98 * n)).toBeLessThan(n / 1000)
})

test('a period matching the stride does not phase-lock the percentiles', async () => {
  // Stride 16 (as above); 200 at every 16th sample, 1 elsewhere. The 2%
  // point is background: a stride-aligned pick would see only 200s.
  const cell = Float32Array.from({ length: 1 << 20 }, (_, i) =>
    i % 16 ? 1 : 200,
  )
  const range = await sampleLevel(4096, 4096, 1024, 1024, async () => cell)
  expect(range[0]).toBe(1)
  expect(range.slice(2)).toEqual([1, 200])
})

test('an all-NaN sample has no finite range', async () => {
  const range = await sampleLevel(4, 1, 4, 1, async () =>
    Float32Array.from([Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
  )
  expect(range).toEqual([
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])
})
