import { beforeEach, describe, expect, test } from 'bun:test'
import {
  chunkTimingSnapshot,
  mergeOffThreadChunkTiming,
  recordChunkPhase,
  resetChunkTiming,
  timeChunkNetAsync,
  timeChunkPhase,
  timeChunkPhaseAsync,
} from './chunkTiming'

describe('chunk phase timing', () => {
  beforeEach(() => {
    resetChunkTiming()
  })

  test('starts empty and reports every phase', () => {
    const snap = chunkTimingSnapshot()
    for (const phase of [
      'net',
      'read',
      'assemble',
      'upload',
      'gradient',
    ] as const) {
      expect(snap.phases[phase]).toEqual({
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

  test('accumulates count, total, max and bytes', () => {
    recordChunkPhase('upload', 4, 100)
    recordChunkPhase('upload', 10, 200)
    recordChunkPhase('upload', 6, 50)
    const upload = chunkTimingSnapshot().phases.upload
    expect(upload.count).toBe(3)
    expect(upload.totalMs).toBe(20)
    expect(upload.maxMs).toBe(10)
    expect(upload.bytes).toBe(350)
  })

  test('ignores non-finite and negative durations', () => {
    recordChunkPhase('net', Number.NaN)
    recordChunkPhase('net', Number.POSITIVE_INFINITY)
    recordChunkPhase('net', -1)
    expect(chunkTimingSnapshot().phases.net.count).toBe(0)
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

  test('overlapping store reads count their shared wall clock once', async () => {
    const span = (ms: number) =>
      timeChunkNetAsync(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return new Uint8Array(4)
      })
    await Promise.all([span(40), span(40), span(40)])
    const snap = chunkTimingSnapshot()
    // Three concurrent 40 ms reads: the sum triples, the union does not.
    expect(snap.phases.net.count).toBe(3)
    expect(snap.phases.net.totalMs).toBeGreaterThan(90)
    expect(snap.netBusyMs).toBeLessThan(snap.phases.net.totalMs / 2)
    expect(snap.netBusyMs).toBeGreaterThan(20)
  })

  test('a read still in flight counts up to the snapshot', async () => {
    let release = () => {}
    const pending = timeChunkNetAsync(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(new Uint8Array(1))
        }),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(chunkTimingSnapshot().netBusyMs).toBeGreaterThan(10)
    release()
    await pending
  })

  test('timeChunkNetAsync records bytes and returns the value', async () => {
    const bytes = await timeChunkNetAsync(async () => new Uint8Array(64))
    expect(bytes?.byteLength).toBe(64)
    expect(chunkTimingSnapshot().phases.net.bytes).toBe(64)
  })

  test('a missing store entry still records its read', async () => {
    const bytes = await timeChunkNetAsync(async () => undefined)
    expect(bytes).toBeUndefined()
    const net = chunkTimingSnapshot().phases.net
    expect(net.count).toBe(1)
    expect(net.bytes).toBe(0)
  })

  test('snapshot is a copy, not a live view', () => {
    recordChunkPhase('gradient', 5)
    const first = chunkTimingSnapshot()
    recordChunkPhase('gradient', 5)
    expect(first.phases.gradient.count).toBe(1)
    expect(chunkTimingSnapshot().phases.gradient.count).toBe(2)
  })

  test('reset clears every phase and the network union', async () => {
    recordChunkPhase('read', 3)
    recordChunkPhase('upload', 3)
    await timeChunkNetAsync(async () => new Uint8Array(2))
    resetChunkTiming()
    const snap = chunkTimingSnapshot()
    expect(snap.phases.read.count).toBe(0)
    expect(snap.phases.upload.count).toBe(0)
    expect(snap.netBusyMs).toBe(0)
    expect(snap.mainThreadMs).toBe(0)
  })

  test('timeChunkPhase returns the value and records one run', () => {
    const value = timeChunkPhase('upload', () => 42, 8)
    expect(value).toBe(42)
    const upload = chunkTimingSnapshot().phases.upload
    expect(upload.count).toBe(1)
    expect(upload.bytes).toBe(8)
    expect(upload.totalMs).toBeGreaterThanOrEqual(0)
  })

  test('timeChunkPhase records even when the span throws', () => {
    expect(() =>
      timeChunkPhase('upload', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(chunkTimingSnapshot().phases.upload.count).toBe(1)
  })

  test('timeChunkPhaseAsync measures the awaited span', async () => {
    const value = await timeChunkPhaseAsync('read', async () => {
      await new Promise((resolve) => setTimeout(resolve, 12))
      return 'done'
    })
    expect(value).toBe('done')
    const read = chunkTimingSnapshot().phases.read
    expect(read.count).toBe(1)
    expect(read.totalMs).toBeGreaterThan(5)
  })

  test('timeChunkPhaseAsync records even when the span rejects', async () => {
    await expect(
      timeChunkPhaseAsync('read', () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope')
    expect(chunkTimingSnapshot().phases.read.count).toBe(1)
  })
})

describe('off-thread merge', () => {
  beforeEach(() => {
    resetChunkTiming()
  })

  test('folds a worker delta in and books it as off-thread', () => {
    recordChunkPhase('assemble', 6, 100)
    mergeOffThreadChunkTiming({
      phases: { assemble: { count: 2, totalMs: 30, maxMs: 20, bytes: 400 } },
      netBusyMs: 25,
    })
    const snap = chunkTimingSnapshot()
    expect(snap.phases.assemble.count).toBe(3)
    expect(snap.phases.assemble.totalMs).toBe(36)
    expect(snap.phases.assemble.bytes).toBe(500)
    // A max is taken, never summed.
    expect(snap.phases.assemble.maxMs).toBe(20)
    expect(snap.phases.assemble.offThreadMs).toBe(30)
    expect(snap.offThreadMs).toBe(30)
    // Only the 6 ms this thread ran blocked the render loop.
    expect(snap.mainThreadMs).toBe(6)
    expect(snap.netBusyMs).toBe(25)
  })

  test('keeps a larger local max over a smaller worker one', () => {
    recordChunkPhase('read', 50)
    mergeOffThreadChunkTiming({
      phases: { read: { count: 1, totalMs: 5, maxMs: 5, bytes: 0 } },
      netBusyMs: 0,
    })
    expect(chunkTimingSnapshot().phases.read.maxMs).toBe(50)
  })

  test('a phase the worker never ran is left alone', () => {
    mergeOffThreadChunkTiming({ phases: {}, netBusyMs: 0 })
    const snap = chunkTimingSnapshot()
    expect(snap.phases.upload.count).toBe(0)
    expect(snap.offThreadMs).toBe(0)
  })

  test('reset clears merged off-thread totals', () => {
    mergeOffThreadChunkTiming({
      phases: { net: { count: 1, totalMs: 12, maxMs: 12, bytes: 64 } },
      netBusyMs: 12,
    })
    resetChunkTiming()
    const snap = chunkTimingSnapshot()
    expect(snap.phases.net.count).toBe(0)
    expect(snap.offThreadMs).toBe(0)
    expect(snap.netBusyMs).toBe(0)
  })
})
