import { expect, test } from 'bun:test'
import { magicWand } from './magicWand'

test('auto picks the calibrated side when scl_slope is negative', () => {
  const slope = -2
  const inter = 100
  const toRaw = (v: number) => (v - inter) / slope
  const raw = [10, 20, 40, 45] // calibrated 80 60 20 10
  const bmp = new Uint8Array(4)
  const r = magicWand([2, 0, 0], bmp, { dimX: 4, dimY: 1, dimZ: 1 }, raw, {
    thresholdMode: 'auto',
    calMin: toRaw(0),
    calMax: toRaw(100),
  })
  // The seed (calibrated 20) is below the midpoint 50, so the darker voxels fill.
  expect([...bmp]).toEqual([0, 0, 1, 1])
  // isBright is in raw units, where the order flips.
  expect(r.isBright).toBe(true)
})
