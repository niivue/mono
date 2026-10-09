// The interleaved vertex layout every 3D shape (meshes, the crosshair
// cylinders, the orientation cube) is drawn with on both backends: position
// float32x3, normal float32x3, color unorm8x4.

import * as NVMeshUtils from '@/mesh/NVMesh'
import type { NVMesh } from '@/NVTypes'

/** position(12) + normal(12) + color(4) */
export const BYTES_PER_VERTEX = 28

/**
 * Interleave a mesh's positions, generated normals and packed colors into the
 * vertex layout both backends draw (BYTES_PER_VERTEX bytes per vertex). Writes
 * into `target` when it is exactly the right size (a reused staging buffer),
 * else allocates.
 */
export function packMeshVertices(
  meshData: NVMesh,
  target?: ArrayBuffer,
): ArrayBuffer {
  const normals = NVMeshUtils.generateNormals(
    meshData.positions,
    meshData.indices,
  )
  const numVerts = meshData.positions.length / 3
  const bytes = numVerts * BYTES_PER_VERTEX
  const vertexData =
    target && target.byteLength === bytes ? target : new ArrayBuffer(bytes)
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
