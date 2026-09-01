import { mat3, mat4, vec3, vec4 } from 'gl-matrix'
import { log } from '@/logger'
import type {
  AffineMatrix,
  AffineTransform,
  NVGlobalCamera,
  NVImage,
} from '@/NVTypes'

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

export function copyAffine(affine: number[][]): AffineMatrix {
  validateAffine(affine)
  return affine.map((row) => [...row]) as AffineMatrix
}

export function arrayToMat4(arr: number[][]): mat4 {
  validateAffine(arr)
  return mat4.fromValues(
    arr[0][0],
    arr[1][0],
    arr[2][0],
    arr[3][0],
    arr[0][1],
    arr[1][1],
    arr[2][1],
    arr[3][1],
    arr[0][2],
    arr[1][2],
    arr[2][2],
    arr[3][2],
    arr[0][3],
    arr[1][3],
    arr[2][3],
    arr[3][3],
  )
}

export function mat4ToArray(m: mat4): AffineMatrix {
  return [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ]
}

export function createAffineTransformMatrix(transform: AffineTransform): mat4 {
  const out = mat4.create()
  mat4.translate(out, out, transform.translation)
  mat4.rotateX(out, out, deg2rad(transform.rotation[0]))
  mat4.rotateY(out, out, deg2rad(transform.rotation[1]))
  mat4.rotateZ(out, out, deg2rad(transform.rotation[2]))
  mat4.scale(out, out, transform.scale)
  return out
}

export function multiplyAffine(
  original: number[][],
  transform: mat4,
): AffineMatrix {
  const originalMat = arrayToMat4(original)
  const result = mat4.create()
  mat4.multiply(result, transform, originalMat)
  return mat4ToArray(result)
}

export function validateAffine(affine: number[][]): void {
  if (!Array.isArray(affine) || affine.length !== 4) {
    throw new Error('Affine matrix must have 4 rows')
  }
  for (const row of affine) {
    if (!Array.isArray(row) || row.length !== 4) {
      throw new Error('Affine matrix rows must each have 4 columns')
    }
    for (const value of row) {
      if (!Number.isFinite(value)) {
        throw new Error('Affine matrix values must be finite numbers')
      }
    }
  }
}

/** Coarsest 2D zoom the wheel will reach, and the step it snaps to. */
export const ZOOM_2D_MIN = 0.1
export const ZOOM_2D_MAX = 10
const ZOOM_2D_SNAP = 0.1

/**
 * One wheel notch of 2D zoom: 10% of the current zoom, snapped to a tenth and
 * clamped to `[ZOOM_2D_MIN, ZOOM_2D_MAX]`.
 *
 * The snap is what makes the zoom land on readable values, but on its own it
 * also swallows the whole low end: 10% of 0.5 is 0.05, which rounds straight
 * back to 0.5, and every zoom below that is fixed in BOTH directions -- 0.2
 * moves to neither 0.18 nor 0.22. So the wheel could never take the view below
 * half size and could never leave a smaller zoom set from code, even though the
 * range says 0.1. When the snap does not move the zoom by at least half a step,
 * take one whole snap increment instead; the multiplicative feel is untouched
 * everywhere the proportional step is already larger than that.
 *
 * The stall test uses a tolerance, not `===`: the caller keeps the zoom in a
 * `vec4` and 0.4 comes back as 0.40000000596, which `===` reads as "moved".
 */
export function stepZoom2D(zoom: number, direction: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return ZOOM_2D_MIN
  const dir = Math.sign(direction)
  if (dir === 0) return zoom
  let next = Math.round(zoom * (1 + 0.1 * dir) * 10) / 10
  if (Math.abs(next - zoom) < ZOOM_2D_SNAP / 2) {
    next = Math.round((zoom + ZOOM_2D_SNAP * dir) * 10) / 10
  }
  return Math.max(ZOOM_2D_MIN, Math.min(ZOOM_2D_MAX, next))
}

