import { mat3, mat4, vec3, vec4 } from "gl-matrix"
import { log } from "@/logger"
import type { NVImage } from "@/NVTypes"

export function vox2mm(_unused: unknown, XYZ: number[], mtx: mat4): vec3 {
  const sform = mat4.clone(mtx)
  mat4.transpose(sform, sform)
  const pos = vec4.fromValues(XYZ[0], XYZ[1], XYZ[2], 1)
  vec4.transformMat4(pos, pos, sform)
  const pos3 = vec3.fromValues(pos[0], pos[1], pos[2])
  return pos3
}

function calculateRayDirection(modelMatrix: mat4, obliqueRAS?: mat4): vec3 {
  if (obliqueRAS) {
    const oblique = mat4.clone(obliqueRAS)
    mat4.multiply(modelMatrix, modelMatrix, oblique)
  }
  const dirClip = vec3.fromValues(0, 0, -1)
  const proj3 = mat3.fromValues(1, 0, 0, 0, -1, 0, 0, 0, -1)
  const dirAfterProj = vec3.create()
  vec3.transformMat3(dirAfterProj, dirClip, proj3)
  const model3 = mat3.create()
  mat3.fromMat4(model3, modelMatrix)
  const invModel3 = mat3.create()
  if (!mat3.invert(invModel3, model3)) {
    // fallback: if not invertible, return a sensible default (e.g. unit Z)
    return vec3.fromValues(0, 0, 1)
  }
  // worldRay = invModel3 * dirAfterProj
  const worldRay = vec3.create()
  vec3.transformMat3(worldRay, dirAfterProj, invModel3)
  vec3.normalize(worldRay, worldRay)
  // small defuzz to avoid exact zero components
  const tiny = 0.00005
  for (let i = 0; i < 3; i++) {
    if (Math.abs(worldRay[i]) < tiny) {
      worldRay[i] = Math.sign(worldRay[i]) * tiny || tiny
    }
  }
  vec3.negate(worldRay, worldRay)
  return worldRay
}

export function cart2sphDeg(x: number, y: number, z: number): [number, number] {
  const len = Math.sqrt(x * x + y * y + z * z)
  if (len === 0) return [0, 0]
  const elevation = -Math.asin(z / len) * (180 / Math.PI)
  let azimuth = Math.atan2(y, x) * (180 / Math.PI) - 90
  azimuth = (azimuth + 360) % 360
  return [azimuth, elevation]
}

function sph2cartDeg(
  azimuth: number,
  elevation: number,
): [number, number, number] {
  const Phi = -elevation * (Math.PI / 180)
  const Theta = ((azimuth + 90) % 360) * (Math.PI / 180)
  const ret: [number, number, number] = [
    Math.cos(Phi) * Math.cos(Theta),
    Math.cos(Phi) * Math.sin(Theta),
    Math.sin(Phi),
  ]
  const len = Math.sqrt(ret[0] * ret[0] + ret[1] * ret[1] + ret[2] * ret[2])
  if (len <= 0.0) {
    return ret
  }
  ret[0] /= len
  ret[1] /= len
  ret[2] /= len
  return ret
}

export function depthAziElevToClipPlane(
  depth: number,
  azimuth: number,
  elevation: number,
): [number, number, number, number] {
  const n = sph2cartDeg(azimuth, elevation)
  return [n[0], n[1], n[2], -depth] // depth negated for shader
}

export function deg2rad(deg: number): number {
  return deg * (Math.PI / 180.0)
}

