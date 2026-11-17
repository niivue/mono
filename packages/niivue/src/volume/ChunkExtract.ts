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

import { mm2vox } from '@/math/NVTransforms'
import { NiiDataType } from '@/NVConstants'
import type { NVImage, TypedVoxelArray } from '@/NVTypes'
import { translatedAffine } from './ChunkExplode'
import type { Vec3f, Vec3i } from './chunking'
import { createNiftiArray } from './utils'

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
  return translatedAffine([], matRAS, voxelOrigin)
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

/** A RAS-ordered voxel box copied out of a volume (see {@link extractRawRegion}). */
export interface RawRegion<T extends TypedVoxelArray = TypedVoxelArray> {
  /** The voxels, x fastest, then y, then z. */
  data: T
  /** The box after clamping to the volume, in its RAS voxel grid. */
  voxelOrigin: Vec3i
  voxelDims: Vec3i
}

type VoxelArrayCtor<T extends TypedVoxelArray> = new (length: number) => T

/**
 * Copy an axis-aligned voxel box of `vol`'s shown frame, RAW: stored values,
 * no `scl_slope`/`scl_inter`, in the volume's own datatype unless `Out` names
 * another. The box is clamped as {@link extractSubVolume}'s is. Reads native
 * storage through the RAS strides, so only the box is copied. Null without CPU
 * voxels, for an RGB/RGBA volume, or when the box misses the volume.
 */
export function extractRawRegion<T extends TypedVoxelArray = TypedVoxelArray>(
  vol: NVImage,
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
  Out?: VoxelArrayCtor<T>,
): RawRegion<T> | null {
  return copyRegion(vol, voxelOrigin, voxelDims, Out, 1, 0)
}

/**
 * One pass for both extractors: at (1, 0) values are unchanged (-0 reads as 0).
 * The per-voxel loop inlines getVoxelValue's native index (utils.ts) rather than
 * calling it, with row offsets hoisted out of the x loop.
 */
function copyRegion<T extends TypedVoxelArray>(
  vol: NVImage,
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
  Out: VoxelArrayCtor<T> | undefined,
  slope: number,
  inter: number,
): RawRegion<T> | null {
  const d = vol.dimsRAS as number[] | undefined
  const src = vol.img
  const start = vol.img2RASstart
  const step = vol.img2RASstep
  if (!d || !src || !start || !step) return null
  // An RGB/RGBA img holds component bytes, not scalar voxels.
  const dt = vol.hdr.datatypeCode
  if (dt === NiiDataType.DT_RGB24 || dt === NiiDataType.DT_RGBA32) return null
  const region = clampRegion(voxelOrigin, voxelDims, [d[1], d[2], d[3]])
  if (!region) return null
  const [dx, dy, dz] = region.size
  const [ox, oy, oz] = region.origin
  const Ctor = Out ?? (src.constructor as VoxelArrayCtor<T>)
  const data = new Ctor(dx * dy * dz)
  const base = start[0] + start[1] + start[2] + (vol.frame4D ?? 0) * vol.nVox3D
  let i = 0
  for (let z = 0; z < dz; z++) {
    const srcZ = base + (oz + z) * step[2]
    for (let y = 0; y < dy; y++) {
      const srcRow = srcZ + (oy + y) * step[1] + ox * step[0]
      for (let x = 0; x < dx; x++)
        data[i++] = src[srcRow + x * step[0]] * slope + inter
    }
  }
  return { data, voxelOrigin: region.origin, voxelDims: region.size }
}

/**
 * Copy an axis-aligned voxel box out of `vol` as a standalone NIfTI.
 *
 * The box is given in the parent's RAS voxel grid (the same grid the chunk plan
 * and `pickExplodedBlock` use) and is clamped to the volume, so a brick whose
 * halo runs past the edge still yields the part that exists. Returns null when
 * the volume has no CPU-side voxels (a purely streamed volume — its bytes live
 * in GPU brick textures, see the streaming note in the example), is RGB/RGBA,
 * or the box is entirely outside.
 */
export function extractSubVolume(
  vol: NVImage,
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
): ExtractedSubVolume | null {
  const matRAS = vol.matRAS as ArrayLike<number> | undefined
  if (!matRAS) return null
  // Float32 with the parent's scaling baked in: the copy is in display units
  // and states slope 1 / inter 0.
  const region = copyRegion(
    vol,
    voxelOrigin,
    voxelDims,
    Float32Array,
    vol.hdr?.scl_slope || 1,
    vol.hdr?.scl_inter || 0,
  )
  if (!region) return null
  const { data: img, voxelOrigin: origin, voxelDims: dims } = region
  const [dx, dy, dz] = dims

  const affine = subVolumeAffine(matRAS, origin)
  const spacingMM = affineSpacing(affine)
  return {
    voxelOrigin: origin,
    voxelDims: dims,
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
      vol.hdr.xyzt_units,
    ),
  }
}

/** A voxel box of a volume and its outer mm edges. */
export interface SubVolumeBox {
  /** First voxel and extent in the volume's RAS voxel grid. */
  voxelOrigin: Vec3i
  voxelDims: Vec3i
  /** Outer edges in world mm (the voxels' corners, not centres). */
  minMM: Vec3f
  maxMM: Vec3f
}

/**
 * The voxel box of `vol` holding both mm points, with its outer mm edges.
 * Null when the volume has no RAS grid or the box misses it.
 */
export function subVolumeBox(
  vol: NVImage,
  aMM: ArrayLike<number>,
  bMM: ArrayLike<number>,
): SubVolumeBox | null {
  const m = vol.matRAS as ArrayLike<number> | undefined
  const d = vol.dimsRAS as number[] | undefined
  if (!m || !d) return null
  const a = mm2vox(vol, aMM, true)
  const b = mm2vox(vol, bMM, true)
  const lo: Vec3i = [0, 0, 0]
  const size: Vec3i = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.round(Math.min(a[k], b[k]))
    size[k] = Math.round(Math.max(a[k], b[k])) - lo[k] + 1
  }
  const region = clampRegion(lo, size, [d[1], d[2], d[3]])
  if (!region) return null
  const { origin, size: dims } = region
  const minMM: Vec3f = [Infinity, Infinity, Infinity]
  const maxMM: Vec3f = [-Infinity, -Infinity, -Infinity]
  // Eight corners, so an oblique volume's outline still encloses its voxels.
  for (let c = 0; c < 8; c++) {
    const mm = applyAffine(
      m,
      origin[0] - 0.5 + (c & 1) * dims[0],
      origin[1] - 0.5 + ((c >> 1) & 1) * dims[1],
      origin[2] - 0.5 + ((c >> 2) & 1) * dims[2],
    )
    for (let r = 0; r < 3; r++) {
      minMM[r] = Math.min(minMM[r], mm[r])
      maxMM[r] = Math.max(maxMM[r], mm[r])
    }
  }
  return { voxelOrigin: origin, voxelDims: dims, minMM, maxMM }
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
