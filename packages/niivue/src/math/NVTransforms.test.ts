import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import type { AffineMatrix, NVGlobalCamera, NVImage } from '@/NVTypes'
import {
  arrayToMat4,
  calculateGlobalVolumeMvp,
  calculateMvpMatrix,
  calculateMvpMatrix2D,
  cart2sphDeg,
  copyAffine,
  createAffineTransformMatrix,
  deg2rad,
  depthAziElevToClipPlane,
  mat4ToArray,
  mm2frac,
  mm2vox,
  mmPerPixel2D,
  mmPerPixelRender,
  multiplyAffine,
  panFollowCrosshair2D,
  rayBoxEntryMM,
  rayMarchFirstVisibleMM,
  slicePlaneEquation,
  stepZoom2D,
  unprojectScreen,
  vox2mm,
  ZOOM_2D_MAX,
  ZOOM_2D_MIN,
  zoomPan2DAbout,
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

  test('keeps the box face when the cutaway carves the far half', () => {
    // Cutaway removes what a solid plane would keep (fx >= 0.5 -> mm x >= 5), so
    // the +x ray still enters at the untouched near face.
    const entry = rayBoxEntryMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      [1, 0, 0, 0],
      true,
    )
    expect(entry?.[0]).toBeCloseTo(0)
  })

  test('advances past a cutaway that carves the near half', () => {
    // Plane [-1,0,0,0]: solid would keep mm x <= 5, so the cutaway carves that
    // near half out. The entry advances to where the ray leaves it (x=5).
    const entry = rayBoxEntryMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      [-1, 0, 0, 0],
      true,
    )
    expect(entry?.[0]).toBeCloseTo(5)
  })

  test('returns null when the cutaway carves the whole ray', () => {
    // Plane [1,0,0,-0.6]: solid keeps fx >= -0.1, i.e. everything in the cube,
    // so the cutaway removes the entire in-box segment.
    expect(
      rayBoxEntryMM([-5, 5, 5], [15, 5, 5], lo, hi, [1, 0, 0, -0.6], true),
    ).toBeNull()
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

  test('lands on tissue exposed by a solid clip plane, not the cut surface', () => {
    // The clip keeps mm x >= 5, and the volume is hollow until x=7: the pick must
    // reach the cavity wall, not stop at the cut surface (x=5).
    const sampler = (x: number) => (x >= 7 ? 1 : 0)
    const hit = rayMarchFirstVisibleMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      sampler,
      [1, 0, 0, 0],
    )
    expect(hit?.[0]).toBeGreaterThanOrEqual(7)
    expect(hit?.[0]).toBeLessThan(7.1)
  })

  test('skips voxels inside a cutaway slab', () => {
    // Cutaway carves out mm x <= 5 (what plane [-1,0,0,0] would keep), so the
    // visible-everywhere volume is first pickable where the ray leaves it.
    const hit = rayMarchFirstVisibleMM(
      [-5, 5, 5],
      [15, 5, 5],
      lo,
      hi,
      () => 1,
      [-1, 0, 0, 0],
      true,
    )
    expect(hit?.[0]).toBeGreaterThanOrEqual(5)
    expect(hit?.[0]).toBeLessThan(5.1)
  })
})

// ---------------------------------------------------------------------------
// zoomPan2DAbout
// ---------------------------------------------------------------------------
//
// These assert against calculateMvpMatrix2D itself rather than restating the
// algebra, because the bug being fixed (niivue/mono#68) was a compensation that
// disagreed with the ortho window the renderer actually builds. A test that
// only re-derived the formula would have passed against the broken code too.

/**
 * Where a world-mm point lands in clip space through the 2D slice transform,
 * driven exactly as `NVSliceLayout` drives it: extents and pan permuted into
 * the tile's [U, V, depth] order, with that orientation's rotations.
 */
