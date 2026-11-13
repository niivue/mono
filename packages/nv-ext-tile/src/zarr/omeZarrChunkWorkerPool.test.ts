import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as zarr from '@niivue/zarrita-rs/inline'
import {
  chunkRegionKey,
  routeChunkToWorker,
  shardExtents,
} from './chunkWorkerRouting'
import {
  OME_ZARR_CHUNK_ERROR,
  openOmeZarrChunkedSource,
} from './omeZarrChunkedSource'

// Bun cannot resolve Vite's inline-worker import; the tests pass real Bun
// workers of the same entry through the pool's createWorker parameter.
// The default entry stands for a worker that cannot run (the fallback path).
mock.module('./omeZarrChunk.worker?worker&inline', () => ({
  default: class {
    postMessage() {
      throw new Error('no worker here')
    }
    terminate() {}
  },
}))
const { OmeZarrChunkWorkerPool } = await import('./omeZarrChunkWorkerPool')

const T = 2
const N = 8
// t x y x x uint8, one chunk per t and 4 x 4 quadrant; value = 100 t + y.
async function makeStore(): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>()
  const root = zarr.root(store)
  await zarr.create(root, {
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [
          {
            axes: [
              { name: 't', type: 'time' },
              { name: 'y', type: 'space' },
              { name: 'x', type: 'space' },
            ],
            datasets: [
              {
                path: '0',
                coordinateTransformations: [
                  { type: 'scale', scale: [1, 1, 1] },
                ],
              },
            ],
          },
        ],
      },
    },
  })
  const arr = await zarr.create(root.resolve('0'), {
    shape: [T, N, N],
    chunkShape: [1, 4, 4],
    dtype: 'uint8',
  })
  const data = Uint8Array.from(
    { length: T * N * N },
    (_, i) => 100 * Math.floor(i / (N * N)) + Math.floor((i % (N * N)) / N),
  )
  await zarr.set(arr, null, {
    data,
    shape: [T, N, N],
    stride: [N * N, N, 1],
  } as zarr.Chunk<zarr.DataType>)
  return store
}

const VARIANTS = new URL('../../fixtures/zarr-variants', import.meta.url)
  .pathname
// 3 x 8 x 8 uint8 (an RGB slide), chunks of cc along c; value = 50 c + y.
async function makeRgbStore(
  cc: number,
  coarseCc?: number,
): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>()
  const root = zarr.root(store)
  const axes = ['c', 'y', 'x'].map((name) => ({
    name,
    type: name === 'c' ? 'channel' : 'space',
  }))
  await zarr.create(root, {
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [
          {
            axes,
            datasets: [
              { path: '0' },
              ...(coarseCc === undefined ? [] : [{ path: '1' }]),
            ],
          },
        ],
      },
    },
  })
  const arr = await zarr.create(root.resolve('0'), {
    shape: [3, N, N],
    chunkShape: [cc, 4, 4],
    dtype: 'uint8',
  })
  const data = Uint8Array.from(
    { length: 3 * N * N },
    (_, i) => 50 * Math.floor(i / (N * N)) + Math.floor((i % (N * N)) / N),
  )
  await zarr.set(arr, null, {
    data,
    shape: [3, N, N],
    stride: [N * N, N, 1],
  } as zarr.Chunk<zarr.DataType>)
  // A coarser level of 3 x 4 x 4 in chunks of coarseCc along c.
  if (coarseCc !== undefined)
    await zarr.create(root.resolve('1'), {
      shape: [3, 4, 4],
      chunkShape: [coarseCc, 4, 4],
      dtype: 'uint8',
    })
  return store
}

const hits: string[] = []
const variantHits: string[] = []
const variantHeads: string[] = []
const rgbStores = new Map<string, Map<string, Uint8Array>>()
const aborted: string[] = []
let hold: Promise<void> | null = null
let server: ReturnType<typeof Bun.serve>
let url = ''

