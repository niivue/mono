/**
 * Chunking math for tiled volume rendering.
 *
 * Splits an oversized volume into axis-aligned sub-volumes ("chunks"), each
 * sized to fit within the GPU's `maxTextureDimension3D`. Each chunk carries
 * a per-face halo of voxels copied from its neighbours so that trilinear
 * sampling at chunk seams reads valid data and produces no visible boundary.
 *
 * Pure metadata only — no GPU resources, no typed-array slicing. Renderer
 * code (Phase 2) consumes `ChunkPlan` to drive per-chunk uploads and draws.
 *
 * See `docs/tiled-volumes.md` for the broader design.
 */

import { log } from '@/logger'

export type Vec3i = [number, number, number]

/** Three floating-point components. */
export type Vec3f = [number, number, number]

export interface VolumeChunkDesc {
  /** First data voxel in volume voxel coords (excludes halo). */
  voxelOrigin: Vec3i
  /** Data extent in voxels (excludes halo). */
  voxelDims: Vec3i
  /** Halo voxels appended on the low (origin) side, per axis. 0 at boundary. */
  haloLow: Vec3i
  /** Halo voxels appended on the high side, per axis. 0 at boundary. */
  haloHigh: Vec3i
  /** Texture extent in voxels = voxelDims + haloLow + haloHigh. ≤ deviceLimit. */
  texDims: Vec3i
  /** Texture's first voxel in volume voxel coords = voxelOrigin − haloLow. */
  texOrigin: Vec3i
  /** Position in the chunk grid (0-indexed). */
  gridIndex: Vec3i
  /**
   * Pyramid level this brick's texture is fetched from. 0 = finest (= the
   * common reference grid). Absent/0 for single-level plans.
   *
   * MULTI-LOD COORDINATE SPLIT (`chunkVolumeMultiLOD` only): when `sourceLevel`
   * is set, `voxelOrigin`/`voxelDims` are in the COMMON (finest, level-0) grid —
   * they drive world placement (`voxelOrigin/voxelDims ÷ plan.volumeDims` gives
   * the brick's sub-cube of the [0,1] world cube, used by all visibility/culling
   * math and `chunkSubOrigin/Size`). In contrast `texOrigin`/`texDims`/`haloLow`/
   * `haloHigh` are in THIS brick's own level grid — they drive the fetch bbox,
   * the uploaded texture size, and the in-texture halo remap. For single-level
   * plans the two grids coincide so every consumer is unchanged.
   */
  sourceLevel?: number
}

export interface ChunkPlan {
  /** Number of chunks per axis. Their product equals chunks.length. */
  gridDims: Vec3i
  /** Distance in voxels between successive chunk data origins, per axis. */
  stride: Vec3i
  /** Chunks in row-major order: index = (z * gy + y) * gx + x. */
  chunks: VolumeChunkDesc[]
  /** Volume voxel dimensions this plan tiles (the COMMON / finest grid). */
  volumeDims: Vec3i
  /** Device limit used to compute this plan. */
  deviceLimit: number
  /** Halo width per axis. */
  haloSize: Vec3i
  /**
   * Full-volume voxel dims per pyramid level, indexed by `VolumeChunkDesc.sourceLevel`
   * (`levelDims[0]` === `volumeDims`). Set only by `chunkVolumeMultiLOD`; used to
   * pick a brick's ray-march step density from its source level. Absent for
   * single-level plans (consumers fall back to `volumeDims`).
   */
  levelDims?: Vec3i[]
}

/**
 * Build a chunk plan for a volume of the given voxel dimensions.
 *
 * @param volumeDims  Volume size in voxels, [w, h, d].
 * @param deviceLimit `maxTextureDimension3D` reported by the GPU device.
 * @param haloSize    Per-axis halo width. Default [1,1,1] — the minimum for
 *                    seam-free trilinear sampling. Use [0,0,0] when the
 *                    caller will sample with nearest-neighbour only.
 */
export function chunkVolume(
  volumeDims: Vec3i,
  deviceLimit: number,
  haloSize: Vec3i = [1, 1, 1],
): ChunkPlan {
  if (deviceLimit < 1) {
    throw new Error(
      `chunkVolume: deviceLimit must be >= 1 (got ${deviceLimit})`,
    )
  }
  for (let a = 0; a < 3; a++) {
    if (volumeDims[a] < 1) {
      throw new Error(
        `chunkVolume: volumeDims[${a}] must be >= 1 (got ${volumeDims[a]})`,
      )
    }
    if (haloSize[a] < 0) {
      throw new Error(
        `chunkVolume: haloSize[${a}] must be >= 0 (got ${haloSize[a]})`,
      )
    }
    if (deviceLimit < 2 * haloSize[a] + 1) {
      throw new Error(
        `chunkVolume: deviceLimit (${deviceLimit}) too small for halo ` +
          `${haloSize[a]} on axis ${a}; need at least ${2 * haloSize[a] + 1}`,
      )
    }
  }

  const stride: Vec3i = [0, 0, 0]
  const gridDims: Vec3i = [1, 1, 1]
  for (let a = 0; a < 3; a++) {
    if (volumeDims[a] <= deviceLimit) {
      // Whole axis fits in one chunk — no halo needed since there's no neighbour.
      stride[a] = volumeDims[a]
      gridDims[a] = 1
    } else {
      stride[a] = deviceLimit - 2 * haloSize[a]
      gridDims[a] = Math.ceil(volumeDims[a] / stride[a])
    }
  }

  const chunks: VolumeChunkDesc[] = []
  for (let cz = 0; cz < gridDims[2]; cz++) {
    for (let cy = 0; cy < gridDims[1]; cy++) {
      for (let cx = 0; cx < gridDims[0]; cx++) {
        const gridIndex: Vec3i = [cx, cy, cz]
        const voxelOrigin: Vec3i = [0, 0, 0]
        const voxelDims: Vec3i = [0, 0, 0]
        const haloLow: Vec3i = [0, 0, 0]
        const haloHigh: Vec3i = [0, 0, 0]
        const texOrigin: Vec3i = [0, 0, 0]
        const texDims: Vec3i = [0, 0, 0]
        for (let a = 0; a < 3; a++) {
          const idx = gridIndex[a]
          const origin = idx * stride[a]
          const dataEnd = Math.min(origin + stride[a], volumeDims[a])
          const data = dataEnd - origin
          // Halo only on faces that have a neighbour in this axis direction.
          // Single-chunk axes (gridDims === 1) get 0 halo on both sides.
          const isFirst = idx === 0
          const isLast = idx === gridDims[a] - 1
          const hLow = isFirst ? 0 : haloSize[a]
          const hHigh = isLast ? 0 : haloSize[a]
          voxelOrigin[a] = origin
          voxelDims[a] = data
          haloLow[a] = hLow
          haloHigh[a] = hHigh
          texOrigin[a] = origin - hLow
          texDims[a] = data + hLow + hHigh
        }
        chunks.push({
          voxelOrigin,
          voxelDims,
          haloLow,
          haloHigh,
          texDims,
          texOrigin,
          gridIndex,
        })
      }
    }
  }
  return {
    gridDims,
    stride,
    chunks,
    volumeDims,
    deviceLimit,
    haloSize,
  }
}

