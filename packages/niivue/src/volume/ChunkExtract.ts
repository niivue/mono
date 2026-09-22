/**
 * Copy a sub-box of a volume out as a standalone, self-describing NIfTI.
 *
 * The exploded 3D render separates a chunked volume into its bricks
 * (`ChunkExplode`), and `pickExplodedBlock` says which brick the user clicked.
 * This module turns that brick back into an ordinary volume so a second viewer
 * can show it on its own — an EPHEMERAL copy: nothing here mutates the parent,
 * and the copy is meant to be rebuilt on the next pick rather than kept.
 *
 * ANATOMICAL COORDINATES ARE PRESERVED. A sub-box differs from its parent only
 * by where its first voxel sits, so the child's voxel->mm affine is the parent's
 * with the origin walked forward to that voxel:
 *
 *     A_child = A_parent . translate(voxelOrigin)
 *
 * The rotation/scale block is copied untouched (an oblique parent stays oblique),
 * and only the translation column moves. So the block viewer's crosshair reads
 * the SAME mm as the parent's — a voxel at MNI (-30, 22, 8) reports (-30, 22, 8)
 * in both panes, even though it is voxel [12, 5, 9] of the extracted block. That
 * is the whole point: the block is re-centred on screen (each viewer frames its
 * own volume's extents) WITHOUT its coordinates being re-centred with it.
 *
 * The parent's `matRAS` is the transform used, not the raw sform/qform: it is
 * the sform/qform after NiiVue's RAS reorientation, which is the frame the chunk
 * plan's voxel coordinates live in. Since `matRAS` is itself RAS-oriented, the
 * extracted NIfTI reloads with an identity permutation and its `matRAS` comes
 * back bit-identical to the affine written here.
 *
 * Voxels are emitted as float32 in DISPLAY units (the parent's `scl_slope` /
 * `scl_inter` are applied during the copy, and the child header states
 * slope 1 / inter 0), so a window carried over from the parent means the same
 * thing in the copy.
 */

import { NiiDataType } from '@/NVConstants'
import type { NVImage } from '@/NVTypes'
import type { Vec3f, Vec3i } from './chunking'
import { createNiftiArray, getImageDataRAS } from './utils'

/** A sub-box of a parent volume, as a loadable NIfTI plus its placement. */
export interface ExtractedSubVolume {
  /** The block's first voxel in the parent's RAS voxel grid. */
  voxelOrigin: Vec3i
  /** The block's extent in voxels. */
  voxelDims: Vec3i
  /**
   * Flat row-major 4x4 mapping BLOCK voxel coords to the PARENT's mm frame
   * (same convention as `NVImage.matRAS`). Written into the emitted NIfTI's
   * sform/qform, so the copy carries the parent's anatomy with it.
   */
  affine: number[]
  /** mm of the block's centre, in the parent's frame. */
  centroidMM: Vec3f
  /** The parent-mm translation the copy applies: mm of block voxel [0,0,0]. */
  originMM: Vec3f
  /** Voxel spacing in mm, per axis (unchanged from the parent). */
  spacingMM: Vec3f
  /** The parent's display window, valid as-is for the copy's float32 values. */
  calMin: number
  calMax: number
  /** A complete NIfTI-1 file: header + float32 voxels in display units. */
  nifti: Uint8Array
}

/**
 * The parent's voxel->mm affine with its origin moved to `voxelOrigin`.
 *
 * `matRAS` is row-major, so the translation lives at indices 3/7/11 and the
 * shift is the rotation/scale block times the origin — the same arithmetic
 * `chunkExplodedMatRAS` uses for a brick's render-time offset, which is why an
 * extracted block lands back exactly where the exploded brick came from.
 */
export function subVolumeAffine(
  matRAS: ArrayLike<number>,
  voxelOrigin: readonly [number, number, number],
): number[] {
  const out: number[] = []
  for (let i = 0; i < 16; i++) out.push(matRAS[i] ?? 0)
  const [ox, oy, oz] = voxelOrigin
  out[3] +=
    ox * (matRAS[0] ?? 0) + oy * (matRAS[1] ?? 0) + oz * (matRAS[2] ?? 0)
  out[7] +=
    ox * (matRAS[4] ?? 0) + oy * (matRAS[5] ?? 0) + oz * (matRAS[6] ?? 0)
  out[11] +=
    ox * (matRAS[8] ?? 0) + oy * (matRAS[9] ?? 0) + oz * (matRAS[10] ?? 0)
  return out
}

