/**
 * A pool of workers that read OME-Zarr chunks, so fetch and decode stop
 * competing with the render loop.
 *
 * Stage B measured the problem (`docs/caching.md` 2.5): 20 seconds of
 * uninteracted streaming cost the render loop 8.6 seconds over a 24 ms frame
 * budget, of which only 125 ms was texture upload. Everything else was the
 * store read and the decode inside zarrita, and all of it ran on the thread
 * that draws. This pool moves that work; the upload and the gradient pass stay
 * where they must be, next to the GPU context.
 *
 * Each worker opens the store itself and keeps its own byte LRU, so a request
 * is routed by hashing its region rather than by picking the idlest worker --
 * see {@link routeChunkToWorker} for why that matters.
 *
 * A worker failure is not automatically fatal: the caller still holds a
 * main-thread source and can read there. Only failures a re-run would repeat
 * (a missing store, a region that will not decode) come back marked final.
 */

import { NVWorker } from '@/workers/NVWorker'
import OmeZarrChunkWorker from '@/workers/omeZarrChunk.worker?worker&inline'
import type { ChunkedVolumeFetch } from './ChunkedVolumeSource'
import {
  type ChunkTimingSnapshot,
  mergeOffThreadChunkTiming,
} from './chunkTiming'
import {
  chunkRegionKey,
  chunkTimingDelta,
  routeChunkToWorker,
  sumByteCacheStats,
  sumPersistStats,
} from './chunkWorkerRouting'
import type {
  ByteCacheStats,
  FetchOmeZarrChunkedSourceOptions,
} from './omeZarrChunkedSource'
import type {
  PersistentCacheOptions,
  PersistentCacheStats,
} from './persistentByteCache'

/** What one worker returns for one chunk. */
interface ChunkReply {
  bytes: Uint8Array
  timing: ChunkTimingSnapshot
  cache: ByteCacheStats | null
  persist: PersistentCacheStats | null
}

/** Options for {@link OmeZarrChunkWorkerPool}. */
export interface OmeZarrChunkPoolOptions {
  /** Workers to start. Clamped to at least one. */
  size: number
  /** Byte budget for EACH worker's store cache. */
  cacheBytesPerWorker: number
  /**
   * The persistent tier EACH worker opens, already sized to its share, or
   * false for no tier at all. The workers share one backing store and are
   * given a scope apiece; routing is deterministic, so a brick returns to the
   * worker that holds it and the scopes partition the store.
   */
  persistPerWorker: PersistentCacheOptions | false
}

export class OmeZarrChunkWorkerPool {
  private readonly workers: NVWorker[]
  private readonly lastTiming: (ChunkTimingSnapshot | null)[]
  private readonly lastCache: (ByteCacheStats | null)[]
  private readonly lastPersist: (PersistentCacheStats | null)[]
  private readonly workerOptions: FetchOmeZarrChunkedSourceOptions[]
  private nextTaskId = 0
  private disposed = false

  constructor(
    private readonly url: string,
    options: FetchOmeZarrChunkedSourceOptions,
    private readonly pool: OmeZarrChunkPoolOptions,
  ) {
    const size = Math.max(1, Math.floor(pool.size) || 1)
    this.workers = Array.from(
      { length: size },
      () => new NVWorker(() => new OmeZarrChunkWorker()),
    )
    this.lastTiming = new Array(size).fill(null)
    this.lastCache = new Array(size).fill(null)
    this.lastPersist = new Array(size).fill(null)
    // Rebuild the options the worker needs rather than forwarding whatever
    // came in: `fetchImpl` is a function and would not survive the clone (the
    // caller declines the pool when one is set), and the worker must not build
    // a pool of its own.
    //
    // `levels` and `ignoreMissingLevels` MUST cross: they decide which
    // datasets get opened, and `levelIndex` is an index into that opened list.
    // Drop them and every request would silently address the wrong level.
    //
    // The persistent tier is the one option that differs per worker: each gets
    // its own scope over the shared backing, plus the full list so a worker
    // can tell a sibling's keys (leave them) from the leftovers of a
    // differently sized pool (delete them).
    const scopes = Array.from({ length: size }, (_, i) => `w${i}/`)
    this.workerOptions = scopes.map((scope) => ({
      channel: options.channel,
      timepoint: options.timepoint,
      levels: options.levels,
      ignoreMissingLevels: options.ignoreMissingLevels,
      cacheBytes: pool.cacheBytesPerWorker,
      persist: pool.persistPerWorker
        ? { ...pool.persistPerWorker, scope, scopes }
        : false,
      workers: 0,
    }))
  }