/**
 * New 2D pan that holds `anchorMM` at the same place on screen while the zoom
 * changes from `pan[3]` to `newZoom`.
 *
 * It lives next to {@link calculateMvpMatrix2D} because it is that function's
 * inverse and is only correct against its convention: the ortho window is the
 * volume's mm extents scaled about their CENTRE by `1/zoom`, then shifted by
 * `-pan`. So the window is centred on `c - pan` with half-width `HW0 / zoom`,
 * and a world point `m` sits at the normalized offset
 *
 *   s = (m - c + pan) * zoom / HW0
 *
 * Holding `s` across a zoom step is therefore a RATIO in the zooms, not a
 * difference, and it is measured from the extent centre rather than from the
 * world origin:
 *
 *   pan' = (zoom / newZoom) * (d + pan) - d,   d = anchorMM - c
 *
 * Getting either half wrong still looks like zoom-about-a-point at zoom 1 and
 * drifts further off the deeper the view is zoomed, which is why this is stated
 * once here and pinned by a test rather than open-coded at the call site.
 *
 * Radiological orientation needs no special case: it negates `s` on the U axis,
 * and holding `-s` fixed is the same condition as holding `s` fixed.
 *
 * @param pan - current `[panX, panY, panZ, zoom]`
 * @param newZoom - the zoom being applied (must be positive and finite)
 * @param anchorMM - world-mm point to keep put (typically the crosshair)
 * @param extentsMin - world-mm minimum of the scene extents
 * @param extentsMax - world-mm maximum of the scene extents
 * @returns the new `[panX, panY, panZ]`; unchanged when the zoom does not move
 */
export function zoomPan2DAbout(
  pan: ArrayLike<number>,
  newZoom: number,
  anchorMM: ArrayLike<number>,
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
): [number, number, number] {
  const current = pan[3] ?? 1
  const out: [number, number, number] = [pan[0], pan[1], pan[2]]
  if (!Number.isFinite(newZoom) || newZoom <= 0 || !Number.isFinite(current)) {
    return out
  }
  const ratio = current / newZoom
  for (let i = 0; i < 3; i++) {
    // A degenerate axis (no volume, or a single slice) has no centre to speak
    // of; d falls out to 0 and the pan simply rescales, which is the right
    // no-op rather than a NaN.
    const centre = (extentsMin[i] + extentsMax[i]) / 2
    const d = anchorMM[i] - centre
    const next = ratio * (d + pan[i]) - d
    out[i] = Number.isFinite(next) ? next : pan[i]
  }
  return out
}

/**
 * New 2D pan that moves just enough to bring `crosshairMM` inside the ortho
 * window on every world axis, or the unchanged pan when it is already inside.
 *
 * This is the spatial analogue of the signal graph's
 * `NVModel.panViewWindowTo`: the window follows a marker that moved on its own
 * (keyboard step, API call, linked instance), while explicit pan and zoom are
 * still free to leave it off-window. Like that precedent it pans MINIMALLY —
 * the crosshair lands exactly on the window edge it crossed rather than being
 * recentred, so a slow crosshair walk scrolls the view instead of jumping it.
 *
 * The convention is {@link calculateMvpMatrix2D}'s (see {@link zoomPan2DAbout}
 * for the derivation): on each axis the window is centred on `c - pan` with
 * half-width `HW0 / zoom`, so `m` is visible iff `|m - c + pan| <= HW0/zoom`.
 * Radiological orientation only negates the normalized U offset, which leaves
 * that bound unchanged, so it needs no special case.
 *
 * At `zoom <= 1` the pan is returned untouched: the window already shows the
 * whole extent (or more), so there is no "outside" to follow the crosshair
 * into, and the default un-zoomed behaviour must stay byte-identical. A
 * degenerate axis (no volume, or a single slice) has zero half-width and is
 * likewise skipped rather than producing NaN.
 *
 * @param pan - current `[panX, panY, panZ, zoom]`
 * @param crosshairMM - world-mm point to keep visible (the crosshair)
 * @param extentsMin - world-mm minimum of the scene extents
 * @param extentsMax - world-mm maximum of the scene extents
 * @returns the new `[panX, panY, panZ]`; unchanged entries are copied as-is
 */
