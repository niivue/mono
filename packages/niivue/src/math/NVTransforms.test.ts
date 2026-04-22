import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import type { NVImage } from '@/NVTypes'
import {
  deg2rad,
  cart2sphDeg,
  depthAziElevToClipPlane,
  vox2mm,
  mm2vox,
  mm2frac,
  slicePlaneEquation,
  unprojectScreen,
} from './NVTransforms'

const EPSILON = 1e-5

function approx(a: number, b: number, eps = EPSILON): void {
  expect(Math.abs(a - b)).toBeLessThan(eps)
}

// ---------------------------------------------------------------------------
// deg2rad
// ---------------------------------------------------------------------------
describe('deg2rad', () => {
  test('0_returns0', () => {
    expect(deg2rad(0)).toBe(0)
  })

  test('180_returnsPi', () => {
    approx(deg2rad(180), Math.PI)
  })

  test('360_returns2Pi', () => {
    approx(deg2rad(360), 2 * Math.PI)
  })

  test('90_returnsHalfPi', () => {
    approx(deg2rad(90), Math.PI / 2)
  })
})

// ---------------------------------------------------------------------------
// cart2sphDeg
// ---------------------------------------------------------------------------
describe('cart2sphDeg', () => {
  test('unitX_returnsCorrectAzimuthElevation', () => {
    const [azimuth, elevation] = cart2sphDeg(1, 0, 0)
    // Elevation should be 0 (in XY plane)
    approx(elevation, 0)
    // Azimuth: atan2(0,1)*180/PI - 90 = -90 → normalized to 270
    approx(azimuth, 270)
  })

  test('origin_returns0_0', () => {
    const [azimuth, elevation] = cart2sphDeg(0, 0, 0)
    expect(azimuth).toBe(0)
    expect(elevation).toBe(0)
  })

  test('unitZ_returnsElevation90', () => {
    const [_azimuth, elevation] = cart2sphDeg(0, 0, 1)
    approx(elevation, -90)
  })
})

// ---------------------------------------------------------------------------
// depthAziElevToClipPlane
// ---------------------------------------------------------------------------
describe('depthAziElevToClipPlane', () => {
  test('returnsCorrectPlane', () => {
    const [nx, ny, nz, d] = depthAziElevToClipPlane(5, 0, 0)
    // Normal should be a unit vector
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    approx(len, 1)
    // Depth should be negated
    expect(d).toBe(-5)
  })
})

// ---------------------------------------------------------------------------
// vox2mm
// ---------------------------------------------------------------------------
describe('vox2mm', () => {
  test('identityMatrix_returnsInputCoords', () => {
    // Identity affine: voxel coords = mm coords
    const mtx = mat4.fromValues(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    )
    const result = vox2mm(null, [3, 4, 5], mtx)
    approx(result[0], 3)
    approx(result[1], 4)
    approx(result[2], 5)
  })

  test('scaledMatrix_scalesCorrectly', () => {
    // 2mm voxels
    const mtx = mat4.fromValues(
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 2, 0,
      0, 0, 0, 1,
    )
    const result = vox2mm(null, [1, 1, 1], mtx)
    approx(result[0], 2)
    approx(result[1], 2)
    approx(result[2], 2)
  })

  test('translatedMatrix_translatesCorrectly', () => {
    // Identity rotation with translation offset
    const mtx = mat4.fromValues(
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    )
    const result = vox2mm(null, [0, 0, 0], mtx)
    approx(result[0], 10)
    approx(result[1], 20)
    approx(result[2], 30)
  })
})

