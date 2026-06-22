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
  // Spread each brick radially from the volume centre by its own centre's
  // fractional offset from 0.5. For a uniform grid this is identical to the
  // legacy gridIndex formula ((i-(n-1)/2)(s-1)/n), but it depends only on the
  // brick's world centre — so it also separates a heterogeneous multi-LOD
  // octree, whose bricks share a degenerate gridIndex/gridDims.
  const [vx, vy, vz] = plan.volumeDims
  return [
    explodeAxisOffset(
      desc.voxelOrigin[0] + desc.voxelDims[0] / 2,
      vx,
      scale[0],
    ),
    explodeAxisOffset(
      desc.voxelOrigin[1] + desc.voxelDims[1] / 2,
      vy,
      scale[1],
    ),
    explodeAxisOffset(
      desc.voxelOrigin[2] + desc.voxelDims[2] / 2,
      vz,
      scale[2],
    ),
  ]
}

function explodeAxisOffset(center: number, volumeDim: number, scale: number) {
  if (volumeDim <= 0 || scale <= 1) return 0
  const centreFrac = center / volumeDim
  return (centreFrac - 0.5) * (scale - 1)
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

// Slab ray/AABB intersection. Returns the entry/exit distances along the ray
// (origin + t·dir) that bound [min,max], or null if it misses. `tEntry` is
// clamped to 0 when the origin is inside the box.
function rayAABBRange(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): { tEntry: number; tExit: number } | null {
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
  return { tEntry: Math.max(0, tmin), tExit: tmax }
}

// Parse model clip planes into active half-spaces [nx,ny,nz,a] in [0,1]^3 object
// space (kept side is dot(n,p-0.5)-a >= 0). Cutaway carves an interior slab, so
// return none there (matching chunksNotClippedOut's conservative choice).
function activeClipPlanes(
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

export interface PickExplodedOptions {
  // Restrict the pick to these chunk indices (e.g. the not-clipped / resident set).
  allowed?: ReadonlySet<number>
  // Active clip planes + cutaway flag, for per-voxel skipping of the clipped-away
  // portion of a block that only partly survives the plane.
  clipPlanes?: ArrayLike<number>
  isCutaway?: boolean
  // Voxel value lookup (RAS order) + the transparency threshold. When given, the
  // ray marches into the block and lands on the first voxel whose value exceeds
  // the threshold (the visible tissue surface) instead of the bounding-box face.
  sample?: (x: number, y: number, z: number) => number
  threshold?: number
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
  opts: PickExplodedOptions = {},
): { chunkIndex: number; voxel: [number, number, number] } | null {
  if (!chunkExplodeEnabled(explode)) return null
  const planes = activeClipPlanes(opts.clipPlanes, opts.isCutaway)
  const [vx, vy, vz] = plan.volumeDims
  const threshold = opts.threshold ?? 0
  let bestT = Number.POSITIVE_INFINITY
  let bestCi = -1
  let bestVoxel: [number, number, number] | null = null

  for (let ci = 0; ci < plan.chunks.length; ci++) {
    if (opts.allowed && !opts.allowed.has(ci)) continue // hidden (clipped/unstreamed)
    const desc = plan.chunks[ci]
    const ox = desc.voxelOrigin[0]
    const oy = desc.voxelOrigin[1]
    const oz = desc.voxelOrigin[2]
    const ex = ox + desc.voxelDims[0]
    const ey = oy + desc.voxelDims[1]
    const ez = oz + desc.voxelDims[2]
    const vox2mm = voxToMMMatrix(
      chunkExplodedMatRAS(plan, ci, matRAS as Float32Array, explode),
    )
    const lo: [number, number, number] = [Infinity, Infinity, Infinity]
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let c = 0; c < 8; c++) {
      const p = applyMat(
        vox2mm,
        c & 1 ? ex : ox,
        c & 2 ? ey : oy,
        c & 4 ? ez : oz,
      )
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k])
        hi[k] = Math.max(hi[k], p[k])
      }
    }
    const range = rayAABBRange(rayOrigin, rayDir, lo, hi)
    if (!range || range.tEntry >= bestT) continue
    const inv = mat4.create()
    if (!mat4.invert(inv, vox2mm)) continue

    // No data sampler: land on the box-entry voxel (the legacy behaviour, used by
    // tests). Block-level `allowed` has already dropped fully-clipped blocks.
    if (!opts.sample) {
      const hitMM = applyMat(
        inv,
        rayOrigin[0] + range.tEntry * rayDir[0],
        rayOrigin[1] + range.tEntry * rayDir[1],
        rayOrigin[2] + range.tEntry * rayDir[2],
      )
      bestT = range.tEntry
      bestCi = ci
      bestVoxel = [
        clampInt(hitMM[0], ox, ex - 1),
        clampInt(hitMM[1], oy, ey - 1),
        clampInt(hitMM[2], oz, ez - 1),
      ]
      continue
    }

    // March the block's data: step ~half a voxel from entry to exit and stop at
    // the first voxel that is opaque (value > threshold) AND on the kept side of
    // every clip plane — the visible tissue surface, not the bounding-box face.
    const vEntry = applyMat(
      inv,
      rayOrigin[0] + range.tEntry * rayDir[0],
      rayOrigin[1] + range.tEntry * rayDir[1],
      rayOrigin[2] + range.tEntry * rayDir[2],
    )
    const vExit = applyMat(
      inv,
      rayOrigin[0] + range.tExit * rayDir[0],
      rayOrigin[1] + range.tExit * rayDir[1],
      rayOrigin[2] + range.tExit * rayDir[2],
    )
    const span = Math.hypot(
      vExit[0] - vEntry[0],
      vExit[1] - vEntry[1],
      vExit[2] - vEntry[2],
    )
    const steps = Math.min(2048, Math.max(1, Math.ceil(span * 2)))
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      const ix = Math.round(vEntry[0] + (vExit[0] - vEntry[0]) * f)
      const iy = Math.round(vEntry[1] + (vExit[1] - vEntry[1]) * f)
      const iz = Math.round(vEntry[2] + (vExit[2] - vEntry[2]) * f)
      if (ix < ox || ix >= ex || iy < oy || iy >= ey || iz < oz || iz >= ez) {
        continue
      }
      if (planes.length > 0) {
        const fx = (ix + 0.5) / vx - 0.5
        const fy = (iy + 0.5) / vy - 0.5
        const fz = (iz + 0.5) / vz - 0.5
        let clipped = false
        for (const [nx, ny, nz, a] of planes) {
          if (nx * fx + ny * fy + nz * fz - a < 0) {
            clipped = true
            break
          }
        }
        if (clipped) continue
      }
      if (opts.sample(ix, iy, iz) > threshold) {
        const t = range.tEntry + (range.tExit - range.tEntry) * f
        if (t < bestT) {
          bestT = t
          bestCi = ci
          bestVoxel = [ix, iy, iz]
        }
        break
      }
    }
  }
  if (bestCi < 0 || !bestVoxel) return null
  return { chunkIndex: bestCi, voxel: bestVoxel }
}

function clampInt(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(val)))
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
