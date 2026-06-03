import { mat4, vec4 } from 'gl-matrix'
import type { ChunkPlan, Vec3f } from './chunking'

export interface ChunkExplodeOptions {
  enabled?: boolean
  scale?: readonly [number, number, number]
}

const IDENTITY_SCALE: Vec3f = [1, 1, 1]
const ZERO_OFFSET: Vec3f = [0, 0, 0]

export function chunkExplodeEnabled(
  explode: ChunkExplodeOptions | null | undefined,
): boolean {
  if (!explode?.enabled) return false
  const scale = chunkExplodeScale(explode)
  return scale.some((axisScale) => axisScale > 1)
}

export function chunkExplodeScale(
  explode: ChunkExplodeOptions | null | undefined,
): Vec3f {
  if (!explode?.enabled) return IDENTITY_SCALE
  const src = explode.scale ?? [1.5, 1.5, 1.5]
  return [
    sanitizeExplodeScale(src[0]),
    sanitizeExplodeScale(src[1]),
    sanitizeExplodeScale(src[2]),
  ]
}

function sanitizeExplodeScale(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, value)
}

export function chunkExplodeOffsetFrac(
  plan: ChunkPlan,
  chunkIndex: number,
  explode: ChunkExplodeOptions | null | undefined,
): Vec3f {
  if (!chunkExplodeEnabled(explode)) return ZERO_OFFSET
  const desc = plan.chunks[chunkIndex]
  if (!desc) return ZERO_OFFSET
  const scale = chunkExplodeScale(explode)
  return [
    explodeAxisOffset(desc.gridIndex[0], plan.gridDims[0], scale[0]),
    explodeAxisOffset(desc.gridIndex[1], plan.gridDims[1], scale[1]),
    explodeAxisOffset(desc.gridIndex[2], plan.gridDims[2], scale[2]),
  ]
}

function explodeAxisOffset(index: number, gridDim: number, scale: number) {
  if (gridDim <= 1 || scale <= 1) return 0
  const center = (gridDim - 1) / 2
  return ((index - center) * (scale - 1)) / gridDim
}

// Column-major gl-matrix mat4 that maps voxel -> mm exactly like
// NVTransforms.vox2mm (mm = transpose(matRAS_row_major) · (voxel,1)). matRAS is
// stored row-major, so transposing the cloned array yields the column-major map.
function voxToMMMatrix(matRAS: ArrayLike<number>): mat4 {
  const a = mat4.fromValues(
    matRAS[0],
    matRAS[1],
    matRAS[2],
    matRAS[3],
    matRAS[4],
    matRAS[5],
    matRAS[6],
    matRAS[7],
    matRAS[8],
    matRAS[9],
    matRAS[10],
    matRAS[11],
    matRAS[12],
    matRAS[13],
    matRAS[14],
    matRAS[15],
  )
  mat4.transpose(a, a)
  return a
}

function applyMat(
  m: mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const p = vec4.fromValues(x, y, z, 1)
  vec4.transformMat4(p, p, m)
  return [p[0], p[1], p[2]]
}

// Slab ray/AABB intersection. Returns the entry distance `t >= 0` along the ray
// (origin + t·dir) where it first enters [min,max], or null if it misses.
function rayAABBEntry(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): number | null {
  let tmin = Number.NEGATIVE_INFINITY
  let tmax = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const oi = o[i]
    const di = d[i]
    if (Math.abs(di) < 1e-12) {
      if (oi < lo[i] || oi > hi[i]) return null // parallel & outside slab
    } else {
      let t1 = (lo[i] - oi) / di
      let t2 = (hi[i] - oi) / di
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }
  if (tmax < 0) return null // box behind the ray
  return tmin >= 0 ? tmin : 0 // origin inside the box -> entry at 0
}

/**
 * Pick the exploded block a world-space ray hits and the voxel where it enters.
 *
 * The 3D render spreads each chunk by `chunkExplodedMatRAS`; depth-picking can't
 * see that (it ray-marches the un-exploded single texture), so 3D drawing on the
 * separated blocks needs a CPU pick. For each chunk we build its mm AABB from the
 * *exploded* matRAS, slab-test the ray, take the nearest entry, and invert that
 * same exploded matRAS to recover the true voxel (clamped to the chunk's data
 * region). The ray must be in the same mm space as `NVTransforms.vox2mm`.
 *
 * `allowed`, when given, restricts the pick to those chunk indices — pass the
 * not-clipped-out / resident set so a right-click can't paint a block the clip
 * plane (or streaming) has hidden.
 *
 * Returns null if the ray misses every (allowed) block or explode is disabled.
 */
