// Shared mesh rendering utilities used by both WebGPU and WebGL2 backends.

import { vec3 } from 'gl-matrix'
import * as NVShapes from '@/mesh/NVShapes'
import type { NVMesh } from '@/NVTypes'

export function calculateExtents(positions: Float32Array): {
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

export function buildSolidColorArray(
  color: number,
  numVerts: number,
): Uint32Array {
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

/**
 * Blend multiple overlay RGBA8 textures into one using additive premultiplied color
 * and max alpha. The result is un-premultiplied so render/slice shaders work unchanged.
 * Each overlay's opacity is already baked into its alpha by the orient shader.
 */
export function blendOverlayData(
  overlays: Uint8Array[],
  dims: number[],
): Uint8Array {
  const nVoxels = dims[0] * dims[1] * dims[2]
  const accum = new Float32Array(nVoxels * 4)
  for (const data of overlays) {
    for (let i = 0; i < nVoxels; i++) {
      const j = i * 4
      const a = data[j + 3] / 255
      if (a <= 0) continue
      accum[j] += (data[j] / 255) * a
      accum[j + 1] += (data[j + 1] / 255) * a
      accum[j + 2] += (data[j + 2] / 255) * a
      accum[j + 3] = Math.max(accum[j + 3], a)
    }
  }
  const result = new Uint8Array(nVoxels * 4)
  for (let i = 0; i < nVoxels; i++) {
    const j = i * 4
    const maxA = accum[j + 3]
    if (maxA > 0) {
      result[j] = Math.min(Math.round((accum[j] / maxA) * 255), 255)
      result[j + 1] = Math.min(Math.round((accum[j + 1] / maxA) * 255), 255)
      result[j + 2] = Math.min(Math.round((accum[j + 2] / maxA) * 255), 255)
      result[j + 3] = Math.round(maxA * 255)
    }
  }
  return result
}