export function panFollowCrosshair2D(
  pan: ArrayLike<number>,
  crosshairMM: ArrayLike<number>,
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
): [number, number, number] {
  const out: [number, number, number] = [pan[0], pan[1], pan[2]]
  const zoom = pan[3] ?? 1
  if (!Number.isFinite(zoom) || zoom <= 1) return out
  for (let i = 0; i < 3; i++) {
    const halfWidth = (extentsMax[i] - extentsMin[i]) / (2 * zoom)
    if (!Number.isFinite(halfWidth) || halfWidth <= 0) continue
    const centre = (extentsMin[i] + extentsMax[i]) / 2
    const offset = crosshairMM[i] - (centre - pan[i])
    if (!Number.isFinite(offset)) continue
    if (offset > halfWidth) out[i] = pan[i] - (offset - halfWidth)
    else if (offset < -halfWidth) out[i] = pan[i] - (offset + halfWidth)
  }
  return out
}

/**
 * Millimetres of world space covered by one canvas pixel on a 2D slice tile.
 *
 * The inverse of the scale {@link calculateMvpMatrix2D} sets up: that function
 * maps the `mn[0]..mx[0]` span (divided by the 2D zoom) across the tile's full
 * pixel width, so the ratio below is the tile's uniform mm-per-pixel. It is the
 * same in both axes because the layout already gives the tile the aspect ratio
 * of its mm extents. Radiological convention only mirrors the U axis, so it
 * leaves the scale alone.
 *
 * Use it to size screen-weight chrome (crosshair thickness, marker radii) that
 * has to be expressed as world geometry.
 *
 * @param mn - world-mm minimum of the tile's ortho window
 * @param mx - world-mm maximum of the tile's ortho window
 * @param leftTopWidthHeight - the tile's canvas rectangle
 * @param pan - the tile's `[panU, panV, zoom]`, as {@link slicePanUV} returns
 * @returns mm per canvas pixel, or 0 for a degenerate tile
 */
export function mmPerPixel2D(
  mn: ArrayLike<number>,
  mx: ArrayLike<number>,
  leftTopWidthHeight: ArrayLike<number>,
  pan?: ArrayLike<number>,
): number {
  const widthPx = leftTopWidthHeight[2]
  if (!(widthPx > 0)) return 0
  const zoom = pan && pan.length > 2 ? pan[2] : 1
  const span = Math.abs(mx[0] - mn[0]) / (zoom > 0 ? zoom : 1)
  return span / widthPx
}

/**
 * Millimetres of world space covered by one canvas pixel on the 3D render tile.
 *
 * {@link calculateMvpMatrix} projects orthographically, so this is a single
 * number rather than a depth-dependent one: the frustum's short side is
 * `2 * 0.8 * furthestFromPivot / volScaleMultiplier` and it is mapped onto the
 * tile's short side in pixels. Keep the two in step -- this reads the same
 * `baseScale` expression that builds the projection.
 *
 * @param leftTopWidthHeight - the tile's canvas rectangle
 * @param furthestFromPivot - scene radius, as passed to {@link calculateMvpMatrix}
 * @param volScaleMultiplier - the render zoom, likewise
 * @returns mm per canvas pixel, or 0 for a degenerate tile
 */
