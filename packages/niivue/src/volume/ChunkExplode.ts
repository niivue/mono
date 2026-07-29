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

// Inset an [lo,hi] mm interval by `m` on both sides; if that inverts (block thinner
// than 2m), collapse to the midpoint. Keeps a drawable face strictly inside the
// block's data voxels (see the boundary note in pickExplodedBlockFace).
function insetRange(loV: number, hiV: number, m: number): [number, number] {
  let l = loV + m
  let h = hiV - m
  if (l > h) {
    const mid = (loV + hiV) / 2
    l = mid
    h = mid
  }
  return [l, h]
}

// Per-axis exploded AABB + constant explode offset + mm-per-voxel for one block —
// the geometry shared by the block-face builders. Null if explode is off / chunk
// out of range.
function explodedBlockGeom(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  chunkIndex: number,
): {
  lo: [number, number, number]
  hi: [number, number, number]
  off: [number, number, number]
  mmPerVox: [number, number, number]
} | null {
  if (!chunkExplodeEnabled(explode)) return null
  const desc = plan.chunks[chunkIndex]
  if (!desc) return null
  const vox2mm = voxToMMMatrix(
    chunkExplodedMatRAS(plan, chunkIndex, matRAS as Float32Array, explode),
  )
  const ox = desc.voxelOrigin[0]
  const oy = desc.voxelOrigin[1]
  const oz = desc.voxelOrigin[2]
  const ex = ox + desc.voxelDims[0]
  const ey = oy + desc.voxelDims[1]
  const ez = oz + desc.voxelDims[2]
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
  const unexplodedOrigin = applyMat(voxToMMMatrix(matRAS), 0, 0, 0)
  const explodedOrigin = applyMat(vox2mm, 0, 0, 0)
  const off: [number, number, number] = [
    explodedOrigin[0] - unexplodedOrigin[0],
    explodedOrigin[1] - unexplodedOrigin[1],
    explodedOrigin[2] - unexplodedOrigin[2],
  ]
  const mmPerVox: [number, number, number] = [
    (hi[0] - lo[0]) / Math.max(1, desc.voxelDims[0]),
    (hi[1] - lo[1]) / Math.max(1, desc.voxelDims[1]),
    (hi[2] - lo[2]) / Math.max(1, desc.voxelDims[2]),
  ]
  return { lo, hi, off, mmPerVox }
}

const INSET_VOX = 1.5

/**
 * The front (ray-entry) face of an exploded block, as an axis-aligned plane.
 *
 * All mm fields are in UN-EXPLODED (data) mm — the space annotations are stored
 * and re-exploded from at render time (buildAnnotation3DRenderData adds the block's
 * explode offset back per vertex). The block is found in EXPLODED space (that is
 * where the ray and the visible geometry live); `explodeOffsetMM` is that block's
 * constant mm shift, kept so `rayBlockFacePointMM` can move the ray into the same
 * un-exploded space.
 */
export interface ExplodedBlockFace {
  chunkIndex: number
  // Face-normal axis (0=x, 1=y, 2=z in mm/RAS) and the plane's constant coordinate.
  axis: 0 | 1 | 2
  planeMM: number
  // The two in-plane axes (in `(axis+1)%3, (axis+2)%3` order) and the block's mm
  // extent on them, so a stroke can be clamped to the face rectangle.
  inPlaneAxes: [number, number]
  loMM: [number, number]
  hiMM: [number, number]
  // The ray/face intersection (already on the face, within the rectangle).
  entryMM: [number, number, number]
  // The block's constant explode shift (exploded mm - un-exploded mm).
  explodeOffsetMM: [number, number, number]
}

