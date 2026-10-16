import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import { calculateCrosshairSegments, fitSegmentsToSlice } from './NVCrosshair'

const extentsMin = [-100, -100, -100]
const extentsMax = [100, 100, 100]
const center = vec3.fromValues(10, -20, 30)
const centerFrac = [0.55, 0.4, 0.65]

/** mm -> texture fraction for a 200 mm cube rotated `deg` about the given axis. */
const obliqueMm2tex = (deg: number, axis: [number, number, number]): mat4 => {
  const tex2mm = mat4.create()
  mat4.rotate(tex2mm, tex2mm, (deg * Math.PI) / 180, axis)
  mat4.translate(tex2mm, tex2mm, [-100, -100, -100])
  mat4.scale(tex2mm, tex2mm, [200, 200, 200])
  const mm2tex = mat4.create()
  if (!mat4.invert(mm2tex, tex2mm)) throw new Error('singular test matrix')
  return mm2tex
}

const texCoord = (mm2tex: mat4, p: vec3, dim: number): number => {
  const t = vec4.transformMat4(
    vec4.create(),
    vec4.fromValues(p[0], p[1], p[2], 1),
    mm2tex,
  )
  return t[dim]
}

const segments = () =>
  calculateCrosshairSegments(extentsMin, extentsMax, centerFrac, 10)

describe('fitSegmentsToSlice', () => {
  test('leaves the arms unchanged for an axis-aligned volume', () => {
    const mm2tex = obliqueMm2tex(0, [1, 0, 0])
    for (const sliceType of [
      SLICE_TYPE.AXIAL,
      SLICE_TYPE.CORONAL,
      SLICE_TYPE.SAGITTAL,
    ]) {
      const fitted = fitSegmentsToSlice(segments(), mm2tex, center, sliceType)
      fitted.forEach((seg, i) => {
        for (let e = 0; e < 2; e++) {
          for (let d = 0; d < 3; d++) {
            expect(seg[e][d]).toBeCloseTo(segments()[i][e][d], 4)
          }
        }
      })
    }
  })

  test('puts the in-plane arms of an oblique volume on the displayed slice', () => {
    const cases: [number, [number, number, number]][] = [
      [SLICE_TYPE.AXIAL, [1, 0, 0]],
      [SLICE_TYPE.CORONAL, [0, 0, 1]],
      [SLICE_TYPE.SAGITTAL, [0, 1, 0]],
    ]
    for (const [sliceType, axis] of cases) {
      const mm2tex = obliqueMm2tex(7, axis)
      const dim = 2 - sliceType
      const slice = texCoord(mm2tex, center, dim)
      const original = segments()
      const fitted = fitSegmentsToSlice(original, mm2tex, center, sliceType)
      fitted.forEach((seg, i) => {
        if (Math.floor(i / 2) === dim) {
          expect(seg).toEqual(original[i])
          return
        }
        for (let e = 0; e < 2; e++) {
          expect(texCoord(mm2tex, seg[e], dim)).toBeCloseTo(slice, 6)
          // Only depth moves, so the arm keeps its place on screen.
          for (let d = 0; d < 3; d++) {
            if (d !== dim) expect(seg[e][d]).toBe(original[i][e][d])
          }
        }
      })
      // The tilt is real: the arms had to move off the world-axis plane.
      const moved = fitted.some((seg, i) =>
        seg.some((p, e) => p[dim] !== original[i][e][dim]),
      )
      expect(moved).toBe(true)
    }
  })

  test('leaves the arms unchanged in a 3D render tile', () => {
    const mm2tex = obliqueMm2tex(7, [1, 0, 0])
    const original = segments()
    expect(
      fitSegmentsToSlice(original, mm2tex, center, SLICE_TYPE.RENDER),
    ).toEqual(original)
  })

  test('leaves the arms unchanged without a volume', () => {
    const original = segments()
    expect(
      fitSegmentsToSlice(original, null, center, SLICE_TYPE.AXIAL),
    ).toEqual(original)
  })
})
