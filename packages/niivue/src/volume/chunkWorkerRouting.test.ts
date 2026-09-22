import { describe, expect, test } from 'bun:test'
import type { ChunkPhase, ChunkTimingSnapshot } from './chunkTiming'
import {
  chunkRegionKey,
  chunkTimingDelta,
  routeChunkToWorker,
  sumByteCacheStats,
} from './chunkWorkerRouting'
import type { ByteCacheStats } from './omeZarrChunkedSource'

function snapshot(
  parts: Partial<
    Record<
      ChunkPhase,
      { count: number; totalMs: number; maxMs: number; bytes: number }
    >
  >,
  netBusyMs = 0,
): ChunkTimingSnapshot {
  const empty = { count: 0, totalMs: 0, maxMs: 0, bytes: 0, offThreadMs: 0 }
  const phases = {
    net: { ...empty },
    read: { ...empty },
    assemble: { ...empty },
    upload: { ...empty },
    gradient: { ...empty },
  }
  for (const [phase, value] of Object.entries(parts)) {
    phases[phase as ChunkPhase] = { ...value, offThreadMs: 0 }
  }
  return { phases, netBusyMs, mainThreadMs: 0, offThreadMs: 0 }
}

function stats(over: Partial<ByteCacheStats>): ByteCacheStats {
  return {
    hits: 0,
    misses: 0,
    admitted: 0,
    rejected: 0,
    evicted: 0,
    evictedBytes: 0,
    entries: 0,
    bytes: 0,
    maxBytes: 0,
    ...over,
  }
}

describe('chunk region key', () => {
  test('separates level, origin and extent', () => {
    const key = chunkRegionKey({
      levelIndex: 2,
      texOrigin: [0, 128, 256],
      texDims: [64, 64, 64],
    })
    expect(key).toBe('2|0,128,256|64,64,64')
  })

  test('two regions differing only in level do not collide', () => {
    const a = chunkRegionKey({ levelIndex: 0, texOrigin: [1], texDims: [2] })
    const b = chunkRegionKey({ levelIndex: 1, texOrigin: [1], texDims: [2] })
    expect(a).not.toBe(b)
  })
})

describe('worker routing', () => {
  test('the same region always lands on the same worker', () => {
    const key = chunkRegionKey({
      levelIndex: 1,
      texOrigin: [64, 0, 0],
      texDims: [64, 64, 64],
    })
    const first = routeChunkToWorker(key, 4)
    for (let i = 0; i < 20; i++) {
      expect(routeChunkToWorker(key, 4)).toBe(first)
    }
  })

  test('stays inside the pool', () => {
    for (let z = 0; z < 40; z++) {
      const key = chunkRegionKey({
        levelIndex: 0,
        texOrigin: [0, 0, z * 64],
        texDims: [64, 64, 64],
      })
      const index = routeChunkToWorker(key, 3)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(3)
    }
  })

  test('spreads adjacent bricks across the pool', () => {
    const used = new Set<number>()
    for (let z = 0; z < 32; z++) {
      used.add(
        routeChunkToWorker(
          chunkRegionKey({
            levelIndex: 0,
            texOrigin: [0, 0, z * 64],
            texDims: [64, 64, 64],
          }),
          4,
        ),
      )
    }
    expect(used.size).toBe(4)
  })

  test('a single worker takes everything', () => {
    expect(routeChunkToWorker('anything', 1)).toBe(0)
  })
})

describe('timing delta', () => {
  test('first reply is the whole snapshot', () => {
    const now = snapshot(
      { read: { count: 3, totalMs: 90, maxMs: 40, bytes: 300 } },
      60,
    )
    const delta = chunkTimingDelta(now, null)
    expect(delta.phases.read).toEqual({
      count: 3,
      totalMs: 90,
      maxMs: 40,
      bytes: 300,
    })
    expect(delta.netBusyMs).toBe(60)
  })

  test('later replies report only what is new', () => {
    const before = snapshot(
      { read: { count: 3, totalMs: 90, maxMs: 40, bytes: 300 } },
      60,
    )
    const now = snapshot(
      { read: { count: 5, totalMs: 130, maxMs: 40, bytes: 500 } },
      95,
    )
    const delta = chunkTimingDelta(now, before)
    expect(delta.phases.read?.count).toBe(2)
    expect(delta.phases.read?.totalMs).toBe(40)
    expect(delta.phases.read?.bytes).toBe(200)
    expect(delta.netBusyMs).toBe(35)
  })

  test('carries the running max, not a difference of maxima', () => {
    const before = snapshot({
      net: { count: 1, totalMs: 10, maxMs: 10, bytes: 0 },
    })
    const now = snapshot({
      net: { count: 2, totalMs: 55, maxMs: 45, bytes: 0 },
    })
    expect(chunkTimingDelta(now, before).phases.net?.maxMs).toBe(45)
  })

  test('an unchanged phase is omitted entirely', () => {
    const same = snapshot({
      upload: { count: 2, totalMs: 8, maxMs: 5, bytes: 0 },
    })
    expect(chunkTimingDelta(same, same).phases.upload).toBeUndefined()
  })
})

describe('byte cache aggregation', () => {
  test('sums the workers and reports the pool budget', () => {
    const total = sumByteCacheStats(
      [
        stats({ hits: 10, misses: 4, entries: 20, bytes: 1000, maxBytes: 512 }),
        stats({ hits: 6, misses: 9, evicted: 2, evictedBytes: 64, bytes: 500 }),
        null,
      ],
      1024,
    )
    expect(total.hits).toBe(16)
    expect(total.misses).toBe(13)
    expect(total.entries).toBe(20)
    expect(total.bytes).toBe(1500)
    expect(total.evicted).toBe(2)
    expect(total.evictedBytes).toBe(64)
    // The budget is the pool's, not any one worker's slice.
    expect(total.maxBytes).toBe(1024)
  })

  test('a pool that has not replied yet reports zeros', () => {
    const total = sumByteCacheStats([null, null], 2048)
    expect(total.hits).toBe(0)
    expect(total.bytes).toBe(0)
    expect(total.maxBytes).toBe(2048)
  })
})