/**
 * Build a chunk plan with an explicit grid size.
 *
 * This is useful for visualization modes that want stable semantic cells
 * (for example a 3x3x3 exploded view) even when the source volume would
 * otherwise fit in one texture. Each axis is partitioned into `gridDims[a]`
 * non-empty chunks using a constant ceil stride so `chunkAtVoxel` remains
 * well-defined.
 */
export function chunkVolumeGrid(
  volumeDims: Vec3i,
  gridDims: Vec3i,
  deviceLimit: number,
  haloSize: Vec3i = [1, 1, 1],
): ChunkPlan {
  if (deviceLimit < 1) {
    throw new Error(
      `chunkVolumeGrid: deviceLimit must be >= 1 (got ${deviceLimit})`,
    )
  }

  const stride: Vec3i = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    if (volumeDims[a] < 1) {
      throw new Error(
        `chunkVolumeGrid: volumeDims[${a}] must be >= 1 (got ${volumeDims[a]})`,
      )
    }
    if (!Number.isInteger(gridDims[a]) || gridDims[a] < 1) {
      throw new Error(
        `chunkVolumeGrid: gridDims[${a}] must be a positive integer (got ${gridDims[a]})`,
      )
    }
    if (gridDims[a] > volumeDims[a]) {
      throw new Error(
        `chunkVolumeGrid: gridDims[${a}] (${gridDims[a]}) cannot exceed ` +
          `volumeDims[${a}] (${volumeDims[a]})`,
      )
    }
    if (haloSize[a] < 0) {
      throw new Error(
        `chunkVolumeGrid: haloSize[${a}] must be >= 0 (got ${haloSize[a]})`,
      )
    }
    if (deviceLimit < 2 * haloSize[a] + 1) {
      throw new Error(
        `chunkVolumeGrid: deviceLimit (${deviceLimit}) too small for halo ` +
          `${haloSize[a]} on axis ${a}; need at least ${2 * haloSize[a] + 1}`,
      )
    }
    stride[a] = Math.ceil(volumeDims[a] / gridDims[a])
  }

  const chunks: VolumeChunkDesc[] = []
  for (let cz = 0; cz < gridDims[2]; cz++) {
    for (let cy = 0; cy < gridDims[1]; cy++) {
      for (let cx = 0; cx < gridDims[0]; cx++) {
        const gridIndex: Vec3i = [cx, cy, cz]
        const voxelOrigin: Vec3i = [0, 0, 0]
        const voxelDims: Vec3i = [0, 0, 0]
        const haloLow: Vec3i = [0, 0, 0]
        const haloHigh: Vec3i = [0, 0, 0]
        const texOrigin: Vec3i = [0, 0, 0]
        const texDims: Vec3i = [0, 0, 0]
        for (let a = 0; a < 3; a++) {
          const idx = gridIndex[a]
          const origin = idx * stride[a]
          const dataEnd = Math.min(origin + stride[a], volumeDims[a])
          const data = dataEnd - origin
          const hLow = idx === 0 ? 0 : haloSize[a]
          const hHigh = idx === gridDims[a] - 1 ? 0 : haloSize[a]
          voxelOrigin[a] = origin
          voxelDims[a] = data
          haloLow[a] = hLow
          haloHigh[a] = hHigh
          texOrigin[a] = origin - hLow
          texDims[a] = data + hLow + hHigh
          if (data < 1) {
            throw new Error(
              `chunkVolumeGrid: gridDims[${a}] produced an empty chunk`,
            )
          }
          if (texDims[a] > deviceLimit) {
            throw new Error(
              `chunkVolumeGrid: chunk texture dim ${texDims[a]} on axis ${a} ` +
                `exceeds deviceLimit ${deviceLimit}`,
            )
          }
        }
        chunks.push({
          voxelOrigin,
          voxelDims,
          haloLow,
          haloHigh,
          texDims,
          texOrigin,
          gridIndex,
        })
      }
    }
  }

  return {
    gridDims,
    stride,
    chunks,
    volumeDims,
    deviceLimit,
    haloSize,
  }
}

/**
 * Minimum per-face halo a brick needs for HARDWARE TRILINEAR reconstruction.
 *
 * `chunkTexCoord` maps a brick's owned world cube onto texture coordinates
 * `[haloLow, haloLow + data]`, i.e. continuous voxel index
 * `[haloLow - 0.5, haloLow + data - 0.5]`: a ray sample can land half a voxel
 * PAST the outermost owned voxel centre, right on the brick face. A trilinear
 * fetch there straddles the face, so it needs one voxel of neighbour data.
 */
export const LINEAR_MIN_HALO = 1

/**
 * Minimum per-face halo a brick needs for TRICUBIC B-spline reconstruction.
 *
 * `sampleTricubic` reads texels `floor(x) - 1 .. floor(x) + 2`. At the face
 * sample above (`x = haloLow - 0.5`) that reaches `haloLow - 2`, so two voxels
 * of neighbour data are required. Measured on chris_t1 with a 48-voxel brick:
 * halo 1 leaves up to 0.42% of the intensity range of clamp-to-edge error in a
 * half-voxel sheet on every internal face (1.8% on a binary worst case); halo 2
 * reproduces the whole-volume reconstruction exactly.
 */
export const CUBIC_MIN_HALO = 2

/**
 * Linear downsample factor of a brick's source pyramid level relative to the
 * common (finest) grid — the geometric mean of the three per-axis ratios, so a
 * pyramid that decimates anisotropically still yields one scalar.
 *
 * 1 for the finest level, for single-level plans (no `levelDims`), and for
 * non-chunked draws. Consumers use it to compensate the brightness a coarse
 * brick loses in the ray-march: averaging voxels destroys the correlation
 * between a sample's colour and its opacity, and front-to-back compositing
 * weights colour by opacity, so a downsampled brick integrates darker than the
 * fine data it stands in for. See `lodGammaExponent`.
 */
