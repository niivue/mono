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
): readonly number[] {
  return backToFront(plan, rayDir, chunkOffsetFor, volScale, !chunkOffsetFor)
}

// Unexploded orders per plan, keyed by `orderKey`. Plans are never mutated.
const ORDER_CACHE = new WeakMap<ChunkPlan, Map<number, number[]>>()

// Without the comparator fallback the BSP order reads only each axis's class
// (|d| < EPS, positive, negative) and the |d| ranking: one of 27 * 6 keys.
function orderKey(d: Vec3f, axes: number[], eps: number): number {
  let key = (axes[0] * 3 + axes[1]) * 3 + axes[2]
  for (let k = 0; k < 3; k++)
    key = key * 3 + (Math.abs(d[k]) < eps ? 0 : d[k] > 0 ? 1 : 2)
  return key
}

function backToFront(
  plan: ChunkPlan,
  rayDir: ArrayLike<number>,
  chunkOffsetFor: ChunkOffsetFor | undefined,
  volScale: ArrayLike<number> | undefined,
  memo: boolean,
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
  const EPS = 1e-9
  const axes = [0, 1, 2].sort((a, b) => Math.abs(d[b]) - Math.abs(d[a]))
  const key = orderKey(d, axes, EPS)
  let cache = memo ? ORDER_CACHE.get(plan) : undefined
  const hit = cache?.get(key)
  if (hit) return hit
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
  // BSP recursive sort. A pairwise comparator is only an APPROXIMATION for
  // mixed-size AABBs (a coarse brick can mis-sort against the fine bricks at
  // oblique angles -> a mis-ordered OPAQUE brick composites over the foreground
  // as a stray bright block). Instead, recursively split the set with an
  // axis-aligned plane that NO brick straddles: every brick on the far side of
  // that plane (along d) is unambiguously behind every brick on the near side,
  // so ordering far-group-then-near-group is exact. Such clean planes always
  // exist for a space-tiling octree; the comparator is only a fallback for a
  // sub-group that somehow has none on a view-aligned axis. This drives ordering
  // violations to zero (validated by ray-march ground truth) at any view angle.
  const order: number[] = []
  let usedFallback = false
  const emit = (idx: number[]): void => {
    if (idx.length <= 1) {
      if (idx.length === 1) order.push(idx[0])
      return
    }
    for (const k of axes) {
      if (Math.abs(d[k]) < EPS) continue
      // Pick the most balanced clean split coord (a brick face no brick crosses).
      let bestC = Number.NaN
      let bestBal = Number.POSITIVE_INFINITY
      for (const c of new Set(idx.map((i) => hi[i][k]))) {
        let straddles = false
        let lows = 0
        let highs = 0
        for (const i of idx) {
          if (lo[i][k] < c - EPS && hi[i][k] > c + EPS) {
            straddles = true
            break
          }
          if (hi[i][k] <= c + EPS) lows++
          else highs++
        }
        if (straddles || lows === 0 || highs === 0) continue
        const bal = Math.abs(lows - highs)
        if (bal < bestBal) {
          bestBal = bal
          bestC = c
        }
      }
      if (!Number.isNaN(bestC)) {
        const lowG = idx.filter((i) => hi[i][k] <= bestC + EPS)
        const highG = idx.filter((i) => lo[i][k] >= bestC - EPS)
        // Far group (drawn first) is the one on the +k side when d[k] > 0.
        emit(d[k] > 0 ? highG : lowG)
        emit(d[k] > 0 ? lowG : highG)
        return
      }
    }
    // No clean split on any view-aligned axis: fall back to the comparator.
    usedFallback = true
    order.push(...[...idx].sort(compare))
  }
  emit(plan.chunks.map((_, i) => i))
  if (memo && !usedFallback) {
    if (!cache) {
      cache = new Map()
      ORDER_CACHE.set(plan, cache)
    }
    cache.set(key, order)
  }
  return order
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
): number[] {
  const [vx, vy, vz] = plan.volumeDims
  const nearLimit = clipSpaceZeroToOne ? 0 : -1
  const out: number[] = []
  const model = MODEL
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
      if (matRAS) chunkCornerToModel(px, py, pz, vx, vy, vz, matRAS, model)
      else {
        model[0] = px
        model[1] = py
        model[2] = pz
        model[3] = 1
      }
      const cx = clipRow(mvp, model, 0)
      const cy = clipRow(mvp, model, 1)
      const cz = clipRow(mvp, model, 2)
      const cw = clipRow(mvp, model, 3)
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

// Scratch homogeneous corner shared by the (synchronous) frustum helpers.
const MODEL = new Float64Array(4)

// Row `row` of column-major `mvp` applied to homogeneous `model`: one clip coord.
function clipRow(
  mvp: Float32Array | number[],
  model: ArrayLike<number>,
  row: number,
): number {
  return (
    mvp[row] * model[0] +
    mvp[4 + row] * model[1] +
    mvp[8 + row] * model[2] +
    mvp[12 + row] * model[3]
  )
}

function chunkCornerToModel(
  xFrac: number,
  yFrac: number,
  zFrac: number,
  vx: number,
  vy: number,
  vz: number,
  matRAS: Float32Array | number[],
  out: Float64Array,
): void {
  const x = xFrac * vx - 0.5
  const y = yFrac * vy - 0.5
  const z = zFrac * vz - 0.5
  out[0] = x * matRAS[0] + y * matRAS[1] + z * matRAS[2] + matRAS[3]
  out[1] = x * matRAS[4] + y * matRAS[5] + z * matRAS[6] + matRAS[7]
  out[2] = x * matRAS[8] + y * matRAS[9] + z * matRAS[10] + matRAS[11]
  out[3] = x * matRAS[12] + y * matRAS[13] + z * matRAS[14] + matRAS[15]
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
): number[] {
  const [vx, vy, vz] = plan.volumeDims
  const score = new Float64Array(indices.length)
  const model = MODEL
  for (let k = 0; k < indices.length; k++) {
    const desc = plan.chunks[indices[k]]
    if (!desc) {
      score[k] = Number.POSITIVE_INFINITY
      continue
    }
    const cx = (desc.voxelOrigin[0] + desc.voxelDims[0] / 2) / vx
    const cy = (desc.voxelOrigin[1] + desc.voxelDims[1] / 2) / vy
    const cz = (desc.voxelOrigin[2] + desc.voxelDims[2] / 2) / vz
    if (matRAS) chunkCornerToModel(cx, cy, cz, vx, vy, vz, matRAS, model)
    else {
      model[0] = cx
      model[1] = cy
      model[2] = cz
      model[3] = 1
    }
    const cw = clipRow(mvp, model, 3)
    if (cw <= 1e-6) {
      score[k] = Number.POSITIVE_INFINITY
      continue
    }
    const ndcX = clipRow(mvp, model, 0) / cw
    const ndcY = clipRow(mvp, model, 1) / cw
    score[k] = ndcX * ndcX + ndcY * ndcY
  }
  const order = Array.from(indices, (_, k) => k)
  order.sort((a, b) => score[a] - score[b])
  for (let k = 0; k < order.length; k++) order[k] = indices[order[k]]
  return order
}

// Parse clip planes into active half-spaces [nx,ny,nz,a] in [0,1]^3 object space
// (kept side is dot(n,p-0.5)-a >= 0), skipping the [0,0,0,2] "no clip" sentinel
// and degenerate normals. Cutaway carves an interior slab, not a half-space, so
// it yields none (culling or skipping against it would be unsafe).
export function activeClipPlanes(
  clipPlanes: ArrayLike<number> | undefined,
  isCutaway: boolean | undefined,
): number[][] {
  if (!clipPlanes || isCutaway) return []
  const out: number[][] = []
  const count = Math.floor(clipPlanes.length / 4)
  for (let p = 0; p < count; p++) {
    const nx = clipPlanes[p * 4 + 0]
    const ny = clipPlanes[p * 4 + 1]
    const nz = clipPlanes[p * 4 + 2]
    const a = clipPlanes[p * 4 + 3]
    if (a > 1 || a < -1) continue
    if (nx * nx + ny * ny + nz * nz < 1e-12) continue
    out.push([nx, ny, nz, a])
  }
  return out
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
 * path calls this. Exploded views skip culling, so boxes are unexploded.
 */
export function chunksNotClippedOut(
  plan: ChunkPlan,
  indices: readonly number[],
  clipPlanes: ArrayLike<number>,
  isCutaway: boolean,
): number[] {
  const planes = activeClipPlanes(clipPlanes, isCutaway)
  if (planes.length === 0) return [...indices]

  const [vx, vy, vz] = plan.volumeDims
  const out: number[] = []
  for (const ci of indices) {
    const desc = plan.chunks[ci]
    if (!desc) {
      out.push(ci) // unknown chunk: keep conservatively
      continue
    }
    const x0 = desc.voxelOrigin[0] / vx
    const y0 = desc.voxelOrigin[1] / vy
    const z0 = desc.voxelOrigin[2] / vz
    const x1 = (desc.voxelOrigin[0] + desc.voxelDims[0]) / vx
    const y1 = (desc.voxelOrigin[1] + desc.voxelDims[1]) / vy
    const z1 = (desc.voxelOrigin[2] + desc.voxelDims[2]) / vz
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

/** One cube in a chunked draw: a plan chunk, or a retiring one from a swap. */
export type ChunkDrawItem<TRetiring> = { index: number; retiring?: TRetiring }

/**
 * Back-to-front draw list while a make-before-break swap is in progress: the
 * plan's chunks not hidden behind a retiring chunk, plus the retiring chunks
 * themselves, sorted together so mixed brick sizes composite in order. A
 * retiring item's `index` is its index in its own (older) plan. Without
 * retiring chunks this is `chunksBackToFront` unchanged.
 */
export function chunkDrawOrder<
  TRetiring extends { plan: ChunkPlan; index: number },
>(
  plan: ChunkPlan,
  retiring: readonly TRetiring[],
  isCovered: (index: number) => boolean,
  rayDir: ArrayLike<number>,
  chunkOffsetFor?: ChunkOffsetFor,
  volScale?: ArrayLike<number>,
): ChunkDrawItem<TRetiring>[] {
  if (retiring.length === 0) {
    return chunksBackToFront(plan, rayDir, chunkOffsetFor, volScale).map(
      (index) => ({ index }),
    )
  }
  const items: ChunkDrawItem<TRetiring>[] = []
  for (let i = 0; i < plan.chunks.length; i++) {
    if (!isCovered(i)) items.push({ index: i })
  }
  for (const t of retiring) items.push({ index: t.index, retiring: t })
  const union: ChunkPlan = {
    ...plan,
    chunks: items.map((it) =>
      it.retiring ? it.retiring.plan.chunks[it.index] : plan.chunks[it.index],
    ),
  }
  // Explode offsets belong to the current plan's indices; retiring cubes
  // draw unexploded for the moment they are on screen.
  const offsetFor: ChunkOffsetFor | undefined = chunkOffsetFor
    ? (u) => {
        const it = items[u]
        return it.retiring ? [0, 0, 0] : chunkOffsetFor(it.index)
      }
    : undefined
  // The union plan is new each frame: not memoised.
  return backToFront(union, rayDir, offsetFor, volScale, false).map(
    (u) => items[u],
  )
}
