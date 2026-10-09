// Shared mesh rendering utilities used by both WebGPU and WebGL2 backends.

import { vec3 } from 'gl-matrix'
import * as NVMeshUtils from '@/mesh/NVMesh'
import * as NVShapes from '@/mesh/NVShapes'
import type { NVMesh } from '@/NVTypes'
import { BYTES_PER_VERTEX } from '@/view/NVCrosshair'

/**
 * Interleave a mesh's positions, generated normals and packed colors into the
 * vertex layout both backends draw (pos float32x3, normal float32x3, color
 * unorm8x4; BYTES_PER_VERTEX bytes per vertex).
 */
export function packMeshVertices(meshData: NVMesh): ArrayBuffer {
  const normals = NVMeshUtils.generateNormals(
    meshData.positions,
    meshData.indices,
  )
  const numVerts = meshData.positions.length / 3
  const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX)
  const f32 = new Float32Array(vertexData)
  const u32 = new Uint32Array(vertexData)
  for (let i = 0; i < numVerts; i++) {
    const offset = (i * BYTES_PER_VERTEX) / 4
    f32[offset] = meshData.positions[i * 3] ?? 0
    f32[offset + 1] = meshData.positions[i * 3 + 1] ?? 0
    f32[offset + 2] = meshData.positions[i * 3 + 2] ?? 0
    f32[offset + 3] = normals[i * 3] ?? 0
    f32[offset + 4] = normals[i * 3 + 1] ?? 0
    f32[offset + 5] = normals[i * 3 + 2] ?? 0
    u32[offset + 6] =
      meshData.colors instanceof Uint32Array
        ? meshData.colors[i]
        : meshData.colors
  }
  return vertexData
}

function calculateExtents(positions: Float32Array): {
  extentsMin: vec3
  extentsMax: vec3
} {
  const mn = vec3.fromValues(Infinity, Infinity, Infinity)
  const mx = vec3.fromValues(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    mn[0] = Math.min(mn[0], x)
    mn[1] = Math.min(mn[1], y)
    mn[2] = Math.min(mn[2], z)
    mx[0] = Math.max(mx[0], x)
    mx[1] = Math.max(mx[1], y)
    mx[2] = Math.max(mx[2], z)
  }
  return { extentsMin: mn, extentsMax: mx }
}

function buildSolidColorArray(color: number, numVerts: number): Uint32Array {
  const colors = new Uint32Array(numVerts)
  colors.fill(color)
  return colors
}

type ShapeMeshData = Omit<NVMesh, 'layers' | 'perVertexColors'>

export function buildSphereMeshData(
  origin: number[] = [1, 1, 1],
  radius = 1,
  color: number[] = [1, 1, 1, 1],
  subdivisions = 2,
): ShapeMeshData {
  const meshData = NVShapes.createSphere(origin, radius, color, subdivisions)
  const positions = new Float32Array(meshData.positions)
  const extents = calculateExtents(positions)
  return {
    positions,
    indices: new Uint32Array(meshData.indices),
    colors: buildSolidColorArray(meshData.rgba32, positions.length / 3),
    clipPlane: new Float32Array([0.0, 0.0, 0.0, 0.0]),
    extentsMin: extents.extentsMin,
    extentsMax: extents.extentsMax,
    opacity: 1.0,
    shaderType: 'phong',
    color: [color[0], color[1], color[2], color[3]] as [
      number,
      number,
      number,
      number,
    ],
    colorbarVisible: false,
  }
}

export function buildCylinderMeshData(
  start: number[],
  dest: number[],
  radius: number,
  color: number[] = [1, 1, 1, 1],
  sides = 20,
  endcaps = true,
): ShapeMeshData {
  const meshData = NVShapes.createCylinder(
    start,
    dest,
    radius,
    color,
    sides,
    endcaps,
  )
  const positions = new Float32Array(meshData.positions)
  const extents = calculateExtents(positions)
  return {
    positions,
    indices: new Uint32Array(meshData.indices),
    colors: buildSolidColorArray(meshData.rgba32, positions.length / 3),
    clipPlane: new Float32Array([0.0, 0.0, 0.0, 0.0]),
    extentsMin: extents.extentsMin,
    extentsMax: extents.extentsMax,
    opacity: 1.0,
    shaderType: 'phong',
    color: [color[0], color[1], color[2], color[3]] as [
      number,
      number,
      number,
      number,
    ],
    colorbarVisible: false,
  }
}
