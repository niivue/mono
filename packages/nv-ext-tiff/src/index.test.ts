import { describe, expect, test } from 'bun:test'
import type {
  NVSlideRangeEvent,
  NVSlideRangeStatus,
  SlideSourceHost,
} from '@niivue/niivue'
import { fromArrayBuffer } from 'geotiff'
import { TiffSlideSource } from './index'

// 64x64 baseline JPEG (cjpeg -sample 1x1): left half (200,30,30), right half (30,30,200).
const JPEG_TILE = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAkHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEzJ3GAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAA/9k=',
  ),
  (c) => c.charCodeAt(0),
)

interface Level {
  width: number
  height: number
  tile: number
  compression: number // 1 none, 7 JPEG
  photometric: number // 2 RGB, 6 YCbCr
  tiles: Uint8Array[] // row-major, each a full (padded) tile
  bits?: number // per sample, default 8
  sampleFormat?: number // 1 uint (default), 2 int, 3 float
  edit?: (entries: number[][]) => void // tamper with IFD entries
}

// Deterministic RGB so an edge-tile crop can be checked pixel-exact.
const rgbAt = (level: number, x: number, y: number) => [
  (x * 7 + level * 50) & 255,
  (y * 5) & 255,
  level * 80,
]

function rawLevel(index: number, width: number, height: number, tile: number) {
  const tiles: Uint8Array[] = []
  for (let ty = 0; ty < Math.ceil(height / tile); ty++) {
    for (let tx = 0; tx < Math.ceil(width / tile); tx++) {
      const t = new Uint8Array(tile * tile * 3)
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          t.set(rgbAt(index, tx * tile + x, ty * tile + y), (y * tile + x) * 3)
        }
      }
      tiles.push(t)
    }
  }
  return { width, height, tile, compression: 1, photometric: 2, tiles }
}

// Minimal little-endian classic TIFF writer: one tiled IFD per level, chained,
// or (subIfds) level 0 in the main chain with the rest under its SubIFDs tag.
function writeTiff(levels: Level[], subIfds = false): ArrayBuffer {
  const out: number[] = [0x49, 0x49, 42, 0, 0, 0, 0, 0]
  const u16 = (p: number, v: number) => {
    out[p] = v & 255
    out[p + 1] = (v >> 8) & 255
  }
  const u32 = (p: number, v: number) => {
    for (let i = 0; i < 4; i++) out[p + i] = (v >>> (8 * i)) & 255
  }
  const append = (bytes: ArrayLike<number>) => {
    const at = out.length
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i] ?? 0)
    if (out.length % 2) out.push(0)
    return at
  }
  const longs = (values: number[]) => {
    const at = append(new Uint8Array(values.length * 4))
    values.forEach((v, i) => {
      u32(at + i * 4, v)
    })
    return at
  }
  const ifdOffsets: number[] = []
  const nextFields: number[] = []
  const subIfdFields: number[] = []
  for (const [i, lv] of levels.entries()) {
    const offsets = lv.tiles.map(append)
    const b = lv.bits ?? 8
    const bps = append([b, 0, b, 0, b, 0])
    const n = lv.tiles.length
    const tileOffsets = n > 1 ? longs(offsets) : (offsets[0] ?? 0)
    const tileCounts =
      n > 1 ? longs(lv.tiles.map((t) => t.length)) : (lv.tiles[0]?.length ?? 0)
    // [tag, type (3 SHORT, 4 LONG), count, value-or-offset]
    const entries: number[][] = [
      [256, 4, 1, lv.width],
      [257, 4, 1, lv.height],
      [258, 3, 3, bps],
      [259, 3, 1, lv.compression],
      [262, 3, 1, lv.photometric],
      [277, 3, 1, 3],
      [284, 3, 1, 1],
      [322, 3, 1, lv.tile],
      [323, 3, 1, lv.tile],
      [324, 4, n, tileOffsets],
      [325, 4, n, tileCounts],
    ]
    if (lv.sampleFormat) {
      const f = lv.sampleFormat
      entries.push([339, 3, 3, append([f, 0, f, 0, f, 0])])
    }
    lv.edit?.(entries)
    if (subIfds && i === 0) entries.push([330, 4, levels.length - 1, 0])
    const at = append(new Uint8Array(2 + entries.length * 12 + 4))
    u16(at, entries.length)
    entries.forEach(([tag = 0, type = 0, count = 0, value = 0], e) => {
      const p = at + 2 + e * 12
      u16(p, tag)
      u16(p + 2, type)
      u32(p + 4, count)
      if (type === 3 && count === 1) u16(p + 8, value)
      else u32(p + 8, value)
      if (tag === 330) subIfdFields.push(p + 8)
    })
    ifdOffsets.push(at)
    nextFields.push(at + 2 + entries.length * 12)
  }
  u32(4, ifdOffsets[0] ?? 0)
  if (subIfds) {
    const subField = subIfdFields[0] ?? 0
    const subs = ifdOffsets.slice(1)
    u32(subField, subs.length === 1 ? (subs[0] ?? 0) : longs(subs))
  } else {
    for (let i = 0; i + 1 < levels.length; i++) {
      u32(nextFields[i] ?? 0, ifdOffsets[i + 1] ?? 0)
    }
  }
  return new Uint8Array(out).buffer
}

