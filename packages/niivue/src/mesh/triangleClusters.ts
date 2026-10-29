// Spatial triangle clusters for crosscut2: triangles are reordered along a
// Morton (Z-order) curve of their centroids and grouped CLUSTER_SIZE at a
// time, so each group is spatially compact and one bounding box per group
// lets a cut plane skip almost all of the mesh. Only triangle order changes;
// every triangle keeps its three vertex indices, so vertex-indexed data is
// unaffected. The input order does not matter (FreeSurfer's, for one, is not
// spatially coherent).

import type { NVMesh } from '@/NVTypes'

// 64 balances GPU and CPU work: on a pial surface a plane crosses ~11% of
// 64-triangle clusters (21% at 256, 7% at 32), and the per-frame bounds test
// is linear in the cluster count.
export const CLUSTER_SIZE = 64
/** Cluster entries pack the plane (0-2) above the cluster index. */
export const PLANE_SHIFT = 30

export type TriangleClusters = {
  /** Triangle numbers of the mesh's `indices`, in cluster order. */
  order: Uint32Array
  /** Per cluster: minX, minY, minZ, maxX, maxY, maxZ. */
  bounds: Float32Array
  clusterCount: number
  /** Scratch for `clustersCrossingPlanes` (room for three planes). */
  entries: Uint32Array<ArrayBuffer>
}

/**
 * The mesh's triangle indices in cluster order, for a one-off GPU upload,
 * padded to whole clusters with degenerate triangles (all three corners on
 * one vertex: it never crosses a plane), so shaders need no bounds check.
 */
export function sortedIndices(
  indices: ArrayLike<number>,
  order: Uint32Array,
): Uint32Array<ArrayBuffer> {
  const nTri = Math.ceil(order.length / CLUSTER_SIZE) * CLUSTER_SIZE
  const sorted = new Uint32Array(nTri * 3)
  for (let i = 0; i < order.length; i++) {
    const t = order[i] * 3
    sorted[i * 3] = indices[t]
    sorted[i * 3 + 1] = indices[t + 1]
    sorted[i * 3 + 2] = indices[t + 2]
  }
  if (order.length > 0)
    sorted.fill(sorted[order.length * 3 - 1], order.length * 3)
  return sorted
}

// Spread the low 10 bits of v so there are two zero bits between each.
function spread3(v: number): number {
  let x = v & 0x3ff
  x = (x | (x << 16)) & 0x030000ff
  x = (x | (x << 8)) & 0x0300f00f
  x = (x | (x << 4)) & 0x030c30c3
  x = (x | (x << 2)) & 0x09249249
  return x
}

/** Stable LSD radix sort of 30-bit keys; returns the sorted permutation. */
function sortByKey(keys: Uint32Array): Uint32Array {
  const n = keys.length
  let src = new Uint32Array(n)
  for (let i = 0; i < n; i++) src[i] = i
  let dst = new Uint32Array(n)
  const counts = new Uint32Array(1024)
  for (let shift = 0; shift < 30; shift += 10) {
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[(keys[i] >>> shift) & 1023]++
    let sum = 0
    for (let b = 0; b < 1024; b++) {
      const c = counts[b]
      counts[b] = sum
      sum += c
    }
    for (let i = 0; i < n; i++) {
      const t = src[i]
      dst[counts[(keys[t] >>> shift) & 1023]++] = t
    }
    ;[src, dst] = [dst, src]
  }
  return src
}

/** Recompute cluster bounds for the triangles of `indices` taken in `order`. */
function updateClusterBounds(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  order: Uint32Array,
  bounds: Float32Array,
): void {
  const nTri = order.length
  const nClusters = bounds.length / 6
  for (let c = 0; c < nClusters; c++) {
    let mnX = Infinity
    let mnY = Infinity
    let mnZ = Infinity
    let mxX = -Infinity
    let mxY = -Infinity
    let mxZ = -Infinity
    const end = Math.min(nTri, (c + 1) * CLUSTER_SIZE)
    for (let k = c * CLUSTER_SIZE * 3; k < end * 3; k++) {
      const v = indices[order[(k / 3) | 0] * 3 + (k % 3)] * 3
      const x = positions[v]
      const y = positions[v + 1]
      const z = positions[v + 2]
      if (x < mnX) mnX = x
      if (y < mnY) mnY = y
      if (z < mnZ) mnZ = z
      if (x > mxX) mxX = x
      if (y > mxY) mxY = y
      if (z > mxZ) mxZ = z
    }
    const b = c * 6
    bounds[b] = mnX
    bounds[b + 1] = mnY
    bounds[b + 2] = mnZ
    bounds[b + 3] = mxX
    bounds[b + 4] = mxY
    bounds[b + 5] = mxZ
  }
}

