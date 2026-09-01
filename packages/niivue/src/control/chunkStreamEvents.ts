import type NiiVueGPU from '@/NVControlBase'
import type { ChunkStreamCounts, ChunkStreamDetail } from '@/NVEvents'

/**
 * Emitter for the chunk-streaming lifecycle events (`chunkStreamProgress`,
 * `chunkStreamIdle`), so a host can hide a spinner or trigger a screenshot
 * without polling `chunkStreamStats()` on a timer.
 *
 * The view's render loop feeds `observe` twice around each upload-pump run:
 * once before the pump (right after the draw requested the frame's working
 * set, so a first frame's `pending` count is visible even when the pump
 * uploads everything in one call) and once after it. Both backends call the
 * same hook from the same point in their loops, so the emission logic is
 * shared here rather than duplicated per backend.
 *
 * Each observation carries only the cheap per-frame counts (a sum of the
 * chunk managers' counters, no decoded-tier walk) plus a provider for the
 * full stats snapshot. The provider is invoked at most once per observation,
 * and only when an event actually fires, so the twice-per-frame observations
 * cost no aggregation on the (overwhelmingly common) frames that emit
 * nothing.
 *
 * "Busy" is `pending + inFlight > 0` — chunks queued for upload or mid-upload.
 * `chunkStreamStats()` returns ZEROED counts (not null) whenever a view is
 * attached, so idleness must be defined on a transition of the counts, not on
 * their absence: `chunkStreamIdle` fires only when an observation is not busy
 * AND the previous observation was — never on an attached view that has not
 * streamed. Streaming that resumes (a camera move queues new bricks) re-arms
 * the transition, so idle marks each time the stream settles.
 *
 * `chunkStreamProgress` fires on any observation in a busy episode (including
 * the settling one) whose `resident`/`pending`/`inFlight`/`total` counts differ
 * from the previously emitted ones — a timer-free throttle: identical
 * back-to-back snapshots (e.g. many frames waiting on the same fetches) emit
 * nothing, and the render loop's cadence bounds the rate. On a settling
 * observation the final progress emit precedes `chunkStreamIdle`, so a
 * progress-only listener also sees the terminal counts.
 *
 * Emission-order convention: both events fire after the residency bookkeeping
 * has been updated, so `chunkStreamStats()` read inside a listener returns the
 * same counts as the event `detail`.
 *
 * Kept in a leaf module (type-only controller import) so it is unit-testable
 * under the bun test runner, unlike the controller itself.
 */
export class ChunkStreamEmitter {
  private _wasBusy = false
  private _last: {
    resident: number
    pending: number
    inFlight: number
    total: number
  } | null = null

  /** Feed one observation; emits `chunkStreamProgress`/`chunkStreamIdle` on
   * the controller as the counts warrant. `snapshot` is only invoked (at most
   * once) when an event fires, so callers may pass the full-aggregation
   * `chunkStreamStats()` without paying for it every frame. */
  observe(
    ctrl: NiiVueGPU,
    counts: ChunkStreamCounts,
    snapshot: () => ChunkStreamDetail,
  ): void {
    const busy = counts.pending + counts.inFlight > 0
    if (busy || this._wasBusy) {
      const last = this._last
      const changed =
        !last ||
        last.resident !== counts.resident ||
        last.pending !== counts.pending ||
        last.inFlight !== counts.inFlight ||
        last.total !== counts.total
      let snap: ChunkStreamDetail | null = null
      if (changed) {
        this._last = {
          resident: counts.resident,
          pending: counts.pending,
          inFlight: counts.inFlight,
          total: counts.total,
        }
        snap = snapshot()
        ctrl.emit('chunkStreamProgress', snap)
      }
      if (this._wasBusy && !busy) {
        ctrl.emit('chunkStreamIdle', snap ?? snapshot())
      }
    }
    this._wasBusy = busy
  }

  /** Forget the busy episode and the last-emitted counts. Called on controller
   * teardown AND whenever the view is torn down or recreated (backend switch,
   * context loss): a recreated view must not inherit the old view's busy
   * episode, which could emit a spurious idle or swallow the next episode's
   * first progress. */
  reset(): void {
    this._wasBusy = false
    this._last = null
  }
}
