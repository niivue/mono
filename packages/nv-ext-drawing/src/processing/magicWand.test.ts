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

test('bright and dark take a one-sided percent band', () => {
  const raw = [36, 40, 44]
  const run = (thresholdMode: 'bright' | 'dark') => {
    const bmp = new Uint8Array(3)
    magicWand([1, 0, 0], bmp, { dimX: 3, dimY: 1, dimZ: 1 }, raw, {
      thresholdMode,
      percent: 0.1,
    })
    return [...bmp]
  }
  expect(run('bright')).toEqual([0, 1, 1])
  expect(run('dark')).toEqual([1, 1, 0])
})

test('auto with percent and a negative scl_slope fills the calibrated dark side', () => {
  // slope -2, intercept 100: calibrated 28 20 12; raw range for cal 0..100 is 50..0
  const bmp = new Uint8Array(3)
  magicWand([1, 0, 0], bmp, { dimX: 3, dimY: 1, dimZ: 1 }, [36, 40, 44], {
    thresholdMode: 'auto',
    calMin: 50,
    calMax: 0,
    percent: 0.1,
  })
  expect([...bmp]).toEqual([0, 1, 1])
})

test('percent mode contains a zero or negative seed', () => {
  const run = (raw: number[]) => {
    const bmp = new Uint8Array(3)
    magicWand([1, 0, 0], bmp, { dimX: 3, dimY: 1, dimZ: 1 }, raw, {
      thresholdMode: 'percent',
      percent: 0.1,
    })
    return [...bmp]
  }
  expect(run([-11, -10, -9])).toEqual([1, 1, 1])
  expect(run([0, 0, 0])).toEqual([1, 1, 1])
  expect(run([8, 10, 12])).toEqual([0, 1, 0])
})
