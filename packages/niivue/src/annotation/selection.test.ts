import { describe, expect, test } from 'bun:test'
import {
  getControlPoints,
  hitTestControlPoint,
  updateShapeBounds,
} from './selection'

// ---------------------------------------------------------------------------
// getControlPoints
// ---------------------------------------------------------------------------
describe('getControlPoints', () => {
  test('rectangle_returns8Points', () => {
    const pts = getControlPoints({
      type: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })
    expect(pts.length).toBe(8)
    // Corners: TL, TR, BR, BL
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts[1]).toEqual({ x: 10, y: 0 })
    expect(pts[2]).toEqual({ x: 10, y: 10 })
    expect(pts[3]).toEqual({ x: 0, y: 10 })
    // Midpoints
    expect(pts[4]).toEqual({ x: 5, y: 0 })
    expect(pts[5]).toEqual({ x: 10, y: 5 })
    expect(pts[6]).toEqual({ x: 5, y: 10 })
    expect(pts[7]).toEqual({ x: 0, y: 5 })
  })

  test('ellipse_returns4CardinalPoints', () => {
    const pts = getControlPoints({
      type: 'ellipse',
      start: { x: 0, y: 0 },
      end: { x: 20, y: 10 },
    })
    expect(pts.length).toBe(4)
    // Center: (10, 5), rx=10, ry=5
    expect(pts[0]).toEqual({ x: 10, y: 0 })  // top
    expect(pts[1]).toEqual({ x: 20, y: 5 })  // right
    expect(pts[2]).toEqual({ x: 10, y: 10 }) // bottom
    expect(pts[3]).toEqual({ x: 0, y: 5 })   // left
  })

  test('line_returns3Points', () => {
    const pts = getControlPoints({
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 4,
    })
    expect(pts.length).toBe(3)
    expect(pts[0]).toEqual({ x: 0, y: 0 })  // start
    expect(pts[1]).toEqual({ x: 10, y: 0 }) // end
    // Width handle: midpoint + perpendicular offset
    expect(pts[2].x).toBeCloseTo(5, 5)
    expect(pts[2].y).toBeCloseTo(2, 5) // perpendicular to horizontal line
  })

  test('freehand_returnsEmpty', () => {
    const pts = getControlPoints({
      type: 'freehand',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })
    expect(pts.length).toBe(0)
  })

  test('measureRect_returns8Points', () => {
    const pts = getControlPoints({
      type: 'measureRect',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })
    expect(pts.length).toBe(8)
  })

  test('circle_returns4Points', () => {
    const pts = getControlPoints({
      type: 'circle',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })
    expect(pts.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// hitTestControlPoint
// ---------------------------------------------------------------------------
describe('hitTestControlPoint', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]

  test('onPoint_returnsIndex', () => {
    expect(hitTestControlPoint({ x: 10, y: 0 }, points, 1)).toBe(1)
  })

  test('withinRadius_returnsIndex', () => {
    expect(hitTestControlPoint({ x: 10.5, y: 0 }, points, 1)).toBe(1)
  })

  test('noHit_returnsNegativeOne', () => {
    expect(hitTestControlPoint({ x: 50, y: 50 }, points, 1)).toBe(-1)
  })

  test('firstMatchWins', () => {
    // If two points overlap, returns the first
    const overlapping = [{ x: 5, y: 5 }, { x: 5, y: 5 }]
    expect(hitTestControlPoint({ x: 5, y: 5 }, overlapping, 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// updateShapeBounds
// ---------------------------------------------------------------------------
describe('updateShapeBounds', () => {
  test('rectangleCornerDrag_fixesOppositeCorner', () => {
    const original = { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
    // Drag TL corner (index 0) to new position
    const result = updateShapeBounds('rectangle', original, 0, { x: -5, y: -5 })
    // Opposite corner (BR = max) stays fixed as the new start
    expect(result.start).toEqual({ x: 10, y: 10 })
    expect(result.end).toEqual({ x: -5, y: -5 })
  })

  test('circleCardinalDrag_maintainsSquareAspect', () => {
    // Circle: start (0,0), end (10,10) → center (5,5), radius 5
    const original = { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
    // Drag top cardinal (index 0) upward to y=-2
    const result = updateShapeBounds('circle', original, 0, { x: 5, y: -2 })
    // New radius = |(-2) - 5| = 7
    expect(result.start).toEqual({ x: -2, y: -2 })
    expect(result.end).toEqual({ x: 12, y: 12 })
  })

  test('lineWidthHandle_adjustsWidth', () => {
    const original = {
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 2,
    }
    // Drag width handle (index 2) far from the line
    const result = updateShapeBounds('line', original, 2, { x: 5, y: 8 })
    expect(result.width).toBeDefined()
    // Width should increase (perpendicular distance * 2)
    expect(result.width!).toBeGreaterThan(2)
    // Endpoints unchanged
    expect(result.start).toEqual({ x: 0, y: 0 })
    expect(result.end).toEqual({ x: 10, y: 0 })
  })

  test('lineStartDrag_movesStartOnly', () => {
    const original = {
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 2,
    }
    const result = updateShapeBounds('line', original, 0, { x: -5, y: 3 })
    expect(result.start).toEqual({ x: -5, y: 3 })
    expect(result.end).toEqual({ x: 10, y: 0 })
  })
})
