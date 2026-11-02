import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type { AnnotationPoint, NVImage, VectorAnnotation } from '@/NVTypes'
import { computeAnnotationStats } from './stats'

// 20x20x1 axial grid, 1 mm voxels, voxel value = its x index.
const N = 20
const img = new Float32Array(N * N)
for (let i = 0; i < img.length; i++) img[i] = i % N
const volume = {
  img,
  hdr: { scl_slope: 1, scl_inter: 0 },
  dimsRAS: [3, N, N, 1],
  pixDimsRAS: [1, 1, 1, 1],
  matRAS: mat4.create(),
  img2RASstart: [0, 0, 0],
  img2RASstep: [1, N, N * N],
  nVox3D: N * N,
} as unknown as NVImage

const square = (x: number, y: number, size: number): AnnotationPoint[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
]

const annotation = (
  polygons: VectorAnnotation['polygons'],
): VectorAnnotation => ({
  id: 'a',
  label: 1,
  group: 'g',
  sliceType: SLICE_TYPE.AXIAL,
  slicePosition: 0,
  polygons,
  shape: { type: 'freehand', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
  style: { fillColor: [1, 0, 0, 1], strokeColor: [1, 0, 0, 1], strokeWidth: 1 },
})

describe('computeAnnotationStats', () => {
  test('counts a square ROI', () => {
    const stats = computeAnnotationStats(
      annotation([{ outer: square(0, 0, 4), holes: [] }]),
      volume,
    )
    expect(stats?.area).toBe(16)
    expect(stats?.max).toBe(3)
  })

  test('covers every piece of a split ROI and skips its holes', () => {
    const stats = computeAnnotationStats(
      annotation([
        { outer: square(0, 0, 4), holes: [square(1, 1, 2)] },
        { outer: square(10, 10, 3), holes: [] },
      ]),
      volume,
    )
    expect(stats?.area).toBe(12 + 9)
    expect(stats?.min).toBe(0)
    expect(stats?.max).toBe(12)
  })
})
