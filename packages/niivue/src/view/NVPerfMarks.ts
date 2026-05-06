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
 * Two-stage gating:
 *
 *  1. Build-time: `__NIIVUE_PERF__` is injected by Vite's `define` and is
 *     `false` unless the build was started with `NIIVUE_PERF=1`. Every
 *     helper bails on the build flag first, so esbuild dead-code-eliminates
 *     the bodies in production bundles — the calls that remain inline to
 *     a bare `return`. This is what guarantees zero runtime cost outside
 *     a perf build.
 *
 *  2. Runtime: inside a perf build, `setPerfMarksEnabled(true)` arms the
 *     marks for a single benchmark scenario; the harness flips it back
 *     off between runs.
 *
 * The bench harness needs a perf build (`bun run dev:perf` or
 * `bun run build:examples:perf`) to record useful numbers; otherwise
 * `consumeFrameStats()` returns an empty object.
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

/**
 * Returns the compile-time build flag (`true` only when Vite was invoked
 * with `NIIVUE_PERF=1`). The benchmark harness uses this to warn the
 * user when they've loaded the page from a non-perf build, since
 * `setPerfMarksEnabled(true)` would silently no-op and produce empty
 * frame stats.
 */
export function isPerfBuild(): boolean {
  return __NIIVUE_PERF__
}

export function setPerfMarksEnabled(value: boolean): void {
  if (!__NIIVUE_PERF__) return
  enabled = value
}

export function arePerfMarksEnabled(): boolean {
  if (!__NIIVUE_PERF__) return false
  return enabled
}

export function setMeshPhaseEnabled(value: boolean): void {
  if (!__NIIVUE_PERF__) return
  meshPhaseEnabled = value
}

export function areMeshPhasesEnabled(): boolean {
  if (!__NIIVUE_PERF__) return false
  return meshPhaseEnabled
}

export function markCpuStart(): void {
  if (!__NIIVUE_PERF__) return
  if (!enabled) return
  phaseTotals.clear()
  performance.mark('niivue:cpu-start')
}

export function markSubmitStart(): void {
  if (!__NIIVUE_PERF__) return
  if (!enabled) return
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
  if (!__NIIVUE_PERF__) return
  if (!enabled) return
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
  if (!__NIIVUE_PERF__) return 0
  if (!enabled) return 0
  return performance.now()
}

export function endPhase(startMs: number, name: string): void {
  if (!__NIIVUE_PERF__) return
  if (!enabled || startMs === 0) return
  const dt = performance.now() - startMs
  phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + dt)
}

/** Increment a named counter by 1 (used for iteration counts). */
export function tickPhase(name: string): void {
  if (!__NIIVUE_PERF__) return
  if (!enabled) return
  phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + 1)
}

/**
 * Read the most recent frame's phase totals. The harness should call
 * this immediately after `render()` returns; values are valid until
 * the next `markCpuStart()`.
 */
export function consumeFrameStats(): Record<string, number> {
  if (!__NIIVUE_PERF__) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of lastPhaseTotals) out[k] = v
  return out
}
