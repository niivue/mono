import { describe, expect, it } from 'bun:test'
import { meshExtents } from './NVMesh'

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
})