export function calculateMvpMatrix2D(
  _leftTopWidthHeight: number[],
  mn: number[],
  mx: number[],
  clipTolerance = Infinity,
  clipCenter?: ArrayLike<number>,
  azimuth = 0,
  elevation = 0,
  isRadiological = false,
  obliqueRAS?: mat4,
  origin?: ArrayLike<number>,
  pan?: ArrayLike<number>,
  clipSpaceZeroToOne = true,
): [mat4, mat4, mat4, vec3] {
  let left: number, right: number, bottom: number, top: number
  if (origin) {
    // Center bounds for rotation-stable framing (mosaic render tiles)
    const hw = (mx[0] - mn[0]) / 2
    const hh = (mx[1] - mn[1]) / 2
    left = -hw
    right = hw
    bottom = -hh
    top = hh
  } else {
    // Use mm extents directly for ortho bounds - tile already has correct aspect ratio
    left = mn[0]
    right = mx[0]
    bottom = mn[1]
    top = mx[1]
    if (isRadiological) {
      left = -mx[0]
      right = -mn[0]
    }
  }
  // Apply 2D zoom and pan (pan = [panU, panV, zoom?])
  if (pan) {
    // Zoom: scale ortho bounds around center (pan[2], default 1)
    const zoom = pan.length > 2 ? pan[2] : 1
    if (zoom !== 1) {
      const cu = (left + right) / 2
      const cv = (bottom + top) / 2
      const hw = (right - left) / (2 * zoom)
      const hh = (top - bottom) / (2 * zoom)
      left = cu - hw
      right = cu + hw
      bottom = cv - hh
      top = cv + hh
    }
    // Pan: shift ortho bounds by world-mm offset
    // Radiological flips the U axis — negate panU to match
    const panU = isRadiological ? -pan[0] : pan[0]
    left -= panU
    right -= panU
    bottom -= pan[1]
    top -= pan[1]
  }
  // Scale for depth based on Z extent
  const scale = 2 * Math.max(Math.abs(mn[2]), Math.abs(mx[2]))
  // Build model matrix: push to -Z, then rotate for slice orientation
  const modelMatrix = mat4.create()
  const translateVec3 = vec3.fromValues(0, 0, -scale * 1.8)
  mat4.translate(modelMatrix, modelMatrix, translateVec3)
  mat4.rotateX(modelMatrix, modelMatrix, deg2rad(elevation - 90))
  mat4.rotateZ(modelMatrix, modelMatrix, deg2rad(azimuth))
  if (origin) {
    mat4.translate(modelMatrix, modelMatrix, [
      -origin[0],
      -origin[1],
      -origin[2],
    ])
  }
  // Compute near/far clip planes
  let near = scale * 0.01
  let far = scale * 8.0
  if (clipTolerance !== Infinity && clipCenter) {
    // Transform clip center through model matrix to get camera-space Z
    const clipCam = vec4.create()
    vec4.transformMat4(
      clipCam,
      vec4.fromValues(clipCenter[0], clipCenter[1], clipCenter[2], 1),
      modelMatrix,
    )
    const centerDepth = -clipCam[2]
    near = centerDepth - clipTolerance
    far = centerDepth + clipTolerance
  }
  const projectionMatrix = mat4.create()
  if (clipSpaceZeroToOne) {
    mat4.orthoZO(projectionMatrix, left, right, bottom, top, near, far)
  } else {
    mat4.ortho(projectionMatrix, left, right, bottom, top, near, far)
  }
  const iModelMatrix = mat4.create()
  mat4.invert(iModelMatrix, modelMatrix)
  const normalMatrix = mat4.create()
  mat4.transpose(normalMatrix, iModelMatrix)
  const mvpMatrix = mat4.create()
  mat4.multiply(mvpMatrix, projectionMatrix, modelMatrix)
  const rayDir = calculateRayDirection(modelMatrix, obliqueRAS)
  return [mvpMatrix, modelMatrix, normalMatrix, rayDir]
}

export function calculateMvpMatrix(
  ltwh: number[],
  azimuth: number,
  elevation: number,
  origin: ArrayLike<number>,
  furthestFromPivot: number,
  volScaleMultiplier: number,
  obliqueRAS?: mat4,
) {
  const mvpMatrix = mat4.create()
  const modelMatrix = mat4.create()
  const normalMatrix = mat4.create()
  const projectionMatrix = mat4.create()
  const whratio = ltwh[2] / ltwh[3]
  const scale = (0.8 * furthestFromPivot) / volScaleMultiplier
  const left = whratio < 1 ? -scale : -scale * whratio
  const right = whratio < 1 ? scale : scale * whratio
  const bottom = whratio < 1 ? -scale / whratio : -scale
  const top = whratio < 1 ? scale / whratio : scale
  const near = scale * 0.01
  const far = scale * 8.0
  mat4.orthoZO(projectionMatrix, left, right, bottom, top, near, far)
  const translateVec3 = vec3.fromValues(0, 0, -scale * 1.8)
  mat4.translate(modelMatrix, modelMatrix, translateVec3)
  mat4.rotateX(modelMatrix, modelMatrix, deg2rad(elevation - 90))
  mat4.rotateZ(modelMatrix, modelMatrix, deg2rad(azimuth))
  mat4.translate(modelMatrix, modelMatrix, [-origin[0], -origin[1], -origin[2]])
  const iModelMatrix = mat4.create()
  mat4.invert(iModelMatrix, modelMatrix)
  mat4.transpose(normalMatrix, iModelMatrix)
  mat4.multiply(mvpMatrix, projectionMatrix, modelMatrix)
  const rayDir = calculateRayDirection(modelMatrix, obliqueRAS)
  return [mvpMatrix, modelMatrix, normalMatrix, rayDir]
}

