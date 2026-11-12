import { describe, expect, test } from 'bun:test'
import type { TypedVoxelArray } from '@niivue/niivue'
import { parseOmeZarrAttrs } from './omeZarr'
import {
  omeZarrFrameCache,
  omeZarrVolumesFrom,
  openOmeZarr,
} from './omeZarrLoader'

// Lazy time (frameSource) and label stores, on in-memory Zarr v2 stores.

const T = 3
const C = 2
const SHAPE = [T, C, 2, 3, 4]
const N = 2 * 3 * 4

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** A tczyx uint16 store whose voxels hold 1000 * t + 100 * c + spatial index. */
function makeStore(attrs: Record<string, unknown> = {}) {
  const reads: string[] = []
  const map = new Map<string, Uint8Array>()
  map.set('/.zgroup', json({ zarr_format: 2 }))
  map.set(
    '/.zattrs',
    json({
      multiscales: [
        {
          version: '0.4',
          axes: ['t', 'c', 'z', 'y', 'x'].map((name) => ({ name })),
          datasets: [{ path: '0' }],
        },
      ],
      ...attrs,
    }),
  )
  map.set(
    '/0/.zarray',
    json({
      zarr_format: 2,
      shape: SHAPE,
      chunks: [1, 1, 2, 3, 4],
      dtype: '<u2',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  )
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < C; c++) {
      const chunk = new Uint16Array(N).map((_v, i) => 1000 * t + 100 * c + i)
      map.set(`/0/${t}.${c}.0.0.0`, new Uint8Array(chunk.buffer))
    }
  }
  const store = {
    get(key: string) {
      if (/\/0\/\d/.test(key)) reads.push(key)
      return map.get(key)
    },
  }
  return { store, reads }
}

describe('lazyTime', () => {
  test('each volume gets a frame source over the store timepoints', async () => {
    const { store, reads } = makeStore()
    const source = await openOmeZarr(store)
    const volumes = await omeZarrVolumesFrom(source, {
      channels: [0, 1],
      timepoint: 1,
      lazyTime: true,
    })
    const [a, b] = volumes.map((v) => v.frameSource)
    expect(a?.count).toBe(T)
    expect(a?.frame).toBe(1)
    expect(a?.group).toBe(b?.group as object)
    const frame = await b?.load(2, new AbortController().signal)
    expect(frame?.[0]).toBe(2100)
    expect(frame?.[N - 1]).toBe(2100 + N - 1)
    // The loaded timepoint is cached: switching back reads nothing.
    reads.length = 0
    expect((await a?.load(1, new AbortController().signal))?.[0]).toBe(1000)
    expect(reads).toEqual([])
  })

  test('a shared group object links two stores', async () => {
    const time = {}
    const raw = await omeZarrVolumesFrom(await openOmeZarr(makeStore().store), {
      channels: [0],
      lazyTime: time,
    })
    const seg = await omeZarrVolumesFrom(await openOmeZarr(makeStore().store), {
      channels: [0],
      lazyTime: time,
    })
    expect(raw[0].frameSource?.group).toBe(time)
    expect(seg[0].frameSource?.group).toBe(time)
  })

  test('without lazyTime there is no frame source', async () => {
    const volumes = await omeZarrVolumesFrom(
      await openOmeZarr(makeStore().store),
      { channels: [0] },
    )
    expect(volumes[0].frameSource).toBeUndefined()
  })
})