export function pickExplodedVoxel(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  rayOrigin: readonly [number, number, number],
  rayDir: readonly [number, number, number],
  allowed?: ReadonlySet<number>,
): { chunkIndex: number; voxel: [number, number, number] } | null {
  if (!chunkExplodeEnabled(explode)) return null
  let bestT = Number.POSITIVE_INFINITY
  let bestCi = -1
  let bestMat: mat4 | null = null
  for (let ci = 0; ci < plan.chunks.length; ci++) {
    if (allowed && !allowed.has(ci)) continue // hidden block (clipped / unstreamed)
    const desc = plan.chunks[ci]
    const m = chunkExplodedMatRAS(plan, ci, matRAS as Float32Array, explode)
    const vox2mm = voxToMMMatrix(m)
    const x0 = desc.voxelOrigin[0]
    const y0 = desc.voxelOrigin[1]
    const z0 = desc.voxelOrigin[2]
    const x1 = x0 + desc.voxelDims[0]
    const y1 = y0 + desc.voxelDims[1]
    const z1 = z0 + desc.voxelDims[2]
    const lo: [number, number, number] = [Infinity, Infinity, Infinity]
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let c = 0; c < 8; c++) {
      const p = applyMat(
        vox2mm,
        c & 1 ? x1 : x0,
        c & 2 ? y1 : y0,
        c & 4 ? z1 : z0,
      )
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k])
        hi[k] = Math.max(hi[k], p[k])
      }
    }
    const t = rayAABBEntry(rayOrigin, rayDir, lo, hi)
    if (t !== null && t < bestT) {
      bestT = t
      bestCi = ci
      bestMat = vox2mm
    }
  }
  if (bestCi < 0 || !bestMat) return null
  const hitMM: [number, number, number] = [
    rayOrigin[0] + bestT * rayDir[0],
    rayOrigin[1] + bestT * rayDir[1],
    rayOrigin[2] + bestT * rayDir[2],
  ]
  const inv = mat4.create()
  if (!mat4.invert(inv, bestMat)) return null
  const v = applyMat(inv, hitMM[0], hitMM[1], hitMM[2])
  const desc = plan.chunks[bestCi]
  const clamp = (val: number, lo2: number, hi2: number) =>
    Math.max(lo2, Math.min(hi2, Math.round(val)))
  return {
    chunkIndex: bestCi,
    voxel: [
      clamp(
        v[0],
        desc.voxelOrigin[0],
        desc.voxelOrigin[0] + desc.voxelDims[0] - 1,
      ),
      clamp(
        v[1],
        desc.voxelOrigin[1],
        desc.voxelOrigin[1] + desc.voxelDims[1] - 1,
      ),
      clamp(
        v[2],
        desc.voxelOrigin[2],
        desc.voxelOrigin[2] + desc.voxelDims[2] - 1,
      ),
    ],
  }
}

export function chunkExplodedMatRAS(
  plan: ChunkPlan,
  chunkIndex: number,
  matRAS: Float32Array | number[],
  explode: ChunkExplodeOptions | null | undefined,
): Float32Array | number[] {
  const offset = chunkExplodeOffsetFrac(plan, chunkIndex, explode)
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return matRAS

  const [vx, vy, vz] = plan.volumeDims
  const ox = offset[0] * vx
  const oy = offset[1] * vy
  const oz = offset[2] * vz
  const out = new Float32Array(16)
  for (let i = 0; i < 16; i++) out[i] = matRAS[i] ?? 0

  out[3] += ox * matRAS[0] + oy * matRAS[1] + oz * matRAS[2]
  out[7] += ox * matRAS[4] + oy * matRAS[5] + oz * matRAS[6]
  out[11] += ox * matRAS[8] + oy * matRAS[9] + oz * matRAS[10]
  out[15] += ox * matRAS[12] + oy * matRAS[13] + oz * matRAS[14]
  return out
}
