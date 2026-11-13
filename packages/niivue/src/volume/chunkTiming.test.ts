import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  chunkTimingSnapshot,
  mergeOffThreadChunkTiming,
  recordChunkPhase,
  resetChunkTiming,
  timeChunkNetAsync,
  timeChunkPhase,
  timeChunkPhaseAsync,
} from './chunkTiming'

let now = 0
let clock: ReturnType<typeof spyOn>

beforeEach(() => {
  now = 0
  clock = spyOn(performance, 'now').mockImplementation(() => now)
  resetChunkTiming()
})

afterEach(() => {
  clock.mockRestore()
})

/** A promise plus the function that settles it, so a test steps the clock between start and end. */
function gate<T>(value: T) {
  let release = () => {}
  const promise = new Promise<T>((resolve) => {
    release = () => resolve(value)
  })
  return { promise, release }
}

describe('chunk phase timing', () => {
  test('accumulates count, total, max and bytes; ignores invalid durations', () => {
    recordChunkPhase('upload', 4, 100)
    recordChunkPhase('upload', 10, 200)
    recordChunkPhase('upload', 6, 50)
    recordChunkPhase('upload', Number.NaN)
    recordChunkPhase('upload', -1)
    expect(chunkTimingSnapshot().phases.upload).toEqual({
      count: 3,
      totalMs: 20,
      maxMs: 10,
      bytes: 350,
      offThreadMs: 0,
    })
  })

  test('main-thread cost is assemble plus upload plus gradient', () => {
    recordChunkPhase('read', 100)
    recordChunkPhase('net', 60)
    recordChunkPhase('assemble', 15)
    recordChunkPhase('upload', 4)
    recordChunkPhase('gradient', 2)
    // Neither read nor net blocks the render loop, so neither counts.
    expect(chunkTimingSnapshot().mainThreadMs).toBe(21)
  })

  test('overlapping store reads count their shared wall clock once, open runs up to now', async () => {
    const reads = [gate(new Uint8Array(4)), gate(new Uint8Array(4))]
    const spans = reads.map((r) => timeChunkNetAsync(() => r.promise))
    now = 25
    // Still in flight: the open run counts up to the snapshot.
    expect(chunkTimingSnapshot().netBusyMs).toBe(25)
    now = 40
    reads[0].release()
    await spans[0]
    now = 50
    reads[1].release()
    await spans[1]
    const snap = chunkTimingSnapshot()
    expect(snap.phases.net.count).toBe(2)
    expect(snap.phases.net.totalMs).toBe(90)
    expect(snap.phases.net.bytes).toBe(8)
    expect(snap.netBusyMs).toBe(50)
  })

  test('a missing store entry still records its read', async () => {
    expect(await timeChunkNetAsync(async () => undefined)).toBeUndefined()
    const net = chunkTimingSnapshot().phases.net
    expect(net.count).toBe(1)
    expect(net.bytes).toBe(0)
  })

  test('timeChunkPhase returns the value and records a throwing span too', () => {
    expect(
      timeChunkPhase(
        'upload',
        () => {
          now = 3
          return 42
        },
        8,
      ),
    ).toBe(42)
    expect(() =>
      timeChunkPhase('upload', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    const upload = chunkTimingSnapshot().phases.upload
    expect(upload.count).toBe(2)
    expect(upload.totalMs).toBe(3)
    expect(upload.bytes).toBe(8)
  })

  test('timeChunkPhaseAsync measures the awaited span and records a rejection too', async () => {
    const span = gate('done')
    const pending = timeChunkPhaseAsync('read', () => span.promise)
    now = 12
    span.release()
    expect(await pending).toBe('done')
    await expect(
      timeChunkPhaseAsync('read', () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope')
    const read = chunkTimingSnapshot().phases.read
    expect(read.count).toBe(2)
    expect(read.totalMs).toBe(12)
  })
})

describe('off-thread merge', () => {
  test('folds a worker delta in and books it as off-thread', () => {
    recordChunkPhase('assemble', 6, 100)
    recordChunkPhase('read', 50)
    mergeOffThreadChunkTiming({
      phases: {
        assemble: { count: 2, totalMs: 30, maxMs: 20, bytes: 400 },
        read: { count: 1, totalMs: 5, maxMs: 5, bytes: 0 },
      },
      netBusyMs: 25,
    })
    const snap = chunkTimingSnapshot()
    expect(snap.phases.assemble.count).toBe(3)
    expect(snap.phases.assemble.totalMs).toBe(36)
    expect(snap.phases.assemble.bytes).toBe(500)
    // A max is taken, never summed, and a larger local one is kept.
    expect(snap.phases.assemble.maxMs).toBe(20)
    expect(snap.phases.read.maxMs).toBe(50)
    expect(snap.phases.assemble.offThreadMs).toBe(30)
    expect(snap.offThreadMs).toBe(35)
    // Only the 6 ms this thread ran blocked the render loop.
    expect(snap.mainThreadMs).toBe(6)
    expect(snap.netBusyMs).toBe(25)
  })

  test('reset clears local, network and merged off-thread totals', async () => {
    recordChunkPhase('upload', 3)
    await timeChunkNetAsync(async () => new Uint8Array(2))
    mergeOffThreadChunkTiming({
      phases: { net: { count: 1, totalMs: 12, maxMs: 12, bytes: 64 } },
      netBusyMs: 12,
    })
    resetChunkTiming()
    const snap = chunkTimingSnapshot()
    for (const phase of Object.values(snap.phases)) {
      expect(phase).toEqual({
        count: 0,
        totalMs: 0,
        maxMs: 0,
        bytes: 0,
        offThreadMs: 0,
      })
    }
    expect(snap.netBusyMs).toBe(0)
    expect(snap.mainThreadMs).toBe(0)
    expect(snap.offThreadMs).toBe(0)
  })
})
