import { describe, expect, test } from 'bun:test'
import { mat4, vec3 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import { projectMMToCanvas, tilePlane } from './sliceUtils'

describe('projectMMToCanvas', () => {
  test('identityMVP_projectsToCenter', () => {
    // Identity MVP: mm (0,0,0) → NDC (0,0,0) → center of tile
    const mvp = mat4.create() // identity
    const ltwh = [0, 0, 100, 100] // tile at origin, 100x100
    const [cx, cy] = projectMMToCanvas([0, 0, 0], mvp, ltwh)
    // NDC (0,0) → canvas (0 + (0+1)*0.5*100, 0 + (1-0)*0.5*100) = (50, 50)
    expect(cx).toBeCloseTo(50, 5)
    expect(cy).toBeCloseTo(50, 5)
  })

  test('offCenter_projectsCorrectly', () => {
    // Identity MVP: mm (1,1,0) → NDC (1,1,0)
    const mvp = mat4.create()
    const ltwh = [0, 0, 200, 200]
    const [cx, cy] = projectMMToCanvas([1, 1, 0], mvp, ltwh)
    // NDC x=1 → canvas: 0 + (1+1)*0.5*200 = 200
    // NDC y=1 → canvas: 0 + (1-1)*0.5*200 = 0
    expect(cx).toBeCloseTo(200, 5)
    expect(cy).toBeCloseTo(0, 5)
  })
})

describe('tilePlane', () => {
  const drawn = {
    axCorSag: SLICE_TYPE.AXIAL,
    mvpMatrix: mat4.create(),
    leftTopWidthHeight: [0, 0, 10, 10],
    planeNormal: vec3.fromValues(0, 0, 1),
    planePoint: vec3.create(),
  }

  test('drawn2DTile_returnsMatrices', () => {
    expect(tilePlane(drawn)).toEqual({
      mvp: drawn.mvpMatrix,
      ltwh: drawn.leftTopWidthHeight,
      pn: drawn.planeNormal,
      pp: drawn.planePoint,
    })
  })

  test('renderOrUndrawnTile_returnsNull', () => {
    expect(tilePlane({ ...drawn, axCorSag: SLICE_TYPE.RENDER })).toBeNull()
    expect(tilePlane({ ...drawn, planePoint: undefined })).toBeNull()
  })
})