// Unproject a screen point (in normalized tile coordinates) + depth back to mm-space
// normalizedX/Y: [0,1] within tile (0,0 = top-left)
// depth: window-space depth value [0,1]
// mvpMatrix: the MVP matrix used to render this tile
export function unprojectScreen(
  normalizedX: number,
  normalizedY: number,
  depth: number,
  mvpMatrix: mat4,
): vec3 {
  const invMVP = mat4.create()
  mat4.invert(invMVP, mvpMatrix)
  // Convert normalized tile coords to NDC
  // X: 0→-1, 1→+1
  // Y: 0→+1 (top), 1→-1 (bottom) — flip because canvas Y is down, NDC Y is up
  const ndcX = normalizedX * 2 - 1
  const ndcY = 1 - normalizedY * 2
  // Convert window depth to clip Z for orthoZO projection
  // orthoZO produces clip Z in [0,1], WebGL viewport transform does (z+1)/2
  // so window depth is [0.5,1.0], and clipZ = depth * 2 - 1 maps back to [0,1]
  const clipZ = depth * 2 - 1
  const clipPos = vec4.fromValues(ndcX, ndcY, clipZ, 1.0)
  const worldPos = vec4.create()
  vec4.transformMat4(worldPos, clipPos, invMVP)
  return vec3.fromValues(
    worldPos[0] / worldPos[3],
    worldPos[1] / worldPos[3],
    worldPos[2] / worldPos[3],
  )
}

/**
 * Compute the plane equation (normal + point) for a 2D slice defined by the
 * volume's `frac2mm` matrix, a slice type, and a slice fraction.
 * Returns null if the plane degenerates (zero-area cross product).
 */
export function slicePlaneEquation(
  frac2mm: mat4,
  sliceType: number,
  sliceFrac: number,
): { normal: vec3; point: vec3 } | null {
  // Determine which texture dimension the slice fixes
  let sliceDim = 2 // axial (SLICE_TYPE.AXIAL = 0)
  if (sliceType === 1) sliceDim = 1 // coronal  (SLICE_TYPE.CORONAL = 1)
  if (sliceType === 2) sliceDim = 0 // sagittal (SLICE_TYPE.SAGITTAL = 2)

  // Build 3 texture-fraction points on the slice plane, matching the shader's
  // texPos construction: axial (x,y,sliceFrac), coronal (x,sliceFrac,y),
  // sagittal (sliceFrac,x,y)
  const makeFrac = (u: number, v: number): vec4 => {
    if (sliceDim === 2) return vec4.fromValues(u, v, sliceFrac, 1) // axial
    if (sliceDim === 1) return vec4.fromValues(u, sliceFrac, v, 1) // coronal
    return vec4.fromValues(sliceFrac, u, v, 1) // sagittal
  }
  const f0 = makeFrac(0, 0)
  const f1 = makeFrac(1, 0)
  const f2 = makeFrac(0, 1)

  // Transform to mm via frac2mm
  const p0 = vec3.create()
  const p1 = vec3.create()
  const p2 = vec3.create()
  const tmp = vec4.create()
  vec4.transformMat4(tmp, f0, frac2mm)
  vec3.set(p0, tmp[0] / tmp[3], tmp[1] / tmp[3], tmp[2] / tmp[3])
  vec4.transformMat4(tmp, f1, frac2mm)
  vec3.set(p1, tmp[0] / tmp[3], tmp[1] / tmp[3], tmp[2] / tmp[3])
  vec4.transformMat4(tmp, f2, frac2mm)
  vec3.set(p2, tmp[0] / tmp[3], tmp[1] / tmp[3], tmp[2] / tmp[3])

  // Plane normal from cross product of two edges
  const e1 = vec3.create()
  const e2 = vec3.create()
  vec3.subtract(e1, p1, p0)
  vec3.subtract(e2, p2, p0)
  const normal = vec3.create()
  vec3.cross(normal, e1, e2)
  const nLen = vec3.length(normal)
  if (nLen < 1e-12) return null
  vec3.scale(normal, normal, 1 / nLen)

  return { normal, point: p0 }
}

