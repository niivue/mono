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
}

export interface ChunkPlan {
  /** Number of chunks per axis. Their product equals chunks.length. */
  gridDims: Vec3i
  /** Distance in voxels between successive chunk data origins, per axis. */
  stride: Vec3i
  /** Chunks in row-major order: index = (z * gy + y) * gx + x. */
  chunks: VolumeChunkDesc[]
  /** Volume voxel dimensions this plan tiles. */
  volumeDims: Vec3i
  /** Device limit used to compute this plan. */
  deviceLimit: number
  /** Halo width per axis. */
  haloSize: Vec3i
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
  // Convert the [0,1] slice fraction to a voxel coordinate, then to a chunk
  // layer the same way chunkAtVoxel does, so picking stays consistent.
  const voxel = sliceFrac * plan.volumeDims[a]
  const clamped = Math.max(0, Math.min(plan.volumeDims[a] - 1e-3, voxel))
  const layer = Math.min(
    plan.gridDims[a] - 1,
    Math.floor(clamped / plan.stride[a]),
  )
  const out: number[] = []
  for (let i = 0; i < plan.chunks.length; i++) {
    if (plan.chunks[i].gridIndex[a] === layer) out.push(i)
  }
  return out
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
}

/** Build the sampling transform for a single chunk of a plan. */
export function chunkSampleTransform(
  plan: ChunkPlan,
  chunkIndex: number,
): ChunkSampleTransform {
  const desc = plan.chunks[chunkIndex]
  const [vx, vy, vz] = plan.volumeDims
  const [tx, ty, tz] = desc.texDims
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
    dataOrigin: [
      desc.haloLow[0] / tx,
      desc.haloLow[1] / ty,
      desc.haloLow[2] / tz,
    ],
    dataSize: [
      desc.voxelDims[0] / tx,
      desc.voxelDims[1] / ty,
      desc.voxelDims[2] / tz,
    ],
    volumeDims: [vx, vy, vz],
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
