/**
 * The public way to open an OME-Zarr store for `nv.loadChunkedVolume`.
 *
 * It is a thin layer over {@link openOmeZarrChunkedSource}: open the store on
 * this thread for its metadata, then, where a document and Workers allow it,
 * put the reads on a pool of chunk workers.
 *
 * The layering is deliberate rather than cosmetic. A chunk worker opens its own
 * store through `openOmeZarrChunkedSource`, so this module -- the only one that
 * knows about the pool, and through it about the bundler-resolved worker entry
 * -- must stay OUTSIDE what a worker imports. Fold the pool back into
 * `omeZarrChunkedSource.ts` and the worker's own module graph reaches the
 * worker entry again.
 */

import { log } from '@/logger'
import type { ChunkedVolumeFetch } from './ChunkedVolumeSource'
import {
  type FetchOmeZarrChunkedSourceOptions,
  OME_ZARR_CHUNK_CACHE_BYTES,
  OME_ZARR_CHUNK_ERROR,
  type OmeZarrChunkedSource,
  openOmeZarrChunkedSource,
} from './omeZarrChunkedSource'
import type { OmeZarrChunkWorkerPool } from './omeZarrChunkWorkerPool'
import {
  OME_ZARR_PERSIST_BYTES,
  type PersistentCacheOptions,
} from './persistentByteCache'

/**
 * Open a store by URL, adapted for `nv.loadChunkedVolume`, with chunk reads on
 * a worker pool wherever one can run. The opened pyramid stays reachable on the
 * result's `zarr` property (level metadata, omero channels).
 *
 * Call `dispose()` when the source is finished with: it terminates the workers
 * and releases their caches. Dropping the reference alone does not.
 */
export async function fetchOmeZarrChunkedSource(
  url: string,
  options: FetchOmeZarrChunkedSourceOptions = {},
): Promise<OmeZarrChunkedSource> {
  const cacheBytes = options.cacheBytes ?? OME_ZARR_CHUNK_CACHE_BYTES
  const poolSize = resolveChunkWorkerCount(options)
  // With a pool running the workers hold the caches, and a duplicate here
  // would only cache what the workers already declined to send twice. The
  // persistent tier follows the byte cache for the same reason. It would also
  // need a scope of its own over the shared backing, and nothing routed here
  // would ever find what the workers wrote.
  const local = await openOmeZarrChunkedSource(url, {
    ...options,
    cacheBytes: poolSize > 0 ? 0 : cacheBytes,
    persist: poolSize > 0 ? false : options.persist,
  })
  if (poolSize === 0) return local
  const persistPerWorker = splitPersistBudget(options.persist, poolSize)
  // Imported on demand, not at the top. The pool carries an inlined worker
  // that bundles zarrita and its codecs -- megabytes that only a caller who
  // actually streams chunks should ever download.
  const { OmeZarrChunkWorkerPool } = await import('./omeZarrChunkWorkerPool')
  const pool = new OmeZarrChunkWorkerPool(url, options, {
    size: poolSize,
    cacheBytesPerWorker: Math.floor(cacheBytes / poolSize),
    persistPerWorker,
  })
  return {
    ...local,
    fetchChunk: (req) => readViaPool(pool, local, req),
    byteCacheStats: () => pool.byteCacheStats(),
    ...(persistPerWorker ? { persistStats: () => pool.persistStats() } : {}),
    dispose: () => pool.dispose(),
  }
}

/**
 * One worker's share of the persistent budget, or false when the caller did
 * not ask for a tier. Splitting rather than handing each worker the whole
 * number keeps the budget meaning what it says: the bytes on the user's disk,
 * not that number times the pool size.
 */
function splitPersistBudget(
  persist: boolean | PersistentCacheOptions | undefined,
  poolSize: number,
): PersistentCacheOptions | false {
  if (!persist) return false
  const options = persist === true ? {} : persist
  const total = options.maxBytes ?? OME_ZARR_PERSIST_BYTES
  return { maxBytes: Math.floor(total / poolSize), name: options.name }
}

/**
 * How many workers this call should get: the caller's number when they gave
 * one, otherwise the default, and zero wherever a pool cannot run.
 */
function resolveChunkWorkerCount(
  options: FetchOmeZarrChunkedSourceOptions,
): number {
  // A custom fetch is a function, and a function does not survive structured
  // cloning. Honour it on this thread rather than dropping it.
  if (options.fetchImpl) return 0
  // A pool exists to keep a render thread free, so it belongs in a document.
  // Off one -- a test runner, a server -- there is nothing to protect and the
  // worker entry may not even resolve.
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return 0
  const asked = options.workers
  if (asked === undefined) return defaultChunkWorkerCount()
  return Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : 0
}

/**
 * How many chunk workers to run when the caller does not say: half the
 * reported cores, at least one and at most four. The ceiling is deliberate.
 * These reads are dominated by network wait rather than CPU, several are
 * already outstanding inside each worker, and every extra worker costs another
 * store open and another slice of the byte budget.
 */
function defaultChunkWorkerCount(): number {
  const cores = navigator?.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/**
 * Read on the pool, falling back to this thread only when the WORKER failed
 * rather than the read. A 404 or an undecodable region fails the same way
 * here, so retrying it would cost a second full read to reach the same error;
 * an abort is not a failure and is re-thrown untouched.
 */
async function readViaPool(
  pool: OmeZarrChunkWorkerPool,
  local: OmeZarrChunkedSource,
  req: ChunkedVolumeFetch,
): Promise<Uint8Array> {
  try {
    return await pool.fetchChunk(req)
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError' || name === OME_ZARR_CHUNK_ERROR) throw err
    log.warn(
      `OME-Zarr chunk worker failed, reading on the main thread: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return local.fetchChunk(req)
  }
}
