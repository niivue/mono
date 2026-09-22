import { describe, expect, test } from 'bun:test'
import * as zarr from 'zarrita'
import { ByteLruCache, omeZarrChunkedSource } from './omeZarrChunkedSource'
import { openOmeZarr } from './omeZarrLoader'

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function zarray(shape: number[], chunks: number[], dtype: string): Uint8Array {
  return jsonBytes({
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  })
}

function zattrs(axes: unknown[], scales: number[][]): Uint8Array {
  return jsonBytes({
    multiscales: [
      {
        version: '0.4',
        axes,
        datasets: scales.map((scale, index) => ({
          path: String(index),
          coordinateTransformations: [{ type: 'scale', scale }],
        })),
      },
    ],
  })
}

const ZYX_AXES = [
  { name: 'z', type: 'space', unit: 'micrometer' },
  { name: 'y', type: 'space', unit: 'micrometer' },
  { name: 'x', type: 'space', unit: 'micrometer' },
]

/**
 * A 3D zyx store, z=4 y=3 x=4 uint16 in 2x2x2 chunks (edge chunks padded, as
 * zarr v2 stores them), each voxel encoding its own coordinates. A brick read
 * that crosses chunk boundaries proves zarrita's assembly and the adapter's
 * region logic together.
 */
function makeChunkedZyxStore(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>()
  store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
  store.set('/.zattrs', zattrs(ZYX_AXES, [[2, 0.5, 0.5]]))
  store.set('/0/.zarray', zarray([4, 3, 4], [2, 2, 2], '<u2'))
  for (let cz = 0; cz < 2; cz++) {
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const chunk = new Uint16Array(2 * 2 * 2)
        let i = 0
        for (let z = cz * 2; z < cz * 2 + 2; z++) {
          for (let y = cy * 2; y < cy * 2 + 2; y++) {
            for (let x = cx * 2; x < cx * 2 + 2; x++) {
              chunk[i] = z < 4 && y < 3 && x < 4 ? z * 100 + y * 10 + x : 0
              i += 1
            }
          }
        }
        store.set(`/0/${cz}.${cy}.${cx}`, new Uint8Array(chunk.buffer))
      }
    }
  }
  return store
}

/** A 5D tczyx store, single chunk, with a coarse second level. */
function makeTczyxStore(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>()
  store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
  store.set(
    '/.zattrs',
    zattrs(
      [
        { name: 't', type: 'time' },
        { name: 'c', type: 'channel' },
        ...ZYX_AXES,
      ],
      [
        [1, 1, 1, 1, 1],
        [1, 1, 1, 2, 2],
      ],
    ),
  )
  const fine = new Uint16Array(2 * 2 * 2 * 3 * 4)
  let i = 0
  for (let t = 0; t < 2; t++) {
    for (let c = 0; c < 2; c++) {
      for (let z = 0; z < 2; z++) {
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 4; x++) {
            fine[i] = t * 10000 + c * 1000 + z * 100 + y * 10 + x
            i += 1
          }
        }
      }
    }
  }
  store.set('/0/.zarray', zarray([2, 2, 2, 3, 4], [2, 2, 2, 3, 4], '<u2'))
  store.set('/0/0.0.0.0.0', new Uint8Array(fine.buffer))
  store.set('/1/.zarray', zarray([2, 2, 2, 2, 2], [2, 2, 2, 2, 2], '<u2'))
  store.set(
    '/1/0.0.0.0.0',
    new Uint8Array(new Uint16Array(2 * 2 * 2 * 2 * 2).buffer),
  )
  return store
}

/** A 3D store whose axes are declared x, y, z, the Human Organ Atlas way. */
function makeXyzStore(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>()
  store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
  store.set(
    '/.zattrs',
    zattrs(
      [
        { name: 'x', type: 'space', unit: 'micrometer' },
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'z', type: 'space', unit: 'micrometer' },
      ],
      [[1, 1, 1]],
    ),
  )
  // C order over declared (x, y, z): z varies fastest in storage.
  const data = new Uint16Array(2 * 3 * 4)
  let i = 0
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 4; z++) {
        data[i] = x * 100 + y * 10 + z
        i += 1
      }
    }
  }
  store.set('/0/.zarray', zarray([2, 3, 4], [2, 3, 4], '<u2'))
  store.set('/0/0.0.0', new Uint8Array(data.buffer))
  return store
}