function projectThroughSlice(
  mm: readonly number[],
  pan: readonly number[],
  extentsMin: readonly number[],
  extentsMax: readonly number[],
  axCorSag = 0,
  isRadiological = false,
): [number, number] {
  // IDX_MAP and rotations(), mirrored from NVSliceLayout so this test pins the
  // transform rather than the layout engine's current wiring to it.
  const map = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 2, 0],
  ][axCorSag]
  const rot = [
    { azimuth: isRadiological ? 180 : 0, elevation: isRadiological ? -90 : 90 },
    { azimuth: isRadiological ? 180 : 0, elevation: 0 },
    { azimuth: isRadiological ? 90 : -90, elevation: 0 },
  ][axCorSag]
  const mn = [extentsMin[map[0]], extentsMin[map[1]], extentsMin[map[2]]]
  const mx = [extentsMax[map[0]], extentsMax[map[1]], extentsMax[map[2]]]
  const [mvp] = calculateMvpMatrix2D(
    [0, 0, 100, 100],
    mn,
    mx,
    Infinity,
    undefined,
    rot.azimuth,
    rot.elevation,
    isRadiological,
    undefined,
    undefined,
    [pan[map[0]], pan[map[1]], pan[3]],
  )
  const clip = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) {
    clip[r] =
      mvp[r] * mm[0] + mvp[4 + r] * mm[1] + mvp[8 + r] * mm[2] + mvp[12 + r]
  }
  return [clip[0] / clip[3], clip[1] / clip[3]]
}

describe('zoomPan2DAbout', () => {
  // Deliberately NOT centred on the world origin: the previous implementation
  // measured from the origin, so a centred volume hid half the bug.
  const extentsMin = [-90, -126, -72]
  const extentsMax = [90, 90, 108]

  test('anchorHoldsItsScreenPositionAcrossOneZoomStep', () => {
    const pan = [0, 0, 0, 1]
    const anchor = [40, -30, 12]
    const before = projectThroughSlice(anchor, pan, extentsMin, extentsMax)
    const next = zoomPan2DAbout(pan, 1.1, anchor, extentsMin, extentsMax)
    const after = projectThroughSlice(
      anchor,
      [next[0], next[1], next[2], 1.1],
      extentsMin,
      extentsMax,
    )
    approx(after[0], before[0])
    approx(after[1], before[1])
  })

  test('anchorStillHoldsAfterManyStepsIntoADeepZoom', () => {
    // The old difference-of-zooms compensation was off by a factor of the new
    // zoom, so it looked passable at 1.0 and drifted badly by 5x.
    const anchor = [-55, 60, -20]
    let pan = [0, 0, 0, 1]
    const before = projectThroughSlice(anchor, pan, extentsMin, extentsMax)
    for (let i = 0; i < 20; i++) {
      const zoom = Math.round(pan[3] * 1.1 * 10) / 10
      const next = zoomPan2DAbout(pan, zoom, anchor, extentsMin, extentsMax)
      pan = [next[0], next[1], next[2], zoom]
    }
    expect(pan[3]).toBeGreaterThan(4)
    const after = projectThroughSlice(anchor, pan, extentsMin, extentsMax)
    approx(after[0], before[0])
    approx(after[1], before[1])
  })

  test('anchorHoldsUnderRadiologicalOrientation', () => {
    const pan = [0, 0, 0, 1]
    const anchor = [40, -30, 12]
    const before = projectThroughSlice(
      anchor,
      pan,
      extentsMin,
      extentsMax,
      0,
      true,
    )
    const next = zoomPan2DAbout(pan, 2, anchor, extentsMin, extentsMax)
    const after = projectThroughSlice(
      anchor,
      [next[0], next[1], next[2], 2],
      extentsMin,
      extentsMax,
      0,
      true,
    )
    approx(after[0], before[0])
    approx(after[1], before[1])
  })

  test('anchorHoldsOnEveryTileFromOneCompensation', () => {
    // One pan serves all three tiles, so the compensation is only correct if it
    // holds under each tile's permutation of the world axes.
    const pan = [-6, 4, 9, 1.3]
    const anchor = [33, -47, 51]
    for (const axCorSag of [0, 1, 2]) {
      const before = projectThroughSlice(
        anchor,
        pan,
        extentsMin,
        extentsMax,
        axCorSag,
      )
      const next = zoomPan2DAbout(pan, 3.1, anchor, extentsMin, extentsMax)
      const after = projectThroughSlice(
        anchor,
        [next[0], next[1], next[2], 3.1],
        extentsMin,
        extentsMax,
        axCorSag,
      )
      approx(after[0], before[0])
      approx(after[1], before[1])
    }
  })

  test('anchorHoldsWhenThePanIsAlreadyNonZero', () => {
    const pan = [12, -8, 3, 1.6]
    const anchor = [25, 41, -7]
    const before = projectThroughSlice(anchor, pan, extentsMin, extentsMax)
    const next = zoomPan2DAbout(pan, 2.4, anchor, extentsMin, extentsMax)
    const after = projectThroughSlice(
      anchor,
      [next[0], next[1], next[2], 2.4],
      extentsMin,
      extentsMax,
    )
    approx(after[0], before[0])
    approx(after[1], before[1])
  })

  test('unchangedZoomLeavesThePanAlone', () => {
    const pan = [12, -8, 3, 2]
    const next = zoomPan2DAbout(pan, 2, [1, 2, 3], extentsMin, extentsMax)
    approx(next[0], 12)
    approx(next[1], -8)
    approx(next[2], 3)
  })

  test('nonPositiveOrNonFiniteZoomIsRefusedRatherThanPropagated', () => {
    const pan = [5, 6, 7, 2]
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = zoomPan2DAbout(pan, bad, [1, 2, 3], extentsMin, extentsMax)
      expect(next).toEqual([5, 6, 7])
    }
  })

  test('degenerateExtentsRescaleThePanRatherThanReturningNaN', () => {
    const flat = [10, 10, 10]
    const next = zoomPan2DAbout([4, 4, 4, 2], 4, [10, 10, 10], flat, flat)
    for (const v of next) expect(Number.isFinite(v)).toBe(true)
    approx(next[0], 2)
  })
})

