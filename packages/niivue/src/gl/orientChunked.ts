// Per-chunk upload + orient + gradient pipeline for tiled volumes (WebGL2).
//
// WebGL2 mirror of wgpu/orientChunked.ts. For each chunk in a ChunkPlan,
// extracts the chunk's source voxel range from the CPU image buffer, runs the
// orient shader with an identity matrix (output dims == source dims), then runs
// the gradient pass on the per-chunk RGBA output. Returns one
// {volumeTexture, volumeGradientTexture} per chunk.
//
// Scope:
//   - Scalar datatypes only. RGB (128), RGBA (2304), and float64 (64) sources
//     throw — they need a chunked variant of the CPU conversion path.
//   - RAS-aligned (identity permutation) sources use a fast strided row copy.
//     Non-identity sources are reoriented to RAS order during the per-chunk CPU
//     extraction, so the orient pass runs with an identity matrix.

import type { NVImage } from '@/NVTypes'
import { bytesPerSourceVoxel } from '@/volume/chunkBudget'
import type { ChunkPlan, Vec3i, VolumeChunkDesc } from '@/volume/chunking'
import {
  extractChunkBytes,
  extractChunkBytesReoriented,
  isIdentityPermutation,
} from '@/volume/orientChunked'
import * as gradient from './gradient'
import { orientChunkToTexture } from './orientOverlay'

export interface VolumeChunkGL {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: WebGLTexture
  /** RGBA8 gradient texture for this chunk; sized desc.texDims. */
  volumeGradientTexture: WebGLTexture
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

/**
 * Build per-chunk RGBA + gradient textures for a chunked volume on WebGL2.
 *
 * Sequential per chunk: extract -> orient -> gradient. Only the returned RGBA +
 * gradient textures persist; the per-chunk source texture is destroyed inside
 * `orientChunkToTexture`.
 */
export function volume2TextureChunkedGL(
  gl: WebGL2RenderingContext,
  nvimage: NVImage,
  plan: ChunkPlan,
): VolumeChunkGL[] {
  if (!nvimage.dimsRAS) {
    throw new Error('orientChunkedGL: missing dimsRAS')
  }
  if (!nvimage.img) {
    throw new Error('orientChunkedGL: missing image data')
  }
  const dt = nvimage.hdr.datatypeCode
  if (dt === 128 || dt === 2304) {
    throw new Error(
      `orientChunkedGL: RGB/RGBA datatypes (${dt}) are not yet supported for chunked volumes`,
    )
  }
  if (dt === 64) {
    throw new Error(
      'orientChunkedGL: float64 (64) is not supported for chunked volumes',
    )
  }
  const bytesPerVoxel = bytesPerSourceVoxel(dt)
  if (bytesPerVoxel === 0) {
    throw new Error(`orientChunkedGL: unsupported NIfTI datatype ${dt}`)
  }
  const volumeDims: Vec3i = [
    nvimage.dimsRAS[1],
    nvimage.dimsRAS[2],
    nvimage.dimsRAS[3],
  ]
  if (
    volumeDims[0] !== plan.volumeDims[0] ||
    volumeDims[1] !== plan.volumeDims[1] ||
    volumeDims[2] !== plan.volumeDims[2]
  ) {
    throw new Error(
      `orientChunkedGL: plan.volumeDims [${plan.volumeDims}] does not match ` +
        `nvimage.dimsRAS [${volumeDims}]`,
    )
  }

  const frame4D = nvimage.frame4D ?? 0
  const frameByteOffset = frame4D * nvimage.nVox3D * bytesPerVoxel
  const srcBytes = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset + frameByteOffset,
    nvimage.nVox3D * bytesPerVoxel,
  )

  const identity = isIdentityPermutation(nvimage)
  const img2RASstart = nvimage.img2RASstart
  const img2RASstep = nvimage.img2RASstep
  if (!identity && (!img2RASstep || !img2RASstart)) {
    throw new Error(
      'orientChunkedGL: source is non-RAS but missing RAS mapping',
    )
  }

  const results: VolumeChunkGL[] = []
  for (const desc of plan.chunks) {
    const chunkBytes =
      identity || !img2RASstart || !img2RASstep
        ? extractChunkBytes(
            srcBytes,
            volumeDims,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
          )
        : extractChunkBytesReoriented(
            srcBytes,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
            img2RASstart,
            img2RASstep,
          )
    const volumeTexture = orientChunkToTexture(
      gl,
      chunkBytes,
      dt,
      desc.texDims,
      nvimage,
    )
    const volumeGradientTexture = gradient.volume2TextureGradientRGBA(
      gl,
      volumeTexture,
      [desc.texDims[0], desc.texDims[1], desc.texDims[2]],
    )
    results.push({ volumeTexture, volumeGradientTexture, desc })
  }
  return results
}

/** Release all per-chunk GPU textures from a previous build. */
export function destroyVolumeChunksGL(
  gl: WebGL2RenderingContext,
  chunks: VolumeChunkGL[] | null,
): void {
  if (!chunks) return
  for (const c of chunks) {
    gl.deleteTexture(c.volumeTexture)
    gl.deleteTexture(c.volumeGradientTexture)
  }
}
