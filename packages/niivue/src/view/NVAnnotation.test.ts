import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { AnnotationPoint, VectorAnnotation } from '@/NVTypes'
import {
  buildAnnotationRenderData,
  projectAnnotationScreenShapes,
} from './NVAnnotation'
import type { GlyphBatch } from './NVFont'
import type { LineData } from './NVLine'
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

describe('annotation label anchors', () => {
  const ann = (
    id: string,
    type: 'measureLine' | 'arrow' | 'rectangle',
    extra: Partial<VectorAnnotation>,
  ): VectorAnnotation => ({
    id,
    label: 1,
    group: 'g',
    sliceType: SLICE_TYPE.AXIAL,
    slicePosition: 0,
    polygons: [{ outer: square(2, 3, 4), holes: [] }],
    shape: { type, start: { x: 2, y: 3 }, end: { x: 6, y: 7 } },
    style: {
      fillColor: [1, 0, 0, 1],
      strokeColor: [0, 1, 0, 1],
      strokeWidth: 1,
    },
    ...extra,
  })
  const stats = { area: 16, min: 0, mean: 1, max: 2, stdDev: 0.5 }
  const model = {
    ui: { isAnnotationDrawn: true },
    annotation: { isEnabled: false },
    annotations: [
      ann('m', 'measureLine', { text: 'hi', stats: { ...stats, length: 5 } }),
      ann('a', 'arrow', { text: 'tail' }),
      ann('r', 'rectangle', { stats }),
    ],
    _persistedAnnotationScreenShapes: [],
    getVolumes: () => [],
  } as unknown as NVModel
  const mvp = mat4.fromScaling(mat4.create(), [0.1, -0.05, 1])
  const tile = {
    axCorSag: SLICE_TYPE.AXIAL,
    mvpMatrix: mvp,
    planeNormal: [0, 0, 1],
    planePoint: [0, 0, 0],
    leftTopWidthHeight: [10, 20, 200, 100],
  } as unknown as SliceTile

  test('the built-in draw and annotationScreenShapes agree', () => {
    const texts: { str: string; x: number; y: number; ax?: number }[] = []
    const buildText = (
      str: string,
      x: number,
      y: number,
      ...rest: unknown[]
    ) => {
      texts.push({ str, x, y, ax: rest[2] as number })
      return { count: 1 } as GlyphBatch
    }
    const buildLine = () => ({}) as LineData
    buildAnnotationRenderData(model, [tile], buildLine, buildText)
    model.ui.isAnnotationDrawn = false
    projectAnnotationScreenShapes(model, [tile])
    model.ui.isAnnotationDrawn = true
    const labels = model._persistedAnnotationScreenShapes.map((s) => s.label)
    // The overlay's measureLine label omits the length (its ruler draws it).
    expect(labels.map((l) => l?.lines)).toEqual([
      ['hi'],
      ['tail'],
      ['Area: 16.0 mm²', 'Min: 0.0  Max: 2.0', 'Mean: 1.0  SD: 0.5'],
    ])
    expect(texts.map((t) => t.str)).toEqual([
      'hi\n5.0 mm',
      'tail',
      'Area: 16.0 mm²\nMin: 0.0  Max: 2.0\nMean: 1.0  SD: 0.5',
    ])
    expect(texts.map((t) => [t.x, t.y, t.ax])).toEqual(
      labels.map((l) => [l?.x, l?.y, l?.align === 'left' ? 0 : 0.5]),
    )
  })
})