// ---------------------------------------------------------------------------
// panFollowCrosshair2D
// ---------------------------------------------------------------------------
//
// Like zoomPan2DAbout above, visibility is asserted through
// calculateMvpMatrix2D itself (via projectThroughSlice): "inside the window"
// means the crosshair's in-plane clip coordinates are within [-1, 1] on the
// ortho window the renderer actually builds, not a restatement of the algebra.

describe('panFollowCrosshair2D', () => {
  // Same deliberately non-origin-centred extents as zoomPan2DAbout.
  const extentsMin = [-90, -126, -72]
  const extentsMax = [90, 90, 108]

  /** True when `mm` projects inside the tile's clip window on both axes. */
  function isVisibleOnTile(
    mm: readonly number[],
    pan: readonly number[],
    axCorSag: number,
    isRadiological = false,
  ): boolean {
    const [u, v] = projectThroughSlice(
      mm,
      pan,
      extentsMin,
      extentsMax,
      axCorSag,
      isRadiological,
    )
    const eps = 1e-4
    return Math.abs(u) <= 1 + eps && Math.abs(v) <= 1 + eps
  }

  test('visibleCrosshairLeavesThePanUntouched', () => {
    const pan = [0, 0, 0, 2]
    const crosshair = [10, -20, 20]
    for (const axCorSag of [0, 1, 2]) {
      expect(isVisibleOnTile(crosshair, pan, axCorSag)).toBe(true)
    }
    const next = panFollowCrosshair2D(pan, crosshair, extentsMin, extentsMax)
    expect(next).toEqual([0, 0, 0])
  })

  test('crosshairPastOneEdgePansMinimallyOnThatAxisAlone', () => {
    // At zoom 2 with zero pan the visible x window is [-45, 45]; x = 60 is out.
    const pan = [0, 0, 0, 2]
    const crosshair = [60, -20, 20]
    expect(isVisibleOnTile(crosshair, pan, 0)).toBe(false)
    const next = panFollowCrosshair2D(pan, crosshair, extentsMin, extentsMax)
    // Minimal move: the crosshair lands exactly ON the crossed edge, so the
    // pan moved by the overshoot (15 mm) and no further; other axes untouched.
    approx(next[0], -15)
    expect(next[1]).toBe(0)
    expect(next[2]).toBe(0)
    const after = [next[0], next[1], next[2], 2]
    const [u] = projectThroughSlice(crosshair, after, extentsMin, extentsMax, 0)
    approx(Math.abs(u), 1)
  })

  test('crosshairBelowTheLowerEdgePansTheOtherWay', () => {
    // Visible y window at zoom 2, pan 0 is [-72, 36]; y = -100 is below it.
    const pan = [0, 0, 0, 2]
    const crosshair = [10, -100, 20]
    const next = panFollowCrosshair2D(pan, crosshair, extentsMin, extentsMax)
    expect(next[0]).toBe(0)
    approx(next[1], 28)
    expect(next[2]).toBe(0)
    const after = [next[0], next[1], next[2], 2]
    const [, v] = projectThroughSlice(
      crosshair,
      after,
      extentsMin,
      extentsMax,
      0,
    )
    approx(Math.abs(v), 1)
  })

  test('followedCrosshairIsVisibleOnEveryTileFromOnePan', () => {
    // Off-window on all three axes at once, with a non-zero starting pan: one
    // shared pan must satisfy each tile's permutation of the world axes.
    const pan = [12, -8, 3, 3.5]
    const crosshair = [-80, 82, -60]
    const next = panFollowCrosshair2D(pan, crosshair, extentsMin, extentsMax)
    const after = [next[0], next[1], next[2], 3.5]
    for (const axCorSag of [0, 1, 2]) {
      expect(isVisibleOnTile(crosshair, pan, axCorSag)).toBe(false)
      expect(isVisibleOnTile(crosshair, after, axCorSag)).toBe(true)
    }
  })

  test('radiologicalOrientationNeedsNoSpecialCase', () => {
    const pan = [0, 0, 0, 2]
    const crosshair = [60, -20, 20]
    const next = panFollowCrosshair2D(pan, crosshair, extentsMin, extentsMax)
    const after = [next[0], next[1], next[2], 2]
    expect(isVisibleOnTile(crosshair, after, 0, true)).toBe(true)
  })

  test('zoomAtOrBelowOneLeavesThePanUntouched', () => {
    // Un-zoomed views keep the default behaviour byte-identical, even for a
    // crosshair a nonzero pan has pushed off-window.
    for (const zoom of [1, 0.5]) {
      const pan = [40, 0, 0, zoom]
      const next = panFollowCrosshair2D(
        pan,
        [500, 500, 500],
        extentsMin,
        extentsMax,
      )
      expect(next).toEqual([40, 0, 0])
    }
  })

  test('degenerateAndNonFiniteInputsAreSkippedNotNaN', () => {
    // A flat axis (single slice) has no window to follow into.
    const flat = [10, 10, 10]
    expect(
      panFollowCrosshair2D([1, 2, 3, 2], [99, 99, 99], flat, flat),
    ).toEqual([1, 2, 3])
    // A NaN crosshair coordinate must not poison the pan.
    const next = panFollowCrosshair2D(
      [0, 0, 0, 2],
      [Number.NaN, 0, 0],
      extentsMin,
      extentsMax,
    )
    expect(next).toEqual([0, 0, 0])
  })
})