/**
 * Intersect a view ray (from screen coordinates) with a known plane.
 * Returns the hit point in mm, or null if the ray is parallel to the plane.
 */
export function intersectPlane(
  nx: number,
  ny: number,
  mvpMatrix: mat4,
  planeNormal: vec3,
  planePoint: vec3,
): [number, number, number] | null {
  // View ray: unproject at depth 0 and 1
  const rayOrigin = unprojectScreen(nx, ny, 0.0, mvpMatrix)
  const rayFar = unprojectScreen(nx, ny, 1.0, mvpMatrix)
  const rayDir = vec3.create()
  vec3.subtract(rayDir, rayFar, rayOrigin)

  // Ray-plane intersection: t = dot(planePoint - rayOrigin, normal) / dot(rayDir, normal)
  const denom = vec3.dot(rayDir, planeNormal)
  if (Math.abs(denom) < 1e-12) return null
  const diff = vec3.create()
  vec3.subtract(diff, planePoint, rayOrigin)
  const t = vec3.dot(diff, planeNormal) / denom

  return [
    rayOrigin[0] + t * rayDir[0],
    rayOrigin[1] + t * rayDir[1],
    rayOrigin[2] + t * rayDir[2],
  ]
}

/**
 * Intersect a view ray through a screen pixel with the slice plane defined by
 * `frac2mm` and the current crosshair position. Returns the hit point in mm,
 * or null if the ray is parallel to the plane.
 *
 * This handles oblique/sheared images correctly: the slice plane is derived
 * from the volume's `frac2mm` matrix (same transform the shader uses), so
 * the plane is tilted for sheared images rather than axis-aligned.
 */
export function intersectSlicePlane(
  nx: number,
  ny: number,
  mvpMatrix: mat4,
  frac2mm: mat4,
  sliceType: number,
  sliceFrac: number,
): [number, number, number] | null {
  const plane = slicePlaneEquation(frac2mm, sliceType, sliceFrac)
  if (!plane) return null
  return intersectPlane(nx, ny, mvpMatrix, plane.normal, plane.point)
}

export function mm2frac(
  nvImage: NVImage,
  mm: ArrayLike<number>,
  isForceSliceMM = false,
): vec3 {
  // given mm, return volume fraction
  // convert from object space in millimeters to normalized texture space XYZ= [0..1, 0..1 ,0..1]
  const mm4 = vec4.fromValues(mm[0], mm[1], mm[2], 1)
  const d = nvImage.dimsRAS
  const frac = vec3.fromValues(0, 0, 0)
  if (typeof d === "undefined") {
    return frac
  }
  if (!isForceSliceMM) {
    if (!nvImage.frac2mmOrtho) {
      return frac
    }
    const xform = mat4.clone(nvImage.frac2mmOrtho)
    mat4.invert(xform, xform)
    vec4.transformMat4(mm4, mm4, xform)
    frac[0] = mm4[0]
    frac[1] = mm4[1]
    frac[2] = mm4[2]
    return frac
  }
  if (d[1] < 1 || d[2] < 1 || d[3] < 1) {
    return frac
  }
  if (!nvImage.matRAS) {
    return frac
  }
  const sform = mat4.clone(nvImage.matRAS)
  mat4.invert(sform, sform)
  mat4.transpose(sform, sform)
  vec4.transformMat4(mm4, mm4, sform)
  frac[0] = (mm4[0] + 0.5) / d[1]
  frac[1] = (mm4[1] + 0.5) / d[2]
  frac[2] = (mm4[2] + 0.5) / d[3]
  return frac
}

