import { describe, expect, test } from 'bun:test'
import type * as zarr from 'zarrita'
import {
  clearPersistentByteCaches,
  openCacheStorageBacking,
  openPersistentByteCache,
  PersistentByteCache,
  type PersistentCacheBacking,
  parsePersistentCacheKey,
  persistentCacheKey,
  withPersistentBytes,
} from './persistentByteCache'

/** An in-memory stand-in for Cache Storage, insertion ordered like the real one. */
class FakeBacking implements PersistentCacheBacking {
  readonly held = new Map<string, Uint8Array>()
  reads = 0
  writeError: Error | null = null

  async keys(): Promise<string[]> {
    return [...this.held.keys()]
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    this.reads++
    return this.held.get(key)
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.writeError) throw this.writeError
    this.held.set(key, new Uint8Array(bytes))
  }

  async remove(key: string): Promise<void> {
    this.held.delete(key)
  }
}

function bytes(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill)
}

describe('persistentCacheKey', () => {
  test('round trips an identity through the key', () => {
    const identity = 'https://dandi.org/v.zarr/0/1/2/3'
    const key = persistentCacheKey(identity, 4096)
    expect(parsePersistentCacheKey(key)).toEqual({ identity, bytes: 4096 })
  })

  test('survives an identity full of separators', () => {
    const identity = 'https://h/a b?x=1&y=2#z/0/0/0'
    const key = persistentCacheKey(identity, 7)
    expect(key.indexOf('?')).toBe(key.indexOf('?b='))
    expect(parsePersistentCacheKey(key)?.identity).toBe(identity)
  })

  test('rejects a key this encoding did not write', () => {
    expect(parsePersistentCacheKey('https://example.com/thing')).toBeNull()
    expect(
      parsePersistentCacheKey('https://niivue.cache/zarr/nosize'),
    ).toBeNull()
  })
})

describe('PersistentByteCache.open', () => {
  test('rebuilds the index and the byte total without reading a body', async () => {
    const backing = new FakeBacking()
    backing.held.set(persistentCacheKey('a', 100), bytes(100))
    backing.held.set(persistentCacheKey('b', 250), bytes(250))
    const cache = await PersistentByteCache.open(backing, 1000)
    expect(cache.stats.entries).toBe(2)
    expect(cache.totalBytes).toBe(350)
    expect(backing.reads).toBe(0)
  })

  test('removes keys it did not write rather than counting them', async () => {
    const backing = new FakeBacking()
    backing.held.set('https://example.com/stray', bytes(10))
    backing.held.set(persistentCacheKey('a', 10), bytes(10))
    const cache = await PersistentByteCache.open(backing, 1000)
    await cache.idle()
    expect(cache.stats.entries).toBe(1)
    expect([...backing.held.keys()]).toEqual([persistentCacheKey('a', 10)])
  })

  test('evicts an inherited store that is over the new budget', async () => {
    const backing = new FakeBacking()
    for (const name of ['a', 'b', 'c']) {
      backing.held.set(persistentCacheKey(name, 100), bytes(100))
    }
    const cache = await PersistentByteCache.open(backing, 150)
    await cache.idle()
    expect(cache.totalBytes).toBe(100)
    // Oldest written goes first: a listing has no recency to go on.
    expect([...backing.held.keys()]).toEqual([persistentCacheKey('c', 100)])
  })

  test('a backing that cannot be listed leaves an empty, usable cache', async () => {
    const backing = new FakeBacking()
    backing.keys = () => Promise.reject(new Error('no listing'))
    const cache = await PersistentByteCache.open(backing, 1000)
    expect(cache.stats.errors).toBe(1)
    expect(cache.stats.entries).toBe(0)
  })
})

