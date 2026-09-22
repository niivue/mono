/**
 * Per-phase timing for the chunked-volume streaming path.
 *
 * Streaming a brick costs three very different kinds of work, and the plan in
 * `docs/caching.md` turns on which one dominates: bytes over the wire, decode
 * on the main thread, and the GPU upload. A decode worker (stage C) can move
 * the first two off the render thread and can do nothing about the third, so
 * the split had to be measured before the worker plumbing was worth writing.
 * Now that the pool exists, the same recorder measures what it moved: a phase
 * a worker ran is counted in full and also booked to `offThreadMs`.
 *
 * The recorder is a module-level singleton: it aggregates every chunked volume
 * on every instance in the page, which is what a profiling aid wants. It also
 * aggregates across CONSUMERS: a slide reading a plane out of a chunked volume
 * goes through the same `fetchChunk`, so its tiles land in `net` and `read`
 * beside the volume's bricks while only the volume's reads reach the brick
 * uploader. Divide each phase by its own `count`; a mean taken across two
 * phases with different counts means nothing. Call
 * {@link resetChunkTiming} to start a measurement window, exercise the view,
 * then read {@link chunkTimingSnapshot}.
 *
 * ```ts
 * resetChunkTiming()
 * // ... scrub a slice, rotate, zoom ...
 * const t = chunkTimingSnapshot()
 * console.log(t.phases.upload.totalMs / t.phases.upload.count)
 * ```
 *
 * What each phase measures, and how honest each number is:
 *
 * - `net` — one store `get`: the network round trip, or a hit in the byte LRU
 *   / HTTP cache. Exact per call.
 * - `read` — one whole `fetchChunk`: `net` plus decompression, dtype
 *   conversion and the region assemble. Wall clock, so concurrent reads
 *   overlap and the total exceeds elapsed time.
 * - `assemble` — the synchronous transpose / zero-pad loop that lays a store
 *   block out x-fastest. Exact, and blocking on whichever thread ran it: with
 *   the chunk worker pool on it runs there, and `offThreadMs` says so.
 * - `upload` — building a texture from the decoded bytes: a volume brick, or
 *   an `NVSlide` tile drawn from the same source. On
 *   WebGPU this awaits `onSubmittedWorkDone`, so it is real GPU time; on
 *   WebGL2 it is the `texImage3D` submission, which is main-thread blocking
 *   but does not include the driver's own asynchronous work.
 * - `gradient` — the per-chunk gradient pass, same caveat per backend.
 *
 * Two derived numbers sit beside the phases, and both are exact rather than
 * inferred:
 *
 * - `mainThreadMs` is `assemble + upload + gradient` MINUS whatever part of
 *   them a chunk worker ran: the streaming work that actually blocks the
 *   render loop. This is the number stage C had to beat, and the part of it a
 *   worker cannot move (`upload` + `gradient`) is visible right next to it.
 *   `offThreadMs` is the complement, the work the pool took away.
 * - `netBusyMs` is wall clock with at least one store `get` outstanding, as a
 *   UNION rather than a sum. One `zarr.get` fans out to every store chunk
 *   covering the region, so those calls overlap each other and overlap sibling
 *   reads; summing them counts the same wall clock many times over.
 *
 * Decode is deliberately NOT reported as a derived figure. It happens inside
 * zarrita between the store read and our assemble loop, we cannot time it
 * directly, and `read - net - assemble` is not a bound in either direction once
 * the `get` calls overlap. Measure it instead: re-visit bricks whose bytes are
 * already in the byte LRU, where `net` falls to near zero and `read - assemble`
 * IS decode.
 */

/** A phase of the per-chunk streaming pipeline. */
export type ChunkPhase = 'net' | 'read' | 'assemble' | 'upload' | 'gradient'

/** Accumulated timing for one {@link ChunkPhase}. */
export interface ChunkPhaseTiming {
  /** How many times the phase ran. */
  count: number
  /** Summed wall clock, milliseconds. */
  totalMs: number
  /** Slowest single run, milliseconds. */
  maxMs: number
  /** Bytes moved, where the phase knows (0 otherwise). */
  bytes: number
  /**
   * The part of `totalMs` that ran on a worker rather than on the render
   * thread. Subtracted out of {@link ChunkTimingSnapshot.mainThreadMs}, so the
   * same phase reads the same way whether or not the chunk worker pool is on.
   */
  offThreadMs: number
}

/** Everything the recorder holds, as a plain snapshot. */
export interface ChunkTimingSnapshot {
  /** Per-phase totals. */
  phases: Record<ChunkPhase, ChunkPhaseTiming>
  /**
   * Wall clock with at least one store `get` outstanding, as a union of the
   * outstanding intervals rather than a sum of them. Overlapping reads count
   * this time once.
   */
  netBusyMs: number
  /**
   * Streaming work that blocked the render loop: `assemble + upload +
   * gradient`, less whatever part of them ran on a chunk worker. Exact, and
   * the figure a decode worker has to improve on.
   */
  mainThreadMs: number
  /**
   * Milliseconds of the phases above that ran on a chunk worker instead of the
   * render thread. Zero with the pool off; with it on, this is what stage C
   * moved.
   */
  offThreadMs: number
}

/** One chunk worker's phase totals, as a delta of its cumulative snapshot. */
export interface OffThreadChunkTiming {
  /** Per-phase deltas. Phases the worker never ran may be omitted. */
  phases: Partial<Record<ChunkPhase, Omit<ChunkPhaseTiming, 'offThreadMs'>>>
  /** The worker's own `netBusyMs` delta. */
  netBusyMs: number
}

const PHASES: readonly ChunkPhase[] = [
  'net',
  'read',
  'assemble',
  'upload',
  'gradient',
]