export function mmPerPixelRender(
  leftTopWidthHeight: ArrayLike<number>,
  furthestFromPivot: number,
  volScaleMultiplier: number,
): number {
  const shortSidePx = Math.min(leftTopWidthHeight[2], leftTopWidthHeight[3])
  if (!(shortSidePx > 0)) return 0
  const zoom = volScaleMultiplier > 0 ? volScaleMultiplier : 1
  const scale = (0.8 * furthestFromPivot) / zoom
  return (2 * scale) / shortSidePx
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
  renderPan?: ArrayLike<number>,
) {
  const mvpMatrix = mat4.create()
  const modelMatrix = mat4.create()
  const normalMatrix = mat4.create()
  const projectionMatrix = mat4.create()
  const whratio = ltwh[2] / ltwh[3]
  // True orthographic zoom: ONLY the frustum extent (left/right/top/bottom)
  // shrinks with the zoom, magnifying the image. The camera distance and the
  // near/far depth range stay tied to the UNZOOMED extent (`baseScale`), so the
  // camera never moves into the volume and the cube is never clipped in depth as
  // you zoom in. (Previously near/far/camera all scaled with `scale`, so a zoom
  // beyond ~1.4x pulled the orthographic camera inside the cube and the near
  // plane cut the front faces — holes in the render.) At volScaleMultiplier == 1
  // every value equals the old formula, so the default view is unchanged.
  const baseScale = 0.8 * furthestFromPivot
  const scale = baseScale / volScaleMultiplier
  const left = whratio < 1 ? -scale : -scale * whratio
  const right = whratio < 1 ? scale : scale * whratio
  const bottom = whratio < 1 ? -scale / whratio : -scale
  const top = whratio < 1 ? scale / whratio : scale
  const near = baseScale * 0.01
  const far = baseScale * 8.0
  mat4.orthoZO(projectionMatrix, left, right, bottom, top, near, far)
  if (renderPan && (renderPan[0] !== 0 || renderPan[1] !== 0)) {
    // Pre-multiply by a clip-space translation so the projected image slides
    // by (panX, panY) in NDC, independent of model rotation.
    const panMat = mat4.create()
    mat4.fromTranslation(panMat, [renderPan[0] ?? 0, renderPan[1] ?? 0, 0])
    mat4.multiply(projectionMatrix, panMat, projectionMatrix)
  }
  const translateVec3 = vec3.fromValues(0, 0, -baseScale * 1.8)
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

export function calculateGlobalVolumeMvp(
  ltwh: number[],
  camera: NVGlobalCamera | undefined,
  position: ArrayLike<number>,
  scale: number | ArrayLike<number> | undefined,
  orientation: ArrayLike<number> | undefined,
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
  obliqueRAS?: mat4,
  // WebGPU's NDC depth is [0,1] (orthoZO is used everywhere else for it); WebGL2
  // is [-1,1]. Pass true on the WebGPU backend so the perspective depth range
  // matches the device, otherwise the near portion clips at close cameras.
  clipSpaceZeroToOne = false,
): [mat4, mat4, mat4, vec3] {
  const aspect = Math.max(0.01, ltwh[2] / Math.max(1, ltwh[3]))
  const fov = camera?.fov ?? 55
  const near = camera?.near ?? 0.1
  const far = camera?.far ?? 900
  const projectionMatrix = mat4.create()
  if (clipSpaceZeroToOne) {
    mat4.perspectiveZO(projectionMatrix, deg2rad(fov), aspect, near, far)
  } else {
    mat4.perspective(projectionMatrix, deg2rad(fov), aspect, near, far)
  }

  const eye = vec3.fromValues(
    camera?.position?.[0] ?? 0,
    camera?.position?.[1] ?? 0,
    camera?.position?.[2] ?? 32,
  )
  const yaw = camera?.yaw ?? 0
  const pitch = camera?.pitch ?? 0
  const cp = Math.cos(pitch)
  const forward = vec3.fromValues(
    Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  )
  const target = vec3.create()
  vec3.add(target, eye, forward)
  const viewMatrix = mat4.create()
  mat4.lookAt(viewMatrix, eye, target, vec3.fromValues(0, 1, 0))

  const center = vec3.fromValues(
    (extentsMin[0] + extentsMax[0]) / 2,
    (extentsMin[1] + extentsMax[1]) / 2,
    (extentsMin[2] + extentsMax[2]) / 2,
  )
  const diameter = Math.max(
    Math.abs(extentsMax[0] - extentsMin[0]),
    Math.abs(extentsMax[1] - extentsMin[1]),
    Math.abs(extentsMax[2] - extentsMin[2]),
    1,
  )
  const sx = typeof scale === 'number' ? scale : (scale?.[0] ?? 1)
  const sy = typeof scale === 'number' ? scale : (scale?.[1] ?? sx)
  const sz = typeof scale === 'number' ? scale : (scale?.[2] ?? sx)

  const modelWorld = mat4.create()
  mat4.translate(modelWorld, modelWorld, [
    position[0] ?? 0,
    position[1] ?? 0,
    position[2] ?? 0,
  ])
  if (orientation) {
    mat4.rotateX(modelWorld, modelWorld, orientation[0] ?? 0)
    mat4.rotateY(modelWorld, modelWorld, orientation[1] ?? 0)
    mat4.rotateZ(modelWorld, modelWorld, orientation[2] ?? 0)
  }
  mat4.scale(modelWorld, modelWorld, [
    sx / diameter,
    sy / diameter,
    sz / diameter,
  ])
  mat4.translate(modelWorld, modelWorld, [-center[0], -center[1], -center[2]])

  const modelMatrix = mat4.create()
  mat4.multiply(modelMatrix, viewMatrix, modelWorld)
  const normalMatrix = mat4.create()
  const iModelMatrix = mat4.create()
  mat4.invert(iModelMatrix, modelMatrix)
  mat4.transpose(normalMatrix, iModelMatrix)
  const mvpMatrix = mat4.create()
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

/** The part of a view ray that survives the volume box and the clip planes. */
interface ClippedRaySegment {
  o: number[]
  d: number[]
  tmin: number
  tmax: number
  /**
   * Cutaway mode only: the carved-out sub-segment the ray passes through
   * unseen. `skipMax <= skipMin` means nothing is carved.
   */
  skipMin: number
  skipMax: number
}

/**
 * Intersect the segment `near`→`far` with the axis-aligned mm box `[lo, hi]`,
 * then account for the clip planes. Returns the surviving `[tmin, tmax]`
 * sub-segment (and the ray origin/direction), or null if nothing survives.
 * Shared by `rayBoxEntryMM` and `rayMarchFirstVisibleMM`.
 *
 * Solid mode trims the segment to the kept side of every plane. Cutaway mode
 * carves that same region OUT instead (mirroring the render/depth-pick shaders,
 * which skip `sampleRange` rather than clamp to it), so the segment keeps the
 * full box range and reports the carved interval as `[skipMin, skipMax]`.
 */
function clipRaySegment(
  near: ArrayLike<number>,
  far: ArrayLike<number>,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
  clipPlanes?: ArrayLike<number>,
  isCutaway?: boolean,
): ClippedRaySegment | null {
  const o = [near[0], near[1], near[2]]
  const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]]
  let tmin = 0
  let tmax = 1
  for (let i = 0; i < 3; i++) {
    const loI = Math.min(lo[i], hi[i])
    const hiI = Math.max(lo[i], hi[i])
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < loI || o[i] > hiI) return null
    } else {
      let t1 = (loI - o[i]) / d[i]
      let t2 = (hiI - o[i]) / d[i]
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }
  // Intersect the in-box segment with the kept side of each clip plane. The plane
  // value g(t) = dot(n, f(t)-0.5) - a is affine in t (f = (mm-lo)/(hi-lo)), so a
  // single crossing splits kept (g>=0) from removed (g<0).
  const noSkip = { skipMin: 0, skipMax: -1 }
  if (!clipPlanes) return { o, d, tmin, tmax, ...noSkip }
  const cx = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const sz = [hi[0] - lo[0] || 1, hi[1] - lo[1] || 1, hi[2] - lo[2] || 1]
  const planeCount = Math.floor(clipPlanes.length / 4)
  let keptMin = tmin
  let keptMax = tmax
  let keptEmpty = false
  for (let p = 0; p < planeCount && !keptEmpty; p++) {
    const nx = clipPlanes[p * 4 + 0]
    const ny = clipPlanes[p * 4 + 1]
    const nz = clipPlanes[p * 4 + 2]
    const a = clipPlanes[p * 4 + 3]
    if (a > 1 || a < -1) continue // sentinel: no clip
    if (nx * nx + ny * ny + nz * nz < 1e-12) continue // degenerate normal
    const n = [nx, ny, nz]
    let g0 = -a
    let gd = 0
    for (let i = 0; i < 3; i++) {
      g0 += (n[i] * (o[i] - cx[i])) / sz[i]
      gd += (n[i] * d[i]) / sz[i]
    }
    if (Math.abs(gd) < 1e-12) {
      if (g0 < 0) keptEmpty = true // ray wholly on the removed side
    } else if (gd > 0) {
      keptMin = Math.max(keptMin, -g0 / gd) // kept for t >= crossing
    } else {
      keptMax = Math.min(keptMax, -g0 / gd) // kept for t <= crossing
    }
    if (keptMin > keptMax) keptEmpty = true
  }
  if (isCutaway) {
    // The kept region is what the cutaway carves away: skip it, keep the rest.
    if (keptEmpty) return { o, d, tmin, tmax, ...noSkip }
    return { o, d, tmin, tmax, skipMin: keptMin, skipMax: keptMax }
  }
  if (keptEmpty) return null
  return { o, d, tmin: keptMin, tmax: keptMax, ...noSkip }
}