export function calculateOverlayTransformMatrix(
  nvImageStationary: NVImage,
  nvImageMoving: NVImage,
): mat4 {
  //  origin in output space
  if (
    !nvImageMoving.mm000 ||
    !nvImageMoving.mm100 ||
    !nvImageMoving.mm010 ||
    !nvImageMoving.mm001
  ) {
    throw new Error("Missing moving image mm corner coordinates")
  }
  const f000 = mm2frac(nvImageStationary, nvImageMoving.mm000, true)
  let f100 = mm2frac(nvImageStationary, nvImageMoving.mm100, true)
  let f010 = mm2frac(nvImageStationary, nvImageMoving.mm010, true)
  let f001 = mm2frac(nvImageStationary, nvImageMoving.mm001, true)
  f100 = vec3.subtract(f100, f100, f000) // direction of i dimension from origin
  f010 = vec3.subtract(f010, f010, f000) // direction of j dimension from origin
  f001 = vec3.subtract(f001, f001, f000) // direction of k dimension from origin
  const mtx = mat4.fromValues(
    f100[0],
    f010[0],
    f001[0],
    f000[0],
    f100[1],
    f010[1],
    f001[1],
    f000[1],
    f100[2],
    f010[2],
    f001[2],
    f000[2],
    0,
    0,
    0,
    1,
  )
  mat4.invert(mtx, mtx)
  return mtx
}

function calculateOblique(nvImage: NVImage): void {
  if (!nvImage.matRAS) {
    throw new Error("matRAS not defined")
  }
  if (nvImage.pixDimsRAS === undefined) {
    throw new Error("pixDimsRAS not defined")
  }
  if (!nvImage.dimsRAS) {
    throw new Error("dimsRAS not defined")
  }
  nvImage.oblique_angle = computeObliqueAngle(nvImage.matRAS)
  const LPI = vox2mm(nvImage, [0.0, 0.0, 0.0], nvImage.matRAS)
  const X1mm = vox2mm(
    nvImage,
    [1.0 / nvImage.pixDimsRAS[1], 0.0, 0.0],
    nvImage.matRAS,
  )
  const Y1mm = vox2mm(
    nvImage,
    [0.0, 1.0 / nvImage.pixDimsRAS[2], 0.0],
    nvImage.matRAS,
  )
  const Z1mm = vox2mm(
    nvImage,
    [0.0, 0.0, 1.0 / nvImage.pixDimsRAS[3]],
    nvImage.matRAS,
  )
  vec3.subtract(X1mm, X1mm, LPI)
  vec3.subtract(Y1mm, Y1mm, LPI)
  vec3.subtract(Z1mm, Z1mm, LPI)
  const oblique = mat4.fromValues(
    X1mm[0],
    X1mm[1],
    X1mm[2],
    0,
    Y1mm[0],
    Y1mm[1],
    Y1mm[2],
    0,
    Z1mm[0],
    Z1mm[1],
    Z1mm[2],
    0,
    0,
    0,
    0,
    1,
  )
  nvImage.obliqueRAS = mat4.clone(oblique)
  const XY = Math.abs(90 - vec3.angle(X1mm, Y1mm) * (180 / Math.PI))
  const XZ = Math.abs(90 - vec3.angle(X1mm, Z1mm) * (180 / Math.PI))
  const YZ = Math.abs(90 - vec3.angle(Y1mm, Z1mm) * (180 / Math.PI))
  nvImage.maxShearDeg = Math.max(Math.max(XY, XZ), YZ)
  if (nvImage.maxShearDeg > 0.1) {
    log.warn(
      "Voxels are rhomboidal, maximum shear is",
      nvImage.maxShearDeg,
      "degrees.",
    )
  }
  // compute a matrix to transform vectors from factional space to mm:
  const dim = vec4.fromValues(
    nvImage.dimsRAS[1],
    nvImage.dimsRAS[2],
    nvImage.dimsRAS[3],
    1,
  )
  const sform = mat4.clone(nvImage.matRAS)
  mat4.transpose(sform, sform)
  const shim = vec4.fromValues(-0.5, -0.5, -0.5, 0) // bitmap with 5 voxels scaled 0..1, voxel centers are 0.1,0.3,0.5,0.7,0.9
  mat4.translate(sform, sform, vec3.fromValues(shim[0], shim[1], shim[2]))
  // mat.mat4.scale(sform, sform, dim);
  sform[0] *= dim[0]
  sform[1] *= dim[0]
  sform[2] *= dim[0]
  sform[4] *= dim[1]
  sform[5] *= dim[1]
  sform[6] *= dim[1]
  sform[8] *= dim[2]
  sform[9] *= dim[2]
  sform[10] *= dim[2]
  nvImage.frac2mm = mat4.clone(sform)
  const pixdimX = nvImage.pixDimsRAS[1] // vec3.length(X1mm);
  const pixdimY = nvImage.pixDimsRAS[2] // vec3.length(Y1mm);
  const pixdimZ = nvImage.pixDimsRAS[3] // vec3.length(Z1mm);
  // orthographic view
  const oform = mat4.clone(sform)
  oform[0] = pixdimX * dim[0]
  oform[1] = 0
  oform[2] = 0
  oform[4] = 0
  oform[5] = pixdimY * dim[1]
  oform[6] = 0
  oform[8] = 0
  oform[9] = 0
  oform[10] = pixdimZ * dim[2]
  const originVoxel = mm2vox(nvImage, [0, 0, 0], true)
  // set matrix translation for distance from origin
  oform[12] = (-originVoxel[0] - 0.5) * pixdimX
  oform[13] = (-originVoxel[1] - 0.5) * pixdimY
  oform[14] = (-originVoxel[2] - 0.5) * pixdimZ
  nvImage.frac2mmOrtho = mat4.clone(oform)
  nvImage.extentsMinOrtho = [oform[12], oform[13], oform[14]]
  nvImage.extentsMaxOrtho = [
    oform[0] + oform[12],
    oform[5] + oform[13],
    oform[10] + oform[14],
  ]
  nvImage.mm2ortho = mat4.create()
  mat4.invert(nvImage.mm2ortho, oblique)
}

