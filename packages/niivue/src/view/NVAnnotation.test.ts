import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { AnnotationPoint, VectorAnnotation } from '@/NVTypes'
import { projectAnnotationScreenShapes } from './NVAnnotation'
import type { SliceTile } from './NVSliceLayout'

const square = (x: number, y: number, size: number): AnnotationPoint[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
]

describe('projectAnnotationScreenShapes', () => {
  test('projects every piece of an eraser-split ROI', () => {
    const annotation: VectorAnnotation = {
      id: 'a',
      label: 1,
      group: 'g',
      sliceType: SLICE_TYPE.AXIAL,
      slicePosition: 0,
      polygons: [
        { outer: square(0, 0, 4), holes: [square(1, 1, 2)] },
        { outer: square(10, 10, 3), holes: [] },
      ],
      style: {
        fillColor: [1, 0, 0, 1],
        strokeColor: [1, 0, 0, 1],
        strokeWidth: 1,
      },
    }
    const model = {
      ui: { isAnnotationDrawn: false },
      annotations: [annotation],
      _persistedAnnotationScreenShapes: [],
      getVolumes: () => [],
    } as unknown as NVModel
    const tile = {
      axCorSag: SLICE_TYPE.AXIAL,
      mvpMatrix: mat4.create(),
      planeNormal: [0, 0, 1],
      planePoint: [0, 0, 0],
      leftTopWidthHeight: [0, 0, 100, 100],
    } as unknown as SliceTile
    projectAnnotationScreenShapes(model, [tile])
    const [shape] = model._persistedAnnotationScreenShapes
    expect(shape?.polygons).toHaveLength(2)
    expect(shape?.polygons[0]?.holes).toHaveLength(1)
    expect(shape?.polygons[1]?.outer).toHaveLength(4)
    expect(shape?.outer).toBe(shape?.polygons[0]?.outer)
  })

  test('gives one shape per tile showing the annotation (#116)', () => {
    const annotation: VectorAnnotation = {
      id: 'a',
      label: 1,
      group: 'g',
      sliceType: SLICE_TYPE.AXIAL,
      slicePosition: 0,
      polygons: [{ outer: square(0, 0, 4), holes: [] }],
      style: {
        fillColor: [1, 0, 0, 1],
        strokeColor: [1, 0, 0, 1],
        strokeWidth: 1,
      },
    }
    const model = {
      ui: { isAnnotationDrawn: false },
      annotations: [annotation],
      _persistedAnnotationScreenShapes: [],
      getVolumes: () => [],
    } as unknown as NVModel
    // A mosaic with the same axial plane twice, side by side.
    const tile = (left: number) =>
      ({
        axCorSag: SLICE_TYPE.AXIAL,
        mvpMatrix: mat4.create(),
        planeNormal: [0, 0, 1],
        planePoint: [0, 0, 0],
        leftTopWidthHeight: [left, 0, 100, 100],
      }) as unknown as SliceTile
    projectAnnotationScreenShapes(model, [tile(0), tile(100)])
    const shapes = model._persistedAnnotationScreenShapes
    expect(shapes.map((s) => [s.id, s.tileIndex])).toEqual([
      ['a', 0],
      ['a', 1],
    ])
    // Each copy is projected into its own tile.
    expect(shapes[1]?.outer[0]?.x).toBe((shapes[0]?.outer[0]?.x ?? 0) + 100)
  })
})