// A Range-only server over an in-memory file that records every request.
// hold: requests never answer, they reject when their signal aborts.
function rangeServer(
  file: ArrayBuffer,
  { honourRange = true, contentRange = 'ok' as 'ok' | 'none' | 'wrong' } = {},
) {
  const server = {
    requests: [] as Array<[number, number]>,
    hold: false,
    onRequest: () => {},
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const range = new Headers(init?.headers).get('Range') ?? ''
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      if (!honourRange || !m) return new Response(file, { status: 200 })
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), file.byteLength - 1)
      server.requests.push([start, end])
      server.onRequest()
      if (server.hold) {
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
      }
      const sent = contentRange === 'wrong' ? start + 1 : start
      const headers: Record<string, string> =
        contentRange === 'none'
          ? {}
          : { 'Content-Range': `bytes ${sent}-${end}/${file.byteLength}` }
      return new Response(file.slice(start, end + 1), { status: 206, headers })
    }) as typeof fetch,
  }
  return server
}

function fakeHost() {
  const events = new Map<string, NVSlideRangeStatus>()
  const host: SlideSourceHost & { wire: number; hits: number } = {
    wire: 0,
    hits: 0,
    resolveUrl: (url) => url,
    addWireBytes(n) {
      host.wire += n
    },
    rangeHit() {
      host.hits++
    },
    rangeFallback() {},
    pushRangeEvent(e: NVSlideRangeEvent) {
      events.set(e.label, e.status)
    },
    updateRangeEvent(label, status) {
      events.set(label, status)
    },
  }
  return { host, events }
}

