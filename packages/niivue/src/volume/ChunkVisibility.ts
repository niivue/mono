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

import type { ChunkPlan, Vec3f } from './chunking'

type ChunkOffsetFor = (chunkIndex: number) => Vec3f

/**
 * Back-to-front draw order for a chunked 3D volume render.
 *
 * The fragment shader ray-marches each chunk cube independently and outputs a
 * premultiplied segment color. The framebuffer then reconstructs the full ray
 * by blending those segment colors, so chunks must be drawn farthest first in
 * the same ray-direction convention used by `calculateRayDirection`.
 *
 * Ordered with a SEPARATING-AXIS comparator: two non-overlapping AABBs that can
 * occlude each other (overlap in screen projection) are always separated along
 * some coordinate axis, and the box on the near side of the most view-aligned
 * separating axis is in front. This is correct for the MIXED brick sizes of a
 * multi-LOD plan; a single scalar key (far corner / centre) mis-orders a large
 * coarse brick against small fine ones at oblique view angles, which — because
 * the chunk draws use depthFunc ALWAYS and rely entirely on this order for
 * premultiplied-alpha compositing — shows up as washed-out, see-through bricks
 * at LOD seams. For equal-size grids it reproduces the previous order.
 */
export function chunksBackToFront(
  plan: ChunkPlan,
  rayDir: ArrayLike<number>,
  chunkOffsetFor?: ChunkOffsetFor,
  volScale?: ArrayLike<number>,
): number[] {
  const rx = finiteRayComponent(rayDir, 0)
  const ry = finiteRayComponent(rayDir, 1)
  const rz = finiteRayComponent(rayDir, 2)
  if (rx * rx + ry * ry + rz * rz <= 1e-12) {
    return plan.chunks.map((_, i) => i)
  }

  const [vx, vy, vz] = plan.volumeDims
  // Effective view-depth direction in the boxes' normalized object space (the
  // axis scale folds in here so a box's separation structure stays axis-aligned).
  const d: Vec3f = [
    finiteScaleComponent(volScale, 0) * rx,
    finiteScaleComponent(volScale, 1) * ry,
    finiteScaleComponent(volScale, 2) * rz,
  ]
  // Each chunk's AABB in normalized [0,1] object space (+ explode offset).
  const lo: Vec3f[] = []
  const hi: Vec3f[] = []
  for (let i = 0; i < plan.chunks.length; i++) {
    const c = plan.chunks[i]
    const o = chunkOffsetFor?.(i)
    const ox = o?.[0] ?? 0
    const oy = o?.[1] ?? 0
    const oz = o?.[2] ?? 0
    lo.push([
      c.voxelOrigin[0] / vx + ox,
      c.voxelOrigin[1] / vy + oy,
      c.voxelOrigin[2] / vz + oz,
    ])
    hi.push([
      (c.voxelOrigin[0] + c.voxelDims[0]) / vx + ox,
      (c.voxelOrigin[1] + c.voxelDims[1]) / vy + oy,
      (c.voxelOrigin[2] + c.voxelDims[2]) / vz + oz,
    ])
  }
  const EPS = 1e-9
  // Far AABB corner projected on d — the fallback key when two boxes are not
  // separated along a view-aligned axis (they overlap in projection and so do
  // not occlude one another; any consistent order is fine).
  const farKey = (i: number): number =>
    (d[0] >= 0 ? hi[i][0] : lo[i][0]) * d[0] +
    (d[1] >= 0 ? hi[i][1] : lo[i][1]) * d[1] +
    (d[2] >= 0 ? hi[i][2] : lo[i][2]) * d[2]
  const compare = (a: number, b: number): number => {
    let axis = -1
    let weight = -1
    for (let k = 0; k < 3; k++) {
      const separated = hi[a][k] <= lo[b][k] + EPS || hi[b][k] <= lo[a][k] + EPS
      const w = Math.abs(d[k])
      if (separated && w > weight) {
        weight = w
        axis = k
      }
    }
    if (axis >= 0 && weight > EPS) {
      const aLower = hi[a][axis] <= lo[b][axis] + EPS
      // The box on the +axis side is farther when d[axis] > 0.
      const aFarther = aLower ? d[axis] < 0 : d[axis] > 0
      return aFarther ? -1 : 1 // farther chunk drawn first (back)
    }
    return farKey(b) - farKey(a) || a - b
  }
  return plan.chunks.map((_, i) => i).sort(compare)
}