export function chunkLodDownsample(
  plan: ChunkPlan,
  desc: VolumeChunkDesc,
): number {
  const level = desc.sourceLevel ?? 0
  if (level === 0 || !plan.levelDims) return 1
  const dims = plan.levelDims[level]
  if (!dims) return 1
  return dimsDownsample(plan.volumeDims, dims)
}

/**
 * `chunkLodDownsample` for data whose dims are known directly rather than via a
 * plan level — the coarse floor, which is its own whole-volume texture and is
 * not a member of `plan.chunks`.
 *
 * The floor is typically the COARSEST data on screen, so leaving it
 * uncompensated puts the largest brightness step in the scene exactly at the
 * boundary of the resident fine region, which is where it is most visible.
 */
export function dimsDownsample(volumeDims: Vec3i, dataDims: Vec3i): number {
  let product = 1
  for (let a = 0; a < 3; a++) {
    const ratio = volumeDims[a] / dataDims[a]
    if (!Number.isFinite(ratio) || ratio <= 0) return 1
    product *= ratio
  }
  const k = Math.cbrt(product)
  return Number.isFinite(k) && k > 1 ? k : 1
}

/**
 * True when every brick in `plan` carries enough halo for a reconstruction
 * kernel that reaches `minHalo` voxels past a face, so no sample inside a
 * brick's owned region reads fabricated (clamp-to-edge) data at an INTERNAL
 * boundary. A face that lies on the level's own boundary is always fine: there
 * is no neighbour data, and the brick's clamp reproduces the whole-volume
 * clamp exactly.
 */
export function planSupportsHalo(plan: ChunkPlan, minHalo: number): boolean {
  for (const c of plan.chunks) {
    const dims = plan.levelDims?.[c.sourceLevel ?? 0] ?? plan.volumeDims
    for (let a = 0; a < 3; a++) {
      // Low face: the kernel needs level voxels down to `dataOrigin - minHalo`,
      // clamped at 0. They are all present iff the texture starts at or before
      // that, which is either a full halo or the level boundary itself.
      if (c.texOrigin[a] > 0 && c.haloLow[a] < minHalo) return false
      // High face: mirror image.
      const texEnd = c.texOrigin[a] + c.texDims[a]
      if (texEnd < dims[a] && c.haloHigh[a] < minHalo) return false
    }
  }
  return true
}

/** True when `plan`'s bricks can be tricubic-sampled without seaming. */
export function planSupportsCubic(plan: ChunkPlan): boolean {
  return planSupportsHalo(plan, CUBIC_MIN_HALO)
}

/** Last reported cubic safety per volume, so a re-plan only warns on a change. */
const cubicWarned = new Map<string, boolean>()

/**
 * Warn once (per volume, per transition) when the tricubic filter is on but the
 * volume's chunk plan cannot support it, so the renderer's silent fallback to
 * trilinear is visible in the log rather than mistaken for a broken filter.
 * Shared by both backends so the message and the trigger cannot drift apart.
 */
export function warnIfCubicUnsafe(
  volumeName: string,
  cubicSafe: boolean,
  cubicRequested: boolean,
): void {
  if (cubicSafe) {
    cubicWarned.delete(volumeName)
    return
  }
  if (!cubicRequested || cubicWarned.get(volumeName)) return
  cubicWarned.set(volumeName, true)
  log.warn(
    `Volume ${volumeName}: cubic interpolation is disabled for its streamed ` +
      `chunks. The chunk plan carries less than ${CUBIC_MIN_HALO} voxels of ` +
      `halo on at least one internal brick face, and the cubic kernel reads ` +
      `${CUBIC_MIN_HALO} voxels past a face, so it would reconstruct from ` +
      `clamp-to-edge data and seam. Re-plan with halo >= ${CUBIC_MIN_HALO} ` +
      `(NVChunkedVolume does this automatically) to enable it.`,
  )
}

/**
 * True when a volume of the given dims needs to be chunked (any axis
 * exceeds the device limit). Cheap pre-check before calling `chunkVolume`.
 */
export function needsChunking(volumeDims: Vec3i, deviceLimit: number): boolean {
  return (
    volumeDims[0] > deviceLimit ||
    volumeDims[1] > deviceLimit ||
    volumeDims[2] > deviceLimit
  )
}

/**
 * Indices of the chunks a single axis-aligned slice plane crosses.
 *
 * A slice plane is perpendicular to one volume axis (`sliceAxis`: 0=x, 1=y,
 * 2=z) at fractional position `sliceFrac` in [0,1]. The plane intersects
 * exactly one layer of chunks along that axis; this returns every chunk in
 * that layer (the full in-plane grid), in `plan.chunks` order.
 */
export function chunksCrossingSlice(
  plan: ChunkPlan,
  sliceAxis: number,
  sliceFrac: number,
): number[] {
  const a = sliceAxis
  // Convert the [0,1] slice fraction to a voxel coordinate, then keep only the
  // bricks whose DATA extent (halo excluded) spans it along the slice axis. This
  // works for both grid plans (a brick's extent === its layer) AND multi-LOD
  // plans, whose degenerate gridDims=[1,1,1]/gridIndex=[0,0,0] made the old
  // layer-based test return every brick (no depth culling -> heavy over-stream).
  const voxel = sliceFrac * plan.volumeDims[a]
  const clamped = Math.max(0, Math.min(plan.volumeDims[a] - 1e-3, voxel))
  const out: number[] = []
  for (let i = 0; i < plan.chunks.length; i++) {
    const c = plan.chunks[i]
    const lo = c.voxelOrigin[a]
    const hi = lo + c.voxelDims[a]
    if (clamped >= lo && clamped < hi) out.push(i)
  }
  return out
}

/**
 * Where a brick's OWNED region sits inside its own texture, as a fraction of
 * that texture: `origin` is the low corner, `size` the extent, per axis.
 *
 * The owned region is the brick's COMMON-grid box (`voxelOrigin`/`voxelDims`,
 * which fixes where the brick sits in the world) expressed in the brick's own
 * LEVEL grid. For a single-level plan the two grids coincide, so this is just
 * the halo-inset data box.
 *
 * For a multi-LOD brick they do NOT coincide. `emitBrick` snaps the fetch box
 * out to whole LEVEL voxels, so the fetched data covers up to one level voxel
 * more than the brick owns on each face; at level 4 of the hoa_heart pyramid
 * one level voxel is 16 common voxels. Treating the fetched box as the owned
 * box shifts and stretches the brick's content (measured up to 8.7 common
 * voxels of offset and 23.7 of stretch on that pyramid), and because
 * neighbouring bricks snap independently, their shared face carries a content
 * discontinuity: a seam that no brightness compensation can remove, because it
 * is geometric. Mapping the TRUE owned box makes two neighbours evaluate the
 * same level coordinate at their shared face, so the content lines up.
 *
 * Shared by every consumer of the remap (both backends' `chunkUniformsFor` and
 * `chunkSampleTransform`) so the two backends cannot drift apart.
 */
