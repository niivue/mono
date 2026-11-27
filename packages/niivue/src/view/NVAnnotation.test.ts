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
    annotationIsHidden: null,
    annotationCalibration: null,
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

  const draw = () => {
    const texts: { str: string; x: number; y: number }[] = []
    const buildText = (str: string, x: number, y: number) => {
      texts.push({ str, x, y })
      return { count: 1 } as GlyphBatch
    }
    projectAnnotationScreenShapes(model, [tile])
    buildAnnotationRenderData(
      model,
      [tile],
      () => ({}) as LineData,
      buildText,
      1,
    )
    return texts
  }

  test('a measured line is a ruler; a closed shape labels below its box', () => {
    const texts = draw().map((t) => t.str)
    // The ruler prints the length; the shape's own label is its text alone.
    expect(texts).toContain('5.00 mm')
    expect(texts).toContain('hi')
    expect(texts).not.toContain('hi\n5.0 mm')
    const rect = model._persistedAnnotationScreenShapes.find(
      (s) => s.id === 'r',
    )
    const bottom = Math.max(...(rect?.outer.map((p) => p.y) ?? []))
    const label = draw().find((t) => t.str.startsWith('Area:'))
    expect(label?.y).toBeGreaterThan(bottom)
  })

  test('calibration scales label lengths by s and areas by s²', () => {
    model.annotationCalibration = {
      scale: 2,
      lengthUnit: 'mm User',
      areaUnit: 'mm² User',
    }
    const texts = draw().map((t) => t.str)
    model.annotationCalibration = null
    expect(texts).toContain('10.0 mm User')
    expect(texts.some((t) => t.startsWith('Area: 64.0 mm² User'))).toBe(true)
  })

  test('a hidden shape is neither drawn nor projected', () => {
    model.annotationIsHidden = (a) => a.id === 'r'
    const texts = draw().map((t) => t.str)
    model.annotationIsHidden = null
    expect(model._persistedAnnotationScreenShapes.map((s) => s.id)).toEqual([
      'm',
      'a',
    ])
    expect(texts.some((t) => t.startsWith('Area:'))).toBe(false)
  })
})

describe('annotation stats labels', () => {
  test('use the base volume unit (um length and area)', () => {
    const style = {
      fillColor: [1, 0, 0, 1],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 1,
    }
    const base = {
      label: 1,
      group: 'g',
      sliceType: SLICE_TYPE.AXIAL,
      slicePosition: 0,
      polygons: [{ outer: square(0, 0, 4), holes: [] }],
      style,
    }
    const stats = { area: 16, min: 0, mean: 1, max: 2, stdDev: 0.5 }
    const model = {
      ui: { isAnnotationDrawn: false },
      annotations: [
        {
          ...base,
          id: 'r',
          shape: {
            type: 'rectangle',
            start: { x: 0, y: 0 },
            end: { x: 4, y: 4 },
          },
          stats,
        },
        {
          ...base,
          id: 'b',
          shape: {
            type: 'bidirectional',
            start: { x: 0, y: 0 },
            end: { x: 4, y: 4 },
          },
          stats: { ...stats, length: 5, shortLength: 2 },
        },
        {
          ...base,
          id: 'm',
          shape: {
            type: 'measureLine',
            start: { x: 0, y: 0 },
            end: { x: 4, y: 4 },
          },
          stats: { ...stats, length: 7 },
        },
        ...[65535, 0.043219].map((value, i) => ({
          ...base,
          id: `p${i}`,
          shape: {
            type: 'measurePoint',
            start: { x: 2, y: 2 },
            end: { x: 2, y: 2 },
          },
          stats: { value },
        })),
      ],
      _persistedAnnotationScreenShapes: [],
      getVolumes: () => [{ hdr: { xyzt_units: 3 | 8 } }],
    } as unknown as NVModel
    const tile = {
      axCorSag: SLICE_TYPE.AXIAL,
      mvpMatrix: mat4.create(),
      planeNormal: [0, 0, 1],
      planePoint: [0, 0, 0],
      leftTopWidthHeight: [0, 0, 100, 100],
    } as unknown as SliceTile
    projectAnnotationScreenShapes(model, [tile])
    const [rect, bidi, line, probeInt, probeFrac] =
      model._persistedAnnotationScreenShapes
    // Probe: integers exact, fractions to 4 significant digits.
    expect(probeInt?.label?.lines).toEqual(['65535'])
    expect(probeFrac?.label?.lines).toEqual(['0.04322'])
    expect(rect?.label?.lines[0]).toBe('Area: 16.0 µm²')
    expect(bidi?.label?.lines.slice(0, 2)).toEqual(['L: 5.0 µm', 'W: 2.0 µm'])
    // External overlays (uikit ruler) label the measured line from these.
    expect(line?.length).toBe(7)
    expect(line?.unit).toBe('µm')
  })
})