beforeAll(async () => {
  const store = await makeStore()
  for (const cc of [1, 3]) rgbStores.set(`rgb${cc}`, await makeRgbStore(cc))
  rgbStores.set('mixed', await makeRgbStore(1, 3))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname
      // The zarr-python fixtures, for the slide tests.
      if (pathname.startsWith('/variants/')) {
        variantHits.push(pathname)
        if (req.method === 'HEAD') variantHeads.push(pathname)
        const file = Bun.file(VARIANTS + pathname.slice('/variants'.length))
        if (!(await file.exists())) return new Response(null, { status: 404 })
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range') ?? '')
        if (!m) return new Response(file)
        const body = await file.slice(Number(m[1]), Number(m[2]) + 1).bytes()
        return new Response(body, { status: 206 })
      }
      const rgb = /^\/(rgb\d|mixed)\.zarr(\/.*)$/.exec(pathname)
      if (rgb) {
        variantHits.push(pathname)
        const body = rgbStores.get(rgb[1])?.get(rgb[2])
        return body
          ? new Response(body as Uint8Array<ArrayBuffer>)
          : new Response(null, { status: 404 })
      }
      const path = pathname.slice('/s.zarr'.length)
      hits.push(path)
      req.signal.addEventListener('abort', () => aborted.push(path))
      if (hold && path.includes('/c/')) await hold
      const body = store.get(path)
      return body
        ? new Response(body as Uint8Array<ArrayBuffer>)
        : new Response(null, { status: 404 })
    },
  })
  url = `http://127.0.0.1:${server.port}/s.zarr`
})
afterAll(() => server.stop(true))

const META = /(zarr\.json|\.zarray|\.zattrs|\.zgroup)$/
const metaHits = () => hits.filter((p) => META.test(p)).length
const chunkHits = () => hits.filter((p) => p.includes('/c/')).length
const workerEntry = () =>
  new Worker(new URL('./omeZarrChunk.worker.ts', import.meta.url).href)
const req = (x: number, y: number, frame?: number, signal?: AbortSignal) => ({
  levelIndex: 0,
  texOrigin: [x, y, 0] as [number, number, number],
  texDims: [4, 4, 1] as [number, number, number],
  bytesPerVoxel: 1,
  ...(frame === undefined ? {} : { frame }),
  ...(signal ? { signal } : {}),
})
const poolOptions = {
  size: 2,
  cacheBytesPerWorker: 1 << 20,
  persistPerWorker: false as const,
}

async function openPool(seed: boolean) {
  const metadata = new Map<string, Uint8Array | undefined>()
  const local = await openOmeZarrChunkedSource(url, {}, metadata)
  const pool = new OmeZarrChunkWorkerPool(
    url,
    {},
    poolOptions,
    seed ? metadata : undefined,
    workerEntry,
  )
  return { local, pool }
}

