import { describe, expect, test } from 'bun:test'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideRangeStatus,
  NVSlideTileManifest,
} from './NVSlide'
import {
  decodeTileBitmap,
  ManifestRangeSource,
  type SlideFetch,
  type SlideSourceHost,
  tileDecoders,
} from './slideSource'

const LEN = 16

const NO_HOST: SlideSourceHost = {
  resolveUrl: (u) => u,
  addWireBytes() {},
  rangeHit() {},
  rangeFallback() {},
  pushRangeEvent() {},
  updateRangeEvent() {},
  channelInfoChanged() {},
}

function manifest(): NVSlideManifest {
  return {
    id: 'm',
    width: 4,
    height: 4,
    levels: [
      {
        index: 0,
        width: 4,
        height: 4,
        tileWidth: 4,
        tileHeight: 4,
        columns: 1,
        rows: 1,
        codec: 'raw-rgba',
        fileUrl: 'tiles.bin',
        tiles: [{ x: 0, y: 0, width: 4, height: 4, offset: 100, length: LEN }],
      },
    ],
  } as NVSlideManifest
}

interface Call {
  url: string
  init?: RequestInit
}

function source(replies: (() => Response)[], baseUrl = 'https://h.test/s/') {
  const calls: Call[] = []
  const events: [string, NVSlideRangeStatus][] = []
  const counts = { wire: 0, hits: 0, fallbacks: 0 }
  const fetch: SlideFetch = async (url, init) => {
    calls.push({ url, init })
    init?.signal?.throwIfAborted()
    const reply = replies[calls.length - 1]
    if (!reply) throw new Error('unexpected fetch')
    return reply()
  }
  const s = new ManifestRangeSource(manifest(), { fetch, baseUrl })
  s.bind({
    resolveUrl: () => {
      throw new Error('baseUrl wins')
    },
    addWireBytes: (n) => {
      counts.wire += n
    },
    rangeHit: () => counts.hits++,
    rangeFallback: () => counts.fallbacks++,
    pushRangeEvent: (e) => events.push([e.label, e.status]),
    updateRangeEvent: (label, status) => events.push([label, status]),
    channelInfoChanged() {},
  })
  const level = s.manifest.levels[0] as NVSlideLevelManifest
  const read = (signal?: AbortSignal) =>
    s.fetchTileBytes(level, level.tiles[0] as never, 'L0', signal)
  return { s, calls, events, counts, read }
}