export function chunkOwnedTexBox(
  plan: ChunkPlan,
  desc: VolumeChunkDesc,
): { origin: Vec3f; size: Vec3f } {
  const level = desc.sourceLevel ?? 0
  const levelDims = level === 0 ? undefined : plan.levelDims?.[level]
  const origin: Vec3f = [0, 0, 0]
  const size: Vec3f = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const tex = desc.texDims[a]
    if (!levelDims) {
      // Grids coincide: the owned box IS the halo-inset data box. Derived from
      // the halos rather than voxelDims so a texture truncated by the device
      // limit keeps the exact value it had before this helper existed.
      origin[a] = desc.haloLow[a] / tex
      size[a] = (tex - desc.haloLow[a] - desc.haloHigh[a]) / tex
      continue
    }
    const scale = levelDims[a] / plan.volumeDims[a]
    // Common voxel coords -> level voxel coords -> texture-local voxel coords.
    const lo = desc.voxelOrigin[a] * scale - desc.texOrigin[a]
    const hi =
      (desc.voxelOrigin[a] + desc.voxelDims[a]) * scale - desc.texOrigin[a]
    // Clamp for a texture the device limit truncated: the tail of the owned box
    // was never uploaded, so sampling it would read past the texture.
    const loTex = Math.max(0, Math.min(tex, lo))
    const hiTex = Math.max(loTex, Math.min(tex, hi))
    origin[a] = loTex / tex
    size[a] = (hiTex - loTex) / tex
  }
  return { origin, size }
}

/**
 * Sampling transform for one chunk: maps a position in the full-volume [0,1]
 * cube to a sample coordinate in the chunk's local texture (halo included).
 *
 * `subOrigin`/`subSize` describe the chunk's data region as a sub-cube of the
 * full-volume [0,1] cube. `dataOrigin`/`dataSize` describe that same data
 * region inside the chunk's own texture (skipping the halo). A sampler does:
 *   local = (p - subOrigin) / subSize * dataSize + dataOrigin
 * Non-chunked volumes use the identity transform (subOrigin 0, subSize 1,
 * dataOrigin 0, dataSize 1).
 */
export interface ChunkSampleTransform {
  /** Chunk data-region origin in the full-volume [0,1] cube. */
  subOrigin: Vec3f
  /** Chunk data-region size in the full-volume [0,1] cube. */
  subSize: Vec3f
  /** Halo offset in the chunk's local texture (skips low-side halo). */
  dataOrigin: Vec3f
  /** Data extent in the chunk's local texture (excludes halo on both sides). */
  dataSize: Vec3f
  /** Full volume voxel dims (texture-size-independent sub-voxel math). */
  volumeDims: Vec3f
  /**
   * Linear downsample factor of this chunk's source pyramid level relative to
   * the finest grid (see `chunkLodDownsample`). 1 for the identity transform
   * and for every single-level plan; consumers use it to compensate the
   * brightness a coarse brick loses.
   */
  lodDownsample: number
}

/** Build the sampling transform for a single chunk of a plan. */
export function chunkSampleTransform(
  plan: ChunkPlan,
  chunkIndex: number,
): ChunkSampleTransform {
  const desc = plan.chunks[chunkIndex]
  const [vx, vy, vz] = plan.volumeDims
  // The chunk's OWNED box inside its own texture — not the fetched box, which
  // a multi-LOD brick snaps out to whole level voxels. See `chunkOwnedTexBox`.
  const owned = chunkOwnedTexBox(plan, desc)
  return {
    subOrigin: [
      desc.voxelOrigin[0] / vx,
      desc.voxelOrigin[1] / vy,
      desc.voxelOrigin[2] / vz,
    ],
    subSize: [
      desc.voxelDims[0] / vx,
      desc.voxelDims[1] / vy,
      desc.voxelDims[2] / vz,
    ],
    dataOrigin: owned.origin,
    dataSize: owned.size,
    volumeDims: [vx, vy, vz],
    lodDownsample: chunkLodDownsample(plan, desc),
  }
}

/** Identity sampling transform — for non-chunked single-texture volumes. */
export function identityChunkSampleTransform(
  volumeDims: Vec3f,
): ChunkSampleTransform {
  return {
    subOrigin: [0, 0, 0],
    subSize: [1, 1, 1],
    dataOrigin: [0, 0, 0],
    dataSize: [1, 1, 1],
    volumeDims,
    lodDownsample: 1,
  }
}

/**
 * Find the chunk that owns a given volume voxel coordinate. Returns null
 * if the coordinate is outside the volume. Halo regions are NOT considered
 * — each data voxel belongs to exactly one chunk.
 */
export function chunkAtVoxel(
  plan: ChunkPlan,
  voxel: Vec3i,
): VolumeChunkDesc | null {
  for (let a = 0; a < 3; a++) {
    if (voxel[a] < 0 || voxel[a] >= plan.volumeDims[a]) return null
  }
  const cx = Math.min(
    plan.gridDims[0] - 1,
    Math.floor(voxel[0] / plan.stride[0]),
  )
  const cy = Math.min(
    plan.gridDims[1] - 1,
    Math.floor(voxel[1] / plan.stride[1]),
  )
  const cz = Math.min(
    plan.gridDims[2] - 1,
    Math.floor(voxel[2] / plan.stride[2]),
  )
  const idx = (cz * plan.gridDims[1] + cy) * plan.gridDims[0] + cx
  return plan.chunks[idx] ?? null
}

/**
 * Stable identity of a chunk's fetched content + placement: two chunks with the
 * same key cover the same source-level region and draw into the same world
 * sub-cube, so a resident GPU texture for one can be reused for the other.
 */
function chunkContentKey(d: VolumeChunkDesc): string {
  return (
    `${d.sourceLevel ?? 0}|${d.voxelOrigin.join(',')}|${d.voxelDims.join(',')}` +
    `|${d.texOrigin.join(',')}|${d.texDims.join(',')}`
  )
}

/**
 * Map each chunk of `oldPlan` to the index of the content-identical chunk in
 * `newPlan` (by `chunkContentKey`), for chunks that exist in both. Used to carry
 * resident GPU textures across an in-place plan swap (multi-LOD refocus): bricks
 * unchanged between the two plans keep their texture; the rest are streamed.
 */
