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
 */
export function generateNormals(
  pts: Float32Array,
  tris: Uint32Array,
): Float32Array {
  const norms = new Float32Array(pts.length)
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
