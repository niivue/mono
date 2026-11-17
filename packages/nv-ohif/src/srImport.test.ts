import { expect, test } from 'bun:test'
import { annotationFromRow } from './srImport'

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
