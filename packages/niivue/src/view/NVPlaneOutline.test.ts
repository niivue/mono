import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import { buildLine } from './NVLine'
import {
  buildPlaneOutline3DRenderData,
  buildPlaneOutlineLines,
  mergeRenderData,
} from './NVPlaneOutline'
import type { SliceTile } from './NVSliceLayout'

const square = {
  cornersMM: [
    [0, 0, 5],
    [10, 0, 5],
    [10, 10, 5],
    [0, 10, 5],
  ] as [number, number, number][],
}
const red = [1, 0, 0, 1]

describe('plane outlines', () => {
  test('four edges on each 2D tile; none on the render tile', () => {
    const tile = (axCorSag: number) =>
      ({
        axCorSag,
        mvpMatrix: mat4.create(),
        leftTopWidthHeight: [0, 0, 100, 100],
      }) as unknown as SliceTile
    // Within the identity MVP's -1..1 so clipping keeps every edge.
    const inTile = {
      cornersMM: square.cornersMM.map(([x, y, z]) => [x / 20, y / 20, z]),
    } as typeof square
    const lines = buildPlaneOutlineLines(
      [inTile],
      [tile(SLICE_TYPE.AXIAL), tile(SLICE_TYPE.RENDER)],
      buildLine,
      red,
    )
    expect(lines).toHaveLength(4)
  })

  // Identity MVP into a 100 px tile: mm (-1..1) maps across the tile.
  const sliceAt = (z: number, ltwh = [0, 0, 100, 100]) =>
    ({
      axCorSag: SLICE_TYPE.AXIAL,
      mvpMatrix: mat4.create(),
      leftTopWidthHeight: ltwh,
      planeNormal: [0, 0, 1],
      planePoint: [0, 0, z],
    }) as unknown as SliceTile
  const flat = (z: number) => ({
    cornersMM: [
      [-0.5, -0.5, z],
      [0.5, -0.5, z],
      [0.5, 0.5, z],
      [-0.5, 0.5, z],
    ] as [number, number, number][],
  })

  test('only the slice an outline lies in draws its rectangle', () => {
    expect(
      buildPlaneOutlineLines([flat(5)], [sliceAt(5.2)], buildLine, red),
    ).toHaveLength(4)
    expect(
      buildPlaneOutlineLines([flat(5)], [sliceAt(9)], buildLine, red),
    ).toHaveLength(0)
  })

  test('a crossing slice draws one segment; a missed one draws none', () => {
    // An upright outline in x = 0, z from 0 to 10.
    const upright = {
      cornersMM: [
        [0, -0.5, 0],
        [0, 0.5, 0],
        [0, 0.5, 10],
        [0, -0.5, 10],
      ] as [number, number, number][],
    }
    expect(
      buildPlaneOutlineLines([upright], [sliceAt(4)], buildLine, red),
    ).toHaveLength(1)
    expect(
      buildPlaneOutlineLines([upright], [sliceAt(20)], buildLine, red),
    ).toHaveLength(0)
  })

  test('a slice through opposite corners draws the full diagonal', () => {
    const ends: number[][] = []
    const record = (x0: number, y0: number, x1: number, y1: number) => {
      ends.push([x0, y0, x1, y1])
      return buildLine(0, 0, 0, 0, 1, red)
    }
    const r = Math.SQRT1_2
    const diagonal = {
      ...sliceAt(0),
      planeNormal: [r, -r, 0],
    } as unknown as SliceTile
    buildPlaneOutlineLines([flat(0)], [diagonal], record, red)
    expect(ends).toHaveLength(1)
    const [x0, y0, x1, y1] = ends[0]
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(Math.hypot(50, 50), 3)
  })

  test('a slice touching one corner draws nothing', () => {
    const touch = {
      ...sliceAt(0),
      planeNormal: [Math.SQRT1_2, Math.SQRT1_2, 0],
      planePoint: [0.5, 0.5, 0],
    } as unknown as SliceTile
    expect(
      buildPlaneOutlineLines([flat(0)], [touch], buildLine, red),
    ).toHaveLength(0)
  })

  test('segments are clipped to their tile', () => {
    const wide = {
      cornersMM: [
        [-5, -0.5, 0],
        [5, -0.5, 0],
        [5, 0.5, 0],
        [-5, 0.5, 0],
      ] as [number, number, number][],
    }
    const xs: number[] = []
    const record = (x0: number, _y0: number, x1: number) => {
      xs.push(x0, x1)
      return buildLine(0, 0, 0, 0, 1, red)
    }
    buildPlaneOutlineLines([wide], [sliceAt(0)], record, red)
    expect(xs.length).toBeGreaterThan(0)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThanOrEqual(100)
  })

  test('the 3D frame is equally wide on every edge of a thin rectangle', () => {
    const thin = {
      cornersMM: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 2, 0],
        [0, 2, 0],
      ] as [number, number, number][],
    }
    const v = buildPlaneOutline3DRenderData([thin], red)?.vertices
    // Inner corner 0 (vertex 4) sits the same distance from both edges.
    expect(v?.[4 * 7]).toBeCloseTo(v?.[4 * 7 + 1] ?? -1, 6)
  })

  test('a 3D frame of eight triangles in the outline colour', () => {
    const data = buildPlaneOutline3DRenderData([square], red)
    expect(data?.indices).toHaveLength(8 * 3)
    expect(Array.from(data?.vertices.slice(3, 7) ?? [])).toEqual(red)
    // Inner corners sit inside the outer ones, on the same plane.
    expect(data?.vertices[4 * 7]).toBeGreaterThan(0)
    expect(data?.vertices[4 * 7 + 2]).toBe(5)
    expect(buildPlaneOutline3DRenderData([], red)).toBeNull()
  })

  test('merging offsets the second set of indices', () => {
    const a = buildPlaneOutline3DRenderData([square], red)
    const merged = mergeRenderData(a, a)
    expect(merged?.indices[24]).toBe((a?.indices[0] ?? 0) + 8)
    expect(mergeRenderData(null, a)).toBe(a)
  })
})
