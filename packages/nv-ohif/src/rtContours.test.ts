import { expect, test } from 'bun:test'
import type { VectorAnnotation } from '@niivue/niivue'
import { ringArea } from './contourOps'
import { rtContourShapes } from './rtContours'

// A gantry-tilt shear: axial voxel plane k is z = 0.5 y + 2 k + 3 (RAS mm).
const grid = {
  affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 2, 3],
  dims: [30, 30, 10] as [number, number, number],
}
const onPlane = (k: number, ring: number[][], dz = 0) => ({
  type: 'CLOSED_PLANAR',
  points: ring.map(([x = 0, y = 0], i) => ({
    x: -x,
    y: -y,
    z: 0.5 * y + 2 * k + 3 + (i === 1 ? dz : 0),
  })),
})
const square = (a: number, b: number) => [
  [a, a],
  [b, a],
  [b, b],
  [a, b],
]
const narrow = [
  [4.9, 2],
  [5.1, 2],
  [5.1, 8],
  [4.9, 8],
]
const area = (s?: Pick<VectorAnnotation, 'polygons'>) =>
  (s?.polygons ?? []).reduce(
    (t, p) =>
      t + ringArea(p.outer) - p.holes.reduce((h, r) => h + ringArea(r), 0),
    0,
  )

test('RT contours become shapes on the voxel planes, holes and keyholes cut', () => {
  // Outer + nested ring (a hole), and a keyhole ring retracing its bridge.
  const keyhole = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
    [0, 5],
    [5, 5],
    [5, 10],
    [10, 10],
    [10, 5],
    [5, 5],
    [0, 5],
  ]
  const r = rtContourShapes(
    grid,
    [
      {
        ROIName: 'Body',
        colorArray: [1, 2, 3],
        contourPoints: [onPlane(4, square(0, 20)), onPlane(4, square(5, 10))],
      },
      { ROIName: 'Keyhole', contourPoints: [onPlane(6, keyhole)] },
    ],
    'rt',
  )
  expect(r?.segments).toEqual([
    { value: 1, label: 'Body', rgb: [1, 2, 3] },
    { value: 2, label: 'Keyhole', rgb: [255, 255, 255] },
  ])
  const [body, key] = r?.shapes ?? []
  expect(body?.group).toBe('seg:rt')
  expect([body?.sliceType, body?.slicePosition]).toEqual([0, 11])
  expect(body?.polygons[0]?.holes).toHaveLength(1)
  expect(area(body)).toBeCloseTo(375, 6)
  expect(area(key)).toBeCloseTo(375, 6)
  // Overlapping rings union (175), whichever vertex starts the second ring.
  for (const start of [0, 2]) {
    const b = square(5, 15)
    const ring = [...b.slice(start), ...b.slice(0, start)]
    const overlap = rtContourShapes(
      grid,
      [{ contourPoints: [onPlane(4, square(0, 10)), onPlane(4, ring)] }],
      'rt',
    )
    expect(area(overlap?.shapes[0])).toBeCloseTo(175, 6)
  }
  // A hole inside A only does not cut B overlapping it: (A - H) + B = 163.
  const mixed = rtContourShapes(
    grid,
    [
      {
        contourPoints: [
          onPlane(4, square(0, 10)),
          onPlane(4, square(5, 15)),
          onPlane(4, square(3, 7)),
        ],
      },
    ],
    'rt',
  )
  expect(area(mixed?.shapes[0])).toBeCloseTo(163, 6)
  // A collinear ring (no area) is skipped, not taken as off-plane, as is one
  // with decimal-string noise (no reliable plane); a ring narrower than
  // ON_PLANE still has area and covers voxel centres.
  const line = rtContourShapes(
    grid,
    [
      {
        contourPoints: [
          onPlane(4, [
            [0.4, 1],
            [0.4, 2],
            [0.4, 3],
          ]),
        ],
      },
      {
        contourPoints: [onPlane(4, narrow)],
      },
      {
        contourPoints: [
          onPlane(
            4,
            [
              [0, 5.5],
              [10, 5.5001],
              [20, 5.5],
            ],
            0.0002,
          ),
        ],
      },
    ],
    'rt',
  )
  expect(area(line?.shapes[0])).toBeCloseTo(1.2, 6)
  expect(line?.segments.map((s) => s.value)).toEqual([1])
  // Off the planes by half a voxel: the drawing shows it instead.
  const off = rtContourShapes(
    grid,
    [{ contourPoints: [onPlane(4, square(0, 20), 1)] }],
    'rt',
  )
  expect(off).toBeNull()
  // Flat but halfway between planes 4 and 5, however narrow.
  const between = rtContourShapes(
    grid,
    [{ contourPoints: [onPlane(4.5, narrow)] }],
    'rt',
  )
  expect(between).toBeNull()
})

// Review of #877: an ROI wholly off the image became a segment (and took one
// of the 255 slots).
test('an ROI wholly outside the grid is not a segment', () => {
  const r = rtContourShapes(
    grid,
    [
      { ROIName: 'Beside', contourPoints: [onPlane(4, square(40, 50))] },
      { ROIName: 'Beyond', contourPoints: [onPlane(20, square(0, 20))] },
      { ROIName: 'Inside', contourPoints: [onPlane(4, square(0, 20))] },
    ],
    'rt',
  )
  expect(r?.segments.map((s) => [s.label, s.value])).toEqual([['Inside', 1]])
  expect(r?.shapes).toHaveLength(1)
})

// Review of #877: the 255 cap flagged truncation before knowing whether the
// next ROI draws anything.
test('an undrawable ROI past the 255 cap is not a truncation', () => {
  const inside = { contourPoints: [onPlane(4, square(0, 20))] }
  const rois = Array.from({ length: 255 }, (_, i) => ({
    ROIName: `R${i}`,
    ...inside,
  }))
  const beyond = {
    ROIName: 'Beyond',
    contourPoints: [onPlane(20, square(0, 20))],
  }
  expect(rtContourShapes(grid, [...rois, beyond], 'rt')?.truncated).toBe(false)
  const r = rtContourShapes(
    grid,
    [...rois, { ROIName: 'More', ...inside }],
    'rt',
  )
  expect([r?.truncated, r?.segments.length, r?.shapes.length]).toEqual([
    true,
    255,
    255,
  ])
})