describe('OmeZarrChunkWorkerPool', () => {
  test('W3: workers open from the main thread metadata, with no request of their own', async () => {
    for (const seed of [true, false]) {
      hits.length = 0
      const { local, pool } = await openPool(seed)
      const opened = metaHits()
      expect(opened).toBeGreaterThan(0)
      const reads = [0, 1].flatMap((t) =>
        [0, 4].flatMap((x) => [0, 4].map((y) => req(x, y, t))),
      )
      const used = new Set(
        reads.map((r) => routeChunkToWorker(chunkRegionKey(r), 2)),
      )
      expect(used.size).toBe(2)
      await Promise.all(reads.map((r) => pool.fetchChunk(r)))
      expect(metaHits() - opened).toBe(seed ? 0 : used.size * opened)
      pool.dispose()
      local.dispose?.()
    }
  })

  test('W4: frames 0 and 1 of one region read twice; a repeat reads nothing', async () => {
    const { local, pool } = await openPool(true)
    let wire = 0
    pool.onWireBytes = (n) => {
      wire += n
    }
    hits.length = 0
    const t0 = await pool.fetchChunk(req(0, 4, 0))
    const t1 = await pool.fetchChunk(req(0, 4, 1))
    expect(chunkHits()).toBe(2)
    expect(t0[0]).toBe(4)
    expect(t1[0]).toBe(104)
    expect((await pool.fetchChunk(req(0, 4, 1)))[0]).toBe(104)
    expect(chunkHits()).toBe(2)
    // Two uncompressed 4 x 4 uint8 chunks crossed the wire.
    expect(wire).toBe(32)
    // The main-thread source reads frames too.
    expect(local.frames).toBe(T)
    expect((await local.fetchChunk(req(4, 0, 1)))[0]).toBe(100)
    pool.dispose()
    local.dispose?.()
  })

  test('W2: a cancel aborts the worker read on the wire', async () => {
    const { local, pool } = await openPool(true)
    let release = (): void => {}
    hold = new Promise((r) => {
      release = r
    })
    hits.length = 0
    aborted.length = 0
    const ac = new AbortController()
    const read = pool.fetchChunk(req(4, 4, 0, ac.signal))
    while (chunkHits() === 0) await Bun.sleep(2)
    ac.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    while (aborted.length === 0) await Bun.sleep(2)
    expect(aborted[0]).toContain('/c/')
    release()
    hold = null
    pool.dispose()
    local.dispose?.()
  })

  test('W5: dispose rejects pending and later reads with AbortError', async () => {
    const { local, pool } = await openPool(true)
    let release = (): void => {}
    hold = new Promise((r) => {
      release = r
    })
    hits.length = 0
    const pending = pool.fetchChunk(req(0, 0, 1))
    while (chunkHits() === 0) await Bun.sleep(2)
    pool.dispose()
    pool.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pool.fetchChunk(req(0, 0))).rejects.toMatchObject({
      name: 'AbortError',
    })
    release()
    hold = null
    // The local source too: its reads reject once disposed.
    local.dispose?.()
    await expect(local.fetchChunk(req(0, 0))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('a read that cannot succeed comes back marked final', async () => {
    const { local, pool } = await openPool(true)
    await expect(
      pool.fetchChunk({ ...req(0, 0), levelIndex: 5 }),
    ).rejects.toMatchObject({ name: OME_ZARR_CHUNK_ERROR })
    pool.dispose()
    local.dispose?.()
  })

  test('slide tiles read on the pool match this thread, channel by channel and for a c-spanning chunk', async () => {
    const { ZarrSlideSource } = await import('./zarrSlideSource')
    for (const name of ['v3-c-spanning', 'v2-zlib-dot-bigendian']) {
      const url = `http://127.0.0.1:${server.port}/variants/${name}.ome.zarr`
      const plain = await ZarrSlideSource.fromUrl(url, { workers: 0 })
      const pooled = await ZarrSlideSource.fromUrl(url, { workers: 0 })
      const pool = new OmeZarrChunkWorkerPool(
        url,
        {},
        poolOptions,
        undefined,
        workerEntry,
      )
      ;(pooled as unknown as { pool: typeof pool }).pool = pool
      const level = plain.manifest.levels[0]
      for (const channels of [[1], [1, 0]])
        for (const tile of [
          level.tiles[0],
          level.tiles[level.tiles.length - 1],
        ]) {
          if (!tile) continue
          const a = await plain.fetchTileSamples?.(level, tile, channels)
          const b = await pooled.fetchTileSamples?.(level, tile, channels)
          expect(Array.from(b?.samples ?? [])).toEqual(
            Array.from(a?.samples ?? []),
          )
        }
      // Still pooled: no worker failure sent it back to this thread.
      expect((pooled as unknown as { pool: unknown }).pool).toBe(pool)
      pooled.dispose()
      plain.dispose()
    }
  })

  test('reads of one shard on two workers probe it once', async () => {
    const url = `http://127.0.0.1:${server.port}/variants/v3-shard-64.ome.zarr`
    const metadata = new Map<string, Uint8Array | undefined>()
    const local = await openOmeZarrChunkedSource(url, {}, metadata)
    const shards = shardExtents(local.zarr, metadata)
    // 64 x 64 shards of 32 x 32 chunks: these four tiles share shard 0/0/0.
    const reads = [0, 32].flatMap((x) =>
      [0, 32].map((y) => ({
        levelIndex: 0,
        texOrigin: [x, y, 0] as [number, number, number],
        texDims: [32, 32, 1] as [number, number, number],
        bytesPerVoxel: 2,
        channel: 0,
      })),
    )
    // By region alone they would spread over both workers.
    expect(
      new Set(reads.map((r) => routeChunkToWorker(chunkRegionKey(r), 2))).size,
    ).toBe(2)
    const pool = new OmeZarrChunkWorkerPool(
      url,
      {},
      { ...poolOptions, shards },
      metadata,
      workerEntry,
    )
    variantHeads.length = 0
    variantHits.length = 0
    await Promise.all(reads.map((r) => pool.fetchChunk(r)))
    expect(variantHeads).toEqual(['/variants/v3-shard-64.ome.zarr/0/c/0/0/0'])
    pool.dispose()
    local.dispose?.()
  })

  test('the pool reads each chunk once: c-spanning and RGB c-chunk 3 stay on this thread, RGB c-chunk 1 goes to the workers', async () => {
    const { ZarrSlideSource } = await import('./zarrSlideSource')
    const chunkReads = async (url: string, pooledRead: boolean) => {
      const source = await ZarrSlideSource.fromUrl(url, {
        workers: 0,
        cacheBytes: 0,
      })
      const pool = new OmeZarrChunkWorkerPool(
        url,
        {},
        { ...poolOptions, cacheBytesPerWorker: 0 },
        undefined,
        workerEntry,
      )
      if (pooledRead) (source as unknown as { pool: typeof pool }).pool = pool
      const level = source.manifest.levels[0]
      const tile = level.tiles[0]
      if (!tile) throw new Error('no tile')
      variantHits.length = 0
      const out = source.manifest.channelInfo
        ? await source.fetchTileSamples?.(level, tile, [1, 0])
        : { samples: await source.fetchTileBytes(level, tile, 'x') }
      const keys = variantHits.filter((k) => k.includes('/c/'))
      const kept = (source as unknown as { pool: unknown }).pool === pool
      source.dispose()
      pool.dispose()
      return {
        keys: keys.sort(),
        samples: Array.from(out?.samples ?? []),
        kept,
      }
    }
    const base = `http://127.0.0.1:${server.port}`
    for (const url of [
      `${base}/variants/v3-c-spanning.ome.zarr`,
      `${base}/rgb3.zarr`,
      `${base}/rgb1.zarr`,
    ]) {
      const plain = await chunkReads(url, false)
      const pooled = await chunkReads(url, true)
      expect(pooled.samples).toEqual(plain.samples)
      expect(pooled.keys).toEqual(plain.keys)
      expect(new Set(pooled.keys).size).toBe(pooled.keys.length)
    }
    // RGB tile 0: R row 0 = 0, G = 50, B = 100.
    const rgb = await chunkReads(`${base}/rgb1.zarr`, true)
    expect(rgb.samples.slice(0, 4)).toEqual([0, 50, 100, 255])
    expect(rgb.kept).toBe(true)
  })

  test('a worker failure sends every in-flight tile back to this thread', async () => {
    const { ZarrSlideSource } = await import('./zarrSlideSource')
    const url = `http://127.0.0.1:${server.port}/variants/v2-zlib-dot-bigendian.ome.zarr`
    const plain = await ZarrSlideSource.fromUrl(url, { workers: 0 })
    const pooled = await ZarrSlideSource.fromUrl(url, { workers: 0 })
    // Workers that crash on their first message.
    const crash = URL.createObjectURL(
      new Blob(['self.onmessage = () => { throw new Error("boom") }']),
    )
    const pool = new OmeZarrChunkWorkerPool(
      url,
      {},
      poolOptions,
      undefined,
      () => new Worker(crash),
    )
    ;(pooled as unknown as { pool: typeof pool | null }).pool = pool
    const warn = console.warn
    console.warn = () => {}
    try {
      const level = plain.manifest.levels[0]
      const tiles = level.tiles.filter((t) => t !== null).slice(0, 6)
      const got = await Promise.all(
        tiles.map((t) => pooled.fetchTileSamples?.(level, t, [0, 1])),
      )
      for (const [i, t] of tiles.entries()) {
        const want = await plain.fetchTileSamples?.(level, t, [0, 1])
        expect(Array.from(got[i]?.samples ?? [])).toEqual(
          Array.from(want?.samples ?? []),
        )
      }
      expect((pooled as unknown as { pool: unknown }).pool).toBeNull()
    } finally {
      console.warn = warn
      pooled.dispose()
      plain.dispose()
    }
  })

  test('workers open the persist tier when the pool asks for one (counting wire bytes does not decline it)', async () => {
    const { local, pool } = await (async () => {
      const metadata = new Map<string, Uint8Array | undefined>()
      const local = await openOmeZarrChunkedSource(url, {}, metadata)
      const pool = new OmeZarrChunkWorkerPool(
        url,
        {},
        { ...poolOptions, persistPerWorker: { maxBytes: 1 << 20 } },
        metadata,
        () =>
          new Worker(
            new URL('./omeZarrChunkPersist.testWorker.ts', import.meta.url)
              .href,
          ),
      )
      return { local, pool }
    })()
    let wire = 0
    pool.onWireBytes = (n) => {
      wire += n
    }
    await pool.fetchChunk(req(4, 0, 1))
    const stats = pool.persistStats()
    expect(stats.writes).toBeGreaterThan(0)
    expect(wire).toBe(16)
    pool.dispose()
    local.dispose?.()
  })

  test('cumulative wire bytes arriving out of order count once', () => {
    const pool = new OmeZarrChunkWorkerPool(
      url,
      {},
      poolOptions,
      undefined,
      workerEntry,
    )
    let wire = 0
    pool.onWireBytes = (n) => {
      wire += n
    }
    const merge = (
      pool as unknown as { merge(i: number, r: object): void }
    ).merge.bind(pool)
    for (const wireBytes of [200, 100, 250]) merge(0, { wireBytes })
    expect(wire).toBe(250)
    pool.dispose()
  })

  test('an unbounded budget stays unbounded for the workers', async () => {
    const { ZarrSlideSource } = await import('./zarrSlideSource')
    const g = globalThis as { window?: unknown }
    g.window = globalThis
    try {
      const mixed = (await ZarrSlideSource.fromUrl(
        `http://127.0.0.1:${server.port}/mixed.zarr`,
        { workers: 3, cacheBytes: Number.POSITIVE_INFINITY },
      )) as unknown as { pool: { pool: { cacheBytesPerWorker: number } } }
      expect(mixed.pool.pool.cacheBytesPerWorker).toBe(Number.POSITIVE_INFINITY)
      ;(mixed as unknown as { dispose(): void }).dispose()
    } finally {
      g.window = undefined
    }
  })

  test('the cache budget: a share while the pool runs, all of it when there is no pool or it is dropped', async () => {
    const { ZarrSlideSource } = await import('./zarrSlideSource')
    const g = globalThis as { window?: unknown }
    g.window = globalThis // resolveChunkWorkerCount wants a document
    const warn = console.warn
    console.warn = () => {}
    type Inner = { pool: unknown; cache: { maxBytes: number } }
    try {
      const base = `http://127.0.0.1:${server.port}`
      const open = (path: string) =>
        ZarrSlideSource.fromUrl(`${base}${path}`, {
          workers: 3,
          cacheBytes: 4000,
        })
      // Level 0 sliced along c, level 1 spanning it: a pool, and this thread
      // keeps half (the share of the levels it reads), the workers a third
      // each of the rest.
      const mixed = (await open('/mixed.zarr')) as unknown as Inner & {
        pool: { pool: { cacheBytesPerWorker: number } }
      }
      expect(mixed.pool).not.toBeNull()
      expect(mixed.cache.maxBytes).toBe(2000)
      expect(mixed.pool.pool.cacheBytesPerWorker).toBe(666)
      // RGB chunked [3, y, x]: every level spans c, so no pool.
      const rgb3 = (await open('/rgb3.zarr')) as unknown as Inner
      expect(rgb3.pool).toBeNull()
      expect(rgb3.cache.maxBytes).toBe(4000)
      // c-chunk 1: a pool, and this thread keeps one share of four.
      const rgb1 = await open('/rgb1.zarr')
      const inner = rgb1 as unknown as Inner
      expect(inner.pool).not.toBeNull()
      expect(inner.cache.maxBytes).toBe(1000)
      // The mocked worker entry cannot run: the read falls back and this
      // thread gets the whole budget back.
      const level = rgb1.manifest.levels[0]
      const tile = level.tiles[0]
      if (!tile) throw new Error('no tile')
      expect((await rgb1.fetchTileBytes(level, tile, 'x'))[1]).toBe(50)
      expect(inner.pool).toBeNull()
      expect(inner.cache.maxBytes).toBe(4000)
      rgb1.dispose()
    } finally {
      g.window = undefined
      console.warn = warn
    }
  })
})
