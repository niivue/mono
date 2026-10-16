import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import { slicePlaneEquation } from '@/math/NVTransforms'
import { SLICE_TYPE, sliceTypeDim } from '@/NVConstants'
import type NVModel from '@/NVModel'
import {
  calculateCrosshairSegments,
  crosshairSegmentsForTile,
  fitSegmentsToSlice,
} from './NVCrosshair'

const SLICE_TYPES_2D = [
  SLICE_TYPE.AXIAL,
  SLICE_TYPE.CORONAL,
  SLICE_TYPE.SAGITTAL,
]

/**
 * The parts of NVModel the crosshair reads, for one 240 mm scene whose
 * background volume's texture axes are `affine` applied to the world axes.
 * NVModel itself cannot be imported under Bun.
 */
const modelWith = (affine: mat4): NVModel => {
  const tex2mm = mat4.clone(affine)
  mat4.translate(tex2mm, tex2mm, [-100, -100, -100])
  mat4.scale(tex2mm, tex2mm, [200, 200, 200])
  const mm2tex = mat4.invert(mat4.create(), tex2mm)
  if (!mm2tex) throw new Error('singular test affine')
  const extentsMin = vec3.fromValues(-120, -120, -120)
  const extentsMax = vec3.fromValues(120, 120, 120)
  const crosshairPos = vec3.fromValues(0.55, 0.4, 0.65)
  const scene2mm = (frac: ArrayLike<number>): vec3 =>
    vec3.fromValues(
      ...([0, 1, 2].map(
        (i) => extentsMin[i] + frac[i] * (extentsMax[i] - extentsMin[i]),
      ) as [number, number, number]),
    )
  return {
    extentsMin,
    extentsMax,
    scene: { crosshairPos },
    ui: { crosshairGap: 10 },
    tex2mm,
    mm2tex,
    volumes: [],
    scene2mm,
    getSliceTexFrac: (dim: number) => {
      const mm = scene2mm(crosshairPos)
      const tex = vec4.transformMat4(
        vec4.create(),
        vec4.fromValues(mm[0], mm[1], mm[2], 1),
        mm2tex,
      )
      return tex[dim]
    },
  } as unknown as NVModel
}

const rotation = (deg: number, axis: [number, number, number]): mat4 =>
  mat4.fromRotation(mat4.create(), (deg * Math.PI) / 180, axis)

const sheared = (): mat4 => {
  const m = rotation(9, [1, 2, 3])
  m[4] += 0.15 // y texture axis leans into x
  m[9] += 0.1 // z texture axis leans into y
  return m
}

/** The plane the slice shader draws for a tile of `sliceType`. */
const drawnPlane = (model: NVModel, sliceType: number) => {
  const plane = slicePlaneEquation(
    model.tex2mm as mat4,
    sliceType,
    model.getSliceTexFrac(sliceTypeDim(sliceType)),
  )
  if (!plane) throw new Error('degenerate test plane')
  return plane
}

const unfitted = (model: NVModel) =>
  calculateCrosshairSegments(
    model.extentsMin,
    model.extentsMax,
    model.scene.crosshairPos,
    model.ui.crosshairGap,
  )

describe('crosshairSegmentsForTile', () => {
  test('leaves the arms of an axis-aligned volume exactly unchanged', () => {
    const model = modelWith(mat4.create())
    for (const sliceType of [...SLICE_TYPES_2D, SLICE_TYPE.RENDER]) {
      expect(crosshairSegmentsForTile(model, sliceType)).toEqual(
        unfitted(model),
      )
    }
  })

  for (const [name, affine] of [
    ['rotated', rotation(7, [1, 1, 1])],
    ['sheared', sheared()],
  ] as const) {
    test(`puts the in-plane arms of a ${name} volume on the drawn slice`, () => {
      const model = modelWith(affine)
      const original = unfitted(model)
      for (const sliceType of SLICE_TYPES_2D) {
        const dim = sliceTypeDim(sliceType)
        const { normal, point } = drawnPlane(model, sliceType)
        const fitted = crosshairSegmentsForTile(model, sliceType)
        let moved = false
        fitted.forEach((seg, i) => {
          if (Math.floor(i / 2) === dim) return
          seg.forEach((p, e) => {
            const toPoint = vec3.subtract(vec3.create(), p, point)
            expect(vec3.dot(toPoint, normal)).toBeCloseTo(0, 4)
            // Only depth moves, so the arm keeps its place on screen.
            for (let d = 0; d < 3; d++) {
              if (d !== dim) expect(p[d]).toBe(original[i][e][d])
            }
            if (p[dim] !== original[i][e][dim]) moved = true
          })
        })
        expect(moved).toBe(true)
      }
    })
  }

  test('leaves the arms unchanged in a 3D render tile', () => {
    const model = modelWith(rotation(7, [1, 1, 1]))
    expect(crosshairSegmentsForTile(model, SLICE_TYPE.RENDER)).toEqual(
      unfitted(model),
    )
  })
})

describe('fitSegmentsToSlice', () => {
  const segments = calculateCrosshairSegments(
    [-100, -100, -100],
    [100, 100, 100],
    [0.5, 0.5, 0.5],
    10,
  )

  test('leaves the arms unchanged without a plane', () => {
    expect(fitSegmentsToSlice(segments, null, SLICE_TYPE.AXIAL)).toEqual(
      segments,
    )
  })

  test('leaves the arms unchanged for a plane edge-on to the view', () => {
    const plane = { normal: [1, 0, 0], point: [0, 0, 0] }
    expect(fitSegmentsToSlice(segments, plane, SLICE_TYPE.AXIAL)).toEqual(
      segments,
    )
  })
})