// Pick the nearest visible exploded block a ray enters and return its FRONT FACE
// as an axis-aligned plane (the box-entry face — no tissue marching). Vector
// drawing projects the whole stroke onto this one plane so the polygon lies flat
// on the block face, instead of following the tissue surface at varying depth.
// The block is chosen in EXPLODED space (where the blocks are separated), then the
// face is returned in UN-EXPLODED mm (see ExplodedBlockFace) so the committed
// annotation, which is re-exploded per block at render, lands back on this face.
// `allowed` drops fully-clipped blocks; the clip-plane CUT of the face itself is
// intentionally ignored for now (adjusting the drawing face to the clip plane is a
// tracked follow-up), so an axis-aligned volume gets an axis-aligned face plane.
export function pickExplodedBlockFace(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  rayOrigin: readonly [number, number, number],
  rayDir: readonly [number, number, number],
  opts: { allowed?: ReadonlySet<number> } = {},
): ExplodedBlockFace | null {
  if (!chunkExplodeEnabled(explode)) return null
  // Un-exploded voxel->mm origin, for the per-block explode offset below. The
  // explode is a pure per-chunk translation, so the offset is constant per block.
  const unexplodedOrigin = applyMat(voxToMMMatrix(matRAS), 0, 0, 0)
  let bestT = Number.POSITIVE_INFINITY
  let best: ExplodedBlockFace | null = null

  for (let ci = 0; ci < plan.chunks.length; ci++) {
    if (opts.allowed && !opts.allowed.has(ci)) continue
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
    const entry: [number, number, number] = [
      rayOrigin[0] + range.tEntry * rayDir[0],
      rayOrigin[1] + range.tEntry * rayDir[1],
      rayOrigin[2] + range.tEntry * rayDir[2],
    ]
    // Entry face = the axis whose near slab-plane is the max (i.e. == tEntry).
    let axis = 0
    let bestNear = Number.NEGATIVE_INFINITY
    for (let k = 0; k < 3; k++) {
      if (Math.abs(rayDir[k]) < 1e-12) continue
      const t1 = (lo[k] - rayOrigin[k]) / rayDir[k]
      const t2 = (hi[k] - rayOrigin[k]) / rayDir[k]
      const near = Math.min(t1, t2)
      if (near > bestNear) {
        bestNear = near
        axis = k
      }
    }
    const a = (axis + 1) % 3
    const b = (axis + 2) % 3
    // This block's exploded origin minus the un-exploded origin = its constant
    // explode shift. Subtract it so the face is reported in un-exploded mm.
    const explodedOrigin = applyMat(vox2mm, 0, 0, 0)
    const off: [number, number, number] = [
      explodedOrigin[0] - unexplodedOrigin[0],
      explodedOrigin[1] - unexplodedOrigin[1],
      explodedOrigin[2] - unexplodedOrigin[2],
    ]
    // Inset the drawable face INSIDE the block's data region by ~1.5 voxels on
    // every side. The render re-explodes each annotation vertex by looking up its
    // containing chunk with floor(texFrac * dims) (explodeOffsetMMAtFrac); a point
    // sitting exactly on the block's outer boundary floors into a NEIGHBOURING
    // chunk and gets that chunk's offset, scattering the vertex off the block. The
    // inset keeps every clamped point strictly inside this block's voxels so the
    // lookup resolves here. mm-per-voxel per axis (axis-aligned assumption).
    const mmPerVox = [
      (hi[0] - lo[0]) / Math.max(1, desc.voxelDims[0]),
      (hi[1] - lo[1]) / Math.max(1, desc.voxelDims[1]),
      (hi[2] - lo[2]) / Math.max(1, desc.voxelDims[2]),
    ]
    // Un-exploded axis bounds + inset plane toward the block centre, clamped so a
    // thin block never pushes the plane past its own centre.
    const loAxU = lo[axis] - off[axis]
    const hiAxU = hi[axis] - off[axis]
    const centreAxU = (loAxU + hiAxU) / 2
    const axisNudge = Math.min(
      INSET_VOX * mmPerVox[axis],
      Math.abs(hiAxU - loAxU) / 2,
    )
    let planeMM = entry[axis] - off[axis]
    planeMM += Math.sign(centreAxU - planeMM) * axisNudge
    // Un-exploded in-plane rectangle, inset on both sides (guard tiny blocks).
    const [loA, hiA] = insetRange(
      lo[a] - off[a],
      hi[a] - off[a],
      INSET_VOX * mmPerVox[a],
    )
    const [loB, hiB] = insetRange(
      lo[b] - off[b],
      hi[b] - off[b],
      INSET_VOX * mmPerVox[b],
    )
    // Clamp the ray-entry point into the inset rectangle for the first stroke point.
    const entryA = Math.max(loA, Math.min(hiA, entry[a] - off[a]))
    const entryB = Math.max(loB, Math.min(hiB, entry[b] - off[b]))
    const entryMM: [number, number, number] = [0, 0, 0]
    entryMM[axis] = planeMM
    entryMM[a] = entryA
    entryMM[b] = entryB
    bestT = range.tEntry
    best = {
      chunkIndex: ci,
      axis: axis as 0 | 1 | 2,
      planeMM,
      inPlaneAxes: [a, b],
      loMM: [loA, loB],
      hiMM: [hiA, hiB],
      entryMM,
      explodeOffsetMM: off,
    }
  }
  return best
}

