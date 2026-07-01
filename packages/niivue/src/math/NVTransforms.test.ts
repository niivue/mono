import { describe, expect, test } from 'bun:test'
import { mat4, vec3 } from 'gl-matrix'
import type { AffineMatrix, NVGlobalCamera, NVImage } from '@/NVTypes'
import {
  arrayToMat4,
  calculateGlobalVolumeMvp,
  cart2sphDeg,
  copyAffine,
  createAffineTransformMatrix,
  deg2rad,
  depthAziElevToClipPlane,
  mat4ToArray,
  mm2frac,
  mm2vox,
  multiplyAffine,
  rayBoxEntryMM,
  rayMarchFirstVisibleMM,
  slicePlaneEquation,
  unprojectScreen,
  vox2mm,
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

describe('affine utilities', () => {
  const affine: AffineMatrix = [
    [1, 0, 0, 10],
    [0, 2, 0, 20],
    [0, 0, 3, 30],
    [0, 0, 0, 1],
  ]

  test('copyAffine_returnsDeepCopy', () => {
    const copy = copyAffine(affine)
    copy[0][3] = 99
    expect(affine[0][3]).toBe(10)
  })

  test('arrayToMat4_roundTrip', () => {
    expect(mat4ToArray(arrayToMat4(affine))).toEqual(affine)
  })

  test('multiplyAffine_appliesWorldTranslationOnLeft', () => {
    const transform = createAffineTransformMatrix({
      translation: [5, -2, 1],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    })
    const result = multiplyAffine(affine, transform)
    expect(result[0][3]).toBe(15)
    expect(result[1][3]).toBe(18)
    expect(result[2][3]).toBe(31)
  })

  test('copyAffine_rejectsInvalidMatrix', () => {
    expect(() => copyAffine([[1, 2, 3]])).toThrow()
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
    const mtx = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    const result = vox2mm(null, [3, 4, 5], mtx)
    approx(result[0], 3)
    approx(result[1], 4)
    approx(result[2], 5)
  })

  test('scaledMatrix_scalesCorrectly', () => {
    // 2mm voxels
    const mtx = mat4.fromValues(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1)
    const result = vox2mm(null, [1, 1, 1], mtx)
    approx(result[0], 2)
    approx(result[1], 2)
    approx(result[2], 2)
  })

  test('translatedMatrix_translatesCorrectly', () => {
    // Identity rotation with translation offset
    const mtx = mat4.fromValues(
      1,
      0,
      0,
      10,
      0,
      1,
      0,
      20,
      0,
      0,
      1,
      30,
      0,
      0,
      0,
      1,
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
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
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
      2,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      1,
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
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
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
    100,
    0,
    0,
    0,
    0,
    100,
    0,
    0,
    0,
    0,
    100,
    0,
    0,
    0,
    0,
    1,
  )

  test('axial_returnsZNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 0, 0.5)
    expect(plane).not.toBeNull()
    if (!plane) return
    // For axial slice, normal should be along Z axis
    approx(Math.abs(plane.normal[2]), 1, 0.01)
    approx(Math.abs(plane.normal[0]), 0, 0.01)
    approx(Math.abs(plane.normal[1]), 0, 0.01)
  })

  test('coronal_returnsYNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 1, 0.5)
    expect(plane).not.toBeNull()
    if (!plane) return
    approx(Math.abs(plane.normal[1]), 1, 0.01)
    approx(Math.abs(plane.normal[0]), 0, 0.01)
    approx(Math.abs(plane.normal[2]), 0, 0.01)
  })

  test('sagittal_returnsXNormal', () => {
    const plane = slicePlaneEquation(frac2mm, 2, 0.5)
    expect(plane).not.toBeNull()
    if (!plane) return
    approx(Math.abs(plane.normal[0]), 1, 0.01)
    approx(Math.abs(plane.normal[1]), 0, 0.01)
    approx(Math.abs(plane.normal[2]), 0, 0.01)
  })
})

// ---------------------------------------------------------------------------
// calculateGlobalVolumeMvp — backend-agnostic helper used by both wgpu and gl
// renderers for tile.space === 'global3d'. Tests pin the shared math so both
// backends stay aligned.
// ---------------------------------------------------------------------------
describe('calculateGlobalVolumeMvp', () => {
  const tile = [0, 0, 800, 600]
  const camera: NVGlobalCamera = {
    position: [0, 0, 32],
    yaw: 0,
    pitch: 0,
    fov: 55,
    near: 0.1,
    far: 900,
  }
  const extentsMin = [-10, -10, -10]
  const extentsMax = [10, 10, 10]

  test('isDeterministic_sameInputProducesSameMvp', () => {
    const [a] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [5, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    const [b] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [5, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    for (let i = 0; i < 16; i++) approx(a[i], b[i])
  })

  test('returnsAllFourMatricesAndRay', () => {
    const result = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    expect(result).toHaveLength(4)
    const [mvp, model, normal, rayDir] = result
    expect(mvp.length).toBe(16)
    expect(model.length).toBe(16)
    expect(normal.length).toBe(16)
    expect(rayDir.length).toBe(3)
    // ray direction is a unit vector
    const len = Math.sqrt(
      rayDir[0] * rayDir[0] + rayDir[1] * rayDir[1] + rayDir[2] * rayDir[2],
    )
    approx(len, 1, 1e-3)
  })

  test('positionTranslatesVolumeCenter', () => {
    // Project the world center (0,0,0) through each model matrix — moving the
    // tile position must shift the projected center between calls.
    const [mvpA] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    const [mvpB] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [50, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    const origin = vec3.fromValues(0, 0, 0)
    const pA = vec3.create()
    const pB = vec3.create()
    vec3.transformMat4(pA, origin, mvpA)
    vec3.transformMat4(pB, origin, mvpB)
    // x-axis positions in clip space must differ once the tile is offset
    expect(Math.abs(pA[0] - pB[0])).toBeGreaterThan(1e-4)
  })

  test('sharedCamera_twoTilesProduceDistinctMvpsForDistinctPositions', () => {
    // Parity contract: same camera shared across tiles, different positions
    // must yield different MVPs. This is how global3d puts every volume in one
    // world space — both backends call this helper per-tile.
    const [mvpLeft] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [-25, 0, 0],
      1,
      undefined,
      extentsMin,
      extentsMax,
    )
    const [mvpRight] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [25, 0, 0],
      1,
      undefined,
      extentsMin,
      extentsMax,
    )
    let diff = 0
    for (let i = 0; i < 16; i++) diff += Math.abs(mvpLeft[i] - mvpRight[i])
    expect(diff).toBeGreaterThan(1e-3)
  })

  test('cameraUndefined_fallsBackToDefaults', () => {
    // Function must accept undefined camera and emit a finite MVP using its
    // documented defaults (eye z=32, yaw=0, pitch=0, fov=55, near=0.1, far=900).
    const [mvp] = calculateGlobalVolumeMvp(
      tile,
      undefined,
      [0, 0, 0],
      1,
      undefined,
      extentsMin,
      extentsMax,
    )
    for (let i = 0; i < 16; i++) expect(Number.isFinite(mvp[i])).toBe(true)
  })

  test('scalarScale_equivalentToUniformVec3Scale', () => {
    const [mvpScalar] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      2,
      undefined,
      extentsMin,
      extentsMax,
    )
    const [mvpVec3] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      [2, 2, 2],
      undefined,
      extentsMin,
      extentsMax,
    )
    for (let i = 0; i < 16; i++) approx(mvpScalar[i], mvpVec3[i])
  })

  test('orientationRotates_changesNormalMatrix', () => {
    const [, , normalA] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      1,
      [0, 0, 0],
      extentsMin,
      extentsMax,
    )
    const [, , normalB] = calculateGlobalVolumeMvp(
      tile,
      camera,
      [0, 0, 0],
      1,
      [0, Math.PI / 4, 0],
      extentsMin,
      extentsMax,
    )
    let diff = 0
    for (let i = 0; i < 16; i++) diff += Math.abs(normalA[i] - normalB[i])
    expect(diff).toBeGreaterThan(1e-3)
  })

  test('aspectRatio_changesProjectionForNonSquareTile', () => {
    const square = calculateGlobalVolumeMvp(
      [0, 0, 600, 600],
      camera,
      [0, 0, 0],
      1,
      undefined,
      extentsMin,
      extentsMax,
    )[0]
    const wide = calculateGlobalVolumeMvp(
      [0, 0, 1200, 600],
      camera,
      [0, 0, 0],
      1,
      undefined,
      extentsMin,
      extentsMax,
    )[0]
    // First column of the perspective matrix scales by 1/aspect, so the [0,0]
    // entry must differ for different tile aspect ratios.
    expect(Math.abs(square[0] - wide[0])).toBeGreaterThan(1e-3)
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

describe('rayBoxEntryMM', () => {
  const lo = [0, 0, 0]
  const hi = [10, 10, 10]

  test('returns the entry face for a ray crossing the box', () => {
    // Ray along +x from x=-5 enters the box at x=0.
    const entry = rayBoxEntryMM([-5, 5, 5], [15, 5, 5], lo, hi)
    expect(entry).not.toBeNull()
    expect(entry?.[0]).toBeCloseTo(0)
    expect(entry?.[1]).toBeCloseTo(5)
    expect(entry?.[2]).toBeCloseTo(5)
  })

  test('returns null when the ray misses the box', () => {
    expect(rayBoxEntryMM([-5, 50, 5], [15, 50, 5], lo, hi)).toBeNull()
  })

  test('clamps to the near point when the origin is inside the box', () => {
    const entry = rayBoxEntryMM([5, 5, 5], [5, 5, 15], lo, hi)
    expect(entry).not.toBeNull()
    expect(entry?.[2]).toBeCloseTo(5) // tmin clamped to 0 -> the near point
  })

  test('is order-independent in lo/hi', () => {
    const entry = rayBoxEntryMM([-5, 5, 5], [15, 5, 5], hi, lo)
    expect(entry?.[0]).toBeCloseTo(0)
  })

  test('advances the entry to a solid clip-plane cut surface', () => {
    // Plane [1,0,0,0]: kept side fx >= 0.5 -> mm x >= 5. The +x ray should enter
    // at the clip surface (x=5), not the clipped-away box face (x=0).
    const entry = rayBoxEntryMM([-5, 5, 5], [15, 5, 5], lo, hi, [1, 0, 0, 0])
    expect(entry?.[0]).toBeCloseTo(5)
  })

  test('ignores the no-clip sentinel and returns the box face', () => {
    const entry = rayBoxEntryMM([-5, 5, 5], [15, 5, 5], lo, hi, [1, 0, 0, 2])
    expect(entry?.[0]).toBeCloseTo(0)
  })

  test('returns null when a clip plane removes the whole ray', () => {
    // Plane [1,0,0,0.6]: kept side fx >= 1.1, impossible inside the [0,1] cube,
    // so the entire in-box segment is clipped away.
    expect(
      rayBoxEntryMM([-5, 5, 5], [15, 5, 5], lo, hi, [1, 0, 0, 0.6]),
    ).toBeNull()
  })

  test('skips clip refinement in cutaway mode', () => {
    const entry = rayBoxEntryMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      [1, 0, 0, 0],
      true,
    )
    expect(entry?.[0]).toBeCloseTo(0) // box face, clip ignored
  })
})

describe('rayMarchFirstVisibleMM', () => {
  const lo = [0, 0, 0]
  const hi = [10, 10, 10]

  test('lands on the first visible voxel, skipping empty front space', () => {
    // Only x >= 6 is "visible"; a +x ray should skip the empty front (x<6).
    const sampler = (x: number) => (x >= 6 ? 1 : 0)
    const hit = rayMarchFirstVisibleMM([-5, 5, 5], [15, 5, 5], lo, hi, sampler)
    expect(hit).not.toBeNull()
    // first sample at/after x=6 (within one march step of 10mm/512)
    expect(hit?.[0]).toBeGreaterThanOrEqual(6)
    expect(hit?.[0]).toBeLessThan(6.1)
  })

  test('returns null when nothing along the ray is visible', () => {
    const hit = rayMarchFirstVisibleMM([-5, 5, 5], [15, 5, 5], lo, hi, () => 0)
    expect(hit).toBeNull()
  })

  test('respects a solid clip plane (no visible voxel on the kept side)', () => {
    // Visible only for x<3, but the clip keeps x>=5 -> no visible voxel kept.
    const sampler = (x: number) => (x < 3 ? 1 : 0)
    const hit = rayMarchFirstVisibleMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      sampler,
      [1, 0, 0, 0],
    )
    expect(hit).toBeNull()
  })

  test('returns null when the ray misses the box', () => {
    const hit = rayMarchFirstVisibleMM(
      [-5, 50, 5],
      [15, 50, 5],
      lo,
      hi,
      () => 1,
    )
    expect(hit).toBeNull()
  })
})
