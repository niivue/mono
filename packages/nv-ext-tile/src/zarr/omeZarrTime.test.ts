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
function makeStore(attrs: Record<string, unknown> = {}, frames = T) {
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
      shape: [frames, ...SHAPE.slice(1)],
      chunks: [1, 1, 2, 3, 4],
      dtype: '<u2',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  )
  for (let t = 0; t < frames; t++) {
    for (let c = 0; c < C; c++) {
      const chunk = new Uint16Array(N).map((_v, i) => 1000 * t + 100 * c + i)
      map.set(`/0/${t}.${c}.0.0.0`, new Uint8Array(chunk.buffer))
    }
  }
  /** Chunk reads of these timepoints wait until released. */
  const held = new Map<number, Promise<void>>()
  const aborted: string[] = []
  const store = {
    async get(key: string, opts?: { signal?: AbortSignal }) {
      if (/\/0\/\d/.test(key)) {
        reads.push(key)
        const wait = held.get(Number(/\/0\/(\d+)\./.exec(key)?.[1]))
        if (wait) {
          opts?.signal?.addEventListener('abort', () => aborted.push(key))
          await wait
        }
      }
      return map.get(key)
    },
  }
  return { store, reads, held, aborted }
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
    // The loaded timepoint is cached: switching back does not read it again
    // (the prefetch of the next frame may).
    reads.length = 0
    expect((await a?.load(1, new AbortController().signal))?.[0]).toBe(1000)
    expect(reads.filter((k) => k.startsWith('/0/1.'))).toEqual([])
  })

  test('VOL-03: the next frame in the direction of travel is prefetched, budgeted and cancelled', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 5))
    const open = async (frameCacheBytes?: number, timepoint = 0) => {
      const { store, reads } = makeStore()
      const [v] = await omeZarrVolumesFrom(await openOmeZarr(store), {
        channels: [0],
        lazyTime: true,
        timepoint,
        ...(frameCacheBytes === undefined ? {} : { frameCacheBytes }),
      })
      const fs = v.frameSource
      if (!fs) throw new Error('no frame source')
      reads.length = 0
      return {
        reads,
        load: (t: number, signal = new AbortController().signal) =>
          fs.load(t, signal),
      }
    }
    // Forward: showing 1 reads 1, then 2.
    const fwd = await open()
    await fwd.load(1)
    await settle()
    expect(fwd.reads).toEqual(['/0/1.0.0.0.0', '/0/2.0.0.0.0'])
    // Scrubbing back from the opened frame 2 to 1 prefetches 0.
    const back = await open(undefined, 2)
    await back.load(1)
    await settle()
    expect(back.reads).toEqual(['/0/1.0.0.0.0', '/0/0.0.0.0.0'])
    // A budget with no room for one more frame prefetches nothing.
    const tight = await open(N * 2 * 2)
    await tight.load(1)
    await settle()
    expect(tight.reads).toEqual(['/0/1.0.0.0.0'])
    // A stale prefetch is cancelled: 4 frames, showing 1 prefetches 2 (held);
    // jumping to 3 makes it stale, so its read is aborted.
    {
      const { store, reads, held, aborted } = makeStore({}, 4)
      let release = (): void => {}
      held.set(2, new Promise((r) => (release = r)))
      const [v] = await omeZarrVolumesFrom(await openOmeZarr(store), {
        channels: [0],
        lazyTime: true,
      })
      const load = (t: number) =>
        v.frameSource?.load(t, new AbortController().signal)
      await load(1)
      await settle()
      expect(reads).toContain('/0/2.0.0.0.0')
      await load(3)
      await settle()
      expect(aborted).toEqual(['/0/2.0.0.0.0'])
      release()
    }
    // A request whose signal was aborted (superseded) starts no prefetch.
    const stale = await open()
    const ac = new AbortController()
    const p = stale.load(1, ac.signal)
    ac.abort()
    await p.catch(() => {})
    await settle()
    expect(stale.reads.filter((k) => k.startsWith('/0/2.'))).toEqual([])
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

  test('a frame bigger than the budget is not kept', async () => {
    const cache = omeZarrFrameCache(5, async (_c, t) => frame(t))
    expect((await cache.load(0, 1))[0]).toBe(1)
    expect(cache.bytes).toBe(0)
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
      new TextDecoder().decode((await store.get('/.zattrs')) as Uint8Array),
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

test('a shared frame read: an aborting caller rejects alone; the read stops once every live caller aborts', async () => {
  let reads = 0
  let seen: AbortSignal | undefined
  let resolve = (): void => {}
  const cache = omeZarrFrameCache(1 << 20, (_c, t, signal) => {
    reads++
    seen = signal
    return new Promise((r) => {
      resolve = () => r(new Uint16Array(4).fill(t))
    })
  })
  const a = new AbortController()
  const first = cache.load(0, 1, a.signal)
  const second = cache.load(0, 1, new AbortController().signal)
  a.abort('stop')
  expect(
    await first.then(
      () => 'resolved',
      (e) => e,
    ),
  ).toBe('stop')
  expect(seen?.aborted).toBe(false)
  resolve()
  expect(Array.from(await second)).toEqual([1, 1, 1, 1])
  expect(reads).toBe(1)
  // A caller already aborted does not keep a shared read alive.
  const live = new AbortController()
  cache.load(0, 2, live.signal).catch(() => {})
  cache.load(0, 2, AbortSignal.abort()).catch(() => {})
  expect(seen?.aborted).toBe(false)
  live.abort()
  expect(seen?.aborted).toBe(true)
})

test('a settled read leaves no listener on the caller signal', async () => {
  const cache = omeZarrFrameCache(1 << 20, async (_c, t) =>
    new Uint8Array(1).fill(t),
  )
  const signal = new AbortController().signal
  let listeners = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  Object.assign(signal, {
    addEventListener: (...a: Parameters<typeof add>) => {
      listeners++
      add(...a)
    },
    removeEventListener: (...a: Parameters<typeof remove>) => {
      listeners--
      remove(...a)
    },
  })
  for (let t = 0; t < 3; t++) await cache.load(0, t, signal)
  expect(listeners).toBe(0)
})

describe('omeZarrLabelColormap', () => {
  test('image-label colours become an exact label LUT; unlisted IDs are clear', async () => {
    const { makeLabelLut } = await import('@niivue/niivue')
    const { omeZarrLabelColormap } = await import('./omeZarrLoader')
    const info = parseOmeZarrAttrs({
      multiscales: [{ datasets: [{ path: '0' }] }],
      'image-label': {
        colors: [
          { 'label-value': 3, rgba: [0, 0, 255, 128] },
          { 'label-value': 1, rgba: [255, 0, 0, 255] },
        ],
      },
    })
    const map = omeZarrLabelColormap(info)
    if (!map) throw new Error('no colormap')
    const lut = makeLabelLut(map)
    // Clear entries at 0 and 4 bound the stated 1 and 3.
    expect([lut.min, lut.max]).toEqual([0, 4])
    expect(Array.from(lut.lut)).toEqual([
      0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 128, 0, 0, 0, 0,
    ])
    expect(
      omeZarrLabelColormap(
        parseOmeZarrAttrs({ multiscales: [{ datasets: [{ path: '0' }] }] }),
      ),
    ).toBeNull()
  })

  test('a sparse table past the label span keeps what fits and warns, so it registers', async () => {
    const { makeLabelLut } = await import('@niivue/niivue')
    const { omeZarrLabelColormap } = await import('./omeZarrLoader')
    const info = parseOmeZarrAttrs({
      multiscales: [{ datasets: [{ path: '0' }] }],
      'image-label': {
        colors: [
          { 'label-value': 16777216, rgba: [0, 255, 0, 255] },
          { 'label-value': 0, rgba: [0, 0, 0, 0] },
          { 'label-value': 2, rgba: [255, 0, 0, 255] },
        ],
      },
    })
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (...a: unknown[]) => warned.push(a[0])
    try {
      const map = omeZarrLabelColormap(info)
      if (!map) throw new Error('no colormap')
      // addColormap's limit: label IDs span at most 256 * 8192.
      const I = map.I ?? []
      expect(Math.max(...I) - Math.min(...I) + 1).toBeLessThanOrEqual(
        256 * 8192,
      )
      // A clear entry after the last kept colour: dropped IDs clamp to it.
      expect(I).toEqual([0, 2, 3])
      const lut = makeLabelLut(map).lut
      expect(Array.from(lut.slice(8, 12))).toEqual([255, 0, 0, 255])
      expect(Array.from(lut.slice(0, 4))).toEqual([0, 0, 0, 0])
      expect(Array.from(lut.slice(-4))).toEqual([0, 0, 0, 0])
      expect(String(warned[0])).toContain('1 colour(s)')
      const of = (colors: { id: number; rgba: number[] }[]) =>
        omeZarrLabelColormap(
          parseOmeZarrAttrs({
            multiscales: [{ datasets: [{ path: '0' }] }],
            'image-label': {
              colors: colors.map((c) => ({
                'label-value': c.id,
                rgba: c.rgba,
              })),
            },
          }),
        )
      // Only ID 3: background 0 (below) and 9 (above) clamp to clear ends.
      const only3 = of([{ id: 3, rgba: [255, 0, 0, 255] }])
      if (!only3) throw new Error('no colormap')
      expect(only3.I).toEqual([2, 3, 4])
      const lut3 = makeLabelLut(only3).lut
      expect(Array.from(lut3.slice(0, 4))).toEqual([0, 0, 0, 0])
      expect(Array.from(lut3.slice(4, 8))).toEqual([255, 0, 0, 255])
      expect(Array.from(lut3.slice(-4))).toEqual([0, 0, 0, 0])
      // Clear at both ends already: the table is exactly the stated colours.
      const ends = of([
        { id: 0, rgba: [0, 0, 0, 0] },
        { id: 5, rgba: [0, 255, 0, 255] },
        { id: 6, rgba: [0, 0, 0, 0] },
      ])
      expect(ends?.I).toEqual([0, 5, 6])
      expect(ends?.G).toEqual([0, 255, 0])
      expect(warned.length).toBe(1)
    } finally {
      console.warn = warn
    }
  })
})
