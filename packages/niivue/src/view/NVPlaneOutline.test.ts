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
    const lines = buildPlaneOutlineLines(
      [square],
      [tile(SLICE_TYPE.AXIAL), tile(SLICE_TYPE.RENDER)],
      buildLine,
      red,
    )
    expect(lines).toHaveLength(4)
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
