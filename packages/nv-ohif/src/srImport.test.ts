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

test('an SR angle imports with its world angle; a rotated rectangle stays', () => {
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
})
