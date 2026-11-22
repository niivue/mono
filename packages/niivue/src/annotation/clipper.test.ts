import { expect, test } from 'bun:test'
import { clipperIntersects, clipperRegionArea, polygonBoolean } from './clipper'

const square = (lo: number, hi: number) => [
  { x: lo, y: lo },
  { x: hi, y: lo },
  { x: hi, y: hi },
  { x: lo, y: hi },
]

// nv-ohif's contour operations (merge, subtract, intersect segments per slice).
test('polygonBoolean keeps holes and each set as one region', () => {
  const ring = [{ outer: square(0, 10), holes: [square(4, 6)] }]
  const b = [{ outer: square(5, 15), holes: [] }]
  const area = (op: Parameters<typeof polygonBoolean>[0]) =>
    clipperRegionArea(polygonBoolean(op, ring, b))
  // 100 - 4 (hole) and 100, sharing 25 - 1 (the hole's corner inside b).
  expect(area('union')).toBeCloseTo(96 + 100 - 24, 6)
  expect(area('intersection')).toBeCloseTo(24, 6)
  expect(area('difference')).toBeCloseTo(96 - 24, 6)
  expect(area('xor')).toBeCloseTo(96 + 100 - 48, 6)
})

// A live-wire trace retraces its pixels (minimized from a rig hang): clipper2-ts's
// sweep never returned until toPath64 dropped the zero-width spike.
test('a ring that doubles back on itself is clipped', () => {
  const p = (pts: number[][]) =>
    pts.map(([x = 0, y = 0]) => ({ x: x / 100, y: y / 100 }))
  const a = {
    outer: p([
      [3208, 4225],
      [3208, 4734],
      [3208, 5243],
    ]),
  }
  const b = {
    outer: p([
      [4465, -3859],
      [4332, -3859],
      [4199, -3859],
      [4731, -3859],
      [4864, -3761],
      [7790, -4152],
      [7923, -4152],
      [8189, -1028],
    ]),
  }
  expect(clipperIntersects(a, b)).toBe(false)
})
