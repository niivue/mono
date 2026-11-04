import { describe, expect, test } from 'bun:test'
import type { AnnotationPoint, VectorAnnotation } from '@/NVTypes'
import {
  generateShape,
  generateSplineFromPoints,
  isAnnotationErased,
} from './shapes'

describe('generateSplineFromPoints', () => {
  test('returns no polygon for fewer than 3 control points', () => {
    expect(generateSplineFromPoints([])).toEqual([])
    expect(generateSplineFromPoints([{ x: 0, y: 0 }])).toEqual([])
    expect(
      generateSplineFromPoints([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toEqual([])
  })

  test('produces a closed sampled polygon through the control points', () => {
    const pts: AnnotationPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const [poly] = generateSplineFromPoints(pts)
    expect(poly).toBeDefined()
    if (!poly) throw new Error('no polygon')
    // 4 control points * 16 samples per segment.
    expect(poly.outer.length).toBe(64)
    expect(poly.holes).toEqual([])
    // The spline passes through each control point at segment starts (t=0).
    expect(poly.outer[0]).toEqual({ x: 0, y: 0 })
    expect(poly.outer[16]).toEqual({ x: 10, y: 0 })
    expect(poly.outer[32]).toEqual({ x: 10, y: 10 })
    expect(poly.outer[48]).toEqual({ x: 0, y: 10 })
  })

  test('stays within the control-point bounding box (no wild overshoot)', () => {
    const pts: AnnotationPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]
    const [poly] = generateSplineFromPoints(pts)
    if (!poly) throw new Error('no polygon')
    for (const p of poly.outer) {
      expect(p.x).toBeGreaterThanOrEqual(-5)
      expect(p.x).toBeLessThanOrEqual(25)
      expect(p.y).toBeGreaterThanOrEqual(-5)
      expect(p.y).toBeLessThanOrEqual(25)
    }
  })
})

describe('isAnnotationErased', () => {
  const start = { x: 0, y: 0 }
  const end = { x: 10, y: 5 }
  const rect = (polygons = generateShape('measureRect', start, end, 1)) =>
    ({
      polygons,
      style: { strokeWidth: 1 },
      shape: { type: 'measureRect', start, end },
    }) as unknown as VectorAnnotation

  test('an intact shape is not erased', () => {
    expect(isAnnotationErased(rect())).toBe(false)
  })

  test('a shape whose polygons were cut is erased', () => {
    const cut = [{ outer: [start, { x: 10, y: 0 }, end], holes: [] }]
    expect(isAnnotationErased(rect(cut))).toBe(true)
  })

  test('a tool generateShape cannot rebuild is never erased', () => {
    const spline = { ...rect(), shape: { type: 'measureSpline', start, end } }
    expect(isAnnotationErased(spline as VectorAnnotation)).toBe(false)
  })

  test('a freehand annotation has no shape to compare', () => {
    const ann = { ...rect(), shape: undefined }
    expect(isAnnotationErased(ann)).toBe(false)
  })
})