// The exploded mm axis-aligned bounding box (min/max, world mm) of one block —
// the same box pickExplodedBlockFace ray-tests. Used to outline the picked block
// on the 3D render (a FocusBox). Returns null if explode is off or the chunk is
// out of range.
export function explodedChunkAABB(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  chunkIndex: number,
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!chunkExplodeEnabled(explode)) return null
  const desc = plan.chunks[chunkIndex]
  if (!desc) return null
  const vox2mm = voxToMMMatrix(
    chunkExplodedMatRAS(plan, chunkIndex, matRAS as Float32Array, explode),
  )
  const ox = desc.voxelOrigin[0]
  const oy = desc.voxelOrigin[1]
  const oz = desc.voxelOrigin[2]
  const ex = ox + desc.voxelDims[0]
  const ey = oy + desc.voxelDims[1]
  const ez = oz + desc.voxelDims[2]
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const p = applyMat(
      vox2mm,
      c & 1 ? ex : ox,
      c & 2 ? ey : oy,
      c & 4 ? ez : oz,
    )
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k])
      max[k] = Math.max(max[k], p[k])
    }
  }
  return { min, max }
}

// Build a block face on a GIVEN axis-aligned plane (`axis` + un-exploded
// `planeMM`) rather than the block's box-entry face — used to draw an SVG on the
// CLIP PLANE cut instead of the block's front face. Returns null if the plane does
// not pass through the block on that axis. The rectangle is the block's in-plane
// extent, inset like pickExplodedBlockFace so re-explode stays on this block.
// `hitInPlane` (un-exploded mm on the two in-plane axes, in `[(axis+1)%3,
// (axis+2)%3]` order) is the stroke's first point; omit it to start at the face
// centre. Passing the real ray/cut hit avoids a spurious spike from the centre.
export function blockFaceOnPlaneMM(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  chunkIndex: number,
  axis: 0 | 1 | 2,
  planeMM: number,
  hitInPlane?: readonly [number, number],
): ExplodedBlockFace | null {
  const geom = explodedBlockGeom(plan, matRAS, explode, chunkIndex)
  if (!geom) return null
  const { lo, hi, off, mmPerVox } = geom
  const loAxU = lo[axis] - off[axis]
  const hiAxU = hi[axis] - off[axis]
  // The plane must cut through this block's data on `axis`.
  if (planeMM < Math.min(loAxU, hiAxU) || planeMM > Math.max(loAxU, hiAxU)) {
    return null
  }
  // Keep the plane a little off the block's own boundary on that axis, too.
  const m = Math.min(INSET_VOX * mmPerVox[axis], Math.abs(hiAxU - loAxU) / 2)
  const clampedPlane = Math.max(
    Math.min(loAxU, hiAxU) + m,
    Math.min(Math.max(loAxU, hiAxU) - m, planeMM),
  )
  const a = ((axis + 1) % 3) as 0 | 1 | 2
  const b = ((axis + 2) % 3) as 0 | 1 | 2
  const [loA, hiA] = insetRange(
    lo[a] - off[a],
    hi[a] - off[a],
    INSET_VOX * mmPerVox[a],
  )
  const [loB, hiB] = insetRange(
    lo[b] - off[b],
    hi[b] - off[b],
    INSET_VOX * mmPerVox[b],
  )
  const entryMM: [number, number, number] = [0, 0, 0]
  entryMM[axis] = clampedPlane
  // Start at the real hit (clamped into the inset rect) if given, else the centre.
  entryMM[a] = hitInPlane
    ? Math.max(loA, Math.min(hiA, hitInPlane[0]))
    : (loA + hiA) / 2
  entryMM[b] = hitInPlane
    ? Math.max(loB, Math.min(hiB, hitInPlane[1]))
    : (loB + hiB) / 2
  return {
    chunkIndex,
    axis,
    planeMM: clampedPlane,
    inPlaneAxes: [a, b],
    loMM: [loA, loB],
    hiMM: [hiA, hiB],
    entryMM,
    explodeOffsetMM: off,
  }
}

