import type NiiVueGPU from '@/NVControlBase'
import type { ChunkStreamCounts, ChunkStreamDetail } from '@/NVEvents'

/**
 * Emitter for the chunk-streaming lifecycle events (`chunkStreamProgress`,
 * `chunkStreamIdle`), so a host can hide a spinner or trigger a screenshot
 * without polling `chunkStreamStats()` on a timer.
 *
 * The view's render loop feeds `observe` once per drawn frame, after the draw
 * (which requested this frame's working set and painted every resident brick)
 * and before the upload pump. Both backends call the same hook from the same
 * point in their loops, so the emission logic is shared here rather than
 * duplicated per backend.
 *
 * Each observation carries the cheap per-frame counts (a sum of the chunk
 * managers' counters, no decoded-tier walk) plus `settled`, the view's verdict
 * on the frame it just painted: nothing queued or mid-upload for the working
 * set this draw asked for, no cross-fade still animating, no drag in progress.
 * The full stats snapshot comes from a provider invoked at most once per
 * observation, and only when an event actually fires, so the per-frame
 * observation costs no aggregation on the (overwhelmingly common) frames that
 * emit nothing.
 *
 * "Busy" is `pending + inFlight > 0`: chunks queued for upload or mid-upload.
 * Observing a busy frame arms the emitter; `chunkStreamIdle` fires on the
 * first SETTLED frame after that, and disarms. Deriving idle from a settled
 * frame rather than from the raw counts is what makes the event safe to
 * screenshot on. The counts reach zero in the pump callback, before the frame
 * that paints the last-admitted brick and while that brick's fade-in still
 * has frames to run. They also reach zero transiently when a plan swap
 * (`remap`) or a failed upload empties the queue without anything becoming
 * resident. None of those is a settled frame, so none of them emits idle; the
 * next drawn frame re-requests whatever the working set still lacks and the
 * emitter stays armed until a frame really is complete.
 *
 * `chunkStreamStats()` returns ZEROED counts (not null) whenever a view is
 * attached, so an emitter that was never armed stays silent: idle never fires
 * on an attached view that has not streamed. Streaming that resumes (a camera
 * move queues new bricks) re-arms it, so idle marks each time the stream
 * settles.
 *
 * `chunkStreamProgress` fires on any busy frame whose
 * `resident`/`pending`/`inFlight`/`total` counts differ from the previously
 * emitted ones (a timer-free throttle: many frames waiting on the same fetches
 * emit nothing, and the render loop's cadence bounds the rate), and once more
 * with the final counts immediately before `chunkStreamIdle`, so a
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
  /** A busy frame has been observed and no settled frame has followed it. */
  private _armed = false
  /** Counts carried by the last emitted event; the progress throttle. */
  private _last: ChunkStreamCounts | null = null

  /** Feed one per-frame observation; emits `chunkStreamProgress` /
   * `chunkStreamIdle` on the controller as the counts warrant. `settled` is
   * the view's verdict on the frame it just painted (see class doc); only a
   * settled observation can emit idle. `snapshot` is invoked at most once, and
   * only when an event fires, so callers may pass the full-aggregation
   * `chunkStreamStats()` without paying for it every frame. */
  observe(
    ctrl: NiiVueGPU,
    counts: ChunkStreamCounts,
    settled: boolean,
    snapshot: () => ChunkStreamDetail,
  ): void {
    const busy = counts.pending + counts.inFlight > 0
    if (busy) {
      this._armed = true
      if (this._remember(counts)) ctrl.emit('chunkStreamProgress', snapshot())
      return
    }
    // Not busy. Silent unless a busy frame preceded this one AND the frame on
    // screen is complete; a zero read mid-fade, mid-drag, or between a remap
    // and the next working-set request leaves the emitter armed.
    if (!this._armed || !settled) return
    this._armed = false
    // The last emitted counts were busy ones (that is what armed us), and
    // these are not, so they always differ: the final progress is
    // unconditional and shares idle's snapshot.
    this._remember(counts)
    const snap = snapshot()
    ctrl.emit('chunkStreamProgress', snap)
    ctrl.emit('chunkStreamIdle', snap)
  }

  /** Record `counts` as the last emitted; returns false (and records nothing)
   * when they equal the previous ones. */
  private _remember(counts: ChunkStreamCounts): boolean {
    const last = this._last
    if (
      last &&
      last.resident === counts.resident &&
      last.pending === counts.pending &&
      last.inFlight === counts.inFlight &&
      last.total === counts.total
    ) {
      return false
    }
    this._last = {
      resident: counts.resident,
      pending: counts.pending,
      inFlight: counts.inFlight,
      total: counts.total,
    }
    return true
  }

  /** Forget the armed state and the last-emitted counts. Called on controller
   * teardown AND whenever a view is wired for the first time (attach, backend
   * switch, context-loss recreate): a recreated view must not inherit the old
   * view's busy episode, which could emit a spurious idle or swallow the next
   * episode's first progress. */
  reset(): void {
    this._armed = false
    this._last = null
  }
}