describe('omeZarrFrameCache', () => {
  const frame = (t: number) => new Uint8Array(10).fill(t) as TypedVoxelArray

  test('evicts the least recently used frames past the byte budget', async () => {
    const reads: number[] = []
    const cache = omeZarrFrameCache(25, async (_c, t) => {
      reads.push(t)
      return frame(t)
    })
    await cache.load(0, 0)
    await cache.load(0, 1)
    await cache.load(0, 0) // touch 0: 1 is now the oldest
    await cache.load(0, 2) // 30 bytes > 25: evicts 1
    expect(cache.bytes).toBe(20)
    await cache.load(0, 0)
    await cache.load(0, 1)
    expect(reads).toEqual([0, 1, 2, 1])
  })

  test('shares a read in flight and drops an aborted one', async () => {
    let reads = 0
    const cache = omeZarrFrameCache(100, async (_c, t, signal) => {
      reads += 1
      await Promise.resolve()
      signal?.throwIfAborted()
      return frame(t)
    })
    const [x, y] = [cache.load(0, 1), cache.load(0, 1)]
    expect(await x).toBe(await y)
    expect(reads).toBe(1)

    const request = new AbortController()
    const cancelled = cache.load(0, 2, request.signal)
    request.abort()
    expect(
      await cancelled.then(
        () => 'shown',
        () => 'aborted',
      ),
    ).toBe('aborted')
    // A later request for the same frame reads it again.
    expect((await cache.load(0, 2))[0]).toBe(2)
    expect(reads).toBe(3)
    expect(cache.bytes).toBe(20)
  })

  test('a failed read is not cached', async () => {
    let fail = true
    const cache = omeZarrFrameCache(100, async (_c, t) => {
      if (fail) throw new Error('offline')
      return frame(t)
    })
    expect(await cache.load(0, 1).catch((e) => e.message)).toBe('offline')
    fail = false
    expect((await cache.load(0, 1))[0]).toBe(1)
  })
})

describe('label stores', () => {
  const omero = {
    omero: {
      channels: [
        { label: 'cells', color: 'FF0000', window: { start: 0, end: 9 } },
      ],
    },
  }

  test('image-label metadata gives a label colormap and no window', async () => {
    const source = await openOmeZarr(
      makeStore({ ...omero, 'image-label': { version: '0.4' } }).store,
    )
    expect(source.info.isLabel).toBe(true)
    const [volume] = await omeZarrVolumesFrom(source, { channels: [0] })
    expect(volume.colormap).toBe('Random')
    expect(volume.name).toBe('cells')
    expect(volume.calMin).toBeUndefined()
  })

  test('the 0.5 layout nests image-label under ome', async () => {
    const { store } = makeStore()
    const attrs = JSON.parse(
      new TextDecoder().decode(store.get('/.zattrs') as Uint8Array),
    )
    const v3 = { ome: { ...attrs, version: '0.5', 'image-label': {} } }
    expect(parseOmeZarrAttrs(v3).isLabel).toBe(true)
    expect(parseOmeZarrAttrs(attrs).isLabel).toBe(false)
  })

  test('labels overrides the detection either way', async () => {
    const plain = await openOmeZarr(makeStore(omero).store)
    const [forced] = await omeZarrVolumesFrom(plain, {
      channels: [0],
      labels: true,
    })
    expect(forced.colormap).toBe('Random')
    const label = await openOmeZarr(
      makeStore({ ...omero, 'image-label': {} }).store,
    )
    const [ramp] = await omeZarrVolumesFrom(label, {
      channels: [0],
      labels: false,
    })
    expect(ramp.colormap).not.toBe('Random')
    expect(ramp.calMax).toBe(9)
  })
})

test('one caller aborting a shared frame read does not fail the other', async () => {
  let reads = 0
  const cache = omeZarrFrameCache(1 << 20, async (_c, t, signal) => {
    reads++
    await new Promise((r) => setTimeout(r, 5))
    if (signal?.aborted) throw new Error('aborted')
    return new Uint16Array(4).fill(t)
  })
  const a = new AbortController()
  const first = cache.load(0, 1, a.signal)
  const second = cache.load(0, 1, new AbortController().signal)
  a.abort()
  first.catch(() => {})
  expect(Array.from(await second)).toEqual([1, 1, 1, 1])
  expect(reads).toBe(1)
})

test('a shared frame read is aborted once every caller aborts', async () => {
  let seen: AbortSignal | undefined
  const cache = omeZarrFrameCache(1 << 20, (_c, _t, signal) => {
    seen = signal
    return new Promise(() => {})
  })
  const a = new AbortController()
  const b = new AbortController()
  cache.load(0, 1, a.signal)
  cache.load(0, 1, b.signal)
  a.abort()
  expect(seen?.aborted).toBe(false)
  b.abort()
  expect(seen?.aborted).toBe(true)
})

test('a caller already aborted does not keep a shared read alive', async () => {
  let seen: AbortSignal | undefined
  const cache = omeZarrFrameCache(1 << 20, (_c, _t, signal) => {
    seen = signal
    return new Promise(() => {})
  })
  const live = new AbortController()
  cache.load(0, 1, live.signal)
  const late = cache.load(0, 1, AbortSignal.abort())
  late.catch(() => {})
  live.abort()
  expect(seen?.aborted).toBe(true)
})
