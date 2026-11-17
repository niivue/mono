import { expect, it } from 'bun:test'
import { computeVolume, timeActivity, timePoints } from './kinetics'

const frames = (raw: number[][]) => ({
  count: raw.length,
  load: async (f: number) => Int16Array.from(raw[f] ?? []),
})

it('computes SUM, AVERAGE and SUBTRACT on scaled frames', async () => {
  // slope 2, inter 1: scaled frames [3, 5], [7, 9], [11, 15].
  const f = frames([
    [1, 2],
    [3, 4],
    [5, 7],
  ])
  expect([...(await computeVolume('SUM', f, 1, 3, 2, 1))]).toEqual([21, 29])
  expect([...(await computeVolume('AVERAGE', f, 2, 3, 2, 1))]).toEqual([9, 12])
  expect([...(await computeVolume('SUBTRACT', f, 1, 3, 2, 1))]).toEqual([
    -8, -10,
  ])
})

it('time-activity: per-label mean, population std, min, max', async () => {
  // Native x is RAS-flipped: RAS voxels 0, 1 (label 1) are native 2, 1.
  const grid = {
    dims: [3, 1, 1] as [number, number, number],
    start: 2,
    step: [-1, 3, 3] as [number, number, number],
    affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  }
  const curves = await timeActivity(
    Uint8Array.from([1, 1, 2]),
    grid,
    frames([
      [10, 20, 30],
      [0, 0, 4],
    ]),
    2,
    1,
  )
  expect(curves.map((c) => [c.value, c.mean, c.std, c.min, c.max])).toEqual([
    [1, [51, 5], [10, 4], [41, 1], [61, 9]],
    [2, [21, 1], [0, 0], [21, 1], [21, 1]],
  ])
})

it('time axis: distinct FrameReferenceTime, rescaled while most points exceed the unit', () => {
  const t = [0, 60000, 120000, 120000].map((FrameReferenceTime) => ({
    FrameReferenceTime,
  }))
  expect(timePoints(t)).toEqual({ points: [0, 60, 120], unit: 's' })
})
