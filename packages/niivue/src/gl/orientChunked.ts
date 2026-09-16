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
import { timeChunkPhase } from '@/volume/chunkTiming'
import type { DecodedChunkCache } from '@/volume/decodedChunkCache'
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
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
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

/** One cached source-byte fetch, with the handle that abandons it. */
interface ChunkFetch {
  promise: Promise<Uint8Array>
  controller: AbortController
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
  /** Abandon every outstanding source read. */
  dispose(): void
}

/**
 * Max outstanding prefetched (fetched-but-not-yet-uploaded) chunk byte buffers
 * per uploader. Bounds CPU memory held by parallel prefetch (~256^3 * bpv each).
 */
const MAX_PREFETCHED_CHUNKS = 16

/**
 * Fetch slots reserved for the working set. A speculative (predicted) read may
 * not grow the outstanding set past `MAX_PREFETCHED_CHUNKS` minus this, so a
 * guess can never take the slot of a chunk the view can already see.
 */
const PREFETCH_SLOTS_RESERVED = 4

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
  // synchronous and cheap, so it is computed on demand without caching. Each
  // entry carries the controller that cancels its read, so a chunk the view
  // stops wanting is abandoned on the wire rather than paid for and dropped.
  const fetchCache = new Map<number, ChunkFetch>()

  function computeBytes(
    index: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
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
          signal,
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
    if (cached) return cached.promise
    // The decoded tier is consulted AFTER the in-flight map so a read already
    // on the wire is never duplicated, and before any new read so an evicted
    // chunk comes back as an upload rather than a fetch + decode.
    const held = decoded?.get(index)
    if (held) return Promise.resolve(held)
    const controller = new AbortController()
    const promise = computeBytes(index, controller.signal)
    const entry: ChunkFetch = { promise, controller }
    fetchCache.set(index, entry)
    // Don't cache rejections: drop the entry so a re-queued chunk retries fresh.
    promise.catch(() => {
      if (fetchCache.get(index) === entry) fetchCache.delete(index)
    })
    return promise
  }

  function prefetchChunk(index: number, speculative = false): void {
    if (!chunkSource) return
    if (fetchCache.has(index)) return
    // Already decoded: there is nothing to warm, and counting the lookup here
    // would credit the tier for a read the pump never made.
    if (decoded?.has(index)) return
    const cap = speculative
      ? MAX_PREFETCHED_CHUNKS - PREFETCH_SLOTS_RESERVED
      : MAX_PREFETCHED_CHUNKS
    if (fetchCache.size >= cap) return
    // The prefetch is speculative, so nobody is awaiting it. Swallow its
    // rejection here (including the abort a later cancel raises) rather than
    // leaving an unobserved promise; a real failure resurfaces when the upload
    // pump asks for the same chunk and re-fetches it.
    void fetchBytes(index).catch(() => {})
  }

  /**
   * Abandon a chunk's source read. Called when the view stops asking for a
   * chunk it had queued: the bytes are no longer wanted, so the read is
   * aborted and the prefetch slot freed for one that is. A later request for
   * the same chunk simply starts a new read.
   */
  function cancelChunk(index: number): void {
    const entry = fetchCache.get(index)
    if (!entry) return
    fetchCache.delete(index)
    entry.controller.abort()
  }

  function dispose(): void {
    for (const entry of fetchCache.values()) entry.controller.abort()
    fetchCache.clear()
  }

  async function uploadChunk(index: number): Promise<VolumeChunkGL> {
    const desc = plan.chunks[index]
    if (!desc) {
      throw new Error(`orientChunkedGL: chunk index ${index} out of range`)
    }
    const chunkBytes = await fetchBytes(index)
    // Consumed — free the CPU buffer reference so prefetch headroom recovers.
    fetchCache.delete(index)
    // Hand the decoded bytes to the tier instead of dropping them: this is the
    // only moment they exist, and holding them through the chunk's residency
    // is what makes its eventual eviction a demotion rather than a loss.
    if (chunkSource) decoded?.set(index, chunkBytes)
    // Timed as `upload`: this is the texImage3D submission, the part of a
    // chunk's cost that a decode worker could never take off this thread.
    const volumeTexture = timeChunkPhase(
      'upload',
      () =>
        isRGBA
          ? rgba2TextureChunk(gl, chunkRGBA(chunkBytes, dt), desc.texDims)
          : orientChunkToTexture(gl, chunkBytes, dt, desc.texDims, nvimage),
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