function voxels(bytes: Uint8Array): Uint16Array {
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

describe('omeZarrChunkedSource', () => {
  test('describes levels in display terms with dataset indices', async () => {
    const source = omeZarrChunkedSource(await openOmeZarr(makeTczyxStore()))
    expect(source.datatypeCode).toBe(512) // DT_UINT16
    expect(source.levels).toEqual([
      { level: 0, shape: [4, 3, 2], spacing: [1, 1, 1] },
      { level: 1, shape: [2, 2, 2], spacing: [2, 2, 1] },
    ])
    expect(source.zarr.channelCount).toBe(2)
  })

  test('reads an interior brick across chunk boundaries', async () => {
    const source = omeZarrChunkedSource(
      await openOmeZarr(makeChunkedZyxStore()),
    )
    const bytes = await source.fetchChunk({
      levelIndex: 0,
      texOrigin: [1, 1, 1],
      texDims: [2, 2, 2],
      bytesPerVoxel: 2,
    })
    expect(bytes.byteLength).toBe(2 * 2 * 2 * 2)
    const out = voxels(bytes)
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          expect(out[x + y * 2 + z * 4]).toBe(
            (z + 1) * 100 + (y + 1) * 10 + (x + 1),
          )
        }
      }
    }
  })

  test('zero-pads a brick that runs past the level bounds', async () => {
    const source = omeZarrChunkedSource(
      await openOmeZarr(makeChunkedZyxStore()),
    )
    const bytes = await source.fetchChunk({
      levelIndex: 0,
      texOrigin: [3, 2, 3],
      texDims: [2, 2, 2],
      bytesPerVoxel: 2,
    })
    const out = voxels(bytes)
    // Only [x=3, y=2, z=3] is in bounds; every other voxel is fill.
    expect(out[0]).toBe(3 * 100 + 2 * 10 + 3)
    expect([...out].filter((v) => v !== 0)).toHaveLength(1)
  })

  test('a brick fully outside the level is all fill', async () => {
    const source = omeZarrChunkedSource(
      await openOmeZarr(makeChunkedZyxStore()),
    )
    const bytes = await source.fetchChunk({
      levelIndex: 0,
      texOrigin: [10, 0, 0],
      texDims: [2, 2, 2],
      bytesPerVoxel: 2,
    })
    expect([...voxels(bytes)].every((v) => v === 0)).toBe(true)
  })

  test('pins the requested channel and timepoint', async () => {
    const opened = await openOmeZarr(makeTczyxStore())
    const source = omeZarrChunkedSource(opened, {
      channel: 1,
      timepoint: 1,
    })
    const bytes = await source.fetchChunk({
      levelIndex: 0,
      texOrigin: [0, 0, 0],
      texDims: [4, 3, 2],
      bytesPerVoxel: 2,
    })
    const out = voxels(bytes)
    expect(out[0]).toBe(11000)
    expect(out[out.length - 1]).toBe(11000 + 100 + 20 + 3)
  })

  test('transposes an x y z-ordered store to x-fastest bricks', async () => {
    const source = omeZarrChunkedSource(await openOmeZarr(makeXyzStore()))
    expect(source.levels[0].shape).toEqual([2, 3, 4])
    const bytes = await source.fetchChunk({
      levelIndex: 0,
      texOrigin: [0, 1, 1],
      texDims: [2, 2, 2],
      bytesPerVoxel: 2,
    })
    const out = voxels(bytes)
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          expect(out[x + y * 2 + z * 4]).toBe(x * 100 + (y + 1) * 10 + (z + 1))
        }
      }
    }
  })

  test('validates its inputs before any read', async () => {
    const opened = await openOmeZarr(makeTczyxStore())
    expect(() => omeZarrChunkedSource(opened, { channel: 2 })).toThrow(
      'channel 2 is out of range',
    )
    expect(() => omeZarrChunkedSource(opened, { timepoint: 9 })).toThrow(
      'timepoint 9 is out of range',
    )
    const source = omeZarrChunkedSource(opened)
    await expect(
      source.fetchChunk({
        levelIndex: 5,
        texOrigin: [0, 0, 0],
        texDims: [1, 1, 1],
        bytesPerVoxel: 2,
      }),
    ).rejects.toThrow('level index 5 is out of range')
    await expect(
      source.fetchChunk({
        levelIndex: 0,
        texOrigin: [0, 0, 0],
        texDims: [1, 1, 1],
        bytesPerVoxel: 4,
      }),
    ).rejects.toThrow('4 bytes/voxel')
  })

  test('rejects a pyramid whose levels disagree on dtype', async () => {
    const store = makeTczyxStore()
    store.set('/1/.zarray', zarray([2, 2, 2, 2, 2], [2, 2, 2, 2, 2], '<u1'))
    const opened = await openOmeZarr(store)
    expect(() => omeZarrChunkedSource(opened)).toThrow('mixed level dtypes')
  })
})

