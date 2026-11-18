import { expect, it } from 'bun:test'
import { cutLine } from './referenceLines'

it('a sagittal plane cuts an axial tile along y at its x; parallel planes do not', () => {
  // Axial tile at z = 10, screen u = x in [-50, 50], v = y in [-40, 40].
  expect(cutLine(0, 10, [-50, -40], [50, 40], 0, 5)).toEqual([
    [5, -40, 10],
    [5, 40, 10],
  ])
  // A coronal plane (y = 7) cuts a sagittal tile (u = y, v = z) along z.
  expect(cutLine(2, 3, [-60, -20], [60, 20], 1, 7)).toEqual([
    [3, 7, -20],
    [3, 7, 20],
  ])
  expect(cutLine(0, 10, [-50, -40], [50, 40], 2, 0)).toBeUndefined()
})
