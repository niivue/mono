import { vec3 } from 'gl-matrix'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import { generateNormals } from '@/mesh/normals'
import { BYTES_PER_VERTEX } from '@/mesh/vertexFormat'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import {
  applyCrosshairOffset,
  crosshairExplodeOffsetForModel,
} from '@/view/crosshairExplode'

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
 * Distinct crosshair geometries a single frame can hold on the GPU.
 *
 * The crosshair is one set of cylinders reused by every tile, but its radius
 * depends on the tile's scale and, for an oblique volume, its arms on the
 * tile's slice plane. WebGPU cannot rewrite one buffer between draws inside a
 * frame (queue writes all land before the submit), so it keeps this many slots
 * in a single buffer, gives each distinct geometry its own slot and lets tiles
 * with identical geometry share one. A frame needing more distinct geometries
 * than this reuses the last slot.
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
  const numVerts = positions.length / 3

  const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX)
  const f32 = new Float32Array(vertexData)
  const u32 = new Uint32Array(vertexData)

  for (let i = 0; i < numVerts; i++) {
    const offset = (i * BYTES_PER_VERTEX) / 4
    f32[offset] = positions[i * 3]
    f32[offset + 1] = positions[i * 3 + 1]
    f32[offset + 2] = positions[i * 3 + 2]
    f32[offset + 3] = normals[i * 3]
    f32[offset + 4] = normals[i * 3 + 1]
    f32[offset + 5] = normals[i * 3 + 2]
    u32[offset + 6] = colorPacked
  }

  return vertexData
}

export function calculateCrosshairSegments(
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
  crosshairPos: ArrayLike<number>,
  gap: number,
): [vec3, vec3][] {
  const center = vec3.create()
  for (let i = 0; i < 3; i++) {
    center[i] =
      extentsMin[i] + crosshairPos[i] * (extentsMax[i] - extentsMin[i])
  }
  const halfGap = gap / 2
  return [
    // X axis
    [
      vec3.fromValues(extentsMin[0], center[1], center[2]),
      vec3.fromValues(center[0] - halfGap, center[1], center[2]),
    ],
    [
      vec3.fromValues(center[0] + halfGap, center[1], center[2]),
      vec3.fromValues(extentsMax[0], center[1], center[2]),
    ],
    // Y axis
    [
      vec3.fromValues(center[0], extentsMin[1], center[2]),
      vec3.fromValues(center[0], center[1] - halfGap, center[2]),
    ],
    [
      vec3.fromValues(center[0], center[1] + halfGap, center[2]),
      vec3.fromValues(center[0], extentsMax[1], center[2]),
    ],
    // Z axis
    [
      vec3.fromValues(center[0], center[1], extentsMin[2]),
      vec3.fromValues(center[0], center[1], center[2] - halfGap),
    ],
    [
      vec3.fromValues(center[0], center[1], center[2] + halfGap),
      vec3.fromValues(center[0], center[1], extentsMax[2]),
    ],
  ]
}

/**
 * Move the in-plane arms of a 2D tile onto the slice it displays.
 *
 * A 2D slice is drawn on the background volume's own voxel plane, which for an
 * oblique volume is tilted against the world axes the arms follow. Left
 * there, each arm leaves the slice in depth and the depth test hides part of
 * it. Shifting every endpoint along the viewing axis keeps the arm where it
 * was on screen and puts it in the slice, as for an axis-aligned volume.
 * Arms along the viewing axis are returned unchanged, as are all arms without
 * a plane or when the plane is untilted or edge-on to the view.
 */
export function fitSegmentsToSlice(
  segments: [vec3, vec3][],
  plane: { normal: ArrayLike<number>; point: ArrayLike<number> } | null,
  sliceType: number,
): [vec3, vec3][] {
  if (!plane) return segments
  const { normal, point } = plane
  const dim = NVConstants.sliceTypeDim(sliceType)
  // Untilted (the plane already holds the world-axis arms) or edge-on: keep the
  // arms, bit for bit, so tiles of an axis-aligned volume share one geometry.
  const isTilted = [0, 1, 2].some(
    (j) => j !== dim && Math.abs(normal[j]) > 1e-6,
  )
  if (!isTilted || Math.abs(normal[dim]) < 1e-6) return segments
  const onSlice = (p: vec3): vec3 => {
    const out = vec3.clone(p)
    let offset = 0
    for (let j = 0; j < 3; j++) {
      if (j !== dim) offset += normal[j] * (p[j] - point[j])
    }
    out[dim] = point[dim] - offset / normal[dim]
    return out
  }
  return segments.map((seg, i) =>
    Math.floor(i / 2) === dim ? seg : [onSlice(seg[0]), onSlice(seg[1])],
  )
}

function isSlice2D(sliceType: number): boolean {
  return (
    sliceType === NVConstants.SLICE_TYPE.AXIAL ||
    sliceType === NVConstants.SLICE_TYPE.CORONAL ||
    sliceType === NVConstants.SLICE_TYPE.SAGITTAL
  )
}

/**
 * The six arm segments a tile of `sliceType` draws: on the tile's slice plane
 * for a 2D tile (the plane the slice shader and picking use), and shifted
 * onto the displaced block of an exploded chunked volume.
 */
export function crosshairSegmentsForTile(
  model: NVModel,
  sliceType: number,
): [vec3, vec3][] {
  const { extentsMin, extentsMax, scene, ui } = model
  let segments = calculateCrosshairSegments(
    extentsMin,
    extentsMax,
    scene.crosshairPos,
    ui.crosshairGap,
  )
  if (model.tex2mm && isSlice2D(sliceType)) {
    const plane = NVTransforms.slicePlaneEquation(
      model.tex2mm,
      sliceType,
      model.getSliceTexFrac(NVConstants.sliceTypeDim(sliceType)),
    )
    segments = fitSegmentsToSlice(segments, plane, sliceType)
  }
  const off = crosshairExplodeOffsetForModel(model)
  return segments.map(([start, end]) => [
    applyCrosshairOffset(start, off),
    applyCrosshairOffset(end, off),
  ])
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