function finiteRayComponent(rayDir: ArrayLike<number>, axis: number): number {
  const value = rayDir[axis]
  return Number.isFinite(value) ? value : 0
}

function finiteScaleComponent(
  volScale: ArrayLike<number> | undefined,
  axis: number,
): number {
  const value = volScale?.[axis]
  return typeof value === 'number' && Number.isFinite(value) && value !== 0
    ? value
    : 1
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
  chunkOffsetFor?: ChunkOffsetFor,
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
    const offset = chunkOffsetFor?.(ci)
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
        ? chunkCornerToModel(
            px + (offset?.[0] ?? 0),
            py + (offset?.[1] ?? 0),
            pz + (offset?.[2] ?? 0),
            vx,
            vy,
            vz,
            matRAS,
          )
        : [
            px + (offset?.[0] ?? 0),
            py + (offset?.[1] ?? 0),
            pz + (offset?.[2] ?? 0),
            1,
          ]
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
 * Order a set of visible chunk indices center-first: nearest the centre of the
 * view (the NDC origin, where the frustum's central axis hits the screen) comes
 * first, then progressively outward. The streaming pump uploads in queue order,
 * so requesting in this order makes the centre of what you're looking at sharpen
 * first and the surrounding tiles spiral in afterwards.
 *
 * Each chunk's centre is projected through `matRAS` then `mvp` to clip space and
 * scored by its squared NDC distance from the origin. Chunks at/behind the
 * camera (w <= 0) sort last. Pure and order-stable for equal scores.
 */
export function orderByViewCenter(
  plan: ChunkPlan,
  indices: readonly number[],
  mvp: Float32Array | number[],
  matRAS?: Float32Array | number[],
  chunkOffsetFor?: ChunkOffsetFor,
): number[] {
  const [vx, vy, vz] = plan.volumeDims
  const score = new Map<number, number>()
  for (let k = 0; k < indices.length; k++) {
    const ci = indices[k]
    const desc = plan.chunks[ci]
    if (!desc) {
      score.set(ci, Number.POSITIVE_INFINITY)
      continue
    }
    const offset = chunkOffsetFor?.(ci)
    const cx =
      (desc.voxelOrigin[0] + desc.voxelDims[0] / 2) / vx + (offset?.[0] ?? 0)
    const cy =
      (desc.voxelOrigin[1] + desc.voxelDims[1] / 2) / vy + (offset?.[1] ?? 0)
    const cz =
      (desc.voxelOrigin[2] + desc.voxelDims[2] / 2) / vz + (offset?.[2] ?? 0)
    const model = matRAS
      ? chunkCornerToModel(cx, cy, cz, vx, vy, vz, matRAS)
      : [cx, cy, cz, 1]
    const cw =
      mvp[3] * model[0] +
      mvp[7] * model[1] +
      mvp[11] * model[2] +
      mvp[15] * model[3]
    if (cw <= 1e-6) {
      score.set(ci, Number.POSITIVE_INFINITY)
      continue
    }
    const ndcX =
      (mvp[0] * model[0] +
        mvp[4] * model[1] +
        mvp[8] * model[2] +
        mvp[12] * model[3]) /
      cw
    const ndcY =
      (mvp[1] * model[0] +
        mvp[5] * model[1] +
        mvp[9] * model[2] +
        mvp[13] * model[3]) /
      cw
    score.set(ci, ndcX * ndcX + ndcY * ndcY)
  }
  return [...indices].sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0))
}

/**
 * Drop chunks that a clip plane removes entirely from a 3D render, so the
 * streaming working set never fetches blocks the cutaway hides. This is the
 * clip-plane analogue of the frustum cull: the renderer already trims the
 * ray-march to the clip plane per sample (`clipSampleRange`), but without this
 * the hidden chunks still stream and stay resident.
 *
 * Convention pinned to the volume shader's `clipSampleRange`
 * (`gl/volumeShaderLib.ts`): each plane is `[nx, ny, nz, a]` in the volume's
 * texture-fraction space `[0,1]^3`, the **kept** (visible) half-space is
 * `dot(n, p - 0.5) - a >= 0`, and the removed/front side is `< 0`. The sentinel
 * `[0,0,0,2]` (a > 1) means "no clip". Multiple planes intersect (a sample is
 * visible only if every plane keeps it), so a chunk is removed when **any**
 * active plane has all 8 of its data-region AABB corners strictly on that
 * plane's removed side. Keeping a chunk whose box straddles a plane is a
 * conservative superset — false positives cost a little budget, a false
 * negative would punch a hole.
 *
 * `isCutaway` (scene.isClipPlaneCutaway) carves an interior slab rather than a
 * half-space, so culling is unsafe there — return the input unchanged. Clip
 * planes are a 3D-render feature; 2D slices ignore them, so only the 3D frustum
 * path calls this. `chunkOffsetFor` matches the frustum path's explode offset.
 */
