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

import { log } from '@/logger'
import type { NVImage } from '@/NVTypes'
import { bytesPerSourceVoxel } from '@/volume/chunkBudget'
import { createChunkFetcher } from '@/volume/chunkFetch'
import type { ChunkPlan, VolumeChunkDesc } from '@/volume/chunking'
import { timeChunkPhase } from '@/volume/chunkTiming'
import type { DecodedChunkCache } from '@/volume/decodedChunkCache'
import {
  type ModulationTextureParams,
  modulationFitsTextureLimit,
} from '@/volume/modulation'
import {
  chunkModulationForDesc,
  chunkRGBA,
  isRGBAChunkDatatype,
} from '@/volume/orientChunked'
import { setTexParams } from './glUtil'
import * as gradient from './gradient'
import {
  createModTexture,
  orientChunkToTexture,
  rgba2TextureChunk,
} from './orientOverlay'

export interface VolumeChunkGL {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: WebGLTexture
  /**
   * RGBA8 gradient texture for this chunk; sized desc.texDims when
   * `hasGradient`, a 1x1x1 placeholder otherwise.
   */
  volumeGradientTexture: WebGLTexture
  /**
   * True if `volumeGradientTexture` holds a real computed gradient; false if it
   * is a 1x1x1 zero placeholder (the ~per-slice gradient pass was skipped
   * because the volume was unlit at upload). The renderer re-uploads such
   * chunks if lighting is later enabled. Either way it is a real, per-chunk
   * texture that destroyVolumeChunksGL frees normally.
   */
  hasGradient: boolean
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

// Allocate a 1x1x1 zero RGBA8 placeholder gradient texture, with the same
// sampling params the gradient sampler uses. Used in place of the expensive
// gradient pass when the volume is unlit (no gradient consumer is active:
// gradientAmount, gradientOpacity and silhouettePower are all zero, the same
// rule as the renderer's _needsGradient()): the gradient
// binding must still hold a complete texture, but the shader only samples it
// when a gradient consumer is on, so a single zero texel is never read — and
// even a stale mid-transition read decodes to the same zeros the old
// brick-sized empty texture held. Keeping it per-chunk (not shared) keeps the
// bind/destroy path unchanged; at 4 bytes it costs nothing, so an unlit
// chunked volume pays 4 bytes per voxel instead of 8.
function emptyGradientTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex)
    throw new Error('orientChunkedGL: failed to allocate gradient texture')
  gl.bindTexture(gl.TEXTURE_3D, tex)
  setTexParams(gl, gl.TEXTURE_3D, gl.LINEAR)
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA8,
    1,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  )
  gl.bindTexture(gl.TEXTURE_3D, null)
  return tex
}

/**
 * On-demand chunk uploader for a chunked volume (WebGL2). The renderer keeps
 * one per chunked volume and calls `uploadChunk` to stream chunks in across
 * frames instead of uploading the whole volume at load. WebGL2 holds no shared
 * GPU resources, so `dispose` only abandons outstanding source reads.
 */
export interface ChunkUploaderGL {
  /** Upload, orient, and gradient the chunk at `index` in the plan. */
  uploadChunk(index: number): Promise<VolumeChunkGL>
  /**
   * Kick off (and cache) the source-byte fetch for `index` ahead of upload, so
   * network-backed fetches for the working set run in parallel instead of
   * serially inside the pump. Bounded and a no-op for in-memory volumes.
   *
   * `speculative` marks a read the view has NOT asked for -- a prediction of
   * where it is going. Those are held to a lower cap so they can only ever use
   * fetch capacity the working set is leaving idle.
   */
  prefetchChunk(index: number, speculative?: boolean): void
  /**
   * Abandon the source-byte fetch for `index`. A no-op for in-memory volumes
   * and for a chunk with nothing outstanding.
   */
  cancelChunk(index: number): void
  /** Abandon every outstanding source read and free the modulator texture. */
  dispose(): void
}