const pixel = (rgba: Uint8Array, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

// Level 0 is ~3 MB (8x6 tiles of 128 px, 48 KiB each): far above geotiff's
// 64 KiB block, so a bounded tile read is distinguishable from a full download.
const PYRAMID = [
  rawLevel(0, 1000, 700, 128),
  rawLevel(1, 500, 350, 128),
  rawLevel(2, 250, 175, 128),
]

async function open(
  file: ArrayBuffer,
  url = 'http://test/slide.tif',
  serverOptions: Parameters<typeof rangeServer>[1] = {},
) {
  const server = rangeServer(file, serverOptions)
  const source = await TiffSlideSource.fromUrl(url, {
    fetch: server.fetchImpl,
  })
  const { host, events } = fakeHost()
  source.bind(host)
  return { source, server, host, events }
}

describe('TiffSlideSource', () => {
  test('builds the pyramid manifest with partial edge tiles', async () => {
    const { source } = await open(writeTiff(PYRAMID))
    const m = source.manifest
    expect(m.id).toBe('slide.tif')
    expect([m.width, m.height]).toEqual([1000, 700])
    expect(m.levels.map((l) => [l.columns, l.rows, l.downsample])).toEqual([
      [8, 6, 1],
      [4, 3, 2],
      [2, 2, 4],
    ])
    const l0 = m.levels[0]
    expect(l0?.tiles.at(-1)).toEqual({ x: 7, y: 5, width: 104, height: 60 })
  })

  test('reads OME-style SubIFD pyramids', async () => {
    const { source } = await open(writeTiff(PYRAMID, true))
    expect(source.manifest.levels.map((l) => l.width)).toEqual([1000, 500, 250])
  })

  test('decodes the default id from the URL', async () => {
    const { source } = await open(
      writeTiff([rawLevel(0, 250, 175, 128)]),
      'http://test/my%20slide.svs?token=1',
    )
    expect(source.manifest.id).toBe('my slide.svs')
  })

  test('sorts levels and skips a tiled image off the base aspect', async () => {
    // SVS keeps a tiled macro (here 640x100) between the pyramid levels.
    const [l0, l1, l2] = PYRAMID as [Level, Level, Level]
    const macro = rawLevel(3, 640, 100, 128)
    for (const subIfds of [false, true]) {
      const { source } = await open(writeTiff([l0, l2, macro, l1], subIfds))
      expect(source.manifest.levels.map((l) => l.width)).toEqual([
        1000, 500, 250,
      ])
    }
  })

  test('crops the bottom-right edge tile pixel-exact', async () => {
    const { source, events } = await open(writeTiff(PYRAMID))
    const level = source.manifest.levels[1]
    const tile = level?.tiles.at(-1)
    if (!level || !tile) throw new Error('missing tile')
    expect([tile.width, tile.height]).toEqual([116, 94])
    const rgba = await source.fetchTileBytes(level, tile, 'edge')
    expect(rgba.length).toBe(116 * 94 * 4)
    expect(pixel(rgba, 116, 115, 93)).toEqual([...rgbAt(1, 499, 349), 255])
    expect(pixel(rgba, 116, 0, 0)).toEqual([...rgbAt(1, 384, 256), 255])
    expect(events.get('edge')).toBe('hit')
  })

  test('one tile reads a bounded byte range, not the file', async () => {
    const file = writeTiff(PYRAMID)
    const { source, server, host } = await open(file)
    const headerBytes = server.requests.reduce((s, [a, b]) => s + b - a + 1, 0)
    // IFDs sit after each level's tiles: one block per IFD plus the header.
    expect(headerBytes).toBeLessThanOrEqual((PYRAMID.length + 1) * 65536)
    // Bytes read while opening (before bind) are reported on bind.
    expect(host.wire).toBe(headerBytes)
    const before = server.requests.length
    const level = source.manifest.levels[0]
    const tile = level?.tiles[9]
    if (!level || !tile) throw new Error('missing tile')
    await source.fetchTileBytes(level, tile, 't')
    const tileReqs = server.requests.slice(before)
    expect(tileReqs.length).toBeGreaterThan(0)
    const tileBytes = tileReqs.reduce((s, [a, b]) => s + b - a + 1, 0)
    // 48 KiB of tile data, rounded out to at most two 64 KiB blocks, plus the
    // block holding its TileOffsets/TileByteCounts entries.
    expect(tileBytes).toBeLessThanOrEqual(3 * 65536)
    expect(tileBytes).toBeLessThan(file.byteLength / 10)
    expect(host.wire).toBe(headerBytes + tileBytes)
    expect(host.hits).toBe(server.requests.length)
  })

  test('honours an abort signal and dispose', async () => {
    const { source, server, events } = await open(writeTiff(PYRAMID))
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    const before = server.requests.length
    const aborted = AbortSignal.abort()
    await expect(
      source.fetchTileBytes(level, tile, 'a', aborted),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.get('a')).toBe('aborted')
    expect(server.requests.length).toBe(before)
    // Abort mid-request: tile 9 is outside the cached header blocks, and the
    // server holds the request until its signal fires.
    const uncached = level.tiles[9]
    if (!uncached) throw new Error('missing tile')
    server.hold = true
    const requested = new Promise<void>((resolve) => {
      server.onRequest = resolve
    })
    const controller = new AbortController()
    const inflight = source.fetchTileBytes(
      level,
      uncached,
      'c',
      controller.signal,
    )
    await requested
    expect(server.requests.length).toBeGreaterThan(before)
    controller.abort()
    await expect(inflight).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.get('c')).toBe('aborted')
    source.dispose()
    const atDispose = server.requests.length
    await expect(source.fetchTileBytes(level, tile, 'b')).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    expect(server.requests.length).toBe(atDispose)
  })

  test('dispose twice closes the file once', async () => {
    const tiff = await fromArrayBuffer(writeTiff(PYRAMID))
    let closes = 0
    // A file source rejects (EBADF) when closed twice.
    tiff.close = async () => {
      closes++
      throw new Error('EBADF')
    }
    const source = await TiffSlideSource.fromGeoTIFF(tiff)
    source.dispose()
    source.dispose()
    await Bun.sleep(0)
    expect(closes).toBe(1)
  })

  test('fromUrl honours an abort signal', async () => {
    const server = rangeServer(writeTiff(PYRAMID))
    await expect(
      TiffSlideSource.fromUrl('http://test/slide.tif', {
        fetch: server.fetchImpl,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('fromUrl aborts a stalled directory read after the header', async () => {
    const server = rangeServer(writeTiff(PYRAMID))
    let second: () => void = () => {}
    const stalled = new Promise<void>((resolve) => {
      second = resolve
    })
    // The header block answers; the next metadata read stalls until aborted.
    server.onRequest = () => {
      if (server.requests.length < 2) return
      server.hold = true
      second()
    }
    const ctrl = new AbortController()
    const opening = TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: server.fetchImpl,
      signal: ctrl.signal,
    })
    await stalled
    ctrl.abort()
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.requests.length).toBeGreaterThan(1)
  })

  test('decodes YCbCr JPEG tiles (a codec core NiiVue lacks)', async () => {
    const jpegLevel: Level = {
      width: 100,
      height: 70,
      tile: 64,
      compression: 7,
      photometric: 6,
      tiles: [JPEG_TILE, JPEG_TILE, JPEG_TILE, JPEG_TILE],
    }
    const { source } = await open(writeTiff([jpegLevel]))
    const level = source.manifest.levels[0]
    if (!level) throw new Error('missing level')
    const [t0, , , t3] = level.tiles
    if (!t0 || !t3) throw new Error('missing tile')
    const full = await source.fetchTileBytes(level, t0, 'j0')
    const near = (got: number[], want: number[]) =>
      got.every((v, i) => Math.abs(v - (want[i] ?? 0)) <= 8)
    expect(near(pixel(full, 64, 8, 8), [200, 30, 30, 255])).toBe(true)
    expect(near(pixel(full, 64, 56, 56), [30, 30, 200, 255])).toBe(true)
    const edge = await source.fetchTileBytes(level, t3, 'j3')
    expect(edge.length).toBe(36 * 6 * 4)
    expect(near(pixel(edge, 36, 2, 2), [200, 30, 30, 255])).toBe(true)
  })

  const openRejects = (lv: Level, error: RegExp) =>
    expect(open(writeTiff([lv]))).rejects.toThrow(error)
  const setTag = (tag: number, value: number) => (entries: number[][]) => {
    for (const e of entries) if (e[0] === tag) e[3] = value
  }

  test('rejects a zero tile width instead of looping forever', async () => {
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), edit: setTag(322, 0) },
      /tile 0x128 is not a multiple of 16/,
    )
  })

  test('rejects tiles that are not a multiple of 16', async () => {
    await openRejects(rawLevel(0, 250, 175, 24), /tile 24x24 is not a multiple/)
  })

  test('caps tiles across levels, not just per level', async () => {
    // Three 16 px-tile levels of ~1M tiles each (tile data omitted).
    const tiny = (side: number): Level => ({
      ...rawLevel(0, 16, 16, 16),
      tiles: [],
      edit: (entries) => {
        setTag(256, side)(entries)
        setTag(257, side)(entries)
      },
    })
    const file = writeTiff([tiny(16384), tiny(16368), tiny(16352)])
    await expect(open(file)).rejects.toThrow(/more than 2097152 tiles/)
  })

  test('rejects a level with too many tiles', async () => {
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), edit: setTag(256, 2 ** 32 - 1) },
      /more than 2097152 tiles/,
    )
  })

  test('rejects non-unsigned samples and WhiteIsZero', async () => {
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), sampleFormat: 3 },
      /SampleFormat 3 is not supported/,
    )
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), edit: setTag(262, 0) },
      /WhiteIsZero is not supported/,
    )
  })

  test('checks Content-Range when the server exposes it', async () => {
    const file = writeTiff(PYRAMID)
    await expect(
      open(file, undefined, { contentRange: 'wrong' }),
    ).rejects.toThrow(/Content-Range starting at 1, requested 0/)
    // Cross-origin without Access-Control-Expose-Headers: no header, still works.
    const { source } = await open(file, undefined, { contentRange: 'none' })
    const level = source.manifest.levels[1]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    expect((await source.fetchTileBytes(level, tile, 'n')).length).toBe(
      tile.width * tile.height * 4,
    )
  })

  test('rejects 16-bit RGB', async () => {
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), bits: 16 },
      /16-bit RGB is not supported/,
    )
  })

  test('stops at a self-referencing IFD chain', async () => {
    const file = writeTiff([rawLevel(0, 250, 175, 128)])
    const view = new DataView(file)
    const ifd = view.getUint32(4, true)
    view.setUint32(ifd + 2 + view.getUint16(ifd, true) * 12, ifd, true)
    const { source } = await open(file)
    expect(source.manifest.levels.map((l) => l.width)).toEqual([250])
  })

  test('skips stripped SubIFD images', async () => {
    // Retag the last level's tile tags as strip tags.
    const stripped = {
      ...rawLevel(2, 250, 175, 128),
      edit: (entries: number[][]) => {
        for (const e of entries) {
          if (e[0] === 324) e[0] = 273
          if (e[0] === 325) e[0] = 279
        }
      },
    }
    const file = writeTiff([PYRAMID[0], PYRAMID[1], stripped] as Level[], true)
    const { source } = await open(file)
    expect(source.manifest.levels.map((l) => l.width)).toEqual([1000, 500])
  })

  test('keeps the HTTP status of a failed request', async () => {
    const fetchImpl = (async () =>
      new Response('no', { status: 404 })) as unknown as typeof fetch
    await expect(
      TiffSlideSource.fromUrl('http://test/slide.tif', { fetch: fetchImpl }),
    ).rejects.toThrow('http://test/slide.tif: HTTP 404')
  })

  test('refuses a server that ignores Range instead of downloading it whole', async () => {
    const file = writeTiff(PYRAMID)
    const server = rangeServer(file, { honourRange: false })
    await expect(
      TiffSlideSource.fromUrl('http://test/slide.tif', {
        fetch: server.fetchImpl,
      }),
    ).rejects.toThrow(/ignored the HTTP Range request/)
  })
})