export function chunksNotClippedOut(
  plan: ChunkPlan,
  indices: readonly number[],
  clipPlanes: ArrayLike<number>,
  isCutaway: boolean,
  chunkOffsetFor?: ChunkOffsetFor,
): number[] {
  if (isCutaway) return [...indices]
  // Collect the active planes once (skip the [0,0,0,2] sentinel + degenerates).
  const planes: number[][] = []
  const planeCount = Math.floor(clipPlanes.length / 4)
  for (let p = 0; p < planeCount; p++) {
    const nx = clipPlanes[p * 4 + 0]
    const ny = clipPlanes[p * 4 + 1]
    const nz = clipPlanes[p * 4 + 2]
    const a = clipPlanes[p * 4 + 3]
    if (a > 1 || a < -1) continue // sentinel: no clip
    if (nx * nx + ny * ny + nz * nz < 1e-12) continue // degenerate normal
    planes.push([nx, ny, nz, a])
  }
  if (planes.length === 0) return [...indices]

  const [vx, vy, vz] = plan.volumeDims
  const out: number[] = []
  for (const ci of indices) {
    const desc = plan.chunks[ci]
    if (!desc) {
      out.push(ci) // unknown chunk: keep conservatively
      continue
    }
    const offset = chunkOffsetFor?.(ci)
    const ox = offset?.[0] ?? 0
    const oy = offset?.[1] ?? 0
    const oz = offset?.[2] ?? 0
    const x0 = desc.voxelOrigin[0] / vx + ox
    const y0 = desc.voxelOrigin[1] / vy + oy
    const z0 = desc.voxelOrigin[2] / vz + oz
    const x1 = (desc.voxelOrigin[0] + desc.voxelDims[0]) / vx + ox
    const y1 = (desc.voxelOrigin[1] + desc.voxelDims[1]) / vy + oy
    const z1 = (desc.voxelOrigin[2] + desc.voxelDims[2]) / vz + oz
    let clippedOut = false
    for (const [nx, ny, nz, a] of planes) {
      let allRemoved = true
      for (let c = 0; c < 8; c++) {
        const px = c & 1 ? x1 : x0
        const py = c & 2 ? y1 : y0
        const pz = c & 4 ? z1 : z0
        const f = nx * (px - 0.5) + ny * (py - 0.5) + nz * (pz - 0.5) - a
        if (f >= 0) {
          allRemoved = false // a corner is on the kept side
          break
        }
      }
      if (allRemoved) {
        clippedOut = true
        break
      }
    }
    if (!clippedOut) out.push(ci)
  }
  return out
}

/**
 * Indices of chunks whose texture region (data + halo) overlaps an inclusive
 * voxel box `[boxMin, boxMax]`. Used to upload only the drawing chunks a pen
 * stroke touched instead of re-uploading the whole volume's drawing layer.
 *
 * The test uses each chunk's `texOrigin`/`texDims` (halo-inclusive), so a voxel
 * painted near a chunk boundary also refreshes the neighbour whose halo covers
 * it — keeping trilinear sampling seamless across the seam.
 */
export function chunksOverlappingVoxelBox(
  plan: ChunkPlan,
  boxMin: readonly number[],
  boxMax: readonly number[],
): number[] {
  const out: number[] = []
  for (let ci = 0; ci < plan.chunks.length; ci++) {
    const d = plan.chunks[ci]
    const ox = d.texOrigin[0]
    const oy = d.texOrigin[1]
    const oz = d.texOrigin[2]
    const ex = ox + d.texDims[0]
    const ey = oy + d.texDims[1]
    const ez = oz + d.texDims[2]
    // Chunk covers [o, e) per axis; box is inclusive. No overlap if the box is
    // entirely left of, or entirely at/right of, the chunk on any axis.
    if (boxMax[0] < ox || boxMin[0] >= ex) continue
    if (boxMax[1] < oy || boxMin[1] >= ey) continue
    if (boxMax[2] < oz || boxMin[2] >= ez) continue
    out.push(ci)
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