function arrayEquals(a: number[], b: number[]): boolean {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((val, index) => val === b[index])
  )
}

export function calculateRAS(nvImage: NVImage): void {
  if (!nvImage.hdr) {
    throw new Error("hdr not set")
  }
  // not elegant, as JavaScript arrays are always 1D
  const a = nvImage.hdr.affine
  const header = nvImage.hdr
  const absR = mat3.fromValues(
    Math.abs(a[0][0]),
    Math.abs(a[0][1]),
    Math.abs(a[0][2]),
    Math.abs(a[1][0]),
    Math.abs(a[1][1]),
    Math.abs(a[1][2]),
    Math.abs(a[2][0]),
    Math.abs(a[2][1]),
    Math.abs(a[2][2]),
  )
  // 1st column = x
  const ixyz = [1, 1, 1]
  if (absR[3] > absR[0]) {
    ixyz[0] = 2 // (absR[1][0] > absR[0][0]) ixyz[0] = 2;
  }
  if (absR[6] > absR[0] && absR[6] > absR[3]) {
    ixyz[0] = 3 // ((absR[2][0] > absR[0][0]) && (absR[2][0]> absR[1][0])) ixyz[0] = 3;
  } // 2nd column = y
  ixyz[1] = 1
  if (ixyz[0] === 1) {
    if (absR[4] > absR[7]) {
      // (absR[1][1] > absR[2][1])
      ixyz[1] = 2
    } else {
      ixyz[1] = 3
    }
  } else if (ixyz[0] === 2) {
    if (absR[1] > absR[7]) {
      // (absR[0][1] > absR[2][1])
      ixyz[1] = 1
    } else {
      ixyz[1] = 3
    }
  } else {
    if (absR[1] > absR[4]) {
      // (absR[0][1] > absR[1][1])
      ixyz[1] = 1
    } else {
      ixyz[1] = 2
    }
  }
  // 3rd column = z: constrained as x+y+z = 1+2+3 = 6
  ixyz[2] = 6 - ixyz[1] - ixyz[0]
  let perm = [1, 2, 3]
  perm[ixyz[0] - 1] = 1
  perm[ixyz[1] - 1] = 2
  perm[ixyz[2] - 1] = 3
  let rotM = mat4.fromValues(
    a[0][0],
    a[0][1],
    a[0][2],
    a[0][3],
    a[1][0],
    a[1][1],
    a[1][2],
    a[1][3],
    a[2][0],
    a[2][1],
    a[2][2],
    a[2][3],
    0,
    0,
    0,
    1,
  )
  // n.b. 0.5 in these values to account for voxel centers, e.g. a 3-pixel wide bitmap in unit space has voxel centers at 0.25, 0.5 and 0.75
  nvImage.mm000 = vox2mm(nvImage, [-0.5, -0.5, -0.5], rotM)
  nvImage.mm100 = vox2mm(nvImage, [header.dims[1] - 0.5, -0.5, -0.5], rotM)
  nvImage.mm010 = vox2mm(nvImage, [-0.5, header.dims[2] - 0.5, -0.5], rotM)
  nvImage.mm001 = vox2mm(nvImage, [-0.5, -0.5, header.dims[3] - 0.5], rotM)
  const R = mat4.create()
  mat4.copy(R, rotM)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i * 4 + j] = rotM[i * 4 + perm[j] - 1] // rotM[i+(4*(perm[j]-1))];//rotM[i],[perm[j]-1];
    }
  }
  const flip = [0, 0, 0]
  if (R[0] < 0) {
    flip[0] = 1
  } // R[0][0]
  if (R[5] < 0) {
    flip[1] = 1
  } // R[1][1]
  if (R[10] < 0) {
    flip[2] = 1
  } // R[2][2]
  nvImage.dimsRAS = [
    header.dims[0],
    header.dims[perm[0]],
    header.dims[perm[1]],
    header.dims[perm[2]],
  ]
  nvImage.pixDimsRAS = [
    header.pixDims[0],
    header.pixDims[perm[0]],
    header.pixDims[perm[1]],
    header.pixDims[perm[2]],
  ]
  nvImage.permRAS = perm.slice()
  for (let i = 0; i < 3; i++) {
    if (flip[i] === 1) {
      nvImage.permRAS[i] = -nvImage.permRAS[i]
    }
  }
  if (arrayEquals(perm, [1, 2, 3]) && arrayEquals(flip, [0, 0, 0])) {
    nvImage.toRAS = mat4.create() // aka fromValues(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1);
    nvImage.matRAS = mat4.clone(rotM)
    calculateOblique(nvImage)
    nvImage.img2RASstep = [
      1,
      nvImage.dimsRAS[1],
      nvImage.dimsRAS[1] * nvImage.dimsRAS[2],
    ]
    nvImage.img2RASstart = [0, 0, 0]
    return // no rotation required!
  }
  mat4.identity(rotM)
  rotM[0 + 0 * 4] = 1 - flip[0] * 2
  rotM[1 + 1 * 4] = 1 - flip[1] * 2
  rotM[2 + 2 * 4] = 1 - flip[2] * 2
  rotM[3 + 0 * 4] = (header.dims[perm[0]] - 1) * flip[0]
  rotM[3 + 1 * 4] = (header.dims[perm[1]] - 1) * flip[1]
  rotM[3 + 2 * 4] = (header.dims[perm[2]] - 1) * flip[2]
  const residualR = mat4.create()
  mat4.invert(residualR, rotM)
  mat4.multiply(residualR, residualR, R)
  nvImage.matRAS = mat4.clone(residualR)
  rotM = mat4.fromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
  rotM[perm[0] - 1 + 0 * 4] = -flip[0] * 2 + 1
  rotM[perm[1] - 1 + 1 * 4] = -flip[1] * 2 + 1
  rotM[perm[2] - 1 + 2 * 4] = -flip[2] * 2 + 1
  rotM[3 + 0 * 4] = flip[0]
  rotM[3 + 1 * 4] = flip[1]
  rotM[3 + 2 * 4] = flip[2]
  nvImage.toRAS = mat4.clone(rotM) // webGL unit textures
  // voxel based column-major,
  rotM[3] = 0
  rotM[7] = 0
  rotM[11] = 0
  rotM[12] = 0
  if (
    nvImage.permRAS[0] === -1 ||
    nvImage.permRAS[1] === -1 ||
    nvImage.permRAS[2] === -1
  ) {
    rotM[12] = header.dims[1] - 1
  }
  rotM[13] = 0
  if (
    nvImage.permRAS[0] === -2 ||
    nvImage.permRAS[1] === -2 ||
    nvImage.permRAS[2] === -2
  ) {
    rotM[13] = header.dims[2] - 1
  }
  rotM[14] = 0
  if (
    nvImage.permRAS[0] === -3 ||
    nvImage.permRAS[1] === -3 ||
    nvImage.permRAS[2] === -3
  ) {
    rotM[14] = header.dims[3] - 1
  }
  nvImage.toRASvox = mat4.clone(rotM)
  const hdr = nvImage.hdr
  perm = nvImage.permRAS
  const aperm = [Math.abs(perm[0]), Math.abs(perm[1]), Math.abs(perm[2])]
  const outdim = [hdr.dims[aperm[0]], hdr.dims[aperm[1]], hdr.dims[aperm[2]]]
  const inStep = [1, hdr.dims[1], hdr.dims[1] * hdr.dims[2]] // increment i,j,k
  const outStep = [
    inStep[aperm[0] - 1],
    inStep[aperm[1] - 1],
    inStep[aperm[2] - 1],
  ]
  const outStart = [0, 0, 0]
  for (let p = 0; p < 3; p++) {
    // flip dimensions
    if (perm[p] < 0) {
      outStart[p] = outStep[p] * (outdim[p] - 1)
      outStep[p] = -outStep[p]
    }
  }
  nvImage.img2RASstep = outStep
  nvImage.img2RASstart = outStart
  calculateOblique(nvImage)
}