// Convert an axis-aligned clip plane (one `[nx,ny,nz,a]` tuple, read from the start
// of `clipPlanes`) to an mm drawing plane (face-normal mm axis + un-exploded depth),
// for drawing an SVG on the clip cut. `clipPlanes` is in [0,1]^3 object space (kept
// side dot(n,p-0.5) >= a); `tex2mm` maps object frac -> mm (column-major mat4).
// Returns null when: no clip / the plane is parked outside the volume (after
// normalizing the normal, |a| > 0.5*L1(n), e.g. depth 2 = "no clip") / the normal is
// not object-axis-aligned (one component ~+-1 after normalizing, the rest ~0) / it
// does not map to a single mm axis (an oblique mm plane the axis-aligned annotation
// model can't represent). `clipDrawPlanesMM` calls this per plane index.
export function clipPlaneToMMAxisPlane(
  clipPlanes: ArrayLike<number> | null | undefined,
  tex2mm: ArrayLike<number> | null | undefined,
): { axis: 0 | 1 | 2; planeMM: number } | null {
  if (!clipPlanes || clipPlanes.length < 4 || !tex2mm) return null
  // Normalize the normal so `a` and the axis test are scale-invariant — a direct
  // model write / document restore can carry an un-normalized normal (public setters
  // normalize via sph2cartDeg). Plane dot(n,p-0.5)=a scales to dot(n/|n|, .)=a/|n|.
  const len = Math.hypot(clipPlanes[0], clipPlanes[1], clipPlanes[2])
  if (len < 1e-6) return null
  const n = [clipPlanes[0] / len, clipPlanes[1] / len, clipPlanes[2] / len]
  const a = clipPlanes[3] / len
  const l1 = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])
  if (Math.abs(a) > 0.5 * l1 + 1e-6) return null
  // Object-axis-aligned: exactly one component ~+-1, the other two ~0.
  let objAxis = -1
  for (let k = 0; k < 3; k++) {
    if (Math.abs(Math.abs(n[k]) - 1) < 1e-3) objAxis = k
  }
  if (objAxis < 0) return null
  const offAxis = [0, 1, 2].every((k) => k === objAxis || Math.abs(n[k]) < 1e-3)
  if (!offAxis) return null
  const M = tex2mm
  // Apply the column-major tex2mm mat4 to a point (w=1) or direction (w=0).
  const xf = (
    x: number,
    y: number,
    z: number,
    w: number,
  ): [number, number, number] => [
    M[0] * x + M[4] * y + M[8] * z + M[12] * w,
    M[1] * x + M[5] * y + M[9] * z + M[13] * w,
    M[2] * x + M[6] * y + M[10] * z + M[14] * w,
  ]
  const pf: [number, number, number] = [0.5, 0.5, 0.5]
  pf[objAxis] = 0.5 + a / n[objAxis]
  const mmPt = xf(pf[0], pf[1], pf[2], 1)
  const e: [number, number, number] = [0, 0, 0]
  e[objAxis] = 1
  const dir = xf(e[0], e[1], e[2], 0)
  let mmAxis = 0
  for (let k = 1; k < 3; k++) {
    if (Math.abs(dir[k]) > Math.abs(dir[mmAxis])) mmAxis = k
  }
  const dom = Math.abs(dir[mmAxis])
  if (dom < 1e-6) return null
  const aligned = [0, 1, 2].every(
    (k) => k === mmAxis || Math.abs(dir[k]) < 1e-3 * dom,
  )
  if (!aligned) return null
  return { axis: mmAxis as 0 | 1 | 2, planeMM: mmPt[mmAxis] }
}