describe('PersistentByteCache', () => {
  test('holds bytes and serves them back', async () => {
    const cache = await PersistentByteCache.open(new FakeBacking(), 1000)
    await cache.set('a', bytes(64, 7))
    const held = await cache.get('a')
    expect(held?.byteLength).toBe(64)
    expect(held?.[0]).toBe(7)
    expect(cache.stats.hits).toBe(1)
    expect(cache.stats.writes).toBe(1)
  })

  test('counts a lookup it cannot answer as a miss', async () => {
    const cache = await PersistentByteCache.open(new FakeBacking(), 1000)
    expect(await cache.get('nothing')).toBeUndefined()
    expect(cache.stats).toMatchObject({ hits: 0, misses: 1 })
  })

  test('an entry the browser cleared reads as a miss, not an error', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    await cache.set('a', bytes(10))
    backing.held.clear()
    expect(await cache.get('a')).toBeUndefined()
    expect(cache.stats).toMatchObject({ misses: 1, errors: 0, entries: 0 })
    expect(cache.totalBytes).toBe(0)
  })

  test('evicts least recently used, and a hit protects an entry', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 300)
    await cache.set('a', bytes(100))
    await cache.set('b', bytes(100))
    await cache.set('c', bytes(100))
    await cache.get('a')
    await cache.set('d', bytes(100))
    await cache.idle()
    expect(cache.totalBytes).toBe(300)
    expect(await cache.get('b')).toBeUndefined()
    expect(await cache.get('a')).toBeDefined()
    expect(cache.stats.evicted).toBe(1)
    expect(cache.stats.evictedBytes).toBe(100)
  })

  test('refuses a value larger than the whole budget, evicting nothing', async () => {
    const cache = await PersistentByteCache.open(new FakeBacking(), 200)
    await cache.set('a', bytes(100))
    await cache.set('big', bytes(300))
    expect(cache.stats).toMatchObject({ rejected: 1, evicted: 0 })
    expect(cache.totalBytes).toBe(100)
    expect(await cache.get('a')).toBeDefined()
  })

  test('a re-write at a different size leaves no orphan behind', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    await cache.set('a', bytes(100))
    await cache.set('a', bytes(50))
    await cache.idle()
    expect([...backing.held.keys()]).toEqual([persistentCacheKey('a', 50)])
    expect(cache.totalBytes).toBe(50)
    expect(cache.stats.entries).toBe(1)
  })

  test('a failed write takes the entry back out of the index', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    backing.writeError = new Error('disk is unhappy')
    await cache.set('a', bytes(100))
    expect(cache.stats).toMatchObject({ errors: 1, entries: 0, writes: 0 })
    expect(cache.totalBytes).toBe(0)
  })

  test('a quota error halves the budget instead of retrying into it', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    await cache.set('a', bytes(400))
    await cache.set('b', bytes(400))
    const quota = new Error('quota')
    quota.name = 'QuotaExceededError'
    backing.writeError = quota
    await cache.set('c', bytes(100))
    await cache.idle()
    expect(cache.maxBytes).toBe(400)
    expect(cache.totalBytes).toBeLessThanOrEqual(400)
    expect(cache.stats.errors).toBe(1)
  })

  test('clear empties the index and the backing', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    await cache.set('a', bytes(10))
    await cache.set('b', bytes(10))
    await cache.clear()
    expect(cache.stats.entries).toBe(0)
    expect(backing.held.size).toBe(0)
  })
})

describe('openPersistentByteCache', () => {
  test('declines a zero budget', async () => {
    expect(
      await openPersistentByteCache({
        maxBytes: 0,
        backing: new FakeBacking(),
      }),
    ).toBeNull()
  })

  test('declines where there is no Cache Storage', async () => {
    // Bun has no `caches`, which is the same answer a non-secure context gives.
    expect(await openPersistentByteCache()).toBeNull()
  })
})

