import { expect, test } from 'bun:test'
import { generateShape, type VectorAnnotation } from '@niivue/niivue'
import { reflectNiivueAnnotation } from './commands'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { annotationFromRow, reportScale } from './srImport'

// An axial volume (voxel dim 3 along RAS z): acquisition plane axial.
const nv = {
  volumes: [{ permRAS: [1, 2, 3] }],
  annotationStyle: {
    fillColor: [1, 0, 0, 1],
    strokeColor: [1, 0, 0, 1],
    strokeWidth: 1,
  },
  annotationAreaIsGeometric: true,
} as unknown as Parameters<typeof annotationFromRow>[0]

test('SR angle and bidirectional import from world points; a rotated rectangle stays', () => {
  const angle = annotationFromRow(nv, {
    uid: 'a',
    toolName: 'Angle',
    points: [
      [10, 0, 5],
      [0, 0, 5],
      [0, 10, 5],
    ],
  })
  expect(angle?.shape?.type).toBe('measureAngle')
  expect(angle?.stats?.angle).toBeCloseTo(90, 9)
  const rotated = annotationFromRow(nv, {
    uid: 'r',
    toolName: 'RectangleROI',
    points: [
      [0, 0, 5],
      [3, 1, 5],
      [2, 4, 5],
      [-1, 3, 5],
    ],
  })
  expect(rotated).toBeUndefined()
  // Short axis written first, on a coronal plane (y = 7): long axis leads.
  const bidi = annotationFromRow(nv, {
    uid: 'b',
    toolName: 'Bidirectional',
    points: [
      [0, 7, -2],
      [0, 7, 2],
      [-5, 7, 0],
      [5, 7, 0],
    ],
  })
  expect(bidi?.sliceType).toBe(1)
  expect(bidi?.shape?.type).toBe('measureBidirectional')
  expect(bidi?.stats?.length).toBeCloseTo(10, 9)
  expect(bidi?.stats?.shortLength).toBeCloseTo(4, 9)
  expect(bidi?.polygons).toHaveLength(2)
})

test('a released native row is restored on the plane it was drawn on', () => {
  // A horizontal coronal line also lies on an axial plane, the acquisition one.
  const style = nv.annotationStyle
  const coronal = {
    id: 'line',
    label: 1,
    group: 'measurements',
    sliceType: 1,
    slicePosition: 30,
    style,
    shape: {
      type: 'measureLine',
      start: { x: 10, y: 20 },
      end: { x: 20, y: 20 },
      width: 1,
    },
    polygons: generateShape(
      'measureLine',
      { x: 10, y: 20 },
      { x: 20, y: 20 },
      1,
    ),
    stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, length: 10 },
  } as VectorAnnotation
  const ds = {
    SeriesInstanceUID: 'series',
    displaySetInstanceUID: 'ds',
    instances: [{ FrameOfReferenceUID: 'for' }],
  }
  let row: Parameters<typeof annotationFromRow>[1] | undefined
  const servicesManager = {
    services: {
      measurementService: {
        createSource: (name: string) => ({ name }),
        addMapping: () => {},
        addRawMeasurement: (
          _s: unknown,
          _t: unknown,
          d: unknown,
          convert: (d: unknown) => typeof row,
        ) => {
          row = convert(d)
          return row?.uid
        },
      },
      displaySetService: { getDisplaySetsForSeries: () => [ds] },
    },
  } as unknown as Parameters<typeof reflectNiivueAnnotation>[1]
  registerNiivue('native-plane', nv as never)
  updateNiivueViewport('native-plane', { displaySets: [ds] as never })
  try {
    expect(
      reflectNiivueAnnotation('native-plane', servicesManager, coronal),
    ).toBe(true)
    const restored = annotationFromRow(nv, row as NonNullable<typeof row>)
    expect(restored?.sliceType).toBe(1)
    expect(restored?.slicePosition).toBe(30)
  } finally {
    unregisterNiivue('native-plane')
  }
})

test('a report row gives its calibration from length, else from area', () => {
  const perImage = (stats: object) => ({
    uid: 'u',
    data: { 'imageId:a': stats },
  })
  expect(reportScale(perImage({ length: 20 }), { length: 10, area: 0 })).toBe(2)
  // An ROI-only report: 16 mm2 stored over 4 mm2 of geometry.
  expect(reportScale(perImage({ area: 16 }), { area: 4 })).toBe(2)
  expect(reportScale(perImage({ value: 3 }), { area: 0 })).toBeUndefined()
  // An overflowed NUM (1e400 parses to Infinity) or a negative one: no scale.
  expect(
    reportScale(perImage({ length: Infinity }), { length: 10, area: 0 }),
  ).toBeUndefined()
  expect(
    reportScale(perImage({ length: -20 }), { length: 10, area: 0 }),
  ).toBeUndefined()
})
