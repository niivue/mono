/**
 * Web Worker entry point for OME-Zarr chunk reads.
 *
 * Runs the whole read path off the render thread: store `get`, decompress,
 * dtype convert, and the transpose / zero-pad assemble. The main thread is
 * left with the one part a worker cannot take, the GPU upload.
 *
 * The worker opens its OWN view of the store, because a zarrita array is not
 * structured-cloneable. Opening costs one metadata round trip per worker,
 * served from the HTTP cache after the first, and it buys the whole pipeline
 * per worker: its own byte LRU, its own timing recorder, no shared state to
 * synchronise. It is the same code path the main thread takes
 * ({@link openOmeZarrChunkedSource}), not a reimplementation of it.
 *
 * Protocol (NVWorker bridge):
 *   Request:  { _wbId, taskId, url, options, req }
 *   Success:  { _wbId, bytes, timing, cache, persist }  (bytes transferred)
 *   Error:    { _wbId, _wbError, _wbErrorName }
 *   Cancel:   { cancel: taskId }                (no reply, fire and forget)
 *
 * `timing`, `cache` and `persist` are CUMULATIVE for this worker; the pool
 * diffs them against what it last saw so nothing is double counted when
 * several reads land out of order.
 */

import type { ChunkedVolumeFetch } from '@niivue/niivue'
import { chunkTimingSnapshot } from '@niivue/niivue'
import {
  type FetchOmeZarrChunkedSourceOptions,
  OME_ZARR_CHUNK_ERROR,
  type OmeZarrChunkedSource,
  openOmeZarrChunkedSource,
} from './omeZarrChunkedSource'

const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self)

/** Opened sources, keyed by URL + open options. One store, many reads. */
const sources = new Map<string, Promise<OmeZarrChunkedSource>>()

/** In-flight reads that {@link cancel} can still abort, by task id. */
const inflight = new Map<number, AbortController>()

function sourceFor(
  url: string,
  options: FetchOmeZarrChunkedSourceOptions,
): Promise<OmeZarrChunkedSource> {
  const key = `${url}\u0000${JSON.stringify(options)}`
  let source = sources.get(key)
  if (!source) {
    source = openOmeZarrChunkedSource(url, options)
    // A failed open must not be remembered: the next request re-opens rather
    // than replaying the rejection forever.
    source.catch(() => {
      if (sources.get(key) === source) sources.delete(key)
    })
    sources.set(key, source)
  }
  return source
}

/**
 * Transfer needs a buffer this view owns outright. `fetchChunk` may hand back
 * a window onto a larger decode buffer, so copy in that case: the copy runs
 * here, off the render thread, and transferring the oversized original would
 * move bytes nobody asked for.
 */
function ownBuffer(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes
  }
  return new Uint8Array(bytes)
}

self.onmessage = async (e: MessageEvent) => {
  const {
    _wbId: id,
    taskId,
    url,
    options,
    req,
    cancel,
  } = e.data as {
    _wbId?: number
    taskId?: number
    url?: string
    options?: FetchOmeZarrChunkedSourceOptions
    req?: ChunkedVolumeFetch
    cancel?: number
  }

  if (typeof cancel === 'number') {
    inflight.get(cancel)?.abort()
    return
  }
  if (typeof url !== 'string' || !req) {
    post({ _wbId: id, _wbError: 'omeZarrChunk worker: malformed request' })
    return
  }

  const controller = new AbortController()
  if (typeof taskId === 'number') inflight.set(taskId, controller)
  try {
    const source = await sourceFor(url, options ?? {})
    const bytes = await source.fetchChunk({ ...req, signal: controller.signal })
    const out = ownBuffer(bytes)
    post(
      {
        _wbId: id,
        bytes: out,
        timing: chunkTimingSnapshot(),
        cache: source.byteCacheStats?.() ?? null,
        persist: source.persistStats?.() ?? null,
      },
      [out.buffer as ArrayBuffer],
    )
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    // Distinguish "this worker is unusable" from "this read cannot succeed".
    // A store that 404s or a region that will not decode fails the same way on
    // the render thread, so the pool must not pay for it twice; an abort is
    // not a failure at all and must never be retried.
    const isAbort = error.name === 'AbortError' || controller.signal.aborted
    post({
      _wbId: id,
      _wbError: error.message,
      _wbErrorName: isAbort ? 'AbortError' : OME_ZARR_CHUNK_ERROR,
    })
  } finally {
    if (typeof taskId === 'number') inflight.delete(taskId)
  }
}
