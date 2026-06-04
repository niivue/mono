// Per-chunk upload + orient + gradient pipeline for tiled volumes (WebGL2).
//
// WebGL2 mirror of wgpu/orientChunked.ts. For each chunk in a ChunkPlan,
// extracts the chunk's source voxel range from the CPU image buffer, runs the
// orient shader with an identity matrix (output dims == source dims), then runs
// the gradient pass on the per-chunk RGBA output. Returns one
// {volumeTexture, volumeGradientTexture} per chunk.
//
// Scope:
//   - Scalar datatypes plus RGB (128) / RGBA (2304) color: scalars go through
//     the orient/colormap shader, color uploads straight to RGBA8 via
//     rgba2TextureChunk (the chunked rgba2Texture bypass). float64 (64) throws.
//   - RAS-aligned (identity permutation) sources use a fast strided row copy.
//     Non-identity sources are reoriented to RAS order during the per-chunk CPU
//     extraction, so the orient pass runs with an identity matrix.

import type { NVImage } from '@/NVTypes'
import { bytesPerSourceVoxel } from '@/volume/chunkBudget'
import type { ChunkPlan, Vec3i, VolumeChunkDesc } from '@/volume/chunking'
import {
  chunkRGBA,
  extractChunkBytes,
  extractChunkBytesReoriented,
  isIdentityPermutation,
  isRGBAChunkDatatype,
} from '@/volume/orientChunked'
import * as gradient from './gradient'
import { orientChunkToTexture, rgba2TextureChunk } from './orientOverlay'

export interface VolumeChunkGL {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: WebGLTexture
  /** RGBA8 gradient texture for this chunk; sized desc.texDims. */
  volumeGradientTexture: WebGLTexture
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

/**
 * On-demand chunk uploader for a chunked volume (WebGL2). The renderer keeps
 * one per chunked volume and calls `uploadChunk` to stream chunks in across
 * frames instead of uploading the whole volume at load. `dispose` exists for
 * interface parity with the WebGPU uploader — WebGL2 holds no shared GPU
 * resources, so it is a no-op.
 */
export interface ChunkUploaderGL {
  /** Upload, orient, and gradient the chunk at `index` in the plan. */
  uploadChunk(index: number): Promise<VolumeChunkGL>
  /**
   * Kick off (and cache) the source-byte fetch for `index` ahead of upload, so
   * network-backed fetches for the working set run in parallel instead of
   * serially inside the pump. Bounded and a no-op for in-memory volumes.
   */
  prefetchChunk(index: number): void
  /** No-op; present for parity with the WebGPU uploader. */
  dispose(): void
}

/**
 * Max outstanding prefetched (fetched-but-not-yet-uploaded) chunk byte buffers
 * per uploader. Bounds CPU memory held by parallel prefetch (~256^3 * bpv each).
 */
const MAX_PREFETCHED_CHUNKS = 16

function bytesFromChunkSource(
  data: ArrayBuffer | Uint8Array | NonNullable<NVImage['img']>,
  expectedBytes: number,
): Uint8Array {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `orientChunkedGL: chunk source returned ${bytes.byteLength} bytes, expected ${expectedBytes}`,
    )
  }
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes)
}

/**
 * Build an on-demand chunk uploader for a chunked volume on WebGL2.
 *
 * Each `uploadChunk` extracts one chunk's source voxels, orients them to an
 * RGBA texture, and runs the gradient pass; only the returned RGBA + gradient
 * textures persist. The renderer pumps these calls a few per frame so a tiled
 * volume streams in rather than stalling the main thread.
 */