const ranged =
  (n: number, start = 100) =>
  () =>
    new Response(new Uint8Array(n).fill(7), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${start + n - 1}/4096` },
    })

describe('ManifestRangeSource transport', () => {
  test('a custom fetch and baseUrl serve every read', async () => {
    const { calls, read, counts } = source([ranged(LEN)])
    expect((await read()).byteLength).toBe(LEN)
    expect(calls[0]?.url).toBe('https://h.test/s/tiles.bin')
    expect(new Headers(calls[0]?.init?.headers).get('Range')).toBe(
      'bytes=100-115',
    )
    expect(calls[0]?.init?.cache).toBeUndefined()
    expect(counts).toEqual({ wire: LEN, hits: 1, fallbacks: 0 })
  })

  test.each([
    'https://h.test/s/',
    undefined, // the host's manifest URL sets the origin
  ])("a file on another origin than baseUrl (%p) is read without the caller's fetch or credentials", async (baseUrl) => {
    const m = manifest()
    const l0 = m.levels[0] as NVSlideLevelManifest
    l0.fileUrl = 'https://cdn.other/tiles.bin'
    const custom: string[] = []
    const s = new ManifestRangeSource(m, {
      fetch: async (url) => {
        custom.push(url)
        return ranged(LEN)()
      },
      baseUrl,
    })
    s.bind({
      ...NO_HOST,
      resolveUrl: (u) => new URL(u, 'https://h.test/s/m.json').href,
    })
    const plain: (RequestInit | undefined)[] = []
    const saved = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      plain.push(init)
      return ranged(LEN)()
    }) as typeof globalThis.fetch
    try {
      await s.fetchTileBytes(l0, l0.tiles[0] as never, 'L0')
      expect(custom).toEqual([])
      expect(plain.map((i) => i?.credentials)).toEqual(['omit'])
      l0.fileUrl = 'tiles.bin' // the manifest's own origin: the caller's fetch
      await s.fetchTileBytes(l0, l0.tiles[0] as never, 'L0')
      expect(custom).toEqual(['https://h.test/s/tiles.bin'])
    } finally {
      globalThis.fetch = saved
    }
  })

  test("a file on the manifest's origin gets the caller's fetch though baseUrl is elsewhere", async () => {
    const m = manifest()
    const l0 = m.levels[0] as NVSlideLevelManifest
    const custom: string[] = []
    const s = new ManifestRangeSource(m, {
      fetch: async (url) => {
        custom.push(url)
        return ranged(LEN)()
      },
      baseUrl: 'https://cdn.test/tiles/',
      manifestUrl: 'https://auth.test/m.json',
    })
    s.bind(NO_HOST)
    for (const url of ['https://auth.test/tile.bin', 'tile.bin']) {
      l0.fileUrl = url
      await s.fetchTileBytes(l0, l0.tiles[0] as never, 'L0')
    }
    expect(custom).toEqual([
      'https://auth.test/tile.bin',
      'https://cdn.test/tiles/tile.bin',
    ])
  })

  test('a truncated cached 206 is read once more with no-store', async () => {
    const { calls, read, counts } = source([ranged(3), ranged(LEN)])
    expect((await read()).byteLength).toBe(LEN)
    expect(calls.map((c) => c.init?.cache)).toEqual([undefined, 'no-store'])
    expect(counts.hits).toBe(1)
  })

  test('a 206 that is short twice is refused (T2)', async () => {
    const { read, events } = source([ranged(3), ranged(3)])
    await expect(read()).rejects.toThrow('Expected 16 bytes, received 3')
    expect(events.at(-1)).toEqual(['L0 100-115', 'failed'])
  })

  test('a 206 at the wrong start is refused (T1)', async () => {
    const { read } = source([ranged(LEN, 0), ranged(LEN, 0)])
    await expect(read()).rejects.toThrow('Content-Range starts at 0')
  })

  test('a 206 whose Content-Range ends elsewhere is refused', async () => {
    // Right length, but the server says it sent bytes 100-114 (15 bytes).
    const short = () =>
      new Response(new Uint8Array(LEN), {
        status: 206,
        headers: { 'content-range': 'bytes 100-114/4096' },
      })
    const { read } = source([short, short])
    await expect(read()).rejects.toThrow('Content-Range ends at 114')
  })

  test('without Content-Range a correct length is accepted (T5)', async () => {
    const { read } = source([
      () => new Response(new Uint8Array(LEN), { status: 206 }),
    ])
    expect((await read()).byteLength).toBe(LEN)
  })

  test('a 206 longer than its range is refused without buffering it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1 << 20))
      },
      cancel() {
        cancelled = true
      },
    })
    const { read } = source([() => new Response(body, { status: 206 })])
    await expect(read()).rejects.toThrow('Reply over 16 bytes')
    expect(cancelled).toBe(true)
  }, 2000)

  test('a whole-file 200 under the cap is sliced (T3)', async () => {
    const file = Uint8Array.from({ length: 200 }, (_, i) => i)
    const { read, counts } = source([() => new Response(file)])
    expect(Array.from(await read())).toEqual(
      Array.from(file.subarray(100, 116)),
    )
    expect(counts.fallbacks).toBe(1)
  })

  test('a whole-file 200 over the cap throws and cancels the body (T3)', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(8 << 20))
      },
      cancel() {
        cancelled = true
      },
    })
    const { read } = source([() => new Response(body)])
    await expect(read()).rejects.toThrow('Reply over 67108864 bytes')
    expect(cancelled).toBe(true)
  })

  test('a stated Content-Length over the cap is refused unread', async () => {
    const { read } = source([
      () =>
        new Response('x', {
          headers: { 'content-length': String(65 << 20) },
        }),
    ])
    await expect(read()).rejects.toThrow('Reply over')
  })

  test('a whole file that ends before the range is refused', async () => {
    const { read } = source([() => new Response(new Uint8Array(50))])
    await expect(read()).rejects.toThrow('ends before byte 115')
  })

  test('dispose aborts a pending read and later reads (L4)', async () => {
    let release: () => void = () => {}
    const fetch: SlideFetch = (_url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        )
        release = () => resolve(ranged(LEN)())
      })
    const s = new ManifestRangeSource(manifest(), {
      fetch,
      baseUrl: 'https://h.test/',
    })
    s.bind(NO_HOST)
    const level = s.manifest.levels[0] as NVSlideLevelManifest
    const pending = s.fetchTileBytes(level, level.tiles[0] as never, 'L0')
    s.dispose()
    s.dispose()
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      s.fetchTileBytes(level, level.tiles[0] as never, 'L0'),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('after dispose an ICC read, ranged or whole, never reaches fetch', async () => {
    for (const icc of [
      { url: 'icc.icm' },
      { url: 'icc.icm', offset: 0, length: 4 },
    ]) {
      let calls = 0
      const s = new ManifestRangeSource(
        { ...manifest(), iccProfile: icc } as NVSlideManifest,
        {
          // Ignores the signal, as a custom fetch may.
          fetch: async () => {
            calls++
            return new Response(new Uint8Array(4))
          },
          baseUrl: 'https://h.test/',
        },
      )
      s.bind(NO_HOST)
      s.dispose()
      await expect(s.fetchIccProfile()).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(calls).toBe(0)
    }
  })
})

describe('dispose with a fetch that ignores its signal', () => {
  const reads = ['tile', 'icc-ranged', 'icc-whole'] as const
  // A 206 whose body never ends; `cancelled` once its stream is cancelled.
  const endless = () => {
    const state = { cancelled: false }
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          state.cancelled = true
        },
      }),
      { status: 206 },
    )
    return { state, response }
  }
  function start(read: (typeof reads)[number], fetch: SlideFetch) {
    const s = new ManifestRangeSource(
      {
        ...manifest(),
        iccProfile:
          read === 'icc-whole'
            ? { url: 'icc.icm' }
            : { url: 'icc.icm', offset: 0, length: 2 },
      } as NVSlideManifest,
      { fetch, baseUrl: 'https://h.test/' },
    )
    s.bind(NO_HOST)
    const level = s.manifest.levels[0] as NVSlideLevelManifest
    const tile = {
      ...(level.tiles?.[0] as NVSlideTileManifest),
      offset: 0,
      length: 2,
    }
    const pending =
      read === 'tile' ? s.fetchTileBytes(level, tile, 't') : s.fetchIccProfile()
    return { s, pending }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const settled = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => 'resolved',
        (e: Error) => e.name,
      ),
      new Promise((r) => setTimeout(() => r('pending'), 100)),
    ])

  test.each(
    reads,
  )('%s: a fetch that never settles rejects on dispose', async (read) => {
    const { s, pending } = start(read, () => new Promise<Response>(() => {}))
    await tick()
    s.dispose()
    expect(await settled(pending)).toBe('AbortError')
  })

  test.each(
    reads,
  )('%s: a reply after dispose is refused and its body cancelled', async (read) => {
    let release = (_: Response) => {}
    const { s, pending } = start(
      read,
      () => new Promise<Response>((r) => (release = r)),
    )
    await tick()
    s.dispose()
    const late = endless()
    release(late.response)
    expect(await settled(pending)).toBe('AbortError')
    await tick()
    expect(late.state.cancelled).toBe(true)
  })

  test.each(
    reads,
  )('%s: a body that never ends rejects on dispose, cancelled', async (read) => {
    const reply = endless()
    const { s, pending } = start(read, async () => reply.response)
    await tick()
    s.dispose()
    expect(await settled(pending)).toBe('AbortError')
    expect(reply.state.cancelled).toBe(true)
  })
})

describe('tile decoders', () => {
  const level = (o: Partial<NVSlideLevelManifest>) =>
    ({ index: 0, width: 2, height: 1, ...o }) as NVSlideLevelManifest
  const decode = tileDecoders.get('raw-gray')
  if (!decode) throw new Error('no raw-gray decoder')

  test('raw-gray copies its bytes: cached samples never share a source buffer', async () => {
    const whole = new Uint8Array(new Uint16Array([1, 2]).buffer)
    const a = await decode(whole, {
      width: 2,
      height: 1,
      level: level({ bitsStored: 16 }),
    })
    expect('samples' in a && a.samples.buffer).not.toBe(whole.buffer)
    expect('samples' in a && Array.from(a.samples)).toEqual([1, 2])
  })

  test('signed monochrome samples are sign-extended from bitsStored (S7)', async () => {
    const lvl = level({
      codec: 'raw-gray',
      bitsStored: 12,
      sampleType: 'i16',
    })
    // A 12-bit codestream decodes unsigned; 0xffb is -5.
    const prior = tileDecoders.get('image/jls')
    tileDecoders.set('image/jls', async () => ({
      samples: new Uint16Array([0xffb, 0x7ff]),
      width: 2,
      height: 1,
      bitsStored: 12,
    }))
    const out = await decodeTileBitmap(
      { ...lvl, codec: 'image/jls' },
      { x: 0, y: 0, width: 2, height: 1 },
      new Uint8Array(0),
      new AbortController().signal,
    )
    if (prior) tileDecoders.set('image/jls', prior)
    else tileDecoders.delete('image/jls')
    expect('samples' in out && out.samples).toEqual(new Int16Array([-5, 2047]))
    const u8 = await decodeTileBitmap(
      { ...lvl, codec: 'raw-gray', bitsStored: 8, sampleType: undefined },
      { x: 0, y: 0, width: 2, height: 1 },
      new Uint8Array([0xfb, 3]),
      new AbortController().signal,
    )
    expect('samples' in u8 && u8.samples).toEqual(new Uint8Array([0xfb, 3]))
  })
})
