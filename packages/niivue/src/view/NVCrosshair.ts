import { vec3 } from 'gl-matrix'
import * as NVShapes from '@/mesh/NVShapes'
import { generateNormals } from '@/mesh/normals'
import { packVertices } from '@/mesh/vertexFormat'
import * as NVConstants from '@/NVConstants'

const CYLINDER_SIDES = 20
const CYLINDER_ENDCAPS = true
export const VERTS_PER_CYLINDER =
  (CYLINDER_SIDES + 1) * 2 + 2 + (CYLINDER_SIDES + 1) * 2

// Pre-computed index buffer (same topology for all cylinders)
let cachedIndices: Uint32Array | null = null

export function getCylinderIndices(): Uint32Array {
  if (cachedIndices) return cachedIndices
  const dummy = NVShapes.createCylinder(
    [0, 0, 0],
    [1, 0, 0],
    1,
    [1, 1, 1, 1],
    CYLINDER_SIDES,
    CYLINDER_ENDCAPS,
  )
  cachedIndices = new Uint32Array(dummy.indices)
  return cachedIndices
}

/**
 * Distinct crosshair thicknesses a single frame can hold on the GPU.
 *
 * The crosshair is one set of cylinders reused by every tile, so a per-tile
 * radius needs a per-tile copy of the geometry. WebGPU cannot rewrite one
 * buffer between draws inside a frame (queue writes all land before the
 * submit), so it keeps this many slots in a single buffer and selects one per
 * draw. Ordinary layouts draw the crosshair on at most four tiles; a layout
 * with more than this many 2D tiles reuses the last slot, which is no worse
 * than the single shared radius this replaced.
 */
export const MAX_CROSSHAIR_TILES = 16

export function buildVertexData(
  start: vec3,
  end: vec3,
  radius: number,
  colorPacked: number,
): ArrayBuffer {
  const cylData = NVShapes.createCylinder(
    Array.from(start) as number[],
    Array.from(end) as number[],
    radius,
    [1, 1, 1, 1],
    CYLINDER_SIDES,
    CYLINDER_ENDCAPS,
  )
  const positions = new Float32Array(cylData.positions)
  const normals = generateNormals(positions, new Uint32Array(cylData.indices))
  return packVertices(positions, normals, colorPacked)
}

export function calculateCrosshairSegments(
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
  crosshairPos: ArrayLike<number>,
  gap: number,
): [vec3, vec3][] {
  const center = vec3.create()
  const lo = vec3.create()
  const hi = vec3.create()
  const halfGap = gap / 2
  for (let i = 0; i < 3; i++) {
    center[i] =
      extentsMin[i] + crosshairPos[i] * (extentsMax[i] - extentsMin[i])
    // A crosshair past the extents (on a slide plane reaching beyond them)
    // stretches its arms to reach it; no arm runs backward.
    lo[i] = Math.min(extentsMin[i], center[i] - halfGap)
    hi[i] = Math.max(extentsMax[i], center[i] + halfGap)
  }
  return [
    // X axis
    [
      vec3.fromValues(lo[0], center[1], center[2]),
      vec3.fromValues(center[0] - halfGap, center[1], center[2]),
    ],
    [
      vec3.fromValues(center[0] + halfGap, center[1], center[2]),
      vec3.fromValues(hi[0], center[1], center[2]),
    ],
    // Y axis
    [
      vec3.fromValues(center[0], lo[1], center[2]),
      vec3.fromValues(center[0], center[1] - halfGap, center[2]),
    ],
    [
      vec3.fromValues(center[0], center[1] + halfGap, center[2]),
      vec3.fromValues(center[0], hi[1], center[2]),
    ],
    // Z axis
    [
      vec3.fromValues(center[0], center[1], lo[2]),
      vec3.fromValues(center[0], center[1], center[2] - halfGap),
    ],
    [
      vec3.fromValues(center[0], center[1], center[2] + halfGap),
      vec3.fromValues(center[0], center[1], hi[2]),
    ],
  ]
}

export function shouldCullCylinder(cylIdx: number, sliceType: number): boolean {
  const axisIndex = Math.floor(cylIdx / 2)
  if (sliceType === NVConstants.SLICE_TYPE.AXIAL && axisIndex === 2) return true
  if (sliceType === NVConstants.SLICE_TYPE.CORONAL && axisIndex === 1)
    return true
  if (sliceType === NVConstants.SLICE_TYPE.SAGITTAL && axisIndex === 0)
    return true
  return false
}

/**
 * A 2D slice of an oblique volume tilts across the crosshair arms and hides the
 * parts behind it. Those parts are redrawn this faintly, as NiiVue 0.x did, so
 * each arm stays whole while the solid and faint halves still show the tilt.
 */
const HIDDEN_ARM_ALPHA = 0.15

/**
 * Opacity for redrawing the arms a 2D slice hides, or 0 for none. Only an
 * oblique base volume (`obliqueAngle` > 0) tilts its slices. Mesh x-ray already
 * redraws hidden arms after the meshes, so this applies only while it is off.
 */
export function hiddenArmAlpha(
  meshXRay: number,
  sliceType: number,
  obliqueAngle: number,
): number {
  if (meshXRay > 0 || obliqueAngle <= 0) return 0
  if (sliceType === NVConstants.SLICE_TYPE.RENDER) return 0
  return HIDDEN_ARM_ALPHA
}
