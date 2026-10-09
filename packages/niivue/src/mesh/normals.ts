import type { NVMesh } from '@/NVTypes'

/**
 * Per-vertex normals for an indexed triangle mesh: each vertex sums the
 * unnormalised (area-weighted) cross products of its triangles, then the sum
 * is negated and scaled to unit length. A vertex whose sum is zero (unused, or
 * only on degenerate triangles) keeps a zero normal.
 *
 * Runs over millions of triangles on every mesh upload, so it uses scalar
 * locals and no per-triangle allocation. The Float32Array accumulator and the
 * operation order are part of the result (they fix the float32 rounding), so
 * keep both when editing.
 *
 * Pass `out` (length `pts.length`) to write into an existing array instead of
 * allocating one; it is zero-filled first, so the result is the same.
 */
export function generateNormals(
  pts: Float32Array,
  tris: Uint32Array,
  out?: Float32Array,
): Float32Array {
  let norms: Float32Array
  if (out) {
    if (out.length !== pts.length) {
      throw new RangeError(
        `generateNormals: out has ${out.length} values, expected ${pts.length}`,
      )
    }
    norms = out.fill(0)
  } else {
    norms = new Float32Array(pts.length)
  }
  const nTriIdx = tris.length
  for (let i = 0; i < nTriIdx; i += 3) {
    const i1 = tris[i] * 3
    const i2 = tris[i + 1] * 3
    const i3 = tris[i + 2] * 3
    const x1 = pts[i1]
    const y1 = pts[i1 + 1]
    const z1 = pts[i1 + 2]
    const qx = pts[i2] - x1
    const qy = pts[i2 + 1] - y1
    const qz = pts[i2 + 2] - z1
    const px = pts[i3] - x1
    const py = pts[i3 + 1] - y1
    const pz = pts[i3 + 2] - z1
    const nx = py * qz - pz * qy
    const ny = pz * qx - px * qz
    const nz = px * qy - py * qx
    norms[i1] += nx
    norms[i1 + 1] += ny
    norms[i1 + 2] += nz
    norms[i2] += nx
    norms[i2 + 1] += ny
    norms[i2 + 2] += nz
    norms[i3] += nx
    norms[i3 + 1] += ny
    norms[i3 + 2] += nz
  }
  const nNormIdx = norms.length
  for (let i = 0; i < nNormIdx; i += 3) {
    const x = norms[i]
    const y = norms[i + 1]
    const z = norms[i + 2]
    const len = Math.sqrt(x * x + y * y + z * z)
    if (len > 0) {
      norms[i] = x / -len
      norms[i + 1] = y / -len
      norms[i + 2] = z / -len
    }
  }
  return norms
}

type NormalsCacheEntry = {
  positions: Float32Array
  indices: Uint32Array
  positionsVersion: number
  normals: Float32Array
}

// Keyed by the mesh object (not stored on it) so copies, serialisation and
// Object.assign never carry a stale entry along.
const _normalsCache = new WeakMap<NVMesh, NormalsCacheEntry>()

/**
 * The mesh's vertex normals, computed by {@link generateNormals} once per
 * geometry and reused by every later GPU upload (a shader, color or layer
 * change rebuilds the GPU resources but not the geometry).
 *
 * Contract: the cache is invalidated when `positions` or `indices` is
 * replaced with a new array (retessellation, re-extrusion) or when
 * `_positionsVersion` changes, which `updateMeshPositions` bumps. Editing
 * `positions` in place any other way leaves the cached normals in use.
 *
 * When only `_positionsVersion` changed (a live update), the cached array is
 * recomputed in place rather than reallocated, so per-frame updates do not
 * allocate. Callers must not modify or keep the returned array.
 */
export function meshNormals(mesh: NVMesh): Float32Array {
  const { positions, indices } = mesh
  const positionsVersion = mesh._positionsVersion ?? 0
  const cached = _normalsCache.get(mesh)
  if (cached && cached.positions === positions && cached.indices === indices) {
    if (cached.positionsVersion !== positionsVersion) {
      generateNormals(positions, indices, cached.normals)
      cached.positionsVersion = positionsVersion
    }
    return cached.normals
  }
  const normals = generateNormals(positions, indices)
  _normalsCache.set(mesh, { positions, indices, positionsVersion, normals })
  return normals
}
