import { describe, expect, test } from 'bun:test'
import type { PolygonWithHoles, VectorAnnotation } from '@/NVTypes'
import {
  getAnnotationSelection,
  getControlPoints,
  hitTestControlPoint,
  resizePolygons,
  updateShapeBounds,
} from './selection'
import { generateShape } from './shapes'

// ---------------------------------------------------------------------------
// getAnnotationSelection
// ---------------------------------------------------------------------------
describe('getAnnotationSelection', () => {
  test('selects a polygon-only annotation without resize handles', () => {
    const annotation = {
      id: 'freehand',
      label: 1,
      group: 'measurements',
      sliceType: 0,
      slicePosition: 0,
      polygons: [
        {
          outer: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
          holes: [],
        },
      ],
      style: {
        fillColor: [1, 0, 0, 0.3],
        strokeColor: [1, 0, 0, 1],
        strokeWidth: 2,
      },
    } as VectorAnnotation

    expect(getAnnotationSelection(annotation)).toEqual({
      annotationId: annotation.id,
      controlPoints: [],
    })
  })
})

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
    expect(pts[0]).toEqual({ x: 10, y: 0 }) // top
    expect(pts[1]).toEqual({ x: 20, y: 5 }) // right
    expect(pts[2]).toEqual({ x: 10, y: 10 }) // bottom
    expect(pts[3]).toEqual({ x: 0, y: 5 }) // left
  })

  test('line_returns3Points', () => {
    const pts = getControlPoints({
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 4,
    })
    expect(pts.length).toBe(3)
    expect(pts[0]).toEqual({ x: 0, y: 0 }) // start
    expect(pts[1]).toEqual({ x: 10, y: 0 }) // end
    // Width handle: midpoint + perpendicular offset
    expect(pts[2].x).toBeCloseTo(5, 5)
    expect(pts[2].y).toBeCloseTo(2, 5) // perpendicular to horizontal line
    // A measure line has no thickness to set: ends only.
    const ends = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 4 }
    expect(getControlPoints({ type: 'measureLine', ...ends })).toEqual([
      ends.start,
      ends.end,
    ])
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
    const overlapping = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]
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
    expect(result.width ?? 0).toBeGreaterThan(2)
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

  // Long axis 0..10 on x, short axis crossing at x = 4, 3 up and 2 down.
  const bidi = {
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
    start2: { x: 4, y: 3 },
    end2: { x: 4, y: -2 },
  }
  const near = (
    p: { x: number; y: number } | undefined,
    x: number,
    y: number,
  ) => {
    expect(p?.x).toBeCloseTo(x, 9)
    expect(p?.y).toBeCloseTo(y, 9)
  }

  test('bidirectional long handle turns the axis and carries the short one', () => {
    // End swung from (10, 0) to (0, 20): the long axis turns 90 degrees about
    // the start and doubles; the short axis keeps 40% along and 3/2 across.
    const r = updateShapeBounds('measureBidirectional', bidi, 1, {
      x: 0,
      y: 20,
    })
    near(r.start, 0, 0)
    near(r.end, 0, 20)
    near(r.start2, -3, 8)
    near(r.end2, 2, 8)
  })

  test('bidirectional short handle slides its axis and sets its own reach', () => {
    const r = updateShapeBounds('measureBidirectional', bidi, 2, { x: 7, y: 5 })
    near(r.start, 0, 0)
    near(r.end, 10, 0)
    near(r.start2, 7, 5)
    near(r.end2, 7, -2)
  })

  test('a skewed short axis keeps its skew when the long axis moves', () => {
    const skewed = { ...bidi, start2: { x: 4, y: -3 }, end2: { x: 6, y: 3 } }
    const r = updateShapeBounds('measureBidirectional', skewed, 0, {
      x: 0.01,
      y: 0,
    })
    near(r.end2, 6.004, 3)
  })

  test('angle vertex handle moves both arms', () => {
    const angle = {
      start: { x: 0, y: 10 },
      end: { x: 0, y: 0 },
      start2: { x: 0, y: 0 },
      end2: { x: 10, y: 0 },
    }
    expect(getControlPoints({ type: 'measureAngle', ...angle })).toEqual([
      angle.start,
      angle.end,
      angle.end2,
    ])
    const r = updateShapeBounds('measureAngle', angle, 1, { x: 1, y: 1 })
    expect([r.end, r.start2]).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ])
    expect([r.start, r.end2]).toEqual([angle.start, angle.end2])
  })
})

describe('resizePolygons', () => {
  const round = (polys: PolygonWithHoles[]) =>
    JSON.stringify(polys, (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v,
    )
  const box = (x0: number, y0: number, x1: number, y1: number) => ({
    start: { x: x0, y: y0 },
    end: { x: x1, y: y1 },
  })

  // Review of #824: an erased probe's move goes through its zero-size box.
  test('moves a zero-size box', () => {
    const dot = [{ outer: [{ x: 1, y: 2 }], holes: [] }]
    expect(
      resizePolygons('measurePoint', box(1, 2, 1, 2), box(4, 6, 4, 6), dot),
    ).toEqual([{ outer: [{ x: 4, y: 6 }], holes: [] }])
    expect(
      resizePolygons('measurePoint', box(1, 2, 1, 2), box(4, 6, 5, 6), dot),
    ).toBeNull()
  })

  test('carries an intact shape onto the shape drawn at the new bounds', () => {
    for (const type of ['measureRect', 'ellipse', 'circle'] as const) {
      const o = box(0, 0, 10, 10)
      const n = box(0, 0, 20, 20)
      const moved = resizePolygons(
        type,
        o,
        n,
        generateShape(type, o.start, o.end, 2),
      )
      expect(round(moved ?? [])).toBe(
        round(generateShape(type, n.start, n.end, 2)),
      )
    }
    for (const type of ['line', 'measureLine'] as const) {
      const o = { ...box(0, 0, 10, 0), width: 2 }
      const n = { ...box(5, 5, 5, 25), width: 4 }
      const moved = resizePolygons(
        type,
        o,
        n,
        generateShape(type, o.start, o.end, 2),
      )
      expect(round(moved ?? [])).toBe(
        round(generateShape(type, n.start, n.end, 4)),
      )
    }
  })

  test('keeps the erased gap of a split rectangle, scaled with it', () => {
    const half = (x0: number, x1: number): PolygonWithHoles => ({
      outer: [
        { x: x0, y: 0 },
        { x: x1, y: 0 },
        { x: x1, y: 10 },
        { x: x0, y: 10 },
      ],
      holes: [],
    })
    const moved = resizePolygons(
      'measureRect',
      box(0, 0, 10, 10),
      box(0, 0, 20, 10),
      [half(0, 4), half(6, 10)],
    )
    expect(moved).toEqual([half(0, 8), half(12, 20)])
  })

  test('declines a degenerate original or destination', () => {
    expect(
      resizePolygons('rectangle', box(0, 0, 0, 10), box(0, 0, 5, 5), []),
    ).toBeNull()
    expect(
      resizePolygons('line', box(1, 1, 1, 1), box(0, 0, 5, 5), []),
    ).toBeNull()
    // A collapsed destination too: it could not be expanded again.
    expect(
      resizePolygons('rectangle', box(0, 0, 10, 10), box(0, 0, 0, 10), []),
    ).toBeNull()
  })
})