describe('ByteLruCache', () => {
  test('evicts least-recently-used entries past the byte budget', () => {
    const cache = new ByteLruCache(10)
    cache.set('a', new Uint8Array(4))
    cache.set('b', new Uint8Array(4))
    cache.get('a') // refresh: b is now the oldest
    cache.set('c', new Uint8Array(4))
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.totalBytes).toBe(8)
  })

  test('remembers absences as zero-byte entries', () => {
    const cache = new ByteLruCache(10)
    cache.set('missing', undefined)
    expect(cache.has('missing')).toBe(true)
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.totalBytes).toBe(0)
  })

  test('never admits a value larger than the budget', () => {
    const cache = new ByteLruCache(10)
    cache.set('big', new Uint8Array(11))
    expect(cache.has('big')).toBe(false)
    expect(cache.totalBytes).toBe(0)

    // Resident entries are not evicted to make room that will not suffice.
    cache.set('a', new Uint8Array(4))
    cache.set('b', new Uint8Array(4))
    cache.set('huge', new Uint8Array(100))
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('huge')).toBe(false)
    expect(cache.totalBytes).toBe(8)
  })

  test('replacing an entry with an oversized value drops the stale entry', () => {
    const cache = new ByteLruCache(10)
    cache.set('k', new Uint8Array(4))
    cache.set('k', new Uint8Array(64))
    // The old value must not survive as stale bytes, and the new one cannot
    // be held, so the key ends up uncached.
    expect(cache.has('k')).toBe(false)
    expect(cache.get('k')).toBeUndefined()
    expect(cache.totalBytes).toBe(0)
  })

  test('a value exactly equal to the budget is admitted', () => {
    const cache = new ByteLruCache(10)
    cache.set('exact', new Uint8Array(10))
    expect(cache.has('exact')).toBe(true)
    expect(cache.totalBytes).toBe(10)
    // A second entry evicts the first rather than exceeding the bound.
    cache.set('next', new Uint8Array(10))
    expect(cache.has('exact')).toBe(false)
    expect(cache.has('next')).toBe(true)
    expect(cache.totalBytes).toBe(10)
  })

  test('a zero budget caches only zero-byte absences', () => {
    const cache = new ByteLruCache(0)
    cache.set('data', new Uint8Array(1))
    expect(cache.has('data')).toBe(false)
    cache.set('absent', undefined)
    expect(cache.has('absent')).toBe(true)
    expect(cache.totalBytes).toBe(0)
  })

  test('rejects negative and NaN budgets at construction', () => {
    expect(() => new ByteLruCache(-1)).toThrow('non-negative')
    expect(() => new ByteLruCache(Number.NaN)).toThrow('non-negative')
    expect(() => new ByteLruCache(Number.POSITIVE_INFINITY)).not.toThrow()
  })

  test('totalBytes never exceeds maxBytes across mixed workloads', () => {
    for (const budget of [1, 7, 10, 64, 1000]) {
      const cache = new ByteLruCache(budget)
      for (let i = 0; i < 50; i++) {
        cache.set(`k${i % 13}`, i % 5 === 0 ? undefined : new Uint8Array(i))
        expect(cache.totalBytes).toBeLessThanOrEqual(budget)
      }
    }
  })

  test('stats separate a thrashing budget from an unused one', () => {
    // Same lookups, same misses, opposite diagnoses: the small budget evicts
    // to make room, the large one simply never sees a repeat.
    const thrash = new ByteLruCache(8)
    for (let i = 0; i < 6; i++) {
      thrash.has(`k${i}`)
      thrash.set(`k${i}`, new Uint8Array(4))
    }
    expect(thrash.stats.hits).toBe(0)
    expect(thrash.stats.misses).toBe(6)
    expect(thrash.stats.evicted).toBeGreaterThan(0)

    const roomy = new ByteLruCache(1024)
    for (let i = 0; i < 6; i++) {
      roomy.has(`k${i}`)
      roomy.set(`k${i}`, new Uint8Array(4))
    }
    expect(roomy.stats.hits).toBe(0)
    expect(roomy.stats.misses).toBe(6)
    expect(roomy.stats.evicted).toBe(0)
  })

  test('counts a lookup once, at the gate zarrita consults', () => {
    const cache = new ByteLruCache(64)
    cache.set('k', new Uint8Array(4))
    // `withByteCaching` calls has() then get(); only has() counts, so a hit
    // is one hit and not two.
    expect(cache.has('k')).toBe(true)
    cache.get('k')
    expect(cache.stats.hits).toBe(1)
    expect(cache.stats.misses).toBe(0)
  })

  test('stats report admissions, rejections and evicted bytes', () => {
    const cache = new ByteLruCache(10)
    cache.set('a', new Uint8Array(6))
    cache.set('absent', undefined)
    cache.set('huge', new Uint8Array(11))
    cache.set('b', new Uint8Array(6)) // evicts 'a'
    const stats = cache.stats
    expect(stats.admitted).toBe(3)
    expect(stats.rejected).toBe(1)
    expect(stats.evicted).toBe(1)
    expect(stats.evictedBytes).toBe(6)
    expect(stats.bytes).toBe(cache.totalBytes)
    expect(stats.entries).toBe(2)
    expect(stats.maxBytes).toBe(10)
  })

  test('resetStats zeroes the counters and keeps the entries', () => {
    const cache = new ByteLruCache(64)
    cache.set('k', new Uint8Array(4))
    cache.has('k')
    cache.has('missing')
    cache.resetStats()
    const stats = cache.stats
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(0)
    expect(stats.admitted).toBe(0)
    expect(stats.entries).toBe(1)
    expect(stats.bytes).toBe(4)
    expect(cache.get('k')).toBeDefined()
  })

  test('with zarrita byte caching, an absent chunk is fetched once', async () => {
    const backing = makeChunkedZyxStore()
    backing.delete('/0/1.1.1') // the chunk holding the far corner
    const reads = new Map<string, number>()
    const counting = {
      async get(key: `/${string}`): Promise<Uint8Array | undefined> {
        reads.set(key, (reads.get(key) ?? 0) + 1)
        return backing.get(key)
      },
    }
    const store = zarr.withByteCaching(counting, {
      cache: new ByteLruCache(1024 * 1024),
    })
    const source = omeZarrChunkedSource(await openOmeZarr(store))
    const read = () =>
      source.fetchChunk({
        levelIndex: 0,
        texOrigin: [0, 2, 2],
        texDims: [4, 1, 2],
        bytesPerVoxel: 2,
      })
    const first = await read()
    // The absent chunk (x >= 2) reads as fill; present neighbours contribute.
    expect(voxels(first)[0]).toBe(2 * 100 + 2 * 10 + 0)
    expect(voxels(first)[1]).toBe(2 * 100 + 2 * 10 + 1)
    expect(voxels(first)[2]).toBe(0)
    await read()
    await read()
    expect(reads.get('/0/1.1.1')).toBe(1)
  })
})
