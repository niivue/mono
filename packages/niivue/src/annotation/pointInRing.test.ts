import { describe, expect, test } from 'bun:test'
import type { AnnotationPoint } from '@/NVTypes'
import { pointInRing } from './pointInRing'

const square: AnnotationPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

describe('pointInRing', () => {
  test('insideSquare_returnsTrue', () => {
    expect(pointInRing({ x: 5, y: 5 }, square)).toBe(true)
  })

  test('outsideSquare_returnsFalse', () => {
    expect(pointInRing({ x: 15, y: 5 }, square)).toBe(false)
  })

  test('farOutside_returnsFalse', () => {
    expect(pointInRing({ x: -10, y: -10 }, square)).toBe(false)
  })

  test('onEdge_boundaryBehavior', () => {
    // Point exactly on the edge of the square — ray casting may return
    // true or false depending on which edge; we just verify it's deterministic
    const onTopEdge = pointInRing({ x: 5, y: 0 }, square)
    const onTopEdgeAgain = pointInRing({ x: 5, y: 0 }, square)
    expect(onTopEdge).toBe(onTopEdgeAgain)
  })

  test('triangle_insideReturnsTrue', () => {
    const triangle: AnnotationPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    expect(pointInRing({ x: 5, y: 3 }, triangle)).toBe(true)
  })

  test('triangle_outsideReturnsFalse', () => {
    const triangle: AnnotationPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    expect(pointInRing({ x: 0, y: 10 }, triangle)).toBe(false)
  })

  test('concavePolygon_correctResult', () => {
    // L-shaped polygon
    const lShape: AnnotationPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ]
    // Inside the L
    expect(pointInRing({ x: 2, y: 2 }, lShape)).toBe(true)
    // In the concave notch (outside)
    expect(pointInRing({ x: 8, y: 8 }, lShape)).toBe(false)
  })

  test('emptyRing_returnsFalse', () => {
    expect(pointInRing({ x: 5, y: 5 }, [])).toBe(false)
  })
})
