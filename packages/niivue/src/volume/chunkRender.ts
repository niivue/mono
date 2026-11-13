// Backend-neutral helpers both chunked-volume renderers (gl/, wgpu/ render.ts) share.
import type { VolumeChunkExplode } from '@/NVTypes'
import { chunkExplodeEnabled, chunkExplodeOffsetFrac } from './ChunkExplode'
import {
  type ChunkPlan,
  chunkLodDownsample,
  chunkOwnedTexBox,
  type Vec3f,
} from './chunking'
import { decodedTierBudgetBytes } from './decodedChunkCache'

/**
 * Per-chunk uniform values for one cube draw of a chunked volume. The renderer
 * computes these from the ChunkPlan; the shader uses them to scale the unit
 * cube into the chunk's sub-region and remap sample positions into the chunk
 * texture (including halo). Non-chunked draws use identity pass-through values.
 */
export interface ChunkUniforms {
  /** Full volume RAS dims in the COMMON grid (vertex placement + frac2ndc). */
  volumeTexDimsFull: Vec3f
  /** Chunk's sub-cube origin in the full-volume [0,1] cube. */
  chunkSubOrigin: Vec3f
  /** Chunk's sub-cube size in the full-volume [0,1] cube. */
  chunkSubSize: Vec3f
  /** Halo offset in the chunk's local texture (skips low-side halo). */
  dataOriginTexFrac: Vec3f
  /** Data extent in the chunk's local texture (excludes halo on both sides). */
  dataSizeTexFrac: Vec3f
  /**
   * Full-volume voxel dims at THIS brick's source pyramid level, used solely for
   * the ray-march step density (one step ≈ one source-level voxel across the
   * full cube). Equals `volumeTexDimsFull` for single-level/non-chunked draws;
   * coarser for multi-LOD bricks so they step (and sample) at their own
   * resolution instead of being oversampled at the finest density.
   */
  rayStepTexVox: Vec3f
  /**
   * False when this draw reads a brick whose halo is too thin for the tricubic
   * kernel (see planSupportsCubic). The filter is forced off for that draw so
   * it cannot reconstruct from clamp-to-edge data at an internal brick face,
   * which would show as a seam. Defaults to true (non-chunked draws, and the
   * coarse floor, which is one whole-volume texture).
   */
  cubicSafe?: boolean
  /**
   * Linear downsample factor of this brick's source pyramid level relative to
   * the finest grid (see chunkLodDownsample). 1 for single-level plans and
   * non-chunked draws; drives the per-level brightness compensation.
   */
  lodDownsample?: number
}

/** Per-chunk uniform values derived from a chunk descriptor and its plan. */
export function chunkUniformsFor(
  plan: ChunkPlan,
  chunkIndex: number,
): ChunkUniforms {
  const desc = plan.chunks[chunkIndex]
  const [vx, vy, vz] = plan.volumeDims
  // Ray-step density comes from this brick's source level (full-volume dims);
  // for single-level plans levelDims is absent so it falls back to volumeDims.
  const rayStep = plan.levelDims?.[desc.sourceLevel ?? 0] ?? plan.volumeDims
  // The brick's OWNED box inside its own texture. A multi-LOD brick fetches a
  // box snapped out to whole level voxels, so the fetched box is NOT the owned
  // box and using it here would misregister the brick. See `chunkOwnedTexBox`.
  const owned = chunkOwnedTexBox(plan, desc)
  return {
    // World placement uses the COMMON grid (voxelOrigin/voxelDims are common-grid
    // for multi-LOD bricks; identical to the level grid for single-level plans).
    volumeTexDimsFull: [vx, vy, vz],
    chunkSubOrigin: [
      desc.voxelOrigin[0] / vx,
      desc.voxelOrigin[1] / vy,
      desc.voxelOrigin[2] / vz,
    ],
    chunkSubSize: [
      desc.voxelDims[0] / vx,
      desc.voxelDims[1] / vy,
      desc.voxelDims[2] / vz,
    ],
    // Texture-space remap uses the brick's OWN level grid.
    dataOriginTexFrac: owned.origin,
    dataSizeTexFrac: owned.size,
    rayStepTexVox: [rayStep[0], rayStep[1], rayStep[2]],
    lodDownsample: chunkLodDownsample(plan, desc),
  }
}

/** Per-chunk explode offsets, or undefined when the plan is not exploded. */
export function chunkOffsetFor(
  plan: ChunkPlan,
  explode: VolumeChunkExplode | undefined,
): ((chunkIndex: number) => Vec3f) | undefined {
  if (!chunkExplodeEnabled(explode)) return undefined
  return (chunkIndex: number) =>
    chunkExplodeOffsetFrac(plan, chunkIndex, explode)
}

/**
 * Set a chunked entry's GPU residency budget, keeping its decoded tier sized
 * against it. The two move together by construction: the tier exists to shadow
 * the resident set, so a share change that shrinks one must shrink the other.
 */
export function setChunkBudget(
  entry: {
    manager: { setBudgetBytes(bytes: number): void }
    decoded: { resize(maxBytes: number): void }
    sourceBytesPerVoxel: number
  },
  bytes: number,
): void {
  entry.manager.setBudgetBytes(bytes)
  entry.decoded.resize(decodedTierBudgetBytes(bytes, entry.sourceBytesPerVoxel))
}
