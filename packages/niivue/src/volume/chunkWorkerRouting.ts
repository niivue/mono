/**
 * The pure parts of the chunk worker pool: which worker a region belongs to,
 * how a worker's cumulative counters become a delta, and how several workers'
 * caches read as one.
 *
 * They live apart from {@link OmeZarrChunkWorkerPool} because that module
 * imports a Vite `?worker&inline` entry, which only a bundler can resolve.
 * Split out, the decisions that actually have edge cases are testable under
 * the Bun runner.
 */

import type {
  ChunkPhase,
  ChunkTimingSnapshot,
  OffThreadChunkTiming,
} from './chunkTiming'
import type { ByteCacheStats } from './omeZarrChunkedSource'
import type { PersistentCacheStats } from './persistentByteCache'

const PHASES: readonly ChunkPhase[] = [
  'net',
  'read',
  'assemble',
  'upload',
  'gradient',
]

/** The content key a chunk request is cached and routed by. */
export function chunkRegionKey(req: {
  levelIndex: number
  texOrigin: readonly number[]
  texDims: readonly number[]
}): string {
  return `${req.levelIndex}|${req.texOrigin.join(',')}|${req.texDims.join(',')}`
}

/**
 * Pick the worker for a region key. The mapping is DETERMINISTIC, which is the
 * whole point: each worker holds its own byte cache, so a brick must come back
 * to the worker that already has its bytes. Routing to whichever worker is
 * idle would spread one brick across the pool and make every revisit a miss.
 */
export function routeChunkToWorker(key: string, size: number): number {
  if (size <= 1) return 0
  // FNV-1a, 32 bit. Cheap, and it spreads keys that differ in a single digit
  // (adjacent bricks) rather than clumping them on one worker.
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash) % size
}

/**
 * Turn a worker's cumulative snapshot into the delta since the last one this
 * pool merged. Workers report cumulatively because several reads can be
 * outstanding inside one worker at once, and a per-read window would either
 * double count their overlap or lose it.
 *
 * `maxMs` is passed through rather than differenced: a maximum cannot be
 * subtracted, and the merge folds it with `Math.max`, so handing over the
 * running maximum is both correct and idempotent.
 */
export function chunkTimingDelta(
  now: ChunkTimingSnapshot,
  before: ChunkTimingSnapshot | null,
): OffThreadChunkTiming {
  const phases: OffThreadChunkTiming['phases'] = {}
  for (const phase of PHASES) {
    const current = now.phases[phase]
    const previous = before?.phases[phase]
    const count = current.count - (previous?.count ?? 0)
    const totalMs = current.totalMs - (previous?.totalMs ?? 0)
    if (count <= 0 && totalMs <= 0) continue
    phases[phase] = {
      count,
      totalMs,
      maxMs: current.maxMs,
      bytes: current.bytes - (previous?.bytes ?? 0),
    }
  }
  return { phases, netBusyMs: now.netBusyMs - (before?.netBusyMs ?? 0) }
}

/**
 * Read several per-worker caches as one. Counts add; `maxBytes` is the budget
 * the pool was given in total, so a hit rate here is measured against the same
 * bytes a single-threaded run would have had.
 */
export function sumByteCacheStats(
  parts: readonly (ByteCacheStats | null)[],
  maxBytes: number,
): ByteCacheStats {
  const total: ByteCacheStats = {
    hits: 0,
    misses: 0,
    admitted: 0,
    rejected: 0,
    evicted: 0,
    evictedBytes: 0,
    entries: 0,
    bytes: 0,
    maxBytes,
  }
  for (const part of parts) {
    if (!part) continue
    total.hits += part.hits
    total.misses += part.misses
    total.admitted += part.admitted
    total.rejected += part.rejected
    total.evicted += part.evicted
    total.evictedBytes += part.evictedBytes
    total.entries += part.entries
    total.bytes += part.bytes
  }
  return total
}

/**
 * Read several per-worker persistent tiers as one. Counts add, as they do for
 * the byte caches, but note what `bytes` means here: the workers share ONE
 * backing store and each owns a scope of it, so a worker's byte total covers
 * only its own scope. Summing them is right precisely because routing is
 * deterministic -- a brick always returns to the worker that holds it, so the
 * scopes partition the keys rather than overlapping.
 */
export function sumPersistStats(
  parts: readonly (PersistentCacheStats | null)[],
  maxBytes: number,
): PersistentCacheStats {
  const total: PersistentCacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    rejected: 0,
    evicted: 0,
    evictedBytes: 0,
    errors: 0,
    entries: 0,
    bytes: 0,
    maxBytes,
  }
  for (const part of parts) {
    if (!part) continue
    total.hits += part.hits
    total.misses += part.misses
    total.writes += part.writes
    total.rejected += part.rejected
    total.evicted += part.evicted
    total.evictedBytes += part.evictedBytes
    total.errors += part.errors
    total.entries += part.entries
    total.bytes += part.bytes
  }
  return total
}