describe('withPersistentBytes', () => {
  function fakeStore(
    held: Map<string, Uint8Array>,
    counter: { reads: number },
  ): zarr.AsyncReadable {
    return {
      get: async (key: string) => {
        counter.reads++
        return held.get(key)
      },
    } as zarr.AsyncReadable
  }

  test('a second session reads from the tier, not the store', async () => {
    const backing = new FakeBacking()
    const held = new Map([['/0/0', bytes(32, 3)]])
    const counter = { reads: 0 }

    const first = await PersistentByteCache.open(backing, 1000)
    const cold = withPersistentBytes(fakeStore(held, counter), first, 'store:')
    expect((await cold.get('/0/0'))?.[0]).toBe(3)
    await first.idle()
    expect(counter.reads).toBe(1)

    // A new cache over the same backing is exactly what a reload builds.
    const second = await PersistentByteCache.open(backing, 1000)
    const warm = withPersistentBytes(fakeStore(held, counter), second, 'store:')
    expect((await warm.get('/0/0'))?.[0]).toBe(3)
    expect(counter.reads).toBe(1)
    expect(second.stats.hits).toBe(1)
  })

  test('scopes keys by prefix so two stores cannot collide', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    const counter = { reads: 0 }
    const one = withPersistentBytes(
      fakeStore(new Map([['/0/0', bytes(8, 1)]]), counter),
      cache,
      'a:',
    )
    const two = withPersistentBytes(
      fakeStore(new Map([['/0/0', bytes(8, 2)]]), counter),
      cache,
      'b:',
    )
    expect((await one.get('/0/0'))?.[0]).toBe(1)
    expect((await two.get('/0/0'))?.[0]).toBe(2)
    await cache.idle()
    expect(cache.stats.entries).toBe(2)
  })

  test('does not persist an absent chunk', async () => {
    const backing = new FakeBacking()
    const cache = await PersistentByteCache.open(backing, 1000)
    const counter = { reads: 0 }
    const store = withPersistentBytes(
      fakeStore(new Map(), counter),
      cache,
      'store:',
    )
    expect(await store.get('/0/0')).toBeUndefined()
    await cache.idle()
    expect(cache.stats.entries).toBe(0)
    expect(backing.held.size).toBe(0)
  })

  test('forwards getRange unpersisted, and only when the store has one', async () => {
    const cache = await PersistentByteCache.open(new FakeBacking(), 1000)
    const ranged = {
      get: async () => undefined,
      getRange: async () => bytes(4, 9),
    } as unknown as zarr.AsyncReadable
    const wrapped = withPersistentBytes(ranged, cache, 'store:')
    expect(wrapped.getRange).toBeDefined()
    expect(
      (await wrapped.getRange?.('/0/0', { offset: 0, length: 4 }))?.[0],
    ).toBe(9)
    const plain = withPersistentBytes(
      { get: async () => undefined } as zarr.AsyncReadable,
      cache,
      'store:',
    )
    expect(plain.getRange).toBeUndefined()
  })
})

describe('openCacheStorageBacking', () => {
  /** The slice of Cache Storage this adapter uses, over plain Maps. */
  function fakeCaches(): CacheStorage & {
    names: Map<string, Map<string, Response>>
  } {
    const names = new Map<string, Map<string, Response>>()
    const storage = {
      names,
      open: async (name: string) => {
        const entries = names.get(name) ?? new Map<string, Response>()
        names.set(name, entries)
        return {
          keys: async () => [...entries.keys()].map((url) => new Request(url)),
          match: async (key: string) => entries.get(key)?.clone(),
          put: async (key: string, response: Response) => {
            entries.set(key, response)
          },
          delete: async (key: string) => entries.delete(key),
        }
      },
      keys: async () => [...names.keys()],
      delete: async (name: string) => names.delete(name),
    }
    return storage as unknown as CacheStorage & {
      names: Map<string, Map<string, Response>>
    }
  }

  test('round trips bytes through Request and Response', async () => {
    const storage = fakeCaches()
    const backing = await openCacheStorageBacking('niivue-zarr-v1', storage)
    expect(backing).not.toBeNull()
    if (!backing) return
    const key = persistentCacheKey('a/b', 3)
    await backing.write(key, new Uint8Array([4, 5, 6]))
    expect(await backing.keys()).toEqual([key])
    expect([...((await backing.read(key)) ?? [])]).toEqual([4, 5, 6])
    await backing.remove(key)
    expect(await backing.read(key)).toBeUndefined()
  })

  test('stores a window onto a larger buffer, not its host', async () => {
    const storage = fakeCaches()
    const backing = await openCacheStorageBacking('niivue-zarr-v1', storage)
    if (!backing) throw new Error('no backing')
    const host = new Uint8Array([1, 2, 3, 4, 5, 6])
    const key = persistentCacheKey('window', 2)
    await backing.write(key, host.subarray(2, 4))
    expect([...((await backing.read(key)) ?? [])]).toEqual([3, 4])
  })

  test('prunes caches an older key encoding wrote', async () => {
    const storage = fakeCaches()
    await storage.open('niivue-zarr-v0')
    await storage.open('someone-elses-cache')
    await openCacheStorageBacking('niivue-zarr-v1', storage)
    expect((await storage.keys()).sort()).toEqual([
      'niivue-zarr-v1',
      'someone-elses-cache',
    ])
  })

  test('clearPersistentByteCaches leaves other origins alone', async () => {
    const storage = fakeCaches()
    await storage.open('niivue-zarr-v1')
    await storage.open('app-shell')
    await clearPersistentByteCaches(storage)
    expect(await storage.keys()).toEqual(['app-shell'])
  })

  test('no Cache Storage means no backing', async () => {
    expect(
      await openCacheStorageBacking('niivue-zarr-v1', undefined),
    ).toBeNull()
  })
})

