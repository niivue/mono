/**
 * Per-frame `performance.mark`/`measure` instrumentation for the renderer.
 *
 * Two consumers:
 *
 *  1. `nv.perf.enabled = true` on the controller — emits a `perfFrame`
 *     CustomEvent after every render, carrying `{ tag, cpuMs, submitMs,
 *     totalMs, phases }`. Use this to measure the cost of user-initiated
 *     actions in real apps.
 *
 *  2. The benchmark harness — flips `setPerfMarksEnabled(true)` and reads
 *     `consumeFrameStats()` / observes `niivue:render-*` measure entries.
 *
 * Both gates share a single runtime flag (`enabled`). When the flag is
 * off, every helper bails on its first line, so the cost in production
 * is one well-predicted branch per call site.
 *
 * Each render produces three named entries via PerformanceObserver:
 *
 *  - `niivue:render-cpu`     — CPU time recording the frame
 *  - `niivue:render-submit`  — JS-side cost of `device.queue.submit()` /
 *                              GL flush (NOT GPU execution time)
 *  - `niivue:render-frame`   — total render() wall time
 *
 * Sub-phase counters (named, per-frame totals) are accumulated via
 * `beginPhase()` / `endPhase(t, name)`. Frame report subscribers receive
 * a snapshot of all phases when the frame closes.
 *
 * Action tagging: `setNextActionTag(tag)` attaches a label to the next
 * frame; `markCpuStart()` consumes it. The tag flows through to the
 * frame report so consumers can correlate cost with user action.
 */

let enabled = false
// Inner-loop per-mesh-iter sub-phase markers are very chatty (3 begin/end
// pairs × N meshes × M tiles per frame). At browser timer resolution of
// 100µs each pair is rounded down, which biases phase-sum LOW versus the
// outer cpu measure. Toggle this off to distinguish real CPU cost from
// instrumentation-rounding artefact.
let meshPhaseEnabled = true

const phaseTotals: Map<string, number> = new Map()
let lastPhaseTotals: Map<string, number> = new Map()

let cpuStartTime = 0
let submitStartTime = 0
let nextActionTag: string | null = null
let activeActionTag: string | null = null
let lastFrameReport: FrameReport | null = null

export type FrameReport = {
  /** Action label set via `setNextActionTag` before the frame, or null. */
  tag: string | null
  /** CPU time recording draw commands, in milliseconds. */
  cpuMs: number
  /** JS-side cost of GPU submission / GL flush, in milliseconds. */
  submitMs: number
  /** Total render() wall time, in milliseconds. */
  totalMs: number
  /** Per-frame totals from `beginPhase`/`endPhase` calls. */
  phases: Record<string, number>
}

const frameSubscribers = new Set<(report: FrameReport) => void>()

export function setPerfMarksEnabled(value: boolean): void {
  enabled = value
}

export function arePerfMarksEnabled(): boolean {
  return enabled
}

export function setMeshPhaseEnabled(value: boolean): void {
  meshPhaseEnabled = value
}

export function areMeshPhasesEnabled(): boolean {
  return meshPhaseEnabled
}

/**
 * Tag the next frame with an action source (e.g. `'pointerdown'`,
 * `'wheel'`). Cleared at the start of the next render so each tag
 * applies to exactly one frame. Caller wins races: the most recent
 * tag before `markCpuStart` is the one recorded.
 */
export function setNextActionTag(tag: string | null): void {
  if (!enabled) return
  nextActionTag = tag
}

/**
 * Subscribe to per-frame reports. Returns a disposer. Subscribers are
 * called synchronously from `markEnd` so the controller can re-emit
 * the report as a CustomEvent before the renderer returns.
 */
export function subscribeFrameReports(
  cb: (report: FrameReport) => void,
): () => void {
  frameSubscribers.add(cb)
  return () => {
    frameSubscribers.delete(cb)
  }
}

export function getLastFrameReport(): FrameReport | null {
  return lastFrameReport
}

export function markCpuStart(): void {
  if (!enabled) return
  // Clear the previous frame's measures so the User Timing buffer stays
  // bounded under long-running sessions (3 entries/frame would otherwise
  // grow without limit). Clearing here — not in markEnd — keeps the
  // just-finished frame visible to synchronous post-render readers.
  try {
    performance.clearMeasures('niivue:render-cpu')
    performance.clearMeasures('niivue:render-submit')
    performance.clearMeasures('niivue:render-frame')
  } catch {
    /* no-op */
  }
  phaseTotals.clear()
  activeActionTag = nextActionTag
  nextActionTag = null
  cpuStartTime = performance.now()
  performance.mark('niivue:cpu-start')
}

export function markSubmitStart(): void {
  if (!enabled) return
  submitStartTime = performance.now()
  performance.mark('niivue:submit-start')
  try {
    performance.measure(
      'niivue:render-cpu',
      'niivue:cpu-start',
      'niivue:submit-start',
    )
  } catch {
    /* missing start mark, skip */
  }
}

export function markEnd(): void {
  if (!enabled) return
  const endTime = performance.now()
  performance.mark('niivue:end')
  try {
    performance.measure(
      'niivue:render-submit',
      'niivue:submit-start',
      'niivue:end',
    )
  } catch {
    /* missing start mark */
  }
  try {
    performance.measure('niivue:render-frame', 'niivue:cpu-start', 'niivue:end')
  } catch {
    /* missing start mark */
  }
  lastPhaseTotals = new Map(phaseTotals)
  const phases: Record<string, number> = {}
  for (const [k, v] of phaseTotals) phases[k] = v
  lastFrameReport = {
    tag: activeActionTag,
    cpuMs: submitStartTime - cpuStartTime,
    submitMs: endTime - submitStartTime,
    totalMs: endTime - cpuStartTime,
    phases,
  }
  activeActionTag = null
  if (frameSubscribers.size > 0) {
    const report = lastFrameReport
    for (const cb of frameSubscribers) cb(report)
  }
  try {
    performance.clearMarks('niivue:cpu-start')
    performance.clearMarks('niivue:submit-start')
    performance.clearMarks('niivue:end')
  } catch {
    /* no-op */
  }
}

/**
 * Sub-phase timer. Returns a start-time token (or 0 when disabled).
 * Pair with `endPhase(token, name)` to accumulate `now()-token` ms
 * into the named bucket.
 */
export function beginPhase(): number {
  if (!enabled) return 0
  return performance.now()
}

export function endPhase(startMs: number, name: string): void {
  if (!enabled || startMs === 0) return
  const dt = performance.now() - startMs
  phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + dt)
}

/** Increment a named counter by 1 (used for iteration counts). */
export function tickPhase(name: string): void {
  if (!enabled) return
  phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + 1)
}

/**
 * Read the most recent frame's phase totals. The harness should call
 * this immediately after `render()` returns; values are valid until
 * the next `markCpuStart()`.
 */
export function consumeFrameStats(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of lastPhaseTotals) out[k] = v
  return out
}
