// Source-byte fetching for a chunked volume's uploader, shared by the WebGL2
// and WebGPU backends (gl/orientChunked.ts, wgpu/orientChunked.ts). Holds the
// in-flight/prefetch cache, the decoded tier hand-off and read cancellation;
// the backends only turn the bytes into textures.

import type { NVImage } from '@/NVTypes'
import type { ChunkPlan, Vec3i } from './chunking'
import type { DecodedChunkCache } from './decodedChunkCache'
import {
  extractChunkBytes,
  extractChunkBytesReoriented,
  isIdentityPermutation,
} from './orientChunked'

/**
 * Max outstanding prefetched (fetched-but-not-yet-uploaded) chunk byte buffers
 * per uploader. Bounds CPU memory held by parallel prefetch: at ~256^3 * bpv
 * per buffer this caps a uint16 source at roughly half a gigabyte.
 */
export const MAX_PREFETCHED_CHUNKS = 16

/**
 * Fetch slots reserved for the working set. A speculative (predicted) read may
 * not grow the outstanding set past `MAX_PREFETCHED_CHUNKS` minus this, so a
 * guess can never take the slot of a chunk the view can already see.
 */
export const PREFETCH_SLOTS_RESERVED = 4

/** One cached source-byte fetch, with the handle that abandons it. */
interface ChunkFetch {
  promise: Promise<Uint8Array>
  controller: AbortController
}

export interface ChunkFetcher {
  /**
   * The source bytes of chunk `index`, for upload. Frees its prefetch slot and
   * hands network-backed bytes to the decoded tier.
   */
  takeChunkBytes(index: number): Promise<Uint8Array>
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
  abortAll(): void
}

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
      `orientChunked: chunk source returned ${bytes.byteLength} bytes, expected ${expectedBytes}`,
    )
  }
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes)
}

/**
 * Fetcher for a chunked volume's source bytes: a `chunkSource` read for a
 * network-backed volume, else a copy out of the current frame of `img`.
 * Throws when the plan does not fit the volume. `nvimage.dimsRAS` must be set.
 */
export function createChunkFetcher(
  nvimage: NVImage,
  plan: ChunkPlan,
  bytesPerVoxel: number,
  decoded: DecodedChunkCache | null,
): ChunkFetcher {
  const dimsRAS = nvimage.dimsRAS ?? []
  const volumeDims: Vec3i = [dimsRAS[1], dimsRAS[2], dimsRAS[3]]
  if (
    volumeDims[0] !== plan.volumeDims[0] ||
    volumeDims[1] !== plan.volumeDims[1] ||
    volumeDims[2] !== plan.volumeDims[2]
  ) {
    throw new Error(
      `orientChunked: plan.volumeDims [${plan.volumeDims}] does not match ` +
        `nvimage.dimsRAS [${volumeDims}]`,
    )
  }
  const chunkSource = nvimage.chunkSource
  const dt = nvimage.hdr.datatypeCode

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
    throw new Error('orientChunked: source is non-RAS but missing RAS mapping')
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
        new Error(`orientChunked: chunk index ${index} out of range`),
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

  async function takeChunkBytes(index: number): Promise<Uint8Array> {
    const chunkBytes = await fetchBytes(index)
    // Consumed — free the CPU buffer reference so prefetch headroom recovers.
    fetchCache.delete(index)
    // Hand the decoded bytes to the tier instead of dropping them: this is the
    // only moment they exist, and holding them through the chunk's residency
    // is what makes its eventual eviction a demotion rather than a loss.
    if (chunkSource) decoded?.set(index, chunkBytes)
    return chunkBytes
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

  function abortAll(): void {
    for (const entry of fetchCache.values()) entry.controller.abort()
    fetchCache.clear()
  }

  return { takeChunkBytes, prefetchChunk, cancelChunk, abortAll }
}
