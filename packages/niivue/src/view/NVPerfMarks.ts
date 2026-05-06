/**
 * Optional `performance.mark`/`measure` instrumentation for the renderer.
 *
 * The benchmark harness flips `setPerfMarksEnabled(true)` before a run,
 * and the WebGPU/WebGL2 view classes call `markCpuStart` / `markSubmitStart`
 * / `markEnd` around their CPU work and GPU submission. Each render
 * produces three named entries via PerformanceObserver:
 *
 *  - `niivue:render-cpu`     — CPU time recording the frame
 *  - `niivue:render-submit`  — JS-side cost of `device.queue.submit()` /
 *                              GL flush (NOT GPU execution time)
 *  - `niivue:render-frame`   — total render() wall time
 *
 * Sub-phase counters (named, per-frame totals) are accumulated via
 * `beginPhase()` / `endPhase(t, name)` deltas across many tiny calls
 * per frame. Snapshot is captured at `markEnd` and read directly by
 * the harness via `consumeFrameStats()` — bypasses PerformanceObserver
 * because the option-bag `performance.measure(name, {start, duration})`
 * form does not consistently surface as 'measure' entries across browsers.
 *
 * When disabled (default) all helpers are no-ops, so production renders
 * pay nothing.
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

export function markCpuStart(): void {
  if (!enabled) return
  phaseTotals.clear()
  performance.mark('niivue:cpu-start')
}

export function markSubmitStart(): void {
  if (!enabled) return
  performance.mark('niivue:submit-start')
  try {
    performance.measure('niivue:render-cpu', 'niivue:cpu-start', 'niivue:submit-start')
  } catch {
    /* missing start mark, skip */
  }
}

export function markEnd(): void {
  if (!enabled) return
  performance.mark('niivue:end')
  try {
    performance.measure('niivue:render-submit', 'niivue:submit-start', 'niivue:end')
  } catch {
    /* missing start mark */
  }
  try {
    performance.measure('niivue:render-frame', 'niivue:cpu-start', 'niivue:end')
  } catch {
    /* missing start mark */
  }
  lastPhaseTotals = new Map(phaseTotals)
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
