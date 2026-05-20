/**
 * View-visibility math for tiled volumes — the CPU side of Phase 3c chunk
 * streaming. Given a chunked volume's `ChunkPlan` and the current views, it
 * computes the *working set*: the chunk indices the renderer needs resident
 * this frame. The streaming manager uploads working-set chunks and evicts
 * the rest.
 *
 * Backend-agnostic and GPU-free. Both the WebGPU and WebGL2 renderers call
 * one implementation so frustum/slice culling stays identical (parity rule).
 * The 2D slice case is `chunksCrossingSlice` in `chunking.ts`; this module
 * adds the 3D frustum cull and a small union helper.
 */

import type { ChunkPlan } from './chunking'

/**
 * Conservative view-frustum cull for a chunked volume's 3D render tile.
 *
 * Returns the indices of chunks whose data sub-region may be visible under
 * `mvp` — the model-view-projection matrix that maps the full-volume [0,1]
 * cube to clip space (the same matrix the chunked cube draw uses). Each
 * chunk's 8 sub-AABB corners are transformed to clip space; a chunk is
 * culled only when all 8 corners fall outside one frustum plane. This admits
 * false positives (a chunk straddling a frustum edge diagonally can survive)
 * but never false negatives, so the result is always a safe superset of the
 * truly-visible chunks — correct for a streaming working set, where dropping
 * a visible chunk would punch a hole but keeping an extra one only costs
 * budget.
 *
 * `mvp` is column-major (gl-matrix convention), matching both renderers.
 * `clipSpaceZeroToOne` selects the near-plane depth convention: `true` for
 * WebGPU ([0,w] depth), `false` for WebGL2 ([-w,w] depth).
 */
export function chunksInFrustum(
  plan: ChunkPlan,
  mvp: Float32Array | number[],
  clipSpaceZeroToOne: boolean,
): number[] {
  const [vx, vy, vz] = plan.volumeDims
  const nearLimit = clipSpaceZeroToOne ? 0 : -1
  const out: number[] = []
  for (let ci = 0; ci < plan.chunks.length; ci++) {
    const desc = plan.chunks[ci]
    const x0 = desc.voxelOrigin[0] / vx
    const y0 = desc.voxelOrigin[1] / vy
    const z0 = desc.voxelOrigin[2] / vz
    const x1 = (desc.voxelOrigin[0] + desc.voxelDims[0]) / vx
    const y1 = (desc.voxelOrigin[1] + desc.voxelDims[1]) / vy
    const z1 = (desc.voxelOrigin[2] + desc.voxelDims[2]) / vz
    // "All 8 corners outside" accumulators, one per frustum plane. A plane
    // culls the chunk only if its flag survives all 8 corners as true.
    let outL = true
    let outR = true
    let outB = true
    let outT = true
    let outN = true
    let outF = true
    // A corner at or behind the camera (w <= 0) makes clip-space plane tests
    // unreliable; treat the whole chunk as visible rather than risk a hole.
    let nearCamera = false
    for (let c = 0; c < 8 && !nearCamera; c++) {
      const px = c & 1 ? x1 : x0
      const py = c & 2 ? y1 : y0
      const pz = c & 4 ? z1 : z0
      const cx = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12]
      const cy = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13]
      const cz = mvp[2] * px + mvp[6] * py + mvp[10] * pz + mvp[14]
      const cw = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15]
      if (cw <= 1e-6) {
        nearCamera = true
        break
      }
      if (cx >= -cw) outL = false
      if (cx <= cw) outR = false
      if (cy >= -cw) outB = false
      if (cy <= cw) outT = false
      if (cz >= nearLimit * cw) outN = false
      if (cz <= cw) outF = false
    }
    if (nearCamera || !(outL || outR || outB || outT || outN || outF)) {
      out.push(ci)
    }
  }
  return out
}

/**
 * Union of several per-tile chunk-index lists into one deduplicated,
 * ascending working set. The renderer collects one list per layout tile
 * (frustum cull for 3D tiles, `chunksCrossingSlice` for 2D tiles) and folds
 * them together here.
 */
export function unionChunkSets(sets: readonly number[][]): number[] {
  const seen = new Set<number>()
  for (const set of sets) {
    for (const i of set) seen.add(i)
  }
  return [...seen].sort((a, b) => a - b)
}
