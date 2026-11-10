import * as path from 'node:path'
import * as url from 'node:url'
import { FileSystemStore } from '@zarrita/storage'
import { describe, expect, it } from 'vitest'
import { defineArrayExtension } from '../src/extension/define-array.js'
import * as zarr from '../src/index.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const fixturesRoot = path.resolve(__dirname, '../fixtures/v3/data.zarr')

async function openFixture(name: string) {
  const store = new FileSystemStore(fixturesRoot)
  return zarr.open.v3(zarr.root(store).resolve(name), { kind: 'array' })
}

describe('defineArrayExtension', () => {
  it('intercepts getChunk', async () => {
    const calls: number[][] = []
    const withTrace = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        calls.push(coords)
        return array.getChunk(coords, options)
      },
    }))
    const arr = await openFixture('1d.chunked.i2')
    const wrapped = withTrace(arr)
    const chunk = await wrapped.getChunk([0])
    expect(chunk.data).toBeInstanceOf(Int16Array)
    expect(calls).toEqual([[0]])
  })

  it('pass-through getters still work (private field access)', async () => {
    const withNoop = defineArrayExtension((_array) => ({}))
    const arr = await openFixture('1d.chunked.i2')
    const wrapped = withNoop(arr)
    // These all read from `this.#metadata` via getters on Array.
    expect(wrapped.shape).toEqual(arr.shape)
    expect(wrapped.dtype).toBe(arr.dtype)
    expect(wrapped.chunks).toEqual(arr.chunks)
    expect(wrapped.attrs).toEqual(arr.attrs)
  })

  it('extensions appear on the wrapped array', async () => {
    const withCounter = defineArrayExtension((_array) => {
      let n = 0
      return {
        bump() {
          n += 1
        },
        get count(): number {
          return n
        },
      }
    })
    const arr = await openFixture('1d.chunked.i2')
    const wrapped = withCounter(arr)
    wrapped.bump()
    wrapped.bump()
    expect(wrapped.count).toBe(2)
  })

  it('works with zarr.get through the interception chain', async () => {
    const cache = new Map<string, zarr.Chunk<zarr.DataType>>()
    const withCache = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        const key = coords.join(',')
        const hit = cache.get(key)
        if (hit) return hit
        const chunk = await array.getChunk(coords, options)
        cache.set(key, chunk)
        return chunk
      },
    }))
    const arr = await openFixture('1d.chunked.i2')
    const wrapped = withCache(arr)
    const a = await zarr.get(wrapped)
    const b = await zarr.get(wrapped)
    expect(a.data).toStrictEqual(b.data)
    // Second pass should hit the cache for each chunk.
    expect(cache.size).toBeGreaterThan(0)
  })
})

describe('extendArray', () => {
  it('no extension returns the array as-is', async () => {
    const arr = await openFixture('1d.chunked.i2')
    const result = await zarr.extendArray(arr)
    expect(result).toBe(arr)
  })

  it('composes multiple extensions in order', async () => {
    const order: string[] = []
    const withA = defineArrayExtension((_array) => ({
      tagA: 'a',
      async getChunk(coords, options) {
        order.push('a')
        return _array.getChunk(coords, options)
      },
    }))
    const withB = defineArrayExtension((_array) => ({
      tagB: 'b',
      async getChunk(coords, options) {
        order.push('b')
        return _array.getChunk(coords, options)
      },
    }))
    const arr = await openFixture('1d.chunked.i2')
    const wrapped = await zarr.extendArray(
      arr,
      (a) => withA(a),
      (a) => withB(a),
    )
    expect(wrapped.tagA).toBe('a')
    expect(wrapped.tagB).toBe('b')
    await wrapped.getChunk([0])
    // Outer wrapper runs first; it calls through to inner.
    expect(order).toEqual(['b', 'a'])
  })
})

describe('zarr.open auto-apply of store arrayExtensions', () => {
  it('applies a single array extension contributed by a store extension', async () => {
    const calls: number[][] = []
    const withTrace = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        calls.push(coords)
        return array.getChunk(coords, options)
      },
    }))
    const withTracedArray = zarr.defineStoreExtension(() => ({
      arrayExtensions: [(a) => withTrace(a)],
    }))
    const store = withTracedArray(new FileSystemStore(fixturesRoot))
    const arr = await zarr.open.v3(zarr.root(store).resolve('1d.chunked.i2'), {
      kind: 'array',
    })
    await arr.getChunk([0])
    expect(calls).toEqual([[0]])
  })

  it('merges inner-first, outer-last across stacked store extensions', async () => {
    const order: string[] = []
    const withA = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        order.push('a')
        return array.getChunk(coords, options)
      },
    }))
    const withB = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        order.push('b')
        return array.getChunk(coords, options)
      },
    }))
    const storeExtA = zarr.defineStoreExtension(() => ({
      arrayExtensions: [(a) => withA(a)],
    }))
    const storeExtB = zarr.defineStoreExtension(() => ({
      arrayExtensions: [(a) => withB(a)],
    }))
    const store = await zarr.extendStore(
      new FileSystemStore(fixturesRoot),
      storeExtA,
      storeExtB,
    )
    // Merged list is visible as a plain field on the composed store.
    expect(
      (store as { arrayExtensions?: unknown[] }).arrayExtensions,
    ).toHaveLength(2)
    const arr = await zarr.open.v3(zarr.root(store).resolve('1d.chunked.i2'), {
      kind: 'array',
    })
    await arr.getChunk([0])
    // Outer store extension (B) becomes the outermost array wrapper, so
    // its getChunk runs first and calls through to A.
    expect(order).toEqual(['b', 'a'])
  })

  it('auto-applies on arrays resolved via a group', async () => {
    const calls: number[][] = []
    const withTrace = defineArrayExtension((array) => ({
      async getChunk(coords, options) {
        calls.push(coords)
        return array.getChunk(coords, options)
      },
    }))
    const withTracedArray = zarr.defineStoreExtension(() => ({
      arrayExtensions: [(a) => withTrace(a)],
    }))
    const store = withTracedArray(new FileSystemStore(fixturesRoot))
    const group = await zarr.open.v3(zarr.root(store), { kind: 'group' })
    const arr = await zarr.open.v3(group.resolve('1d.chunked.i2'), {
      kind: 'array',
    })
    await arr.getChunk([0])
    expect(calls).toEqual([[0]])
  })

  it('returns the array as-is when the store has no arrayExtensions', async () => {
    const store = new FileSystemStore(fixturesRoot)
    const arr = await zarr.open.v3(zarr.root(store).resolve('1d.chunked.i2'), {
      kind: 'array',
    })
    // No Proxy wrapping — the returned Array is the concrete class instance.
    expect(arr).toBeInstanceOf(zarr.Array)
  })
})