// ---------------------------------------------------------------------------
// stepZoom2D
// ---------------------------------------------------------------------------

describe('stepZoom2D', () => {
  test('everyNotchMovesTheZoom', () => {
    // The plain snapped 10% step froze at 0.5 on the way down and left every
    // smaller zoom stuck in both directions.
    for (const dir of [1, -1]) {
      let zoom = dir > 0 ? ZOOM_2D_MIN : ZOOM_2D_MAX
      for (let i = 0; i < 200; i++) {
        const next = stepZoom2D(zoom, dir)
        if (next === ZOOM_2D_MAX || next === ZOOM_2D_MIN) break
        expect(next).not.toBe(zoom)
        zoom = next
      }
    }
  })

  test('bothEndsOfTheRangeAreReachable', () => {
    // Second pass through fround: scene.pan2Dxyzmm is a vec4, so 0.4 comes back
    // as 0.40000000596 and an exact stall test jammed the wheel there.
    for (const f of [(x: number) => x, Math.fround]) {
      let zoom = f(1)
      for (let i = 0; i < 200 && zoom > ZOOM_2D_MIN; i++)
        zoom = f(stepZoom2D(zoom, -1))
      expect(zoom).toBe(f(ZOOM_2D_MIN))
      for (let i = 0; i < 200 && zoom < ZOOM_2D_MAX; i++)
        zoom = f(stepZoom2D(zoom, 1))
      expect(zoom).toBe(f(ZOOM_2D_MAX))
    }
  })

  test('lowEndStepsAreReversible', () => {
    // Where the forced increment governs, the grid is walked one tenth at a
    // time and a notch back undoes a notch in. Higher up the proportional step
    // takes over and does not round-trip (7 -> 7.7 -> 6.9), which is the
    // multiplicative curve working as intended, not a defect.
    for (const zoom of [0.1, 0.2, 0.3, 0.4]) {
      approx(stepZoom2D(stepZoom2D(zoom, 1), -1), zoom)
    }
  })

  test('staysOnTheTenthsGrid', () => {
    let zoom = 1
    for (let i = 0; i < 40; i++) {
      zoom = stepZoom2D(zoom, i % 3 === 0 ? -1 : 1)
      approx(zoom * 10, Math.round(zoom * 10))
    }
  })

  test('clampsRatherThanRunningPastTheRange', () => {
    expect(stepZoom2D(ZOOM_2D_MAX, 1)).toBe(ZOOM_2D_MAX)
    expect(stepZoom2D(ZOOM_2D_MIN, -1)).toBe(ZOOM_2D_MIN)
  })

  test('noDirectionIsANoOp', () => {
    expect(stepZoom2D(1.7, 0)).toBe(1.7)
  })

  test('aBrokenZoomRecoversToTheFloor', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stepZoom2D(bad, 1)).toBe(ZOOM_2D_MIN)
    }
  })
})

