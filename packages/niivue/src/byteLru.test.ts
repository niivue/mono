import { describe, expect, test } from 'bun:test'
import { ByteLru } from './byteLru'

const bytes = (n: number) => new Uint8Array(n)
const lru = (maxBytes: number) =>
  new ByteLru<string, Uint8Array | undefined>(maxBytes)

describe('ByteLru', () => {
  test('evicts least-recently-used first; get refreshes, peek does not', () => {
    const cache = lru(12)
    cache.set('a', bytes(4))
    cache.set('b', bytes(4))
    cache.set('c', bytes(4))
    cache.get('a') // b is now the oldest
    cache.peek('b')
    cache.set('d', bytes(4))
    expect(['a', 'b', 'c', 'd'].map((k) => cache.has(k))).toEqual([
      true,
      false,
      true,
      true,
    ])
    expect(cache.totalBytes).toBe(12)
  })

  test('returns the value it was given', () => {
    const cache = lru(100)
    const value = bytes(10)
    cache.set('k', value)
    expect(cache.get('k')).toBe(value)
  })

  test('remembers undefined as a zero-byte entry', () => {
    const cache = lru(10)
    cache.set('missing', undefined)
    expect(cache.has('missing')).toBe(true)
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.totalBytes).toBe(0)
  })

  test('refuses a value larger than the budget without evicting for it', () => {
    const cache = lru(10)
    cache.set('a', bytes(4))
    cache.set('b', bytes(4))
    cache.set('huge', bytes(11))
    expect(['a', 'b', 'huge'].map((k) => cache.has(k))).toEqual([
      true,
      true,
      false,
    ])
    expect(cache.totalBytes).toBe(8)
    // A value exactly the budget fits, evicting the rest.
    cache.set('exact', bytes(10))
    expect(cache.has('exact')).toBe(true)
    expect(cache.totalBytes).toBe(10)
    // keepOversize (the slide tile cache) holds it alone instead.
    const tiles = new ByteLru<string, Uint8Array>(
      10,
      undefined,
      undefined,
      true,
    )
    for (const k of ['a', 'huge']) tiles.set(k, bytes(k === 'a' ? 4 : 11))
    expect([tiles.has('a'), tiles.has('huge')]).toEqual([false, true])
  })

  test('replacing a key drops the stale value, even when the new one is refused', () => {
    const cache = lru(10)
    cache.set('k', bytes(4))
    cache.set('k', bytes(6))
    expect(cache.totalBytes).toBe(6)
    expect(cache.size).toBe(1)
    cache.set('k', bytes(64))
    expect(cache.has('k')).toBe(false)
    expect(cache.totalBytes).toBe(0)
  })

  test('a zero budget holds only zero-byte entries', () => {
    const cache = lru(0)
    cache.set('data', bytes(1))
    cache.set('absent', undefined)
    expect(cache.has('data')).toBe(false)
    expect(cache.has('absent')).toBe(true)
  })

  test('rejects negative and NaN budgets', () => {
    expect(() => lru(-1)).toThrow('non-negative')
    expect(() => lru(Number.NaN)).toThrow('non-negative')
    expect(() => lru(Number.POSITIVE_INFINITY)).not.toThrow()
    expect(() => lru(10).resize(-1)).toThrow('non-negative')
  })

  test('totalBytes never exceeds maxBytes across mixed workloads', () => {
    for (const budget of [1, 7, 10, 64, 1000]) {
      const cache = lru(budget)
      for (let i = 0; i < 50; i++) {
        cache.set(`k${i % 13}`, i % 5 === 0 ? undefined : bytes(i))
        expect(cache.totalBytes).toBeLessThanOrEqual(budget)
      }
    }
  })

  test('only has counts a lookup, as zarrita calls has then get', () => {
    const cache = lru(64)
    cache.set('k', bytes(4))
    expect(cache.has('k')).toBe(true)
    cache.get('k')
    cache.peek('k')
    cache.get('missing')
    cache.has('missing')
    expect([cache.stats.hits, cache.stats.misses]).toEqual([1, 1])
  })

  test('stats report admissions, rejections and evictions', () => {
    const cache = lru(10)
    cache.set('a', bytes(6))
    cache.set('absent', undefined)
    cache.set('huge', bytes(11))
    cache.set('b', bytes(6)) // evicts 'a'
    expect(cache.stats).toEqual({
      hits: 0,
      misses: 0,
      admitted: 3,
      rejected: 1,
      evicted: 1,
      evictedBytes: 6,
      entries: 2,
      bytes: 6,
      maxBytes: 10,
    })
  })

  test('resize evicts down to a smaller budget', () => {
    const cache = lru(100)
    for (const k of ['a', 'b', 'c']) cache.set(k, bytes(10))
    cache.resize(15)
    expect(cache.totalBytes).toBe(10)
    expect(cache.has('c')).toBe(true)
    cache.resize(100)
    cache.set('d', bytes(10))
    expect(cache.totalBytes).toBe(20)
  })

  test('clear drops the entries but keeps the counters', () => {
    const cache = lru(100)
    cache.set('k', bytes(10))
    cache.has('k')
    cache.clear()
    expect(cache.stats).toMatchObject({ hits: 1, entries: 0, bytes: 0 })
  })

  test('remap re-keys survivors in recency order and drops the rest', () => {
    const cache = new ByteLru<number, Uint8Array>(21)
    const one = bytes(10)
    const two = bytes(10)
    cache.set(1, one)
    cache.set(2, two)
    cache.set(3, bytes(1))
    cache.remap(
      new Map([
        [1, 10],
        [2, 20],
      ]),
    )
    expect([cache.peek(10), cache.peek(20), cache.has(3)]).toEqual([
      one,
      two,
      false,
    ])
    expect(cache.totalBytes).toBe(20)
    // 10 came from the older entry, so it is still the first to go.
    cache.set(30, bytes(10))
    expect([cache.has(10), cache.has(20)]).toEqual([false, true])
  })

  test('remap onto one key keeps the more recent value and frees the other', () => {
    const disposed: number[] = []
    const cache = new ByteLru<number, { id: number; bytes: number }>(
      100,
      (v) => v.bytes,
      (v) => disposed.push(v.id),
    )
    cache.set(1, { id: 1, bytes: 10 })
    cache.set(2, { id: 2, bytes: 20 })
    cache.remap(
      new Map([
        [1, 3],
        [2, 3],
      ]),
    )
    expect(disposed).toEqual([1])
    expect(cache.totalBytes).toBe(20)
    cache.set(4, { id: 4, bytes: 80 }) // fits beside the survivor
    expect(cache.peek(3)?.id).toBe(2)
  })

  test('remap keeps a key mapped to undefined', () => {
    const cache = new ByteLru<string | undefined, Uint8Array>(100)
    const value = bytes(4)
    cache.set('a', value)
    cache.remap(new Map([['a', undefined]]))
    expect(cache.peek(undefined)).toBe(value)
    expect(cache.totalBytes).toBe(4)
  })

  test('remap frees a displaced absence entry', () => {
    const disposed: Array<Uint8Array | undefined> = []
    const cache = new ByteLru<string, Uint8Array | undefined>(
      100,
      undefined,
      (v) => disposed.push(v),
    )
    const value = bytes(4)
    cache.set('a', undefined)
    cache.set('b', value)
    cache.remap(
      new Map([
        ['a', 'c'],
        ['b', 'c'],
      ]),
    )
    expect(disposed).toStrictEqual([undefined])
    expect(cache.peek('c')).toBe(value)
  })

  test('disposes every value it lets go of and bumps version', () => {
    const disposed: string[] = []
    const cache = new ByteLru<string, { id: string; bytes: number }>(
      10,
      (v) => v.bytes,
      (v) => disposed.push(v.id),
    )
    const v0 = cache.version
    cache.set('a', { id: 'a1', bytes: 5 })
    cache.set('a', { id: 'a2', bytes: 5 }) // replace
    cache.set('b', { id: 'b', bytes: 5 })
    cache.set('c', { id: 'c', bytes: 5 }) // evicts a2
    cache.set('d', { id: 'big', bytes: 11 }) // refused
    cache.remap(new Map([['c', 'c']])) // drops b
    cache.clear() // c
    expect(disposed).toEqual(['a1', 'a2', 'big', 'b', 'c'])
    expect(cache.version).toBeGreaterThan(v0)
  })
})
