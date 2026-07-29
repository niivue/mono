import { describe, expect, test } from 'bun:test'
import type { AnnotationPoint } from '@/NVTypes'
import { generateSplineFromPoints } from './shapes'

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
