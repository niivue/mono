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

/** Observe as the views do: the counts eagerly (a ChunkStreamDetail is a
 * structural superset of ChunkStreamCounts), the full snapshot lazily. */
function observe(
  em: ChunkStreamEmitter,
  ctrl: NiiVueGPU,
  s: ChunkStreamDetail,
) {
  em.observe(ctrl, s, () => s)
}

describe('chunk stream events', () => {
  test('an attached view that never streams emits nothing', () => {
    // chunkStreamStats() returns zeroed counts (not null) once a view is
    // attached, so repeated all-zero observations must stay silent.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    for (let i = 0; i < 5; i++) observe(em, ctrl, stats())
    // Same for an ordinary (non-chunked) volume: resident stays 0 but total
    // could too; also check a fully-resident-from-the-start shape.
    observe(em, ctrl, stats({ resident: 8, total: 8 }))
    expect(emit).not.toHaveBeenCalled()
  })

  test('streaming start emits progress, not idle', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const s = stats({ pending: 4, total: 8 })
    observe(em, ctrl, s)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('chunkStreamProgress', s)
  })

  test('an unchanged busy snapshot does not re-emit progress', () => {
    // Many frames can pass while the same fetches are outstanding; identical
    // counts must not spam listeners (the timer-free throttle).
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    expect(emit).toHaveBeenCalledTimes(1)
  })

  test('a count change during a busy episode emits progress again', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    const s2 = stats({ resident: 2, pending: 2, inFlight: 1, total: 8 })
    observe(em, ctrl, s2)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', s2)
  })

  test('settling emits a final progress then idle, both with the final stats', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    const final = stats({ resident: 8, total: 8 })
    observe(em, ctrl, final)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', final)
    expect(emit).toHaveBeenNthCalledWith(3, 'chunkStreamIdle', final)
  })

  test('a single-pump upload still transitions (pre-pump observation was busy)', () => {
    // The views observe BEFORE the pump as well as after, so a tiny volume
    // whose whole working set uploads in one pump call still produces a
    // busy observation followed by an idle one.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 2, total: 2 })) // pre-pump
    observe(em, ctrl, stats({ resident: 2, total: 2 })) // post-pump
    expect(emit).toHaveBeenCalledWith(
      'chunkStreamIdle',
      stats({ resident: 2, total: 2 }),
    )
  })

  test('idle does not repeat while the stream stays settled', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 1, total: 4 }))
    observe(em, ctrl, stats({ resident: 4, total: 4 }))
    observe(em, ctrl, stats({ resident: 4, total: 4 }))
    observe(em, ctrl, stats({ resident: 4, total: 4 }))
    const idleCalls = emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle')
    expect(idleCalls).toHaveLength(1)
  })

  test('streaming that resumes re-arms idle (one idle per settle)', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    observe(em, ctrl, stats({ resident: 4, total: 8 }))
    // Camera moved: new bricks queued.
    observe(em, ctrl, stats({ resident: 4, pending: 4, total: 8 }))
    observe(em, ctrl, stats({ resident: 8, total: 8 }))
    const idleCalls = emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle')
    expect(idleCalls).toHaveLength(2)
  })

  test('inFlight alone keeps the stream busy', () => {
    // A drained queue with uploads mid-flight is not idle yet.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 3, total: 3 }))
    observe(em, ctrl, stats({ inFlight: 3, total: 3 }))
    expect(
      emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle'),
    ).toHaveLength(0)
    observe(em, ctrl, stats({ resident: 3, total: 3 }))
    expect(
      emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle'),
    ).toHaveLength(1)
  })

  test('the snapshot provider is only invoked when an event fires', () => {
    // The views observe twice per frame while streaming; the full stats
    // aggregation (decoded-tier walk) must not run on observations that emit
    // nothing.
    const { ctrl } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const snapshot = mock(() => stats())
    em.observe(ctrl, stats(), snapshot) // never streamed: silent
    expect(snapshot).not.toHaveBeenCalled()
    const busy = stats({ pending: 4, total: 8 })
    em.observe(ctrl, busy, () => busy) // progress fires
    em.observe(ctrl, busy, snapshot) // unchanged busy counts: silent
    expect(snapshot).not.toHaveBeenCalled()
  })

  test('a settling observation takes one snapshot shared by progress and idle', () => {
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 2, total: 2 }))
    const final = stats({ resident: 2, total: 2 })
    const snapshot = mock(() => final)
    em.observe(ctrl, final, snapshot)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenNthCalledWith(2, 'chunkStreamProgress', final)
    expect(emit).toHaveBeenNthCalledWith(3, 'chunkStreamIdle', final)
  })

  test('reset drops the busy episode so a stale idle cannot fire', () => {
    // The controller resets on teardown AND when a view is recreated
    // (backend switch, context loss): the new view's first settled
    // observation must not look like the old episode settling.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    observe(em, ctrl, stats({ pending: 4, total: 8 }))
    observe(em, ctrl, stats({ resident: 2, pending: 2, total: 8 }))
    em.reset()
    observe(em, ctrl, stats())
    // Nothing after reset: no idle, and no extra progress either.
    expect(emit).toHaveBeenCalledTimes(2)
    expect(
      emit.mock.calls.filter((c) => c[0] === 'chunkStreamIdle'),
    ).toHaveLength(0)
  })

  test('reset also forgets the last-emitted counts (no swallowed progress)', () => {
    // After a recreation, the new view's first busy observation must emit
    // progress even if its counts happen to equal the last emitted ones.
    const { ctrl, emit } = fakeCtrl()
    const em = new ChunkStreamEmitter()
    const s = stats({ pending: 4, total: 8 })
    observe(em, ctrl, s)
    em.reset()
    observe(em, ctrl, s)
    expect(
      emit.mock.calls.filter((c) => c[0] === 'chunkStreamProgress'),
    ).toHaveLength(2)
  })
})