export function matchChunksByContent(
  oldPlan: ChunkPlan,
  newPlan: ChunkPlan,
): Map<number, number> {
  const newByKey = new Map<string, number>()
  for (let i = 0; i < newPlan.chunks.length; i++) {
    newByKey.set(chunkContentKey(newPlan.chunks[i]), i)
  }
  const oldToNew = new Map<number, number>()
  for (let i = 0; i < oldPlan.chunks.length; i++) {
    const ni = newByKey.get(chunkContentKey(oldPlan.chunks[i]))
    if (ni !== undefined) oldToNew.set(i, ni)
  }
  return oldToNew
}

/**
 * An axis-aligned box in COMMON (finest, level-0) voxel coordinates. `min` is
 * inclusive and `max` exclusive, so a one-voxel-thin slab at depth z is
 * `{ min: [0, 0, z], max: [w, h, z + 1] }` (any positive thickness works: a
 * brick intersects when its box overlaps the open interval).
 */
export interface MultiLodBounds {
  /** Inclusive lower corner in common-grid voxels. */
  min: Vec3f
  /** Exclusive upper corner in common-grid voxels. */
  max: Vec3f
}

/** A focused region of interest, in COMMON (finest, level-0) voxel coordinates. */
export interface MultiLodFocus {
  /** Focus centre in common-grid voxels. */
  center: Vec3f
  /**
   * Focus radius in common-grid voxels. Bricks whose region lies within this
   * distance of the centre render at the finest level; each further doubling of
   * distance steps one pyramid level coarser.
   */
  radius: number
  /**
   * Regions that must be covered by ONE uniform pyramid level. After the octree
   * pass every brick intersecting any bound is subdivided until nothing coarser
   * than the current level floor remains inside it, so a visible slice never
   * shows a seam between two resolutions. The budget pass keeps re-applying
   * this on each candidate: it may raise the floor (coarsening the bounds
   * uniformly) but never mixes levels inside them. The 2:1 balance is not
   * re-enforced across a bound's faces (that would re-refine every neighbour
   * of a thin slab), so LOD steps there may exceed one level. Omit for the
   * plain distance-driven octree.
   */
  reserveBounds?: MultiLodBounds[]
  /**
   * An un-biased focus (common-grid voxels) whose brick is refined to the
   * finest level in force regardless of `radius` or `detail`, so the point
   * under the crosshair always has a finest-detail brick. "In force" is
   * `minLevel`, or the level floor once the budget pass has raised it: the
   * floor is a hard cap, so this never re-introduces a finer brick into a
   * uniformly coarsened plan. Lets `center` stay biased off cell boundaries
   * (see `focusCenterBiased`) to keep the distance-driven subdivision stable.
   * Only used when `reserveBounds` is empty; omit to keep the plan purely
   * distance-driven.
   */
  reserveCenter?: Vec3f
}

export interface MultiLodOptions {
  /**
   * Target brick texture edge, in the brick's OWN level voxels. A level-ℓ brick
   * covers `cellEdge · (commonDims/levelDims[ℓ])` common voxels, so coarser
   * bricks are physically larger but keep a bounded texture. Default 128.
   */
  cellEdge?: number
  /** Per-axis halo, in the brick's own level voxels. Default [1,1,1]. */
  haloSize?: Vec3i
  /** Coarsest level to use. Default `levelDims.length - 1`. */
  maxLevel?: number
  /**
   * Finest level to use (a max-detail cap): no brick renders finer than this,
   * even at the focus. Default 0 (the finest level). The common reference grid
   * stays level 0, so geometry is unchanged — only the texture detail is capped.
   */
  minLevel?: number
  /**
   * GPU byte budget for the resident brick set (rgba + gradient = 8 B/voxel over
   * each brick's padded texture). When the assignment exceeds it, a global level
   * floor is raised (coarsening the whole volume uniformly) until it fits.
   * Omit/0 to skip budgeting.
   */
  budgetBytes?: number
  /**
   * Scale-relative detail factor controlling LOD falloff. A cell refines while
   * its distance-beyond-`radius` is below `detail · cellSize`, so the level
   * changes by ~1 per cell step. Values >= ~1 keep the octree 2:1 balanced
   * (face-adjacent bricks differ by at most one level => smooth LOD transitions);
   * larger widens the finest core. Default 1. The budget pass only lowers it.
   */
  detail?: number
  /**
   * Maximum number of bricks. The budget pass coarsens (shrinks `detail`, then
   * raises the level floor) until the plan fits, so the renderer's per-tile chunk
   * limit is never exceeded. Omit/0 for no cap.
   */
  maxBricks?: number
  /**
   * EXACT uniform lattice: tile the volume into `gridDims[a]` bricks per axis,
   * every one drawn from `minLevel`. Pins the brick COUNT (which otherwise falls
   * out of `cellEdge` and the pyramid), so a caller can ask for "4 blocks" and
   * get 4. Bypasses the octree entirely: `focus`, `radius`, `detail`,
   * `budgetBytes` and `maxBricks` are all unused. An axis is silently GROWN when
   * its brick would not fit `deviceLimit` (fewer bricks means bigger ones, and a
   * brick over the texture limit would be clamped and sample squashed), so read
   * the plan's own `gridDims` back for what was actually built.
   */
  gridDims?: Vec3i
}

/**
 * Build a Neuroglancer-style per-brick multi-resolution chunk plan.
 *
 * Partitions the whole volume into an octree of non-overlapping bricks: bricks
 * near `focus` are subdivided down to the finest level, bricks further away are
 * emitted at progressively coarser pyramid levels (and are physically larger, so
 * the brick count and per-brick texture stay bounded — unlike a uniform lattice
 * over the finest grid). All bricks composite into the same world cube; the
 * renderer draws each sampling its own level texture (see the coordinate split
 * on `VolumeChunkDesc.sourceLevel`).
 *
 * `levelDims[0]` is the COMMON reference grid (finest level actually used) and
 * becomes `plan.volumeDims`. `levelDims[ℓ]` is the full-volume voxel dims of
 * pyramid level ℓ (densest first). Levels need not be exact powers of two; the
 * common→level mapping rounds per axis.
 */