/**
 * Entry point (mm) where the segment `near`→`far` first crosses the axis-aligned
 * mm box `[lo, hi]` while staying on the kept side of any active clip planes, or
 * null if it misses. `near`/`far` are typically two `unprojectScreen` points
 * (depth 0 and 1) bounding the view ray. Used to pick a chunked/multi-LOD
 * volume's near *visible* surface for the crosshair when the GPU depth-pick
 * cannot sample its (non-single) texture.
 *
 * `clipPlanes` is the flat scene clip-plane array ([nx,ny,nz,a] per plane, in the
 * volume's [0,1] cube where the kept side is `dot(n, f-0.5) - a >= 0`; the
 * sentinel `|a| > 1` means "no clip"). When a solid clip plane has carved away
 * the near box face, the entry advances to the clip surface (the visible cut)
 * instead of the clipped-away box face. In cutaway mode the carved slab is
 * skipped instead, so an entry inside it advances to where the ray leaves it.
 */
export function rayBoxEntryMM(
  near: ArrayLike<number>,
  far: ArrayLike<number>,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
  clipPlanes?: ArrayLike<number>,
  isCutaway?: boolean,
): [number, number, number] | null {
  const seg = clipRaySegment(near, far, lo, hi, clipPlanes, isCutaway)
  if (!seg) return null
  const { o, d, tmax, skipMin, skipMax } = seg
  let t = seg.tmin
  if (skipMax > skipMin && t >= skipMin && t <= skipMax) {
    t = skipMax // entry is inside the cutaway: land where the ray leaves it
    if (t >= tmax - 1e-9) return null // nothing left: the cutaway took it all
  }
  return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
}