export function buildTriangleClusters(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): TriangleClusters {
  const nTri = Math.floor(indices.length / 3)
  const centroids = new Float32Array(nTri * 3)
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < nTri; t++) {
    for (let a = 0; a < 3; a++) {
      const c =
        (positions[indices[t * 3] * 3 + a] +
          positions[indices[t * 3 + 1] * 3 + a] +
          positions[indices[t * 3 + 2] * 3 + a]) /
        3
      centroids[t * 3 + a] = c
      if (c < mn[a]) mn[a] = c
      if (c > mx[a]) mx[a] = c
    }
  }
  const scale = mn.map((m, a) => (mx[a] > m ? 1023 / (mx[a] - m) : 0))
  const keys = new Uint32Array(nTri)
  for (let t = 0; t < nTri; t++) {
    keys[t] =
      spread3((centroids[t * 3] - mn[0]) * scale[0]) |
      (spread3((centroids[t * 3 + 1] - mn[1]) * scale[1]) << 1) |
      (spread3((centroids[t * 3 + 2] - mn[2]) * scale[2]) << 2)
  }
  const order = sortByKey(keys)
  const clusterCount = Math.ceil(nTri / CLUSTER_SIZE)
  const bounds = new Float32Array(clusterCount * 6)
  updateClusterBounds(positions, indices, order, bounds)
  return {
    order,
    bounds,
    clusterCount,
    entries: new Uint32Array(clusterCount * 3),
  }
}

type CacheEntry = {
  clusters: TriangleClusters
  indices: ArrayLike<number>
  positions: ArrayLike<number>
  positionsVersion: number
  dataVersion: number
  indicesHash: number
}
const _cache = new WeakMap<NVMesh, CacheEntry>()

// FNV-1a over the indices: tells an in-place index edit apart from the color
// edits that also bump `_dataVersion`, without keeping a copy of the indices.
function hashIndices(indices: ArrayLike<number>): number {
  let h = 0x811c9dc5
  for (let i = 0; i < indices.length; i++) {
    h = Math.imul(h ^ indices[i], 0x01000193)
  }
  return h >>> 0
}

/**
 * The mesh's clusters, built on first use. New `indices` or `positions`
 * arrays, or indices edited in place (`_dataVersion` with different
 * contents), rebuild them as a new object so GPU copies know to rewrite; an
 * in-place position edit (`_positionsVersion`) only refreshes the bounds.
 * Any other `_dataVersion` bump (a setMesh that re-uploads the vertices)
 * refreshes the bounds too, since it also uploads edited positions.
 */
export function meshClusters(mesh: NVMesh): TriangleClusters {
  const positionsVersion = mesh._positionsVersion ?? 0
  const dataVersion = mesh._dataVersion ?? 0
  const hit = _cache.get(mesh)
  if (hit && hit.indices === mesh.indices && hit.positions === mesh.positions) {
    let isCurrent = true
    let isMoved = hit.positionsVersion !== positionsVersion
    if (hit.dataVersion !== dataVersion) {
      hit.dataVersion = dataVersion
      isCurrent = hashIndices(mesh.indices) === hit.indicesHash
      isMoved = true
    }
    if (isCurrent) {
      if (isMoved) {
        updateClusterBounds(
          mesh.positions,
          mesh.indices,
          hit.clusters.order,
          hit.clusters.bounds,
        )
        hit.positionsVersion = positionsVersion
      }
      return hit.clusters
    }
  }
  const clusters = buildTriangleClusters(mesh.positions, mesh.indices)
  _cache.set(mesh, {
    clusters,
    indices: mesh.indices,
    positions: mesh.positions,
    positionsVersion,
    dataVersion,
    indicesHash: hashIndices(mesh.indices),
  })
  return clusters
}

/** Drop a mesh's cached clusters: `updateGLVolume` after an untracked in-place edit. */
export function clearMeshClusters(mesh: NVMesh): void {
  _cache.delete(mesh)
}

/**
 * The clusters each cut plane crosses, as `cluster | (plane << PLANE_SHIFT)`.
 * `planes` is the crosscut2 uniform: columns 0-2 are `[nx, ny, nz, d]`,
 * element 15 the count. Returns a view of `clusters.entries`, valid until the
 * next call (GPU uploads copy it at once).
 */
export function clustersCrossingPlanes(
  clusters: TriangleClusters,
  planes: Float32Array,
): Uint32Array<ArrayBuffer> {
  const { bounds, clusterCount, entries } = clusters
  let count = 0
  for (let p = 0; p < planes[15]; p++) {
    const nx = planes[p * 4]
    const ny = planes[p * 4 + 1]
    const nz = planes[p * 4 + 2]
    const d = planes[p * 4 + 3]
    const ax = Math.abs(nx)
    const ay = Math.abs(ny)
    const az = Math.abs(nz)
    for (let c = 0; c < clusterCount; c++) {
      const b = c * 6
      const hx = 0.5 * (bounds[b + 3] - bounds[b])
      const hy = 0.5 * (bounds[b + 4] - bounds[b + 1])
      const hz = 0.5 * (bounds[b + 5] - bounds[b + 2])
      const s =
        nx * (bounds[b] + hx) +
        ny * (bounds[b + 1] + hy) +
        nz * (bounds[b + 2] + hz) -
        d
      if (Math.abs(s) <= ax * hx + ay * hy + az * hz) {
        entries[count++] = c | (p << PLANE_SHIFT)
      }
    }
  }
  return entries.subarray(0, count)
}
