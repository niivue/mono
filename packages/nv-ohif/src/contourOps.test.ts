import { expect, test } from 'bun:test'
import type { NiiVue, VectorAnnotation } from '@niivue/niivue'
import {
  combineSegments,
  decimateRing,
  ringArea,
  smoothRing,
} from './contourOps'
import { contourGroup } from './contourSeg'

const squareRing = (n: number) => {
  // 40 mm square, n points per side.
  const pts = []
  for (let i = 0; i < n; i++) pts.push({ x: (40 * i) / n, y: 0 })
  for (let i = 0; i < n; i++) pts.push({ x: 40, y: (40 * i) / n })
  for (let i = 0; i < n; i++) pts.push({ x: 40 - (40 * i) / n, y: 40 })
  for (let i = 0; i < n; i++) pts.push({ x: 0, y: 40 - (40 * i) / n })
  return pts
}

// Remove extra points: collinear points go, corners stay.
test('decimateRing keeps a dense square to its corners', () => {
  const out = decimateRing(squareRing(20), 0.1)
  expect(out).toHaveLength(4)
  expect(ringArea(out)).toBeCloseTo(1600, 6)
})

// Smooth: knots by arc length, so a sparse (decimated) ring only rounds its corners.
test('smoothRing rounds a 4-point square without shrinking it', () => {
  const sparse = squareRing(1)
  const out = smoothRing(sparse)
  expect(out.length).toBeGreaterThan(sparse.length)
  expect(Math.abs(ringArea(out) / 1600 - 1)).toBeLessThan(0.01)
})

// Audit: OHIF's Combine allows A = B. A segment intersected with itself is
// itself and subtracted from itself is empty (both operands, not A alone).
test('combineSegments with one segment as both operands', () => {
  const group = contourGroup('s')
  const square = {
    id: 'q',
    group,
    label: 1,
    sliceType: 0,
    slicePosition: 0,
    polygons: [{ outer: squareRing(1), holes: [] }],
  } as unknown as VectorAnnotation
  const run = (op: 'intersection' | 'difference') => {
    let shapes = [square]
    const nv = {
      volumes: [],
      get annotations() {
        return shapes
      },
      replaceAnnotations(ids: string[], added: VectorAnnotation[]) {
        shapes = [...shapes.filter((a) => !ids.includes(a.id)), ...added]
      },
    } as unknown as NiiVue
    combineSegments(nv, 's', 1, 1, 1, op)
    return shapes.reduce(
      (n, a) => n + a.polygons.reduce((m, p) => m + ringArea(p.outer), 0),
      0,
    )
  }
  expect(run('intersection')).toBeCloseTo(1600, 6)
  expect(run('difference')).toBe(0)
})

// Review of #875: a result into B kept B's old shapes beside the new ones.
test('combineSegments into segment B replaces its shapes', () => {
  const group = contourGroup('s')
  const square = (id: string, label: number) =>
    ({
      id,
      group,
      label,
      sliceType: 0,
      slicePosition: 0,
      polygons: [{ outer: squareRing(1), holes: [] }],
    }) as unknown as VectorAnnotation
  let shapes = [square('a', 1), square('b', 2)]
  const nv = {
    volumes: [],
    get annotations() {
      return shapes
    },
    replaceAnnotations(ids: string[], added: VectorAnnotation[]) {
      shapes = [...shapes.filter((a) => !ids.includes(a.id)), ...added]
    },
  } as unknown as NiiVue
  combineSegments(nv, 's', 1, 2, 2, 'union')
  expect(shapes.filter((a) => a.label === 2).map((a) => a.id)).not.toContain(
    'b',
  )
  expect(shapes.filter((a) => a.label === 2)).toHaveLength(1)
})