// True when matRAS maps voxel axes to mm axes as a generalized permutation (each
// voxel axis' mm direction is dominated by a single, distinct mm axis) — i.e. no
// rotation or shear. The block-face drawing builds an mm axis-aligned plane from a
// block's mm AABB, which only matches the visible block face when this holds; on an
// oblique/sheared volume the AABB is a loose box and the committed SVG would land on
// the wrong plane, so callers gate the feature on this.
export function isMatRASAxisAligned(matRAS: ArrayLike<number>): boolean {
  const seen = new Set<number>()
  for (let j = 0; j < 3; j++) {
    // mm direction of voxel axis j = column j of the row-major linear part.
    const col = [matRAS[j], matRAS[4 + j], matRAS[8 + j]]
    let dom = 0
    for (let k = 1; k < 3; k++) {
      if (Math.abs(col[k]) > Math.abs(col[dom])) dom = k
    }
    const mag = Math.abs(col[dom])
    if (mag < 1e-6) return false
    for (let k = 0; k < 3; k++) {
      if (k !== dom && Math.abs(col[k]) > 1e-3 * mag) return false
    }
    seen.add(dom)
  }
  return seen.size === 3
}

// An axis-aligned clip plane as an mm drawing plane (face-normal axis + un-exploded
// depth), as produced by clipPlaneToMMAxisPlane.
export interface ClipDrawPlane {
  axis: 0 | 1 | 2
  planeMM: number
}

// Pick the block whose CLIP-PLANE cut surface the ray hits first, and return its
// clip-plane face. Considers EVERY given plane (there can be several active clip
// planes, on different axes) and keeps the NEAREST cut the ray actually enters — so
// the SVG lands on whichever cut the user is looking at. The clip cuts every block
// at the same UN-EXPLODED depth (planeMM on its axis), so each block's visible cut
// sits at planeMM + the block's explode offset; we intersect the ray with each
// block's exploded cut plane and keep the nearest whose hit lands within that
// block's rectangle. This does NOT rely on the tissue pick (which ignores the
// cutaway and would land on a removed front block). Returns null when the ray hits
// no cut. `allowed` restricts to visible blocks.
export function pickClipPlaneBlockFace(
  plan: ChunkPlan,
  matRAS: ArrayLike<number>,
  explode: ChunkExplodeOptions | null | undefined,
  rayOrigin: readonly [number, number, number],
  rayDir: readonly [number, number, number],
  planes: ReadonlyArray<ClipDrawPlane>,
  opts: { allowed?: ReadonlySet<number> } = {},
): ExplodedBlockFace | null {
  if (!chunkExplodeEnabled(explode) || planes.length === 0) return null
  let bestT = Number.POSITIVE_INFINITY
  let bestCi = -1
  let bestAxis: 0 | 1 | 2 = 0
  let bestPlaneMM = 0
  // The ray/cut hit on the winning block, in UN-EXPLODED in-plane mm — so the
  // stroke's first point is where the user clicked, not the block-face centre.
  let bestHit: [number, number] | undefined
  for (let ci = 0; ci < plan.chunks.length; ci++) {
    if (opts.allowed && !opts.allowed.has(ci)) continue
    const geom = explodedBlockGeom(plan, matRAS, explode, ci)
    if (!geom) continue
    const { lo, hi, off } = geom
    for (const { axis, planeMM } of planes) {
      const dAxis = rayDir[axis]
      if (Math.abs(dAxis) < 1e-9) continue
      const a = (axis + 1) % 3
      const b = (axis + 2) % 3
      // The clip must actually cut this block (planeMM in its un-exploded range).
      const loAxU = lo[axis] - off[axis]
      const hiAxU = hi[axis] - off[axis]
      if (
        planeMM < Math.min(loAxU, hiAxU) ||
        planeMM > Math.max(loAxU, hiAxU)
      ) {
        continue
      }
      // This block's cut surface in exploded mm, and where the ray crosses it.
      const t = (planeMM + off[axis] - rayOrigin[axis]) / dAxis
      if (t <= 0 || t >= bestT) continue
      const ha = rayOrigin[a] + t * rayDir[a]
      const hb = rayOrigin[b] + t * rayDir[b]
      if (ha < lo[a] || ha > hi[a] || hb < lo[b] || hb > hi[b]) continue
      bestT = t
      bestCi = ci
      bestAxis = axis
      bestPlaneMM = planeMM
      bestHit = [ha - off[a], hb - off[b]]
    }
  }
  if (bestCi < 0) return null
  return blockFaceOnPlaneMM(
    plan,
    matRAS,
    explode,
    bestCi,
    bestAxis,
    bestPlaneMM,
    bestHit,
  )
}