// ---------------------------------------------------------------------------
// mm2vox roundtrip
// ---------------------------------------------------------------------------
describe('mm2vox', () => {
  test('identityRAS_roundtripsWithVox2mm', () => {
    const matRAS = mat4.fromValues(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    )
    const fakeImage = { matRAS } as unknown as NVImage
    const mm = vox2mm(null, [3, 4, 5], matRAS)
    const vox = mm2vox(fakeImage, mm)
    // mm2vox rounds to integer voxels by default
    expect(vox[0]).toBe(3)
    expect(vox[1]).toBe(4)
    expect(vox[2]).toBe(5)
  })

  test('frac_mode_returnsFloat', () => {
    const matRAS = mat4.fromValues(
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 2, 0,
      0, 0, 0, 1,
    )
    const fakeImage = { matRAS } as unknown as NVImage
    const vox = mm2vox(fakeImage, [3, 3, 3], true)
    // 3mm / 2mm per voxel = 1.5 voxels
    approx(vox[0], 1.5)
    approx(vox[1], 1.5)
    approx(vox[2], 1.5)
  })
})

// ---------------------------------------------------------------------------
// mm2frac
// ---------------------------------------------------------------------------
describe('mm2frac', () => {
  test('validImage_returnsNormalizedCoords', () => {
    const matRAS = mat4.fromValues(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    )
    const fakeImage = {
      dimsRAS: [3, 10, 10, 10],
      matRAS,
      frac2mmOrtho: null,
    } as unknown as NVImage

    // Use isForceSliceMM=true path which uses matRAS
    const frac = mm2frac(fakeImage, [5, 5, 5], true)
    // (vox + 0.5) / dim = frac → vox = mm for identity → frac = (5+0.5)/10 = 0.55
    approx(frac[0], 0.55)
    approx(frac[1], 0.55)
    approx(frac[2], 0.55)
  })

  test('undefinedDims_returnsZeroVector', () => {
    const fakeImage = {
      dimsRAS: undefined,
      matRAS: mat4.create(),
      frac2mmOrtho: null,
    } as unknown as NVImage
    const frac = mm2frac(fakeImage, [5, 5, 5], true)
    expect(frac[0]).toBe(0)
    expect(frac[1]).toBe(0)
    expect(frac[2]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// slicePlaneEquation
// ---------------------------------------------------------------------------
describe('slicePlaneEquation', () => {
  // Build a simple identity frac2mm (scale 100mm per axis)
  const frac2mm = mat4.fromValues(
    100, 0, 0, 0,
    0, 100, 0, 0,
    0, 0, 100, 0,
    0, 0, 0, 1,
  )

  test('axial_returnsZNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 0, 0.5)
    expect(plane).not.toBeNull()
    // For axial slice, normal should be along Z axis
    approx(Math.abs(plane!.normal[2]), 1, 0.01)
    approx(Math.abs(plane!.normal[0]), 0, 0.01)
    approx(Math.abs(plane!.normal[1]), 0, 0.01)
  })

  test('coronal_returnsYNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 1, 0.5)
    expect(plane).not.toBeNull()
    approx(Math.abs(plane!.normal[1]), 1, 0.01)
    approx(Math.abs(plane!.normal[0]), 0, 0.01)
    approx(Math.abs(plane!.normal[2]), 0, 0.01)
  })

  test('sagittal_returnsXNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 2, 0.5)
    expect(plane).not.toBeNull()
    approx(Math.abs(plane!.normal[0]), 1, 0.01)
    approx(Math.abs(plane!.normal[1]), 0, 0.01)
    approx(Math.abs(plane!.normal[2]), 0, 0.01)
  })
})

// ---------------------------------------------------------------------------
// unprojectScreen
// ---------------------------------------------------------------------------
describe('unprojectScreen', () => {
  test('center_returnsReasonablePoint', () => {
    // Build a simple ortho MVP
    const mvp = mat4.create()
    mat4.ortho(mvp, -1, 1, -1, 1, 0.1, 100)
    const model = mat4.create()
    mat4.translate(model, model, [0, 0, -50])
    const combined = mat4.create()
    mat4.multiply(combined, mvp, model)

    const result = unprojectScreen(0.5, 0.5, 0.5, combined)
    // Should return a finite point
    expect(Number.isFinite(result[0])).toBe(true)
    expect(Number.isFinite(result[1])).toBe(true)
    expect(Number.isFinite(result[2])).toBe(true)
  })
})