describe('scoped caches over one backing', () => {
  test('a scope adopts only its own keys and leaves a sibling alone', async () => {
    const backing = new FakeBacking()
    const scopes = ['w0/', 'w1/']
    const one = await PersistentByteCache.open(backing, 1024, 'w0/', scopes)
    const two = await PersistentByteCache.open(backing, 1024, 'w1/', scopes)
    await one.set('brick', new Uint8Array(64))
    await two.set('brick', new Uint8Array(64))
    await one.idle()
    await two.idle()

    const reopened = await PersistentByteCache.open(
      backing,
      1024,
      'w0/',
      scopes,
    )
    expect(reopened.stats.entries).toBe(1)
    expect(reopened.totalBytes).toBe(64)
    // The sibling's entry is still there for the sibling to find.
    expect((await backing.keys()).length).toBe(2)
    expect((await two.get('brick'))?.length).toBe(64)
  })

  test('a scope no longer in use is cleared out', async () => {
    const backing = new FakeBacking()
    const four = ['w0/', 'w1/', 'w2/', 'w3/']
    for (const scope of four) {
      const cache = await PersistentByteCache.open(backing, 1024, scope, four)
      await cache.set('brick', new Uint8Array(32))
      await cache.idle()
    }
    expect((await backing.keys()).length).toBe(4)

    // Half the pool this time: w2 and w3 own nothing now.
    const two = ['w0/', 'w1/']
    const cache = await PersistentByteCache.open(backing, 1024, 'w0/', two)
    expect(cache.stats.entries).toBe(1)
    const left = await backing.keys()
    expect(left.length).toBe(2)
    expect(
      left.every((key) => key.includes('w0%2F') || key.includes('w1%2F')),
    ).toBe(true)
  })

  test('a scoped cache serves the store through withPersistentBytes', async () => {
    const backing = new FakeBacking()
    const bytes = new Uint8Array([7, 7, 7])
    let reads = 0
    const store = {
      get: async (): Promise<Uint8Array | undefined> => {
        reads++
        return bytes
      },
    }
    const cold = await PersistentByteCache.open(backing, 1024, 'w1/', ['w1/'])
    const first = withPersistentBytes(store, cold, 'https://store/')
    expect((await first.get('/0/0/0'))?.length).toBe(3)
    await cold.idle()
    expect(reads).toBe(1)

    const warm = await PersistentByteCache.open(backing, 1024, 'w1/', ['w1/'])
    const second = withPersistentBytes(store, warm, 'https://store/')
    expect((await second.get('/0/0/0'))?.length).toBe(3)
    expect(reads).toBe(1)
  })
})

test('openPersistentByteCache honours the scope it is given', async () => {
  const backing = new FakeBacking()
  const cache = await openPersistentByteCache({
    backing,
    maxBytes: 1024,
    scope: 'w2/',
    scopes: ['w0/', 'w1/', 'w2/'],
  })
  expect(cache?.scope).toBe('w2/')
  await cache?.set('brick', new Uint8Array(8))
  await cache?.idle()
  expect((await backing.keys())[0]).toContain('w2%2F')
})