/**
 * Intersect a ray with a block face and return the mm point, clamped to the face
 * rectangle so it stays ON the block. The ray is in EXPLODED space (unprojected
 * from the exploded render); the face is un-exploded, so the ray origin is shifted
 * by the block's explode offset before intersecting, and the result is un-exploded
 * mm (ready to store as an annotation vertex). Returns null when the ray is
 * parallel to the face or the crossing is behind the origin.
 */
export function rayBlockFacePointMM(
  face: ExplodedBlockFace,
  rayOrigin: readonly [number, number, number],
  rayDir: readonly [number, number, number],
): [number, number, number] | null {
  const dAxis = rayDir[face.axis]
  if (Math.abs(dAxis) < 1e-9) return null
  const [a, b] = face.inPlaneAxes
  // Move the ray into un-exploded space (the face's space): exploded = unexploded
  // + offset, so subtract the offset from the origin (direction is unchanged).
  const oAxis = rayOrigin[face.axis] - face.explodeOffsetMM[face.axis]
  const oa = rayOrigin[a] - face.explodeOffsetMM[a]
  const ob = rayOrigin[b] - face.explodeOffsetMM[b]
  const t = (face.planeMM - oAxis) / dAxis
  if (t <= 0) return null
  const pa = Math.max(face.loMM[0], Math.min(face.hiMM[0], oa + t * rayDir[a]))
  const pb = Math.max(face.loMM[1], Math.min(face.hiMM[1], ob + t * rayDir[b]))
  const out: [number, number, number] = [0, 0, 0]
  out[face.axis] = face.planeMM
  out[a] = pa
  out[b] = pb
  return out
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

/**
 * World-mm translation of the exploded block that contains the voxel at volume
 * fraction `frac` ([0,1] per axis), or [0,0,0] when explode is off / the point is
 * outside the volume / no block contains it. Used to shift an overlay (e.g. the
 * 3D crosshair) onto its displaced block. Scans chunks, so it works for
 * non-uniform (multi-LOD) plans — not just the uniform grid that
 * `gridIndex`/`stride` assume. The translation matches `chunkExplodedMatRAS`.
 */
export function explodeOffsetMMAtFrac(
  plan: ChunkPlan,
  explode: ChunkExplodeOptions | null | undefined,
  matRAS: ArrayLike<number>,
  frac: ArrayLike<number>,
): Vec3f {
  if (!chunkExplodeEnabled(explode)) return [0, 0, 0]
  const [vx, vy, vz] = plan.volumeDims
  const voxel = [
    Math.floor((frac[0] ?? 0.5) * vx),
    Math.floor((frac[1] ?? 0.5) * vy),
    Math.floor((frac[2] ?? 0.5) * vz),
  ]
  let chunkIndex = -1
  for (let i = 0; i < plan.chunks.length; i++) {
    const c = plan.chunks[i]
    if (
      voxel[0] >= c.voxelOrigin[0] &&
      voxel[0] < c.voxelOrigin[0] + c.voxelDims[0] &&
      voxel[1] >= c.voxelOrigin[1] &&
      voxel[1] < c.voxelOrigin[1] + c.voxelDims[1] &&
      voxel[2] >= c.voxelOrigin[2] &&
      voxel[2] < c.voxelOrigin[2] + c.voxelDims[2]
    ) {
      chunkIndex = i
      break
    }
  }
  if (chunkIndex < 0) return [0, 0, 0]
  const off = chunkExplodeOffsetFrac(plan, chunkIndex, explode)
  const ox = off[0] * vx
  const oy = off[1] * vy
  const oz = off[2] * vz
  return [
    ox * matRAS[0] + oy * matRAS[1] + oz * matRAS[2],
    ox * matRAS[4] + oy * matRAS[5] + oz * matRAS[6],
    ox * matRAS[8] + oy * matRAS[9] + oz * matRAS[10],
  ]
}
