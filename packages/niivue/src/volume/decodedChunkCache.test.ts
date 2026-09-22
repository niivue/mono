import { describe, expect, test } from 'bun:test'
import { DecodedChunkCache, decodedTierBudgetBytes } from './decodedChunkCache'

/** A distinguishable buffer of `n` bytes. */
function buf(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

describe('decodedTierBudgetBytes', () => {
  test('shadows the resident set plus a tail', () => {
    // uint8 source: a resident chunk is 8 bytes/voxel on the GPU, 1 on the CPU.
    expect(decodedTierBudgetBytes(800, 1)).toBe(150)
    // float32 source: half the GPU footprint, so half again the tier.
    expect(decodedTierBudgetBytes(800, 4)).toBe(600)
  })

  test('never exceeds the ceiling', () => {
    expect(decodedTierBudgetBytes(8_000_000_000, 4, 1000)).toBe(1000)
  })

  test('is zero for a degenerate budget or datatype', () => {
    expect(decodedTierBudgetBytes(0, 2)).toBe(0)
    expect(decodedTierBudgetBytes(1000, 0)).toBe(0)
    expect(decodedTierBudgetBytes(Number.NaN, 2)).toBe(0)
  })
})

describe('DecodedChunkCache', () => {
  test('rejects a nonsensical budget', () => {
    expect(() => new DecodedChunkCache(-1)).toThrow()
    expect(() => new DecodedChunkCache(Number.NaN)).toThrow()
  })

  test('returns the buffer it was given', () => {
    const cache = new DecodedChunkCache(100)
    const bytes = buf(10, 7)
    cache.set(3, bytes)
    expect(cache.get(3)).toBe(bytes)
    expect(cache.totalBytes).toBe(10)
  })

  test('counts hits and misses per lookup', () => {
    const cache = new DecodedChunkCache(100)
    cache.set(1, buf(10))
    cache.get(1)
    cache.get(1)
    cache.get(2)
    expect(cache.stats.hits).toBe(2)
    expect(cache.stats.misses).toBe(1)
  })

  test('has does not count a lookup or restamp recency', () => {
    const cache = new DecodedChunkCache(20)
    cache.set(1, buf(10))
    cache.set(2, buf(10))
    expect(cache.has(1)).toBe(true)
    expect(cache.stats.hits).toBe(0)
    expect(cache.stats.misses).toBe(0)
    // 1 is still the least recently used, so it goes first.
    cache.set(3, buf(10))
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(true)
  })

  test('evicts least-recently-used first', () => {
    const cache = new DecodedChunkCache(30)
    cache.set(1, buf(10))
    cache.set(2, buf(10))
    cache.set(3, buf(10))
    // Touching 1 makes 2 the oldest.
    cache.get(1)
    cache.set(4, buf(10))
    expect(cache.has(2)).toBe(false)
    expect(cache.has(1)).toBe(true)
    expect(cache.has(3)).toBe(true)
    expect(cache.has(4)).toBe(true)
    expect(cache.stats.evicted).toBe(1)
    expect(cache.totalBytes).toBe(30)
  })

  test('holds the frontier a reversal reaches first', () => {
    // Four chunks fit on the GPU, six in the tier; the view scans 0..7.
    const cache = new DecodedChunkCache(60)
    for (let i = 0; i < 8; i++) cache.set(i, buf(10))
    // The GPU now holds 4..7, so those tier entries are the redundant ones and
    // 2 and 3 -- evicted from the GPU most recently -- are the useful depth.
    expect(cache.has(3)).toBe(true)
    expect(cache.has(2)).toBe(true)
    expect(cache.has(1)).toBe(false)
    expect(cache.has(0)).toBe(false)
  })

  test('refuses a buffer larger than the whole budget', () => {
    const cache = new DecodedChunkCache(30)
    cache.set(1, buf(10))
    cache.set(2, buf(40))
    expect(cache.has(2)).toBe(false)
    // And keeps what it already had: nothing was evicted to make room.
    expect(cache.has(1)).toBe(true)
    expect(cache.stats.rejected).toBe(1)
    expect(cache.totalBytes).toBe(10)
  })

  test('a zero budget makes the tier inert', () => {
    const cache = new DecodedChunkCache(0)
    cache.set(1, buf(10))
    expect(cache.has(1)).toBe(false)
    expect(cache.totalBytes).toBe(0)
  })

  test('replacing a key does not double-count its bytes', () => {
    const cache = new DecodedChunkCache(100)
    cache.set(1, buf(10))
    cache.set(1, buf(20))
    expect(cache.totalBytes).toBe(20)
    expect(cache.stats.entries).toBe(1)
  })

  test('shrinking the budget evicts down to it', () => {
    const cache = new DecodedChunkCache(100)
    cache.set(1, buf(10))
    cache.set(2, buf(10))
    cache.set(3, buf(10))
    cache.setMaxBytes(15)
    expect(cache.totalBytes).toBe(10)
    expect(cache.has(3)).toBe(true)
    expect(cache.has(1)).toBe(false)
    // Growing it back holds more again.
    cache.setMaxBytes(100)
    cache.set(4, buf(10))
    expect(cache.totalBytes).toBe(20)
  })

  test('delete drops an entry and its bytes', () => {
    const cache = new DecodedChunkCache(100)
    cache.set(1, buf(10))
    cache.delete(1)
    cache.delete(1)
    expect(cache.has(1)).toBe(false)
    expect(cache.totalBytes).toBe(0)
  })

  test('clear drops the entries but keeps the counters', () => {
    const cache = new DecodedChunkCache(100)
    cache.set(1, buf(10))
    cache.get(1)
    cache.clear()
    expect(cache.totalBytes).toBe(0)
    expect(cache.stats.entries).toBe(0)
    expect(cache.stats.hits).toBe(1)
  })

  test('remap re-keys the survivors and drops the rest', () => {
    const cache = new DecodedChunkCache(100)
    const one = buf(10, 1)
    const two = buf(10, 2)
    cache.set(1, one)
    cache.set(2, two)
    cache.remap(new Map([[2, 5]]))
    expect(cache.get(5)).toBe(two)
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(false)
    expect(cache.totalBytes).toBe(10)
  })

  test('remap keeps recency order', () => {
    const cache = new DecodedChunkCache(20)
    cache.set(1, buf(10))
    cache.set(2, buf(10))
    cache.remap(
      new Map([
        [1, 10],
        [2, 20],
      ]),
    )
    // 10 came from 1, the older entry, so it is still the first to go.
    cache.set(30, buf(10))
    expect(cache.has(10)).toBe(false)
    expect(cache.has(20)).toBe(true)
  })
})