function emptyPhase(): ChunkPhaseTiming {
  return { count: 0, totalMs: 0, maxMs: 0, bytes: 0, offThreadMs: 0 }
}

const totals = new Map<ChunkPhase, ChunkPhaseTiming>()

/** Outstanding store reads, for the `netBusyMs` union. */
let netOutstanding = 0
/** When the current run of outstanding reads began. */
let netRunStart = 0
/** Accumulated union of the outstanding-read intervals. */
let netBusyMs = 0
/** The same, as reported by chunk workers. See {@link mergeOffThreadChunkTiming}. */
let offThreadNetBusyMs = 0

function phaseEntry(phase: ChunkPhase): ChunkPhaseTiming {
  let entry = totals.get(phase)
  if (!entry) {
    entry = emptyPhase()
    totals.set(phase, entry)
  }
  return entry
}

/** Add one run of `phase` to the totals. Non-finite durations are ignored. */
export function recordChunkPhase(
  phase: ChunkPhase,
  ms: number,
  bytes = 0,
): void {
  if (!Number.isFinite(ms) || ms < 0) return
  const entry = phaseEntry(phase)
  entry.count++
  entry.totalMs += ms
  if (ms > entry.maxMs) entry.maxMs = ms
  if (Number.isFinite(bytes) && bytes > 0) entry.bytes += bytes
}

/**
 * Fold a chunk worker's phase totals into this thread's. The worker runs the
 * same `net` / `read` / `assemble` spans against its own recorder, so what
 * arrives is a DELTA of its cumulative snapshot: counts and sums add, `maxMs`
 * takes the larger of the two, and every millisecond is also booked as
 * off-thread so {@link ChunkTimingSnapshot.mainThreadMs} keeps meaning "work
 * that blocked the render loop".
 *
 * `netBusyMs` is a union per recorder, and a union of unions is not derivable
 * from the parts: two workers busy over the same wall clock contribute it
 * twice. Merged `netBusyMs` is therefore an UPPER bound with a pool running,
 * exact with one worker or none.
 */
export function mergeOffThreadChunkTiming(delta: OffThreadChunkTiming): void {
  for (const phase of PHASES) {
    const add = delta.phases[phase]
    if (!add) continue
    const ms = Number.isFinite(add.totalMs) ? Math.max(0, add.totalMs) : 0
    const entry = phaseEntry(phase)
    entry.count += Math.max(0, add.count)
    entry.totalMs += ms
    entry.offThreadMs += ms
    if (Number.isFinite(add.maxMs) && add.maxMs > entry.maxMs) {
      entry.maxMs = add.maxMs
    }
    if (Number.isFinite(add.bytes) && add.bytes > 0) entry.bytes += add.bytes
  }
  if (Number.isFinite(delta.netBusyMs) && delta.netBusyMs > 0) {
    offThreadNetBusyMs += delta.netBusyMs
  }
}

/** Time a synchronous span and record it as `phase`. */
export function timeChunkPhase<T>(
  phase: ChunkPhase,
  run: () => T,
  bytes = 0,
): T {
  const start = performance.now()
  try {
    return run()
  } finally {
    recordChunkPhase(phase, performance.now() - start, bytes)
  }
}

/**
 * Time an awaited span and record it as `phase`. The result is wall clock, so
 * overlapping calls each count their own full duration.
 */
export async function timeChunkPhaseAsync<T>(
  phase: ChunkPhase,
  run: () => Promise<T>,
  bytes = 0,
): Promise<T> {
  const start = performance.now()
  try {
    return await run()
  } finally {
    recordChunkPhase(phase, performance.now() - start, bytes)
  }
}

/**
 * Time an awaited store read: it counts toward the `net` phase like any other
 * span, and also toward the {@link ChunkTimingSnapshot.netBusyMs} union so
 * concurrent reads do not multiply-count the same wall clock.
 */
export async function timeChunkNetAsync<T extends { byteLength: number }>(
  run: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const start = performance.now()
  if (netOutstanding++ === 0) netRunStart = start
  let bytes: T | undefined
  try {
    bytes = await run()
    return bytes
  } finally {
    const end = performance.now()
    if (--netOutstanding === 0) netBusyMs += Math.max(0, end - netRunStart)
    recordChunkPhase('net', end - start, bytes?.byteLength ?? 0)
  }
}

/** Read the accumulated totals. The returned object is a copy. */
export function chunkTimingSnapshot(): ChunkTimingSnapshot {
  const phases = {} as Record<ChunkPhase, ChunkPhaseTiming>
  for (const phase of PHASES) {
    const entry = totals.get(phase)
    phases[phase] = entry ? { ...entry } : emptyPhase()
  }
  // A run still open at snapshot time counts up to now, so a long stall shows
  // as it happens rather than only once the last read lands.
  const openRun =
    netOutstanding > 0 ? Math.max(0, performance.now() - netRunStart) : 0
  const blocking: readonly ChunkPhase[] = ['assemble', 'upload', 'gradient']
  let mainThreadMs = 0
  let offThreadMs = 0
  for (const phase of PHASES) {
    offThreadMs += phases[phase].offThreadMs
    if (blocking.includes(phase)) {
      mainThreadMs += phases[phase].totalMs - phases[phase].offThreadMs
    }
  }
  return {
    phases,
    netBusyMs: netBusyMs + openRun + offThreadNetBusyMs,
    mainThreadMs,
    offThreadMs,
  }
}

/** Clear every phase. Call this to start a measurement window. */
export function resetChunkTiming(): void {
  totals.clear()
  netBusyMs = 0
  offThreadNetBusyMs = 0
  // Reads already in flight belong to the new window from here on.
  netRunStart = performance.now()
}
