import { describe, expect, mock, test } from 'bun:test'
import type NiiVueGPU from '@/NVControlBase'
import type { ChunkStreamDetail } from '@/NVEvents'
import { ChunkStreamEmitter } from './chunkStreamEvents'

function fakeCtrl() {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const ctrl = { emit } as unknown as NiiVueGPU
  return { ctrl, emit }
}

function stats(over: Partial<ChunkStreamDetail> = {}): ChunkStreamDetail {
  return {
    resident: 0,
    pending: 0,
    inFlight: 0,
    total: 0,
    staleDropped: 0,
    predicted: 0,
    decoded: {
      hits: 0,
      misses: 0,
      admitted: 0,
      rejected: 0,
      evicted: 0,
      entries: 0,
      bytes: 0,
      maxBytes: 0,
    },
    ...over,
  }
}

/** Observe one drawn frame as the views do: the counts eagerly (a
 * ChunkStreamDetail is a structural superset of ChunkStreamCounts), the full
 * snapshot lazily. `settled` defaults to the view's own predicate on a frame
 * with no drag or fade: nothing queued or in flight. */
function frame(
  em: ChunkStreamEmitter,
  ctrl: NiiVueGPU,
  s: ChunkStreamDetail,
  settled = s.pending === 0 && s.inFlight === 0,
) {
  em.observe(ctrl, s, settled, () => s)
}

const idles = (emit: ReturnType<typeof fakeCtrl>['emit']) =>
  emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle')
const progresses = (emit: ReturnType<typeof fakeCtrl>['emit']) =>
  emit.mock.calls.filter((c) => c[0] === 'chunkStreamProgress')