function computeObliqueAngle(mtx44: mat4): number {
  const mtx = mat4.clone(mtx44)
  mat4.transpose(mtx, mtx44)
  const dxtmp = Math.sqrt(mtx[0] * mtx[0] + mtx[1] * mtx[1] + mtx[2] * mtx[2])
  const xmax =
    Math.max(Math.max(Math.abs(mtx[0]), Math.abs(mtx[1])), Math.abs(mtx[2])) /
    dxtmp
  const dytmp = Math.sqrt(mtx[4] * mtx[4] + mtx[5] * mtx[5] + mtx[6] * mtx[6])
  const ymax =
    Math.max(Math.max(Math.abs(mtx[4]), Math.abs(mtx[5])), Math.abs(mtx[6])) /
    dytmp
  const dztmp = Math.sqrt(mtx[8] * mtx[8] + mtx[9] * mtx[9] + mtx[10] * mtx[10])
  const zmax =
    Math.max(Math.max(Math.abs(mtx[8]), Math.abs(mtx[9])), Math.abs(mtx[10])) /
    dztmp
  const fig_merit = Math.min(Math.min(xmax, ymax), zmax)
  let oblique_angle = Math.abs((Math.acos(fig_merit) * 180.0) / Math.PI)
  if (oblique_angle > 0.01) {
    log.warn(
      "Voxels not aligned with world space:",
      oblique_angle,
      "degrees from plumb.",
    )
  } else {
    oblique_angle = 0.0
  }
  return oblique_angle
}

export function mm2vox(
  nvImage: NVImage,
  mm: ArrayLike<number>,
  frac = false,
): vec3 | Float32Array {
  if (!nvImage.matRAS) {
    throw new Error("matRAS undefined")
  }
  const sform = mat4.clone(nvImage.matRAS)
  const out = mat4.clone(sform)
  mat4.transpose(out, sform)
  mat4.invert(out, out)
  const pos = vec4.fromValues(mm[0], mm[1], mm[2], 1)
  vec4.transformMat4(pos, pos, out)
  const pos3 = vec3.fromValues(pos[0], pos[1], pos[2])
  if (frac) {
    return pos3
  }
  return new Float32Array([
    Math.round(pos3[0]),
    Math.round(pos3[1]),
    Math.round(pos3[2]),
  ])
}
