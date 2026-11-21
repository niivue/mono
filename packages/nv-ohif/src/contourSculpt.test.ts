import { expect, test } from 'bun:test'
import { ringArea } from './contourOps'
import { sculptRadius, sculptRing } from './contourSculpt'

// A circle 2 mm outside a square's edge pushes in the circular segment it
// overlaps; the pushed arc is filled in, not a chord between moved points.
test('sculptRing carves the circle out of the outline', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ]
  const out = sculptRing(ring, { x: 22, y: 10 }, 5)
  const segment = 25 * Math.acos(2 / 5) - 2 * Math.sqrt(21)
  expect(ringArea(out) / (400 - segment)).toBeCloseTo(1, 2)
})

// cornerstone's dynamic cursor: a press 2 mm off the outline sculpts with a
// 2 mm circle; without it, or nearer than the edge allows, the full radius.
test('sculptRadius follows the press distance only when dynamic', () => {
  const square = [
    {
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      holes: [],
    },
  ]
  expect(sculptRadius(5, square, { x: 22, y: 10 }, true)).toBeCloseTo(2, 9)
  expect(sculptRadius(5, square, { x: 22, y: 10 }, false)).toBe(5)
  expect(sculptRadius(5, square, { x: 10, y: 10 }, true)).toBe(5)
})

// Audit repro: a press 0.01 mm from a 100 mm outline gives a 0.01 mm circle;
// split at r / 4 the perimeter became 160k points. A 1 mm pixel floor bounds it.
test('sculptRing spacing floor bounds a tiny circle', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 99.98, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]
  expect(sculptRing(ring, { x: 99.995, y: 50 }, 0.01, 1).length).toBeLessThan(
    500,
  )
})
