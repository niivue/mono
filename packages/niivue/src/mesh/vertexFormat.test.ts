import { describe, expect, test } from 'bun:test'
import type { NVMesh } from '@/NVTypes'
import { generateNormals, meshNormals } from './normals'
import { BYTES_PER_VERTEX, packMeshVertices } from './vertexFormat'

// Two triangles sharing an edge, bent along it so every normal is distinct.
function bentQuad(): NVMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    colors: new Uint32Array([1, 2, 3, 4]),
  } as unknown as NVMesh
}

function packedNormals(buffer: ArrayBuffer): Float32Array {
  const f32 = new Float32Array(buffer)
  const stride = BYTES_PER_VERTEX / 4
  const n = f32.length / stride
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = f32[i * stride + 3]
    out[i * 3 + 1] = f32[i * stride + 4]
    out[i * 3 + 2] = f32[i * stride + 5]
  }
  return out
}

describe('packMeshVertices', () => {
  test('packs normals from the per-mesh cache', () => {
    const mesh = bentQuad()
    const original = generateNormals(mesh.positions, mesh.indices)
    const first = packMeshVertices(mesh)
    const cached = meshNormals(mesh)
    expect(Array.from(packedNormals(first))).toEqual(Array.from(original))
    // Repacking the same geometry reuses the cached normals array.
    packMeshVertices(mesh)
    expect(meshNormals(mesh)).toBe(cached)
    // An in-place edit without a version bump still packs the cached
    // normals, which proves packing reads the cache.
    mesh.positions[11] = -2
    const stale = packMeshVertices(mesh)
    expect(Array.from(packedNormals(stale))).toEqual(Array.from(original))
    expect(new Float32Array(stale)[3 * (BYTES_PER_VERTEX / 4) + 2]).toBe(-2)
    // Bumping the version (as updateMeshPositions does) refreshes them in
    // the same array.
    mesh._positionsVersion = 1
    const fresh = packMeshVertices(mesh, stale)
    expect(fresh).toBe(stale)
    expect(meshNormals(mesh)).toBe(cached)
    expect(Array.from(packedNormals(fresh))).toEqual(
      Array.from(generateNormals(mesh.positions, mesh.indices)),
    )
    expect(Array.from(packedNormals(fresh))).not.toEqual(Array.from(original))
  })
})
