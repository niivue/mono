// Backend-agnostic CPU helpers for per-chunk volume extraction.
//
// These pure functions slice a chunk's voxel range out of a contiguous CPU
// image buffer. They are shared by both GPU backends' chunked upload paths
// (wgpu/orientChunked.ts and gl/orientChunked.ts) and have no GPU dependency.

import type { NVImage } from '@/NVTypes'
import type { Vec3i } from '@/volume/chunking'

/**
 * True when the source image's storage order matches RAS without any permutation
 * or flip — i.e. source voxel (x,y,z) is at CPU offset (z*dy+y)*dx+x.
 *
 * Mirrors the inline check in `prepareRGBAData` (view/NVOrient.ts).
 */
export function isIdentityPermutation(nvimage: NVImage): boolean {
  if (!nvimage.img2RASstep || !nvimage.img2RASstart || !nvimage.dimsRAS) {
    return false
  }
  return (
    nvimage.img2RASstep[0] === 1 &&
    nvimage.img2RASstep[1] === nvimage.dimsRAS[1] &&
    nvimage.img2RASstep[2] === nvimage.dimsRAS[1] * nvimage.dimsRAS[2] &&
    nvimage.img2RASstart[0] === 0 &&
    nvimage.img2RASstart[1] === 0 &&
    nvimage.img2RASstart[2] === 0
  )
}

/**
 * Copy a `texDims`-sized 3D sub-region starting at `texOrigin` out of a
 * contiguous source buffer with row-major (x-fastest) layout. Returns a
 * fresh Uint8Array sized exactly to the chunk extent — no padding.
 *
 * Exported for unit testing. Pure CPU function; no GPU dependencies.
 *
 * @param srcBytes        Source buffer, viewed as bytes (Uint8Array).
 * @param volumeDims      Full volume dims in voxels [dx, dy, dz].
 * @param bytesPerVoxel   Source format byte stride per voxel.
 * @param texOrigin       Chunk's first voxel in volume coords (may equal 0).
 * @param texDims         Chunk extent in voxels (must fit within volumeDims).
 */
export function extractChunkBytes(
  srcBytes: Uint8Array,
  volumeDims: Vec3i,
  bytesPerVoxel: number,
  texOrigin: Vec3i,
  texDims: Vec3i,
): Uint8Array {
  const [dx, dy] = volumeDims
  const [ox, oy, oz] = texOrigin
  const [sx, sy, sz] = texDims
  const out = new Uint8Array(sx * sy * sz * bytesPerVoxel)
  const srcRowStride = dx * bytesPerVoxel
  const srcSliceStride = dx * dy * bytesPerVoxel
  const dstRowStride = sx * bytesPerVoxel
  const dstSliceStride = sx * sy * bytesPerVoxel
  const rowByteLen = sx * bytesPerVoxel
  for (let z = 0; z < sz; z++) {
    const srcZ = oz + z
    const dstZBase = z * dstSliceStride
    const srcZBase = srcZ * srcSliceStride
    for (let y = 0; y < sy; y++) {
      const srcOff = srcZBase + (oy + y) * srcRowStride + ox * bytesPerVoxel
      const dstOff = dstZBase + y * dstRowStride
      out.set(srcBytes.subarray(srcOff, srcOff + rowByteLen), dstOff)
    }
  }
  return out
}

/**
 * Extract a `texDims`-sized chunk while reorienting a non-RAS-aligned source
 * into RAS row-major order. For each RAS voxel in the chunk the native CPU
 * index is `sum(img2RASstart) + x*stepX + y*stepY + z*stepZ` — the same signed
 * permutation `reorientRGBA`/`getVoxel` use. The result is byte-identical to
 * what `extractChunkBytes` would produce from an already-RAS source, so the
 * downstream orient pass runs with the identity matrix.
 *
 * Exported for unit testing. Pure CPU function; no GPU dependencies.
 *
 * @param srcBytes      Source buffer (one 3D frame) viewed as bytes.
 * @param bytesPerVoxel Source format byte stride per voxel.
 * @param texOrigin     Chunk's first RAS voxel in volume coords.
 * @param texDims       Chunk extent in RAS voxels.
 * @param img2RASstart  Per-axis native start offsets (NVImage.img2RASstart).
 * @param img2RASstep   Per-axis native strides, signed (NVImage.img2RASstep).
 */
/**
 * Compose a per-chunk overlay orient matrix.
 *
 * The orient shader (both backends) maps an output normalized coord into the
 * source overlay via `in[k] = sum_j mtx[k*4+j] * coord[j]`. When a chunk is
 * oriented into its own `texDims`-sized output texture, the shader's `coord`
 * is chunk-local. This folds the affine lift `o = coord * scale + offset`
 * (chunk-local [0,1] -> full-volume [0,1]) into `mtx`, so the same shader
 * produces the chunk's slice of the full overlay.
 *
 *   scale[j]  = chunk.texDims[j]   / volumeDims[j]
 *   offset[j] = chunk.texOrigin[j] / volumeDims[j]
 *
 * Convention-independent: only uses the `mtx[k*4+j]` indexing both the GLSL
 * (`coord * mtx`) and WGSL (`dot(mtxRow_k, coord)`) orient passes share.
 *
 * @param mtx     Original 16-element overlay matrix (full-volume orient).
 * @param scale   Per-axis chunk extent fraction of the full volume.
 * @param offset  Per-axis chunk origin fraction of the full volume.
 */
export function chunkOverlayMatrix(
  mtx: Float32Array,
  scale: Vec3i | readonly number[],
  offset: Vec3i | readonly number[],
): Float32Array {
  const out = new Float32Array(16)
  for (let k = 0; k < 4; k++) {
    const b = k * 4
    out[b + 0] = mtx[b + 0] * scale[0]
    out[b + 1] = mtx[b + 1] * scale[1]
    out[b + 2] = mtx[b + 2] * scale[2]
    out[b + 3] =
      mtx[b + 0] * offset[0] +
      mtx[b + 1] * offset[1] +
      mtx[b + 2] * offset[2] +
      mtx[b + 3]
  }
  return out
}

export function extractChunkBytesReoriented(
  srcBytes: Uint8Array,
  bytesPerVoxel: number,
  texOrigin: Vec3i,
  texDims: Vec3i,
  img2RASstart: number[],
  img2RASstep: number[],
): Uint8Array {
  const [ox, oy, oz] = texOrigin
  const [sx, sy, sz] = texDims
  const out = new Uint8Array(sx * sy * sz * bytesPerVoxel)
  const startSum = img2RASstart[0] + img2RASstart[1] + img2RASstart[2]
  const [stepX, stepY, stepZ] = img2RASstep
  let dst = 0
  for (let z = 0; z < sz; z++) {
    const baseZ = startSum + (oz + z) * stepZ
    for (let y = 0; y < sy; y++) {
      const baseZY = baseZ + (oy + y) * stepY
      for (let x = 0; x < sx; x++) {
        const srcOff = (baseZY + (ox + x) * stepX) * bytesPerVoxel
        for (let b = 0; b < bytesPerVoxel; b++) {
          out[dst++] = srcBytes[srcOff + b]
        }
      }
    }
  }
  return out
}