export function chunkVolumeMultiLOD(
  levelDims: Vec3i[],
  focus: MultiLodFocus,
  deviceLimit: number,
  options: MultiLodOptions = {},
): ChunkPlan {
  if (levelDims.length < 1) {
    throw new Error('chunkVolumeMultiLOD: need at least one level')
  }
  const commonDims = levelDims[0]
  const maxLevel = Math.min(
    options.maxLevel ?? levelDims.length - 1,
    levelDims.length - 1,
  )
  const minLevel = Math.min(
    Math.max(0, Math.floor(options.minLevel ?? 0)),
    maxLevel,
  )
  const halo = options.haloSize ?? [1, 1, 1]
  const maxHalo = Math.max(halo[0], halo[1], halo[2])
  // A brick's texture is data + 2*halo voxels and must fit the device limit, so
  // a cell holds at most (deviceLimit - 2*halo) source voxels. Clamp cellEdge to
  // that ceiling: a larger value would let emitBrick clamp texDims while the data
  // extent stayed larger (squashed/clipped sampling).
  const cellEdge = Math.min(
    Math.max(8, Math.floor(options.cellEdge ?? 128)),
    Math.max(1, deviceLimit - 2 * maxHalo),
  )
  const radius = Math.max(1e-3, focus.radius)
  // Scale-relative detail factor. A cell refines while `beyond < BASE_DETAIL *
  // cellSize`; >= ~1 keeps the octree 2:1 balanced (one level change per cell).
  // Larger = wider finest core (more bricks); the budget pass only shrinks it.
  const BASE_DETAIL = options.detail ?? 1

  // Refinement is SCALE-RELATIVE: a cell is subdivided while its nearest distance
  // to the focus is small RELATIVE TO ITS OWN SIZE (`detail` * cell extent).
  // Because the threshold scales with the cell, the level changes by ~1 per cell
  // step, so face-adjacent bricks differ by at most one level — a 2:1 balanced
  // octree with smooth LOD transitions (no fine-next-to-very-coarse walls). The
  // `radius` adds an absolute finest core regardless of `detail`. `detail` is
  // lowered by the budget pass (cells must be closer to refine -> coarser overall)
  // before the level floor is raised as a last resort.
  const cellExtent = (sizeC: Vec3i): number =>
    Math.max(sizeC[0], sizeC[1], sizeC[2])

  // Nearest common-voxel distance from the focus centre to an axis-aligned box.
  const distanceToBox = (originC: Vec3i, sizeC: Vec3i): number => {
    let sq = 0
    for (let a = 0; a < 3; a++) {
      const lo = originC[a]
      const hi = originC[a] + sizeC[a]
      const c = focus.center[a]
      const outside = c < lo ? lo - c : c > hi ? c - hi : 0
      sq += outside * outside
    }
    return Math.sqrt(sq)
  }

  // Map a common-grid span [originC, originC+sizeC] into level ℓ's grid and emit
  // a brick: world placement stays common-grid (voxelOrigin/voxelDims), the
  // texture/halo/fetch fields are level-grid.
  const emitBrick = (
    originC: Vec3i,
    sizeC: Vec3i,
    level: number,
    chunks: VolumeChunkDesc[],
  ): void => {
    const ld = levelDims[level]
    const texOrigin: Vec3i = [0, 0, 0]
    const texDims: Vec3i = [0, 0, 0]
    const haloLow: Vec3i = [0, 0, 0]
    const haloHigh: Vec3i = [0, 0, 0]
    for (let a = 0; a < 3; a++) {
      const scale = ld[a] / commonDims[a]
      const loL = Math.max(0, Math.floor(originC[a] * scale))
      const hiL = Math.min(ld[a], Math.ceil((originC[a] + sizeC[a]) * scale))
      const dataL = Math.max(1, hiL - loL)
      const hLow = loL > 0 ? halo[a] : 0
      const hHigh = loL + dataL < ld[a] ? halo[a] : 0
      texOrigin[a] = loL - hLow
      texDims[a] = Math.min(deviceLimit, dataL + hLow + hHigh)
      haloLow[a] = hLow
      haloHigh[a] = Math.max(0, texDims[a] - dataL - hLow)
    }
    chunks.push({
      voxelOrigin: [originC[0], originC[1], originC[2]],
      voxelDims: [sizeC[0], sizeC[1], sizeC[2]],
      haloLow,
      haloHigh,
      texDims,
      texOrigin,
      gridIndex: [0, 0, 0],
      sourceLevel: level,
    })
  }

  // An EXACT uniform lattice, when the caller pinned one. `gridDims` replaces
  // the octree outright: every brick is drawn from `minLevel`, so the plan is
  // one regular grid whose brick COUNT is the caller's rather than a value that
  // falls out of `cellEdge` and the pyramid. That is what a lattice you pick
  // bricks out of needs -- see `examples/vox.block.pick.zarr.html`, whose block
  // control asks for 4 / 9 / 16 blocks directly. The budget/`maxBricks` passes
  // are skipped (they coarsen by refining less, and there is nothing here to
  // refine); the brick count is small and each brick is bounded by `deviceLimit`,
  // so the plan's bytes are bounded by `count * deviceLimit^3 * 8`.
  if (options.gridDims) {
    // Largest texture extent any brick on this axis would need, computed the
    // same way `emitBrick` does (common box -> level box, plus the halo faces).
    const axisNeed = (a: number, count: number): number => {
      const ld = levelDims[minLevel]
      const scale = ld[a] / commonDims[a]
      const stride = Math.ceil(commonDims[a] / count)
      let need = 0
      for (let i = 0; i < count; i++) {
        const originC = i * stride
        const sizeC = Math.min(stride, commonDims[a] - originC)
        if (sizeC <= 0) break
        const loL = Math.max(0, Math.floor(originC * scale))
        const hiL = Math.min(ld[a], Math.ceil((originC + sizeC) * scale))
        const dataL = Math.max(1, hiL - loL)
        const hLow = loL > 0 ? halo[a] : 0
        const hHigh = loL + dataL < ld[a] ? halo[a] : 0
        need = Math.max(need, dataL + hLow + hHigh)
      }
      return need
    }
    const grid: Vec3i = [1, 1, 1]
    const stride: Vec3i = [1, 1, 1]
    for (let a = 0; a < 3; a++) {
      const asked = Math.floor(options.gridDims[a])
      // One brick per axis at least, and never more cells than the LEVEL has
      // voxels (an empty brick has nothing to fetch).
      let count = Math.min(
        Math.max(1, Number.isFinite(asked) ? asked : 1),
        levelDims[minLevel][a],
      )
      // A brick's texture is data + 2*halo and `emitBrick` CLAMPS texDims to the
      // device limit, which would squash the sampling rather than fail loudly.
      // When the asked-for lattice cannot fit, more cells is the only direction
      // that keeps every brick correct, so grow this axis until it does.
      while (
        count < levelDims[minLevel][a] &&
        axisNeed(a, count) > deviceLimit
      ) {
        count++
      }
      grid[a] = count
      stride[a] = Math.ceil(commonDims[a] / grid[a])
      // A ceil stride can leave the last cells empty (e.g. 10 voxels in 4 cells
      // strides by 3 and fills only 4); drop them so `chunkAtVoxel`'s index math
      // still lands on a real brick.
      grid[a] = Math.ceil(commonDims[a] / stride[a])
    }
    const chunks: VolumeChunkDesc[] = []
    for (let cz = 0; cz < grid[2]; cz++) {
      for (let cy = 0; cy < grid[1]; cy++) {
        for (let cx = 0; cx < grid[0]; cx++) {
          const index: Vec3i = [cx, cy, cz]
          const originC: Vec3i = [0, 0, 0]
          const sizeC: Vec3i = [0, 0, 0]
          for (let a = 0; a < 3; a++) {
            originC[a] = index[a] * stride[a]
            sizeC[a] = Math.min(stride[a], commonDims[a] - originC[a])
          }
          emitBrick(originC, sizeC, minLevel, chunks)
          chunks[chunks.length - 1].gridIndex = index
        }
      }
    }
    return {
      gridDims: grid,
      stride,
      chunks,
      volumeDims: [commonDims[0], commonDims[1], commonDims[2]],
      deviceLimit,
      haloSize: [halo[0], halo[1], halo[2]],
      levelDims: levelDims.map((d) => [d[0], d[1], d[2]] as Vec3i),
    }
  }

  // Two bricks share a 2D FACE: their common-grid boxes are adjacent on exactly
  // one axis (touching planes) and overlap on the other two.
  const faceAdjacent = (a: VolumeChunkDesc, b: VolumeChunkDesc): boolean => {
    let adjacent = 0
    let overlapping = 0
    for (let k = 0; k < 3; k++) {
      const a0 = a.voxelOrigin[k]
      const a1 = a0 + a.voxelDims[k]
      const b0 = b.voxelOrigin[k]
      const b1 = b0 + b.voxelDims[k]
      if (a1 <= b0 || b1 <= a0) {
        if (a1 === b0 || b1 === a0) adjacent++
        else return false // a gap on this axis -> not touching
      } else {
        overlapping++
      }
    }
    return adjacent === 1 && overlapping === 2
  }

  // Split a brick's common-grid box into octants (same ceil-halving as the
  // octree) and emit each one finer level into `out`.
  const splitBrick = (d: VolumeChunkDesc, out: VolumeChunkDesc[]): void => {
    const newLevel = Math.max(0, (d.sourceLevel ?? 0) - 1)
    for (let oz = 0; oz < 2; oz++) {
      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const off = [ox, oy, oz]
          const childOrigin: Vec3i = [0, 0, 0]
          const childSize: Vec3i = [0, 0, 0]
          let empty = false
          for (let a = 0; a < 3; a++) {
            const half = Math.ceil(d.voxelDims[a] / 2)
            const start = off[a] === 0 ? 0 : half
            const extent = Math.min(half, d.voxelDims[a] - start)
            if (extent <= 0) {
              empty = true
              break
            }
            childOrigin[a] = d.voxelOrigin[a] + start
            childSize[a] = extent
          }
          if (!empty) emitBrick(childOrigin, childSize, newLevel, out)
        }
      }
    }
  }

  // Enforce a 2:1 BALANCED octree: repeatedly split any brick that has a
  // face-neighbour more than one level finer, so face-adjacent bricks differ by
  // at most one level (smooth LOD transitions, no fine-next-to-very-coarse
  // walls). Scale-relative refinement gets close but does not constrain siblings
  // of unequal size, so this post-pass is what makes the bound hard. `floor`
  // caps how fine we may split (budget fallback).
  const balance = (
    descs: VolumeChunkDesc[],
    floor: number,
  ): VolumeChunkDesc[] => {
    let list = descs
    for (let iter = 0; iter < 32; iter++) {
      let changed = false
      const out: VolumeChunkDesc[] = []
      for (let i = 0; i < list.length; i++) {
        const d = list[i]
        const level = d.sourceLevel ?? 0
        const divisible =
          d.voxelDims[0] > 1 || d.voxelDims[1] > 1 || d.voxelDims[2] > 1
        if (level <= minLevel || level <= floor || !divisible) {
          out.push(d)
          continue
        }
        let finestNeighbor = Number.POSITIVE_INFINITY
        for (let j = 0; j < list.length; j++) {
          if (j !== i && faceAdjacent(d, list[j])) {
            finestNeighbor = Math.min(finestNeighbor, list[j].sourceLevel ?? 0)
          }
        }
        if (finestNeighbor < level - 1) {
          splitBrick(d, out)
          changed = true
        } else {
          out.push(d)
        }
      }
      list = out
      if (!changed) break
    }
    return list
  }

  // Reservation pass (opt-in via `focus.reserveBounds` / `focus.reserveCenter`).
  // Runs on every candidate the budget pass builds, AFTER the octree + balance,
  // so it composes with the level floor instead of fighting it.
  //  - bounds: walk the levels from the coarsest down to `target` and split
  //    every brick at that level that intersects a bound. `build` emits nothing
  //    finer than its floor, so afterwards every brick touching a bound sits at
  //    exactly `target`: one uniform level per bound, no mixed-LOD seam inside a
  //    visible slice. The budget loop may raise `target` (coarsening the bounds
  //    as a whole) but can never end up with a mix.
  //  - centre only: split the brick containing `reserveCenter`, then its child
  //    containing it, down to `target` -- a single mandatory finest-detail
  //    branch under the crosshair (at most 7 extra bricks per level) even when
  //    `center` is biased away from it or `detail` has been shrunk. It stops at
  //    the floor, not `minLevel`, so a budget-raised floor stays a hard cap.
  // Neither present: the list is returned untouched, so plans are identical to
  // a call without the options.
  const reserveBounds = focus.reserveBounds ?? []
  const intersectsBounds = (d: VolumeChunkDesc): boolean =>
    reserveBounds.some((b) => {
      for (let a = 0; a < 3; a++) {
        const lo = d.voxelOrigin[a]
        const hi = lo + d.voxelDims[a]
        if (lo >= b.max[a] || hi <= b.min[a]) return false
      }
      return true
    })
  const containsPoint = (d: VolumeChunkDesc, p: Vec3f): boolean => {
    for (let a = 0; a < 3; a++) {
      const lo = d.voxelOrigin[a]
      if (p[a] < lo || p[a] >= lo + d.voxelDims[a]) return false
    }
    return true
  }
  const reserve = (
    descs: VolumeChunkDesc[],
    target: number,
  ): VolumeChunkDesc[] => {
    if (reserveBounds.length > 0) {
      let list = descs
      for (let level = maxLevel; level > target; level--) {
        const out: VolumeChunkDesc[] = []
        for (const d of list) {
          if ((d.sourceLevel ?? 0) === level && intersectsBounds(d)) {
            splitBrick(d, out)
          } else {
            out.push(d)
          }
        }
        list = out
      }
      return list
    }
    const centre = focus.reserveCenter
    if (!centre) return descs
    let list = descs
    for (let iter = 0; iter <= maxLevel; iter++) {
      const i = list.findIndex(
        (d) => (d.sourceLevel ?? 0) > target && containsPoint(d, centre),
      )
      if (i < 0) break
      const out: VolumeChunkDesc[] = []
      splitBrick(list[i], out)
      list = [...list.slice(0, i), ...out, ...list.slice(i + 1)]
    }
    return list
  }

  // Recursive octree: a node at `level` covers a common-grid box. If a finer
  // level is desired for its region (and it is divisible), split into octants
  // and recurse one level finer; otherwise emit it as a brick.
  const build = (
    detail: number,
    floor: number,
    rootScale = 1,
  ): VolumeChunkDesc[] => {
    const chunks: VolumeChunkDesc[] = []
    const subdivide = (originC: Vec3i, sizeC: Vec3i, level: number): void => {
      const divisible = sizeC[0] > 1 || sizeC[1] > 1 || sizeC[2] > 1
      if (level <= minLevel || level <= floor || !divisible) {
        emitBrick(originC, sizeC, level, chunks)
        return
      }
      // Refine while the cell is close to the focus relative to its own size, or
      // within the absolute finest-core radius. Scale-relative => 2:1 balanced.
      const beyond = Math.max(0, distanceToBox(originC, sizeC) - radius)
      if (beyond >= detail * cellExtent(sizeC)) {
        emitBrick(originC, sizeC, level, chunks)
        return
      }
      for (let oz = 0; oz < 2; oz++) {
        for (let oy = 0; oy < 2; oy++) {
          for (let ox = 0; ox < 2; ox++) {
            const off = [ox, oy, oz]
            const childOrigin: Vec3i = [0, 0, 0]
            const childSize: Vec3i = [0, 0, 0]
            let empty = false
            for (let a = 0; a < 3; a++) {
              const half = Math.ceil(sizeC[a] / 2)
              const start = off[a] === 0 ? 0 : half
              const extent = Math.min(half, sizeC[a] - start)
              if (extent <= 0) {
                empty = true
                break
              }
              childOrigin[a] = originC[a] + start
              childSize[a] = extent
            }
            if (!empty) subdivide(childOrigin, childSize, level - 1)
          }
        }
      }
    }
    // Root: tile the volume into level-maxLevel bricks, each bounded to a
    // `cellEdge`-level-voxel texture, then refine each toward the focus.
    const rootSpan: Vec3i = [0, 0, 0]
    for (let a = 0; a < 3; a++) {
      const scale = commonDims[a] / levelDims[maxLevel][a] // common voxels / level voxel
      rootSpan[a] = Math.max(1, Math.round(cellEdge * rootScale * scale))
    }
    for (let z = 0; z < commonDims[2]; z += rootSpan[2]) {
      for (let y = 0; y < commonDims[1]; y += rootSpan[1]) {
        for (let x = 0; x < commonDims[0]; x += rootSpan[0]) {
          const originC: Vec3i = [x, y, z]
          const sizeC: Vec3i = [
            Math.min(rootSpan[0], commonDims[0] - x),
            Math.min(rootSpan[1], commonDims[1] - y),
            Math.min(rootSpan[2], commonDims[2] - z),
          ]
          subdivide(originC, sizeC, maxLevel)
        }
      }
    }
    return balance(chunks, floor)
  }

  // Budget pass — fit BOTH the GPU byte budget (rgba + gradient = 8 B per padded
  // texture voxel) and an optional brick-count cap (the renderer rejects plans
  // over its per-tile chunk limit, and the resident set must not be evicted):
  // 1) shrink `detail` — cells must be closer to the focus (relative to their
  //    size) to refine, so the whole field coarsens while staying 2:1 balanced.
  // 2) only if that still cannot fit, raise the level floor as a hard cap (the
  //    balance may degrade here).
  // Every candidate goes through `reserve`, so reserved bounds stay uniform at
  // the candidate's floor and the crosshair keeps its finest brick throughout.
  const budget =
    options.budgetBytes && options.budgetBytes > 0 ? options.budgetBytes : 0
  const maxBricks =
    options.maxBricks && options.maxBricks > 0
      ? options.maxBricks
      : Number.POSITIVE_INFINITY
  const bytesOf = (cs: VolumeChunkDesc[]): number =>
    cs.reduce(
      (sum, c) => sum + c.texDims[0] * c.texDims[1] * c.texDims[2] * 8,
      0,
    )
  const overBudget = (cs: VolumeChunkDesc[]): boolean =>
    (budget > 0 && bytesOf(cs) > budget) || cs.length > maxBricks
  let detail = BASE_DETAIL
  let floor = minLevel
  let chunks = reserve(build(detail, floor), floor)
  if (budget > 0 || maxBricks !== Number.POSITIVE_INFINITY) {
    for (let i = 0; i < 16 && overBudget(chunks); i++) {
      detail /= 1.6
      chunks = reserve(build(detail, floor), floor)
    }
    while (overBudget(chunks) && floor < maxLevel) {
      floor++
      chunks = reserve(build(detail, floor), floor)
    }
    // The detail/floor passes refine toward the focus but never coarsen the ROOT
    // grid, so a small `cellEdge` on a large volume can leave the root box count
    // above `maxBricks` even at floor === maxLevel. Grow the root cell (fewer,
    // larger bricks) until the cap is met — bounded so a root brick never exceeds
    // the device texture limit. If the cap is still unreachable at the limit, the
    // volume genuinely cannot fit `maxBricks` device-sized bricks (rare).
    if (chunks.length > maxBricks) {
      const maxRootScale = Math.max(
        1,
        Math.floor((deviceLimit - 2 * maxHalo) / cellEdge),
      )
      let rootScale = 1
      while (chunks.length > maxBricks && rootScale < maxRootScale) {
        rootScale = Math.min(maxRootScale, rootScale * 2)
        chunks = reserve(build(detail, maxLevel, rootScale), maxLevel)
      }
    }
  }

  return {
    gridDims: [1, 1, 1],
    stride: [commonDims[0], commonDims[1], commonDims[2]],
    chunks,
    volumeDims: [commonDims[0], commonDims[1], commonDims[2]],
    deviceLimit,
    haloSize: [halo[0], halo[1], halo[2]],
    levelDims: levelDims.map((d) => [d[0], d[1], d[2]] as Vec3i),
  }
}
