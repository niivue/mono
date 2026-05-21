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
 * Back-to-front draw order for a chunked 3D volume render.
 *
 * The fragment shader ray-marches each chunk cube independently and outputs a
 * premultiplied segment color. The framebuffer then reconstructs the full ray
 * by blending those segment colors, so chunks must be drawn farthest first in
 * the same ray-direction convention used by `calculateRayDirection`.
 *
 * Use each chunk's far AABB corner, not its center, so edge chunks with
 * nonuniform sizes sort according to the farthest possible segment endpoint.
 */
export function chunksBackToFront(
  plan: ChunkPlan,
  rayDir: ArrayLike<number>,
): number[] {
  const rx = finiteRayComponent(rayDir, 0)
  const ry = finiteRayComponent(rayDir, 1)
  const rz = finiteRayComponent(rayDir, 2)
  if (rx * rx + ry * ry + rz * rz <= 1e-12) {
    return plan.chunks.map((_, i) => i)
  }

  const [vx, vy, vz] = plan.volumeDims
  const depth = plan.chunks.map((c) => {
    const x =
      rx >= 0 ? (c.voxelOrigin[0] + c.voxelDims[0]) / vx : c.voxelOrigin[0] / vx
    const y =
      ry >= 0 ? (c.voxelOrigin[1] + c.voxelDims[1]) / vy : c.voxelOrigin[1] / vy
    const z =
      rz >= 0 ? (c.voxelOrigin[2] + c.voxelDims[2]) / vz : c.voxelOrigin[2] / vz
    return x * rx + y * ry + z * rz
  })

  return plan.chunks
    .map((_, i) => i)
    .sort((a, b) => depth[b] - depth[a] || a - b)
}

function finiteRayComponent(rayDir: ArrayLike<number>, axis: number): number {
  const value = rayDir[axis]
  return Number.isFinite(value) ? value : 0
}

/**
 * Conservative view-frustum cull for a chunked volume's 3D render tile.
 *
 * Returns the indices of chunks whose data sub-region may be visible under
 * `mvp`. When `matRAS` is supplied, chunk corners follow the same path as the
 * volume vertex shader: full-volume fraction -> voxel space -> matRAS -> MVP.
 * Without `matRAS`, this keeps the legacy/unit-test behavior where `mvp` maps
 * the full-volume [0,1] cube directly to clip space. Each chunk's 8 sub-AABB
 * corners are transformed to clip space; a chunk is culled only when all 8
 * corners fall outside one frustum plane. This admits false positives (a
 * chunk straddling a frustum edge diagonally can survive) but never false
 * negatives, so the result is always a safe superset of the truly-visible
 * chunks — correct for a streaming working set, where dropping a visible chunk
 * would punch a hole but keeping an extra one only costs budget.
 *
 * `mvp` is column-major (gl-matrix convention), matching both renderers.
 * `clipSpaceZeroToOne` selects the near-plane depth convention: `true` for
 * WebGPU ([0,w] depth), `false` for WebGL2 ([-w,w] depth).
 */
export function chunksInFrustum(
  plan: ChunkPlan,
  mvp: Float32Array | number[],
  clipSpaceZeroToOne: boolean,
  matRAS?: Float32Array | number[],
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
      const model = matRAS
        ? chunkCornerToModel(px, py, pz, vx, vy, vz, matRAS)
        : [px, py, pz, 1]
      const cx =
        mvp[0] * model[0] +
        mvp[4] * model[1] +
        mvp[8] * model[2] +
        mvp[12] * model[3]
      const cy =
        mvp[1] * model[0] +
        mvp[5] * model[1] +
        mvp[9] * model[2] +
        mvp[13] * model[3]
      const cz =
        mvp[2] * model[0] +
        mvp[6] * model[1] +
        mvp[10] * model[2] +
        mvp[14] * model[3]
      const cw =
        mvp[3] * model[0] +
        mvp[7] * model[1] +
        mvp[11] * model[2] +
        mvp[15] * model[3]
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

function chunkCornerToModel(
  xFrac: number,
  yFrac: number,
  zFrac: number,
  vx: number,
  vy: number,
  vz: number,
  matRAS: Float32Array | number[],
): [number, number, number, number] {
  const x = xFrac * vx - 0.5
  const y = yFrac * vy - 0.5
  const z = zFrac * vz - 0.5
  return [
    x * matRAS[0] + y * matRAS[1] + z * matRAS[2] + matRAS[3],
    x * matRAS[4] + y * matRAS[5] + z * matRAS[6] + matRAS[7],
    x * matRAS[8] + y * matRAS[9] + z * matRAS[10] + matRAS[11],
    x * matRAS[12] + y * matRAS[13] + z * matRAS[14] + matRAS[15],
  ]
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
