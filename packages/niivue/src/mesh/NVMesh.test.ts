import { describe, expect, it } from 'bun:test'
import { vec3 } from 'gl-matrix'
import { createMesh, meshExtents } from './NVMesh'

describe('meshExtents', () => {
  it('bounds a triangle per axis', () => {
    const { extentsMin, extentsMax } = meshExtents(
      new Float32Array([1, -2, 3, -4, 5, 0, 2, 0, -6]),
    )
    expect(Array.from(extentsMin)).toEqual([-4, -2, -6])
    expect(Array.from(extentsMax)).toEqual([2, 5, 3])
  })

  it('is inverted infinity for no vertices', () => {
    const { extentsMin, extentsMax } = meshExtents(new Float32Array(0))
    expect(Array.from(extentsMin)).toEqual([Infinity, Infinity, Infinity])
    expect(Array.from(extentsMax)).toEqual([-Infinity, -Infinity, -Infinity])
  })

  it('ignores a trailing partial triple instead of returning NaN', () => {
    const { extentsMin, extentsMax } = meshExtents(
      new Float32Array([1, 2, 3, 9, 9]),
    )
    expect(Array.from(extentsMin)).toEqual([1, 2, 3])
    expect(Array.from(extentsMax)).toEqual([1, 2, 3])
  })
})

describe('createMesh extents', () => {
  const tri = new Float32Array([0, 0, 0, 1, 2, 3, -1, -2, -3])
  const idx = new Uint32Array([0, 1, 2])
  const col = new Uint32Array(0)

  it('computes extents from positions', () => {
    const m = createMesh(tri, idx, col)
    expect(Array.from(m.extentsMin)).toEqual([-1, -2, -3])
    expect(Array.from(m.extentsMax)).toEqual([1, 2, 3])
  })

  it('lets options override the computed extents', () => {
    const extentsMin = vec3.fromValues(-10, -10, -10)
    const m = createMesh(tri, idx, col, { extentsMin })
    expect(m.extentsMin).toBe(extentsMin)
    expect(Array.from(m.extentsMax)).toEqual([1, 2, 3])
  })
})