  /** Workers running. */
  get size(): number {
    return this.workers.length
  }

  /**
   * Read one chunk on a worker. Rejects with an `AbortError` when `req.signal`
   * fires, and with the worker's own error otherwise; the caller decides
   * whether that error is worth a main-thread retry.
   */
  async fetchChunk(req: ChunkedVolumeFetch): Promise<Uint8Array> {
    // A read that arrives after dispose belongs to a volume being torn down.
    // Reporting it as an abort keeps the caller from "recovering" by reading
    // the same bytes on the main thread for a view that no longer wants them.
    if (this.disposed) throw abortError('OME-Zarr chunk pool: already disposed')
    const { levelIndex, texOrigin, texDims, bytesPerVoxel, signal } = req
    signal?.throwIfAborted()
    const index = routeChunkToWorker(
      chunkRegionKey({ levelIndex, texOrigin, texDims }),
      this.workers.length,
    )
    const worker = this.workers[index]
    const taskId = this.nextTaskId++
    // The cancel reaches the worker's own read, not just its queue: an abort
    // while the bytes are already on the wire is the case worth cancelling.
    // Not after dispose: `notify` would re-create the very worker `terminate`
    // just tore down, to cancel a task that died with it.
    const onAbort = (): void => {
      if (!this.disposed) worker.notify({ cancel: taskId })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const reply = await worker.execute<ChunkReply>({
        taskId,
        url: this.url,
        options: this.workerOptions[index],
        req: { levelIndex, texOrigin, texDims, bytesPerVoxel },
      })
      this.merge(index, reply)
      return reply.bytes
    } catch (err) {
      // `terminate` rejects everything outstanding with a plain error. Once
      // disposed, that is teardown rather than worker failure, so it reports
      // as an abort for the same reason the guard above does.
      if (this.disposed) throw abortError('OME-Zarr chunk pool: disposed')
      throw err
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * The pool's byte caches, summed. The numbers are as of each worker's last
   * reply, so an idle pool reports its last known state rather than nothing.
   */
  byteCacheStats(): ByteCacheStats {
    return sumByteCacheStats(
      this.lastCache,
      this.pool.cacheBytesPerWorker * this.workers.length,
    )
  }

  /**
   * The pool's persistent tiers, summed, as of each worker's last reply. The
   * budget reported is the pool's total, so a hit rate here reads against the
   * same disk a single-threaded run would have used.
   */
  persistStats(): PersistentCacheStats {
    const perWorker = this.pool.persistPerWorker
    return sumPersistStats(
      this.lastPersist,
      (perWorker ? (perWorker.maxBytes ?? 0) : 0) * this.workers.length,
    )
  }

  /** Terminate every worker and reject whatever is outstanding. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const worker of this.workers) worker.terminate()
  }

  private merge(index: number, reply: ChunkReply): void {
    if (reply.timing) {
      mergeOffThreadChunkTiming(
        chunkTimingDelta(reply.timing, this.lastTiming[index]),
      )
      this.lastTiming[index] = reply.timing
    }
    if (reply.cache) this.lastCache[index] = reply.cache
    if (reply.persist) this.lastPersist[index] = reply.persist
  }
}

/**
 * An error the rest of the pipeline treats as "nobody wants this any more":
 * never retried, never fallen back to the main thread, never logged.
 */
function abortError(message: string): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}