/**
 * March the kept (in-box, un-clipped) part of the view ray and return the mm of
 * the first sample whose `sampler(x,y,z)` is positive — the first *visible*
 * voxel given the current window (the app's sampler returns 0 for transparent /
 * below-threshold values). Returns null if the ray misses or no visible voxel is
 * crossed. `steps` bounds the march cost (the segment is short — one volume
 * crossing). See `rayBoxEntryMM` for the clip-plane convention.
 */
export function rayMarchFirstVisibleMM(
  near: ArrayLike<number>,
  far: ArrayLike<number>,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
  sampler: (x: number, y: number, z: number) => number,
  clipPlanes?: ArrayLike<number>,
  isCutaway?: boolean,
  steps = 512,
): [number, number, number] | null {
  const seg = clipRaySegment(near, far, lo, hi, clipPlanes, isCutaway)
  if (!seg) return null
  const { o, d, tmin, tmax, skipMin, skipMax } = seg
  const n = Math.max(1, Math.floor(steps))
  for (let s = 0; s <= n; s++) {
    const t = tmin + ((tmax - tmin) * s) / n
    // Cutaway: the carved slab is not on screen, so it must not be pickable.
    if (skipMax > skipMin && t >= skipMin && t <= skipMax) continue
    const x = o[0] + d[0] * t
    const y = o[1] + d[1] * t
    const z = o[2] + d[2] * t
    if (sampler(x, y, z) > 0) return [x, y, z]
  }
  return null
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
  if (typeof d === 'undefined') {
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
    throw new Error('Missing moving image mm corner coordinates')
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
    throw new Error('matRAS not defined')
  }
  if (nvImage.pixDimsRAS === undefined) {
    throw new Error('pixDimsRAS not defined')
  }
  if (!nvImage.dimsRAS) {
    throw new Error('dimsRAS not defined')
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
      'Voxels are rhomboidal, maximum shear is',
      nvImage.maxShearDeg,
      'degrees.',
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
    throw new Error('hdr not set')
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
      'Voxels not aligned with world space:',
      oblique_angle,
      'degrees from plumb.',
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
    throw new Error('matRAS undefined')
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