describe('chunk stream events', () => {
  test('an attached view that never streams emits nothing', () => {
    // chunkStreamStats() returns zeroed counts (not null) once a view is
    // attached, so repeated settled all-zero frames must stay silent.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    for (let i = 0; i < 5; i++) frame(em, ctrl, stats())
    // Same for a volume fully resident from its first frame.
    frame(em, ctrl, stats({ resident: 8, total: 8 }))
    expect(emit).not.toHaveBeenCalled()
  })

  test('streaming start emits progress, not idle', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const s = stats({ pending: 4, total: 8 })
    frame(em, ctrl, s)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('chunkStreamProgress', s)
  })

  test('an unchanged busy snapshot does not re-emit progress', () => {
    // Many frames can pass while the same fetches are outstanding; identical
    // counts must not spam listeners (the timer-free throttle).
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    expect(emit).toHaveBeenCalledTimes(1)
  })

  test('a count change during a busy episode emits progress again', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    const s2 = stats({ resident: 2, pending: 2, inFlight: 1, total: 8 })
    frame(em, ctrl, s2)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', s2)
  })

  test('settling emits a final progress then idle, both with the final stats', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    const final = stats({ resident: 8, total: 8 })
    frame(em, ctrl, final)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', final)
    expect(emit).toHaveBeenNthCalledWith(3, 'chunkStreamIdle', final)
  })

  test('a single-pump upload still transitions (the requesting frame was busy)', () => {
    // The frame that requests the working set is observed before the pump
    // runs, so a tiny volume whose whole working set uploads in one pump call
    // still produces a busy frame followed by a settled one.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 2, total: 2 }))
    frame(em, ctrl, stats({ resident: 2, total: 2 }))
    expect(emit).toHaveBeenCalledWith(
      'chunkStreamIdle',
      stats({ resident: 2, total: 2 }),
    )
  })

  test('idle waits for a settled frame, not for the counts to reach zero', () => {
    // The last brick was admitted: counts are zero, but the frame that paints
    // it is still cross-fading in. A screenshot taken now would miss it.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 1, total: 4 }))
    const done = stats({ resident: 4, total: 4 })
    frame(em, ctrl, done, false) // fade still animating
    frame(em, ctrl, done, false)
    expect(idles(emit)).toHaveLength(0)
    // No half-way progress either: the terminal counts arrive with idle.
    expect(progresses(emit)).toHaveLength(1)
    frame(em, ctrl, done, true) // fade finished
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', done)
    expect(emit).toHaveBeenNthCalledWith(3, 'chunkStreamIdle', done)
  })

  test('a mid-drag frame with everything resident is not idle', () => {
    // The pump is paused while dragging, so a drag that starts after the last
    // admit sees zero counts on frames whose working set may still change.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 1, total: 4 }))
    frame(em, ctrl, stats({ resident: 4, total: 4 }), false) // dragging
    expect(idles(emit)).toHaveLength(0)
    frame(em, ctrl, stats({ resident: 4, total: 4 }), true) // released
    expect(idles(emit)).toHaveLength(1)
  })

  test('a transient zero (remap or failed upload) does not settle the stream', () => {
    // swapChunkedVolumePlan -> remap() clears the queue and in-flight set
    // between frames; a failed upload clears its in-flight mark with nothing
    // resident. Either way the view reports the frame as not settled until a
    // draw has re-requested the working set and found nothing missing.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ resident: 4, inFlight: 2, total: 8 }))
    frame(em, ctrl, stats({ resident: 4, total: 8 }), false)
    expect(emit).toHaveBeenCalledTimes(1)
    // The next draw requests the new plan's bricks: still one episode.
    frame(em, ctrl, stats({ resident: 4, pending: 3, total: 9 }))
    frame(em, ctrl, stats({ resident: 7, total: 9 }))
    expect(idles(emit)).toHaveLength(1)
    expect(emit).toHaveBeenLastCalledWith(
      'chunkStreamIdle',
      stats({ resident: 7, total: 9 }),
    )
  })

  test('idle does not repeat while the stream stays settled', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 1, total: 4 }))
    frame(em, ctrl, stats({ resident: 4, total: 4 }))
    frame(em, ctrl, stats({ resident: 4, total: 4 }))
    frame(em, ctrl, stats({ resident: 4, total: 4 }))
    expect(idles(emit)).toHaveLength(1)
  })

  test('streaming that resumes re-arms idle (one idle per settle)', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    frame(em, ctrl, stats({ resident: 4, total: 8 }))
    // Camera moved: new bricks queued.
    frame(em, ctrl, stats({ resident: 4, pending: 4, total: 8 }))
    frame(em, ctrl, stats({ resident: 8, total: 8 }))
    expect(idles(emit)).toHaveLength(2)
  })

  test('a resumed episode whose first counts repeat an old busy frame still emits progress', () => {
    // Eviction then re-request can reproduce the exact counts of an earlier
    // busy frame; the throttle must compare against the settled counts idle
    // carried, not against that stale busy frame.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const busy = stats({ resident: 4, pending: 4, total: 8 })
    frame(em, ctrl, busy)
    frame(em, ctrl, stats({ resident: 8, total: 8 }))
    frame(em, ctrl, busy)
    expect(progresses(emit)).toHaveLength(3)
  })

  test('inFlight alone keeps the stream busy', () => {
    // A drained queue with uploads mid-flight is not idle yet.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 3, total: 3 }))
    frame(em, ctrl, stats({ inFlight: 3, total: 3 }))
    expect(idles(emit)).toHaveLength(0)
    frame(em, ctrl, stats({ resident: 3, total: 3 }))
    expect(idles(emit)).toHaveLength(1)
  })

  test('the snapshot provider is only invoked when an event fires', () => {
    // The full stats aggregation (decoded-tier walk) must not run on frames
    // that emit nothing.
    const { ctrl } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const snapshot = mock(() => stats())
    em.observe(ctrl, stats(), true, snapshot) // never streamed: silent
    expect(snapshot).not.toHaveBeenCalled()
    const busy = stats({ pending: 4, total: 8 })
    em.observe(ctrl, busy, false, () => busy) // progress fires
    em.observe(ctrl, busy, false, snapshot) // unchanged busy counts: silent
    const done = stats({ resident: 8, total: 8 })
    em.observe(ctrl, done, false, snapshot) // zero but unsettled: silent
    expect(snapshot).not.toHaveBeenCalled()
  })

  test('a settling frame takes one snapshot shared by progress and idle', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 2, total: 2 }))
    const final = stats({ resident: 2, total: 2 })
    const snapshot = mock(() => final)
    em.observe(ctrl, final, true, snapshot)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', final)
    expect(emit).toHaveBeenNthCalledWith(3, 'chunkStreamIdle', final)
  })

  test('reset drops the busy episode so a stale idle cannot fire', () => {
    // The controller resets on teardown AND when a view is wired for the first
    // time (attach, backend switch, context loss): the new view's first
    // settled frame must not look like the old episode settling.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    frame(em, ctrl, stats({ pending: 4, total: 8 }))
    frame(em, ctrl, stats({ resident: 2, pending: 2, total: 8 }))
    em.reset()
    frame(em, ctrl, stats())
    // Nothing after reset: no idle, and no extra progress either.
    expect(emit).toHaveBeenCalledTimes(2)
    expect(idles(emit)).toHaveLength(0)
  })

  test('reset also forgets the last-emitted counts (no swallowed progress)', () => {
    // After a recreation, the new view's first busy frame must emit progress
    // even if its counts happen to equal the last emitted ones.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const s = stats({ pending: 4, total: 8 })
    frame(em, ctrl, s)
    em.reset()
    frame(em, ctrl, s)
    expect(progresses(emit)).toHaveLength(2)
  })
})