describe('mmPerPixel2D', () => {
  // Project a 1 mm step through the very matrix the helper claims to invert and
  // check it lands one reported pixel away. Pinned against the matrix rather
  // than against a formula so the two cannot drift apart.
  const pixelsPerMM = (
    mn: number[],
    mx: number[],
    ltwh: number[],
    pan?: number[],
  ): number => {
    const [mvp] = calculateMvpMatrix2D(
      ltwh,
      mn,
      mx,
      Infinity,
      undefined,
      0,
      0,
      false,
      undefined,
      undefined,
      pan,
      false,
    )
    const at = (u: number): number => {
      const p = vec4.fromValues(u, 0, 0, 1)
      vec4.transformMat4(p, p, mvp)
      // NDC x spans [-1, 1] across the tile's pixel width.
      return ((p[0] / p[3]) * ltwh[2]) / 2
    }
    return Math.abs(at(1) - at(0))
  }

  test('reports the tile scale calculateMvpMatrix2D sets up', () => {
    const mn = [-90, -110, 0]
    const mx = [90, 110, 0]
    const ltwh = [0, 0, 360, 440]
    const measured = pixelsPerMM(mn, mx, ltwh)
    expect(mmPerPixel2D(mn, mx, ltwh)).toBeCloseTo(1 / measured, 6)
    expect(mmPerPixel2D(mn, mx, ltwh)).toBeCloseTo(0.5, 6)
  })

  test('shrinks with the 2D zoom', () => {
    const mn = [-90, -110, 0]
    const mx = [90, 110, 0]
    const ltwh = [0, 0, 360, 440]
    const pan = [0, 0, 4]
    const measured = pixelsPerMM(mn, mx, ltwh, pan)
    expect(mmPerPixel2D(mn, mx, ltwh, pan)).toBeCloseTo(1 / measured, 6)
    // A crosshair asking for a fixed pixel weight therefore asks for a quarter
    // of the world radius once the view is zoomed 4x.
    expect(mmPerPixel2D(mn, mx, ltwh, pan)).toBeCloseTo(
      mmPerPixel2D(mn, mx, ltwh) / 4,
      6,
    )
  })

  test('is 0 for a tile with no width', () => {
    expect(mmPerPixel2D([-1, -1, 0], [1, 1, 0], [0, 0, 0, 10])).toBe(0)
  })
})

describe('mmPerPixelRender', () => {
  const pixelsPerMM = (
    ltwh: number[],
    furthest: number,
    zoom: number,
  ): number => {
    const [mvp] = calculateMvpMatrix(ltwh, 0, 0, [0, 0, 0], furthest, zoom)
    const at = (u: number): number => {
      const p = vec4.fromValues(u, 0, 0, 1)
      vec4.transformMat4(p, p, mvp as mat4)
      return ((p[0] / p[3]) * ltwh[2]) / 2
    }
    return Math.abs(at(1) - at(0))
  }

  test('reports the scale calculateMvpMatrix sets up', () => {
    const ltwh = [0, 0, 600, 400]
    const measured = pixelsPerMM(ltwh, 100, 1)
    expect(mmPerPixelRender(ltwh, 100, 1)).toBeCloseTo(1 / measured, 6)
  })

  test('shrinks with the render zoom', () => {
    const ltwh = [0, 0, 400, 600]
    const measured = pixelsPerMM(ltwh, 100, 2)
    expect(mmPerPixelRender(ltwh, 100, 2)).toBeCloseTo(1 / measured, 6)
    expect(mmPerPixelRender(ltwh, 100, 2)).toBeCloseTo(
      mmPerPixelRender(ltwh, 100, 1) / 2,
      6,
    )
  })

  test('is 0 for a tile with no area', () => {
    expect(mmPerPixelRender([0, 0, 600, 0], 100, 1)).toBe(0)
  })
})