/** Apply a row-major 4x4 to a point. */
function applyAffine(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): Vec3f {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ]
}

/** Per-axis voxel size = the norm of each column of the rotation/scale block. */
function affineSpacing(m: ArrayLike<number>): Vec3f {
  return [
    Math.hypot(m[0], m[4], m[8]) || 1,
    Math.hypot(m[1], m[5], m[9]) || 1,
    Math.hypot(m[2], m[6], m[10]) || 1,
  ]
}

/** Clamp a box to `[0, dims)` and return null when nothing is left. */
function clampRegion(
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
  dims: readonly [number, number, number],
): { origin: Vec3i; size: Vec3i } | null {
  const origin: Vec3i = [0, 0, 0]
  const size: Vec3i = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    // Intersect, do not shift: a box hanging off the low edge is TRIMMED, so the
    // returned region is always the part of the request that actually exists.
    const requested = Math.floor(voxelOrigin[k])
    const lo = Math.max(0, requested)
    const hi = Math.min(dims[k], requested + Math.floor(voxelDims[k]))
    if (hi <= lo) return null
    origin[k] = lo
    size[k] = hi - lo
  }
  return { origin, size }
}

/**
 * Copy an axis-aligned voxel box out of `vol` as a standalone NIfTI.
 *
 * The box is given in the parent's RAS voxel grid (the same grid the chunk plan
 * and `pickExplodedBlock` use) and is clamped to the volume, so a brick whose
 * halo runs past the edge still yields the part that exists. Returns null when
 * the volume has no CPU-side voxels (a purely streamed volume — its bytes live
 * in GPU brick textures, see the streaming note in the example) or the box is
 * entirely outside.
 */
export function extractSubVolume(
  vol: NVImage,
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
): ExtractedSubVolume | null {
  const dimsRAS = vol.dimsRAS as number[] | undefined
  const matRAS = vol.matRAS as ArrayLike<number> | undefined
  if (!dimsRAS || !matRAS) return null
  const parentDims: Vec3i = [dimsRAS[1], dimsRAS[2], dimsRAS[3]]
  const region = clampRegion(voxelOrigin, voxelDims, parentDims)
  if (!region) return null
  const src = getImageDataRAS(vol)
  if (!src) return null

  const [dx, dy, dz] = region.size
  const [ox, oy, oz] = region.origin
  const parentX = parentDims[0]
  const parentXY = parentDims[0] * parentDims[1]
  // getImageDataRAS returns RAW values; bake the parent's scaling in so the copy
  // is in display units and can state slope 1 / inter 0.
  const slope = vol.hdr?.scl_slope || 1
  const inter = vol.hdr?.scl_inter || 0
  const img = new Float32Array(dx * dy * dz)
  for (let z = 0; z < dz; z++) {
    const srcZ = (oz + z) * parentXY
    const dstZ = z * dx * dy
    for (let y = 0; y < dy; y++) {
      const srcRow = srcZ + (oy + y) * parentX + ox
      const dstRow = dstZ + y * dx
      for (let x = 0; x < dx; x++) {
        img[dstRow + x] = src[srcRow + x] * slope + inter
      }
    }
  }

  const affine = subVolumeAffine(matRAS, region.origin)
  const spacingMM = affineSpacing(affine)
  return {
    voxelOrigin: region.origin,
    voxelDims: region.size,
    affine,
    // Voxel centres run 0..d-1, so the box centre sits at (d-1)/2.
    centroidMM: applyAffine(affine, (dx - 1) / 2, (dy - 1) / 2, (dz - 1) / 2),
    originMM: applyAffine(affine, 0, 0, 0),
    spacingMM,
    calMin: vol.calMin,
    calMax: vol.calMax,
    nifti: createNiftiArray(
      [dx, dy, dz],
      [spacingMM[0], spacingMM[1], spacingMM[2]],
      affine,
      NiiDataType.DT_FLOAT32,
      img,
    ),
  }
}

/**
 * Copy one brick of `vol`'s chunk plan out as a standalone NIfTI.
 *
 * Uses the brick's DATA region (`voxelOrigin`/`voxelDims`), not its texture
 * region, so the copy holds exactly the voxels that brick owns and no halo — two
 * adjacent blocks extracted this way tile the parent without overlap.
 */
export function extractChunkBlock(
  vol: NVImage,
  chunkIndex: number,
): ExtractedSubVolume | null {
  const desc = vol.chunkPlan?.chunks[chunkIndex]
  if (!desc) return null
  return extractSubVolume(vol, desc.voxelOrigin, desc.voxelDims)
}