export function createChunkUploaderGL(
  gl: WebGL2RenderingContext,
  nvimage: NVImage,
  plan: ChunkPlan,
): ChunkUploaderGL {
  if (!nvimage.dimsRAS) {
    throw new Error('orientChunkedGL: missing dimsRAS')
  }
  const chunkSource = nvimage.chunkSource
  if (!nvimage.img && !chunkSource) {
    throw new Error('orientChunkedGL: missing image data')
  }
  const dt = nvimage.hdr.datatypeCode
  // RGB/RGBA color sources upload straight to RGBA8 (see chunkRGBA), bypassing
  // the orient/colormap shader — the chunked analogue of rgba2Texture.
  const isRGBA = isRGBAChunkDatatype(dt)
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
  const srcBytes = nvimage.img
    ? new Uint8Array(
        nvimage.img.buffer,
        nvimage.img.byteOffset + frameByteOffset,
        nvimage.nVox3D * bytesPerVoxel,
      )
    : null

  const identity = chunkSource ? true : isIdentityPermutation(nvimage)
  const img2RASstart = nvimage.img2RASstart
  const img2RASstep = nvimage.img2RASstep
  if (!chunkSource && !identity && (!img2RASstep || !img2RASstart)) {
    throw new Error(
      'orientChunkedGL: source is non-RAS but missing RAS mapping',
    )
  }

  // Cache of in-flight / ready source-byte fetches, keyed by chunk index. Only
  // populated for chunkSource (network-backed) volumes; in-memory extraction is
  // synchronous and cheap, so it is computed on demand without caching.
  const fetchCache = new Map<number, Promise<Uint8Array>>()

  function computeBytes(index: number): Promise<Uint8Array> {
    const desc = plan.chunks[index]
    if (!desc) {
      return Promise.reject(
        new Error(`orientChunkedGL: chunk index ${index} out of range`),
      )
    }
    const expectedBytes =
      desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bytesPerVoxel
    if (chunkSource) {
      return Promise.resolve(
        chunkSource({
          chunkIndex: index,
          desc,
          plan,
          datatypeCode: dt,
          bytesPerVoxel,
        }),
      ).then((r) => bytesFromChunkSource(r, expectedBytes))
    }
    const bytes =
      identity || !img2RASstart || !img2RASstep
        ? extractChunkBytes(
            srcBytes as Uint8Array,
            volumeDims,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
          )
        : extractChunkBytesReoriented(
            srcBytes as Uint8Array,
            bytesPerVoxel,
            desc.texOrigin,
            desc.texDims,
            img2RASstart,
            img2RASstep,
          )
    return Promise.resolve(bytes)
  }

  function fetchBytes(index: number): Promise<Uint8Array> {
    if (!chunkSource) return computeBytes(index)
    const cached = fetchCache.get(index)
    if (cached) return cached
    const p = computeBytes(index)
    fetchCache.set(index, p)
    // Don't cache rejections: drop the entry so a re-queued chunk retries fresh.
    p.catch(() => {
      if (fetchCache.get(index) === p) fetchCache.delete(index)
    })
    return p
  }

  function prefetchChunk(index: number): void {
    if (!chunkSource) return
    if (fetchCache.has(index)) return
    if (fetchCache.size >= MAX_PREFETCHED_CHUNKS) return
    void fetchBytes(index)
  }

  async function uploadChunk(index: number): Promise<VolumeChunkGL> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunkedGL: chunk index ${index} out of range`)
    }
    const chunkBytes = await fetchBytes(index)
    // Consumed — free the CPU buffer reference so prefetch headroom recovers.
    fetchCache.delete(index)
    const volumeTexture = isRGBA
      ? rgba2TextureChunk(gl, chunkRGBA(chunkBytes, dt), desc.texDims)
      : orientChunkToTexture(gl, chunkBytes, dt, desc.texDims, nvimage)
    const volumeGradientTexture = gradient.volume2TextureGradientRGBA(
      gl,
      volumeTexture,
      [desc.texDims[0], desc.texDims[1], desc.texDims[2]],
    )
    return { volumeTexture, volumeGradientTexture, desc }
  }

  return { uploadChunk, prefetchChunk, dispose: () => fetchCache.clear() }
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