/**
 * Build an on-demand chunk uploader for a chunked volume on WebGL2.
 *
 * Each `uploadChunk` extracts one chunk's source voxels, orients them to an
 * RGBA texture, and runs the gradient pass; only the returned RGBA + gradient
 * textures persist. The renderer pumps these calls a few per frame so a tiled
 * volume streams in rather than stalling the main thread.
 *
 * The modulator's weight texture, when the volume has one, is the only GPU
 * resource shared across chunks; it is created lazily on the first scalar
 * upload and freed by `dispose`.
 */
export function createChunkUploaderGL(
  gl: WebGL2RenderingContext,
  nvimage: NVImage,
  plan: ChunkPlan,
  // Whether to compute a real gradient for each chunk. Read per upload so the
  // decision tracks the current lighting; the renderer re-streams the volume when
  // this crosses false->true (see VolumeRendererGL). Defaults to always-on so
  // existing callers keep prior behavior.
  wantsGradient: () => boolean = () => true,
  // Decoded-chunk tier, owned by the renderer's cache entry so it survives an
  // uploader rebuild (a colormap/window change re-orients bytes it already
  // holds) and can be re-keyed through a plan swap. Never populated for an
  // in-memory volume, whose chunks are a cheap copy out of a buffer we are
  // already holding -- shadowing those would only duplicate the image.
  decoded: DecodedChunkCache | null = null,
  // Resolved modulation for this volume (buildModulationParams against its
  // OWN grid), or null. Baked into every chunk texture like the colormap is,
  // so the renderer's display key must cover it (chunkedDisplayKey).
  modulation: ModulationTextureParams | null = null,
): ChunkUploaderGL {
  const maxTextureDimension3D = gl.getParameter(
    gl.MAX_3D_TEXTURE_SIZE,
  ) as number
  if (!modulationFitsTextureLimit(modulation, maxTextureDimension3D)) {
    log.warn(
      `modulation disabled: grid ${modulation?.dims.join('x')} exceeds WebGL max 3D texture size (${maxTextureDimension3D})`,
    )
    modulation = null
  }
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
  const { takeChunkBytes, prefetchChunk, cancelChunk, abortAll } =
    createChunkFetcher(nvimage, plan, bytesPerVoxel, decoded)

  // Shared modulator weights, uploaded once for all chunks of this uploader.
  let modTexture: WebGLTexture | null = null
  function ensureModTexture(): WebGLTexture | null {
    if (!modulation) return null
    if (!modTexture) modTexture = createModTexture(gl, modulation)
    return modTexture
  }

  function dispose(): void {
    abortAll()
    if (modTexture) {
      gl.deleteTexture(modTexture)
      modTexture = null
    }
  }

  async function uploadChunk(index: number): Promise<VolumeChunkGL> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunkedGL: chunk index ${index} out of range`)
    }
    const chunkBytes = await takeChunkBytes(index)
    // Timed as `upload`: this is the texImage3D submission, the part of a
    // chunk's cost that a decode worker could never take off this thread.
    const volumeTexture = timeChunkPhase(
      'upload',
      () =>
        isRGBA
          ? rgba2TextureChunk(gl, chunkRGBA(chunkBytes, dt), desc.texDims)
          : orientChunkToTexture(
              gl,
              chunkBytes,
              dt,
              desc.texDims,
              nvimage,
              chunkModulationForDesc(modulation, desc, plan),
              ensureModTexture(),
            ),
      chunkBytes.byteLength,
    )
    const dims: [number, number, number] = [
      desc.texDims[0],
      desc.texDims[1],
      desc.texDims[2],
    ]
    // Skip the (expensive, ~per-slice) gradient pass when the volume is unlit;
    // a 1x1x1 placeholder keeps the bind/destroy path identical while paying
    // 4 bytes total instead of 4 bytes per voxel.
    const hasGradient = wantsGradient()
    const volumeGradientTexture = timeChunkPhase('gradient', () =>
      hasGradient
        ? gradient.volume2TextureGradientRGBA(gl, volumeTexture, dims)
        : emptyGradientTexture(gl),
    )
    return { volumeTexture, volumeGradientTexture, desc, hasGradient }
  }

  return { uploadChunk, prefetchChunk, cancelChunk, dispose }
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
