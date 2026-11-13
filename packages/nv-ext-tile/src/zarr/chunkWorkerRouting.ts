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
  ByteLruStats,
  ChunkPhase,
  ChunkTimingSnapshot,
  OffThreadChunkTiming,
} from '@niivue/niivue'
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
  frame?: number
}): string {
  // Frame 0 keeps the pre-time key, so routing (and persisted scopes) hold.
  const frame = req.frame ? `|t${req.frame}` : ''
  return `${req.levelIndex}|${req.texOrigin.join(',')}|${req.texDims.join(',')}${frame}`
}

/** FNV-1a, 32 bit signed: cheap, and it spreads keys that differ in one digit. */
export function fnv1a(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash
}

/**
 * Pick the worker for a region key. The mapping is DETERMINISTIC, which is the
 * whole point: each worker holds its own byte cache, so a brick must come back
 * to the worker that already has its bytes. Routing to whichever worker is
 * idle would spread one brick across the pool and make every revisit a miss.
 */
export function routeChunkToWorker(key: string, size: number): number {
  if (size <= 1) return 0
  return Math.abs(fnv1a(key)) % size
}

/**
 * Turn a worker's cumulative snapshot into the delta since the last one this
 * pool merged. Workers report cumulatively because several reads can be
 * outstanding inside one worker at once, and a per-read window would either
 * double count their overlap or lose it.
 *
 * `maxMs` is passed through rather than differenced: a maximum cannot be
 * subtracted, and the merge folds it with `Math.max`, so handing over the
 * running maximum is both correct and idempotent. Null for a snapshot behind
 * `before`, so the caller keeps the newer baseline.
 */
export function chunkTimingDelta(
  now: ChunkTimingSnapshot,
  before: ChunkTimingSnapshot | null,
): OffThreadChunkTiming | null {
  // Cumulative snapshots only grow; one behind `before` adds nothing.
  if (
    before &&
    (now.netBusyMs < before.netBusyMs ||
      PHASES.some((p) => now.phases[p].count < before.phases[p].count))
  )
    return null
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
  parts: readonly (ByteLruStats | null)[],
  maxBytes: number,
): ByteLruStats {
  const total: ByteLruStats = {
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

/**
 * How many workers this call should get: the caller's number when they gave
 * one, otherwise the default, and zero wherever a pool cannot run.
 */
export function resolveChunkWorkerCount(options: {
  fetch?: unknown
  workers?: number
}): number {
  // A custom fetch is a function, and a function does not survive structured
  // cloning. Honour it on this thread rather than dropping it.
  if (options.fetch) return 0
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
