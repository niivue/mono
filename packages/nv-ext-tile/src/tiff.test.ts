import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  fromArrayBuffer,
  fromFile,
  GeoTIFFImage,
  Pool,
} from '@niivue/geotiff-rs'
import {
  NVSlide,
  type NVSlideRangeEvent,
  type NVSlideRangeStatus,
  type SlideSourceHost,
} from '@niivue/niivue'
import { registerDcm2niixTiffDecoders, TiffSlideSource } from './tiff'
import { type TiffSpacingTags, tiffPixelSpacingMM } from './tiffSpacing'

// 64x64 baseline JPEG (cjpeg -sample 1x1): left half (200,30,30), right half (30,30,200).
const JPEG_TILE = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAkHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEzJ3GAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAA/9k=',
  ),
  (c) => c.charCodeAt(0),
)

// 16x16 lossless JPEG 2000 codestream (opj_compress -mct 1 -n 2) of RGB
// (16x, 16y, 128).
const J2K_TILE = Uint8Array.from(
  atob(
    '/0//UQAvAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBAQQEAAH/XAAHQEBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAACoAAH/k8+0vBEdtk9h32cNPQ8B9ZqouL5H/LLzUHWs3o203Lf0KBnUUnqc3N0r1y2McJOIDUd/34CoFT4y0PYK28DY3s7q1XX+bmcCFlwZ34EwJ3Vmip8cpb26jzqvWzP8l0KQdPeib1EuYd72SMu4UcNYduwH/3/AfCJA+QIANqGZvz2mNF+g+cKAPmKisD/B84SD5wo2oZnPPmKisD//2Q==',
  ),
  (c) => c.charCodeAt(0),
)

interface Level {
  width: number
  height: number
  tile: number
  compression: number // 1 none, 7 JPEG, 34712 JPEG 2000
  photometric: number // 2 RGB, 6 YCbCr
  tiles: Uint8Array[] // row-major, each a full (padded) tile
  bits?: number // per sample, default 8
  sampleFormat?: number // 1 uint (default), 2 int, 3 float
  extraSamples?: number // adds a 4th sample: 1 associated, 2 unassociated alpha
  samples?: number // per pixel, default 3 (4 with extraSamples)
  edit?: (entries: number[][]) => void // tamper with IFD entries
  icc?: Uint8Array // an ICC profile (tag 34675)
  colorMap?: number[] // palette (tag 320), 3 * 2^bits uint16
  ascii?: Record<number, string> // ASCII tags (e.g. 270, 700 XMP, 65000)
  longs?: Record<number, number[]> // LONG array tags (e.g. 65426)
  float?: Record<number, number> // one FLOAT (e.g. 65421)
  subfileType?: number // NewSubfileType (tag 254)
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
const writeTiff = (levels: Level[], subIfds = false) =>
  writePlanes(subIfds ? [levels] : levels.map((l) => [l]))

// Each plane's first level in the main chain, the rest under its SubIFDs (as
// OME-TIFF); `description` is the first IFD's ImageDescription.
function writePlanes(planes: Level[][], description = ''): ArrayBuffer {
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
  const chain: number[] = [] // main-chain IFDs
  const nextFields: number[] = []
  const subs: Array<{ field: number; ifds: number[] }> = []
  for (const [pi, plane] of planes.entries())
    for (const [i, lv] of plane.entries()) {
      const offsets = lv.tiles.map(append)
      const b = lv.bits ?? 8
      const spp = lv.samples ?? (lv.extraSamples ? 4 : 3)
      const perSample = (v: number) =>
        spp === 1 ? v : append(Array(spp).fill([v, 0]).flat())
      const bps = perSample(b)
      const n = lv.tiles.length
      const tileOffsets = n > 1 ? longs(offsets) : (offsets[0] ?? 0)
      const tileCounts =
        n > 1
          ? longs(lv.tiles.map((t) => t.length))
          : (lv.tiles[0]?.length ?? 0)
      // [tag, type (3 SHORT, 4 LONG), count, value-or-offset]
      const entries: number[][] = [
        [256, 4, 1, lv.width],
        [257, 4, 1, lv.height],
        [258, 3, spp, bps],
        [259, 3, 1, lv.compression],
        [262, 3, 1, lv.photometric],
        [277, 3, 1, spp],
        [284, 3, 1, 1],
        [322, 3, 1, lv.tile],
        [323, 3, 1, lv.tile],
        [324, 4, n, tileOffsets],
        [325, 4, n, tileCounts],
      ]
      if (lv.sampleFormat) {
        const f = lv.sampleFormat
        entries.push([339, 3, spp, perSample(f)])
      }
      if (lv.extraSamples) entries.push([338, 3, 1, lv.extraSamples])
      if (lv.icc) entries.push([34675, 7, lv.icc.length, append(lv.icc)])
      if (lv.colorMap)
        entries.push([
          320,
          3,
          lv.colorMap.length,
          append(new Uint8Array(Uint16Array.from(lv.colorMap).buffer)),
        ])
      if (lv.subfileType) entries.push([254, 4, 1, lv.subfileType])
      for (const [tag, v] of Object.entries(lv.longs ?? {}))
        entries.push([Number(tag), 4, v.length, longs(v)])
      for (const [tag, v] of Object.entries(lv.float ?? {}))
        entries.push([
          Number(tag),
          11,
          1,
          new Uint32Array(Float32Array.of(v).buffer)[0] ?? 0,
        ])
      for (const [tag, value] of Object.entries(lv.ascii ?? {})) {
        const text = new TextEncoder().encode(`${value}\0`)
        entries.push([Number(tag), 2, text.length, append(text)])
      }
      if (description && pi === 0 && i === 0) {
        const text = new TextEncoder().encode(`${description}\0`)
        entries.push([270, 2, text.length, append(text)])
      }
      lv.edit?.(entries)
      if (i === 0 && plane.length > 1)
        entries.push([330, 4, plane.length - 1, 0])
      const at = append(new Uint8Array(2 + entries.length * 12 + 4))
      u16(at, entries.length)
      entries.forEach(([tag = 0, type = 0, count = 0, value = 0], e) => {
        const p = at + 2 + e * 12
        u16(p, tag)
        u16(p + 2, type)
        u32(p + 4, count)
        if (type === 3 && count === 1) u16(p + 8, value)
        else u32(p + 8, value)
        if (tag === 330) subs.push({ field: p + 8, ifds: [] })
      })
      if (i === 0) {
        chain.push(at)
        nextFields.push(at + 2 + entries.length * 12)
      } else subs.at(-1)?.ifds.push(at)
    }
  u32(4, chain[0] ?? 0)
  for (const { field, ifds } of subs)
    u32(field, ifds.length === 1 ? (ifds[0] ?? 0) : longs(ifds))
  for (let i = 0; i + 1 < chain.length; i++)
    u32(nextFields[i] ?? 0, chain[i + 1] ?? 0)
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
    channelInfoChanged() {},
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

  test('serves the base image ICC profile (tag 34675), or null', async () => {
    const icc = Uint8Array.from({ length: 300 }, (_, i) => i & 255)
    const [l0, ...rest] = PYRAMID as [Level, ...Level[]]
    const tagged = await open(writeTiff([{ ...l0, icc }, ...rest]))
    expect(await tagged.source.fetchIccProfile()).toEqual(icc)
    const plain = await open(writeTiff(PYRAMID))
    expect(await plain.source.fetchIccProfile()).toBeNull()
  })

  test('a disposed source refuses its cached ICC profile', async () => {
    const icc = Uint8Array.from({ length: 300 }, (_, i) => i & 255)
    const [l0, ...rest] = PYRAMID as [Level, ...Level[]]
    const { source } = await open(writeTiff([{ ...l0, icc }, ...rest]))
    expect(await source.fetchIccProfile()).toEqual(icc)
    source.dispose()
    await expect(source.fetchIccProfile()).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('dispose cancels a deferred ICC profile read; abort stops the wait', async () => {
    // 200 KB: past geotiff's first block, so the profile needs its own Range read.
    const icc = new Uint8Array(200_000).fill(42)
    const [l0, ...rest] = PYRAMID as [Level, ...Level[]]
    const { source, server } = await open(writeTiff([{ ...l0, icc }, ...rest]))
    server.hold = true
    const caller = new AbortController()
    let settled = ''
    const fetched = source.fetchIccProfile(caller.signal).then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected'),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(server.requests.length).toBeGreaterThan(0)
    caller.abort()
    await fetched
    expect(settled).toBe('rejected')
    // The read itself: dispose aborts the request the server is still holding
    // (held requests settle only when their signal fires).
    const second = source.fetchIccProfile().then(
      () => 'settled',
      () => 'settled',
    )
    await new Promise((r) => setTimeout(r, 20))
    source.dispose()
    const pending = new Promise((r) => setTimeout(() => r('pending'), 200))
    expect(await Promise.race([second, pending])).toBe('settled')
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

  // NewSubfileType 1: a reduced-resolution image, as Philips marks its levels.
  const subfile = (type: number) => (entries: number[][]) => {
    entries.unshift([254, 4, 1, type])
  }
  const reduced = subfile(1)

  test('NewSubfileType is a bit field: reduced multipage pads, a mask does not', async () => {
    // 256x256 holds d=4 of the 1024x768 base, padded to 128 px tiles.
    for (const [type, levels] of [
      [3, 2],
      [5, 1],
    ]) {
      const padded = { ...rawLevel(1, 256, 256, 128), edit: subfile(type ?? 0) }
      const { source } = await open(
        writeTiff([rawLevel(0, 1024, 768, 128), padded]),
      )
      expect(source.manifest.levels.length).toBe(levels ?? 0)
    }
  })

  test('a tiled macro that fits the tile padding does not replace a level', async () => {
    // The 256x256 macro, ahead of the 256x192 level, pads like d=4 would.
    const macro = rawLevel(3, 256, 256, 128)
    const levels = [
      rawLevel(0, 1024, 768, 128),
      macro,
      rawLevel(2, 256, 192, 128),
    ]
    const { source } = await open(writeTiff(levels))
    const m = source.manifest
    expect(m.levels.map((l) => [l.width, l.height, l.downsample])).toEqual([
      [1024, 768, 1],
      [256, 192, 4],
    ])
    const l1 = m.levels[1]
    const tile = l1?.tiles[0]
    if (!l1 || !tile) throw new Error('missing tile')
    const rgba = await source.fetchTileBytes(l1, tile, 'level')
    expect(pixel(rgba, 128, 5, 5)).toEqual([...rgbAt(2, 5, 5), 255])
  })

  test('keeps Philips levels padded to whole tiles, at their content size', async () => {
    // 1024x768 base; d=4 holds 256x192 in a 256x256 image, d=8 and d=16 both
    // fit one 128 px tile. Each would fail the aspect test.
    const levels = [
      rawLevel(0, 1024, 768, 128),
      rawLevel(1, 512, 384, 128),
      rawLevel(2, 256, 256, 128),
      rawLevel(3, 128, 128, 128),
      rawLevel(4, 128, 128, 128),
    ].map((lv, i) => (i ? { ...lv, edit: reduced } : lv))
    const { source } = await open(writeTiff(levels))
    const m = source.manifest
    expect(m.levels.map((l) => [l.width, l.height, l.downsample])).toEqual([
      [1024, 768, 1],
      [512, 384, 2],
      [256, 192, 4],
      [128, 96, 8],
      [64, 48, 16],
    ])
    const l2 = m.levels[2]
    const tile = l2?.tiles.at(-1)
    if (!l2 || !tile) throw new Error('missing tile')
    expect(tile).toEqual({ x: 1, y: 1, width: 128, height: 64 })
    const rgba = await source.fetchTileBytes(l2, tile, 'padded')
    expect(pixel(rgba, 128, 127, 63)).toEqual([...rgbAt(2, 255, 191), 255])
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

  test('keeps the alpha of RGBA tiles, unpremultiplying associated alpha', async () => {
    // Pixel 0 transparent red, pixel 1 half-opaque grey (premultiplied 64).
    const rgbaTile = (first: number[], second: number[]) => {
      const t = new Uint8Array(16 * 16 * 4).fill(255)
      t.set(first, 0)
      t.set(second, 4)
      return t
    }
    const level = (extraSamples: number, second: number[]): Level => ({
      width: 16,
      height: 16,
      tile: 16,
      compression: 1,
      photometric: 2,
      extraSamples,
      tiles: [rgbaTile([255, 0, 0, 0], second)],
    })
    const read = async (lv: Level) => {
      const { source } = await open(writeTiff([lv]))
      const l = source.manifest.levels[0]
      const t = l?.tiles[0]
      if (!l || !t) throw new Error('missing tile')
      return source.fetchTileBytes(l, t, 'alpha')
    }
    const straight = await read(level(2, [128, 128, 128, 128]))
    expect(pixel(straight, 16, 0, 0)).toEqual([255, 0, 0, 0])
    expect(pixel(straight, 16, 1, 0)).toEqual([128, 128, 128, 128])
    expect(pixel(straight, 16, 2, 0)).toEqual([255, 255, 255, 255])
    const associated = await read(level(1, [64, 64, 64, 128]))
    expect(pixel(associated, 16, 1, 0)).toEqual([128, 128, 128, 128])
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

  test('returns a zero-byte (absent) tile transparent without decoding', async () => {
    const sparse: Level = {
      width: 128,
      height: 64,
      tile: 64,
      compression: 7,
      photometric: 6,
      tiles: [JPEG_TILE, new Uint8Array(0)],
    }
    const tiff = await fromArrayBuffer(writeTiff([sparse]))
    let decodes = 0
    const pool = {
      decode: () => {
        decodes++
        throw new Error('decoder called')
      },
    } as unknown as Pool
    const source = await TiffSlideSource.fromGeoTIFF(tiff, { pool })
    const level = source.manifest.levels[0]
    const absent = level?.tiles[1]
    if (!level || !absent) throw new Error('missing tile')
    const rgba = await source.fetchTileBytes(level, absent, 'empty')
    expect(rgba.length).toBe(64 * 64 * 4)
    expect(rgba.every((v) => v === 0)).toBe(true)
    expect(decodes).toBe(0)
  })

  test('concurrent reads of absent and present tiles each see their byte count', async () => {
    // 16 x 16 u8 tiles of 16 px, every other one absent, read over a slow
    // remote source: the counts table is loaded block by block, concurrently.
    const tiles = Array.from({ length: 256 }, (_, i) =>
      i % 2 ? new Uint8Array(0) : new Uint8Array(256).fill(7),
    )
    const file = writeTiff([
      {
        width: 256,
        height: 256,
        tile: 16,
        compression: 1,
        photometric: 1,
        tiles,
        bits: 8,
        samples: 1,
      },
    ])
    const server = rangeServer(file)
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      await Bun.sleep(1)
      return server.fetchImpl(url as string, init)
    }) as typeof fetch
    const source = await TiffSlideSource.fromUrl('http://test/sparse.tif', {
      fetch: fetchImpl,
    })
    const level = source.manifest.levels[0]
    if (!level) throw new Error('no level')
    const all = await Promise.all(
      level.tiles.map((t, i) =>
        source.fetchTileBytes(level, t as NonNullable<typeof t>, `c${i}`),
      ),
    )
    expect(all.every((b, i) => b[0] === (i % 2 ? 0 : 7))).toBe(true)
  })

  test('keeps a planar tile whose first sample alone is absent', async () => {
    const planar: Level = {
      width: 64,
      height: 64,
      tile: 64,
      compression: 1,
      photometric: 2,
      // One tile per sample (red, green, blue); red absent.
      tiles: [
        new Uint8Array(0),
        new Uint8Array(4096).fill(180),
        new Uint8Array(4096).fill(90),
      ],
      edit: (entries) => {
        const planarEntry = entries.find((e) => e[0] === 284)
        if (planarEntry) planarEntry[3] = 2
      },
    }
    const source = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(writeTiff([planar])),
    )
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    const rgba = await source.fetchTileBytes(level, tile, 'planar')
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 180, 90, 255])
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

  test('keeps a one-tile level at its exact size (bioformats)', async () => {
    const { source } = await open(
      writeTiff([rawLevel(0, 160, 160, 16), rawLevel(1, 20, 20, 20)], true),
    )
    const level = source.manifest.levels[1]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    expect([level.tileWidth, level.columns, tile.width]).toEqual([20, 1, 20])
    const rgba = await source.fetchTileBytes(level, tile, 'one')
    expect(pixel(rgba, 20, 19, 19)).toEqual([...rgbAt(1, 19, 19), 255])
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

  test('rejects non-unsigned samples', async () => {
    await openRejects(
      { ...rawLevel(0, 250, 175, 128), sampleFormat: 3 },
      /SampleFormat 3 is not supported/,
    )
  })

  test('shows WhiteIsZero 0 as white', async () => {
    // Gray from the first sample: rgbAt gives 0 at x 0 and 7 at x 1.
    const { source } = await open(
      writeTiff([{ ...rawLevel(0, 250, 175, 128), edit: setTag(262, 0) }]),
    )
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    const rgba = await source.fetchTileBytes(level, tile, 'w')
    expect(pixel(rgba, 128, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 128, 1, 0)).toEqual([248, 248, 248, 255])
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

  test('rejects JPEG that geotiff-rs cannot decode at open', async () => {
    const jpeg = (photometric: number, bits: number, compression = 7) => ({
      ...rawLevel(0, 250, 175, 128),
      compression,
      photometric,
      bits,
    })
    await openRejects(jpeg(6, 12), /12-bit JPEG is not supported/)
    await openRejects(jpeg(1, 12), /12-bit JPEG is not supported/)
    await openRejects(jpeg(6, 8, 6), /old-style JPEG is not supported/)
    // Non-JPEG 16-bit gray and 8-bit YCbCr JPEG still open.
    for (const lv of [{ ...jpeg(1, 16), compression: 1 }, jpeg(6, 8)]) {
      const { source } = await open(writeTiff([lv]))
      expect(source.manifest.levels.length).toBe(1)
    }
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

// geotiff's decoder registry is process-wide: these run in order, after every
// other TIFF test.
// A grey 1-sample level whose values encode its IFD: id * 1000 + level * 100 + (x + y) % 50.
function grayLevel(
  id: number,
  level: number,
  width: number,
  height: number,
  { bits = 16, sampleFormat = 1, tile = 16, photometric = 1 } = {},
): Level {
  const Typed = (
    {
      '8,1': Uint8Array,
      '16,1': Uint16Array,
      '32,1': Uint32Array,
      '8,2': Int8Array,
      '16,2': Int16Array,
      '32,2': Int32Array,
      '32,3': Float32Array,
      '64,3': Float64Array,
    } as Record<
      string,
      | typeof Uint8Array
      | typeof Uint16Array
      | typeof Uint32Array
      | typeof Int8Array
      | typeof Int16Array
      | typeof Int32Array
      | typeof Float32Array
      | typeof Float64Array
    >
  )[`${bits},${sampleFormat}`]
  if (!Typed) throw new Error('unsupported test dtype')
  const tiles: Uint8Array[] = []
  for (let ty = 0; ty < Math.ceil(height / tile); ty++) {
    for (let tx = 0; tx < Math.ceil(width / tile); tx++) {
      const t = new Typed(tile * tile)
      for (let y = 0; y < tile; y++)
        for (let x = 0; x < tile; x++)
          t[y * tile + x] =
            (id * 1000 + level * 100 + ((tx * tile + x + ty * tile + y) % 50)) %
            (bits === 8
              ? 256
              : bits === 16 && sampleFormat === 2
                ? 32768
                : 65536)
      tiles.push(new Uint8Array(t.buffer))
    }
  }
  return {
    width,
    height,
    tile,
    compression: 1,
    photometric,
    tiles,
    bits,
    samples: 1,
    ...(sampleFormat === 1 ? {} : { sampleFormat }),
  }
}

// Bin b of the 1001-bin 2-98% histogram over mn..mx (robustMinMax).
const bin = (b: number, mn: number, mx: number) => b / (1000 / (mx - mn)) + mn

/** Runs `f` with stand-ins for the browser bitmap API NVSlide renders tiles with. */
async function withFakeBitmaps<T>(f: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>
  const saved = [g.ImageData, g.createImageBitmap]
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  g.createImageBitmap = async (img: { width: number; height: number }) => ({
    width: img.width,
    height: img.height,
    close() {},
  })
  try {
    return await f()
  } finally {
    ;[g.ImageData, g.createImageBitmap] = saved
  }
}

// One plane per IFD id, each a 2-level SubIFD pyramid (40x32, 20x16).
const grayPlanes = (
  ids: number[],
  dtype: object | ((id: number) => object) = {},
) =>
  ids.map((id) => {
    const d = typeof dtype === 'function' ? dtype(id) : dtype
    return [grayLevel(id, 0, 40, 32, d), grayLevel(id, 1, 20, 16, d)]
  })

const omeXml = (pixels: string, inner = '') =>
  `<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06" UUID="urn:uuid:self"><Image ID="Image:0"><Pixels ID="Pixels:0" ${pixels}>${inner}</Pixels></Image></OME>`

// Two channels (red DAPI, green GFP), SizeZ 2.
const TWO_CHANNELS =
  '<Channel ID="Channel:0:0" Name="DAPI" Color="-16776961" SamplesPerPixel="1"/>' +
  '<Channel ID="Channel:0:1" Name="GFP" Color="16711935" SamplesPerPixel="1"/>'

async function openOme(
  order: string,
  ids: number[],
  options: {
    z?: number
    t?: number
    inner?: string
    dtype?: object | ((id: number) => object)
    singleQuotes?: boolean
    pixels?: string
  } = {},
) {
  const doubleQuoted = omeXml(
    `DimensionOrder="${order}" SizeX="40" SizeY="32" SizeC="2" SizeZ="2" SizeT="1" Type="uint16" ${options.pixels ?? ''}`,
    options.inner ?? `${TWO_CHANNELS}<TiffData/>`,
  )
  const xml = options.singleQuotes
    ? doubleQuoted.replaceAll('"', "'")
    : doubleQuoted
  const server = rangeServer(writePlanes(grayPlanes(ids, options.dtype), xml))
  return TiffSlideSource.fromUrl('http://test/ome.tif', {
    fetch: server.fetchImpl,
    z: options.z,
    t: options.t,
  })
}

// Each sample plane's first value, i.e. its IFD id * 1000 + level * 100.
async function planeIds(
  source: TiffSlideSource,
  channels: number[],
  level = 0,
) {
  const lv = source.manifest.levels[level]
  const tile = lv?.tiles[0]
  if (!lv || !tile || !source.fetchTileSamples) throw new Error('no samples')
  const r = await source.fetchTileSamples(lv, tile, channels)
  expect([r.width, r.height, r.planes]).toEqual([16, 16, channels.length])
  return channels.map((_, p) => r.samples[p * 256])
}

describe('multi-channel OME-TIFF', () => {
  test('states channels and serves each one as samples', async () => {
    // XYCZT: IFD = c + 2z, so IFD ids 0 and 1 are z 0's channels.
    const source = await openOme('XYCZT', [0, 1, 2, 3])
    const m = source.manifest
    expect([m.dtype, m.channels]).toEqual(['uint16', 'gray'])
    expect(m.levels.map((l) => [l.width, l.codec, l.bitsStored])).toEqual([
      [40, 'raw-gray', 16],
      [20, 'raw-gray', 16],
    ])
    // Windows: 2-98% of the coarsest level, id * 1000 + 100 + s, s = x + y in
    // 0..34 over 20 x 16: 6 of 320 samples per end lie at s <= 2 and s >= 32,
    // bins 59 and 941 of 1000.
    expect(m.channelInfo).toEqual([
      {
        name: 'DAPI',
        rgb: [255, 0, 0],
        window: { calMin: bin(59, 100, 134), calMax: bin(941, 100, 134) },
        active: true,
      },
      {
        name: 'GFP',
        rgb: [0, 255, 0],
        window: {
          calMin: bin(59, 1100, 1134),
          calMax: bin(941, 1100, 1134),
        },
        active: true,
      },
    ])
    expect(await planeIds(source, [1, 0])).toEqual([1000, 0])
    expect(await planeIds(source, [1], 1)).toEqual([1100])
    const lv = m.levels[0]
    const tile = lv?.tiles[0]
    if (!lv || !tile) throw new Error('missing tile')
    await expect(source.fetchTileBytes(lv, tile, 'b')).rejects.toThrow(
      /fetchTileSamples/,
    )
  })

  test('maps planes by DimensionOrder and the z option', async () => {
    // XYZCT: IFD = z + 2c.
    expect(
      await planeIds(await openOme('XYZCT', [0, 1, 2, 3]), [0, 1]),
    ).toEqual([0, 2000])
    expect(
      await planeIds(await openOme('XYZCT', [0, 1, 2, 3], { z: 1 }), [0, 1]),
    ).toEqual([1000, 3000])
    expect(
      await planeIds(await openOme('XYCZT', [0, 1, 2, 3], { z: 1 }), [0, 1]),
    ).toEqual([2000, 3000])
    await expect(openOme('XYCZT', [0, 1, 2, 3], { z: 2 })).rejects.toThrow(
      /z 2 is not in 0-1/,
    )
    await expect(openOme('XYCZT', [0, 1, 2, 3], { t: 1 })).rejects.toThrow(
      /t 1 is not in 0-0/,
    )
  })

  test('maps planes through TiffData IFD and First* attributes', async () => {
    // Channel 1 first in the file: c1 at IFD 0, c0 z0 at IFD 1.
    const inner = `${TWO_CHANNELS}<TiffData IFD="1" FirstC="0"/><TiffData IFD="0" FirstC="1"/>`
    expect(
      await planeIds(await openOme('XYCZT', [0, 1], { inner }), [0, 1]),
    ).toEqual([1000, 0])
    // A plane no TiffData holds, or one past the IFD cap, is refused.
    const far = `${TWO_CHANNELS}<TiffData IFD="9999" FirstC="1"/><TiffData IFD="0"/>`
    await expect(openOme('XYCZT', [0, 1], { inner: far })).rejects.toThrow(
      /maps to IFD 9999/,
    )
  })

  test('decodes character references in TiffData and UUID attributes', async () => {
    const inner = `${TWO_CHANNELS}<TiffData IFD="&#49;" FirstC="&#x30;" PlaneCount="&#49;"/><TiffData IFD="0" FirstC="1"/>`
    expect(
      await planeIds(await openOme('XYCZT', [0, 1], { inner }), [0, 1]),
    ).toEqual([1000, 0])
    const split = `${TWO_CHANNELS}<TiffData FirstC="0" IFD="0"><UUID FileName="ome.tif">urn:uuid:self</UUID></TiffData><TiffData FirstC="1" IFD="0"><UUID FileName="b&amp;c.ome.tif">urn:uuid:b</UUID></TiffData>`
    await expect(openOme('XYCZT', [0, 1], { inner: split })).rejects.toThrow(
      /is in b&c\.ome\.tif; open that file/,
    )
  })

  test('keeps WhiteIsZero planes white at 0', async () => {
    const source = await openOme('XYCZT', [0, 1, 2, 3], {
      dtype: { photometric: 0 },
    })
    expect(source.manifest.levels.map((l) => l.photometric)).toEqual([
      'MONOCHROME1',
      'MONOCHROME1',
    ])
  })

  test('rejects channels with different PhotometricInterpretation', async () => {
    // XYCZT: plane 1 is channel 1; one manifest photometric would invert it.
    await expect(
      openOme('XYCZT', [0, 1, 2, 3], {
        dtype: (id: number) => ({ photometric: id === 1 ? 0 : 1 }),
      }),
    ).rejects.toThrow("channel 1's PhotometricInterpretation differs")
  })

  test('reads single-quoted OME-XML attributes', async () => {
    const source = await openOme('XYCZT', [0, 1, 2, 3], { singleQuotes: true })
    expect(source.manifest.channelInfo?.map((c) => [c.name, c.rgb])).toEqual([
      ['DAPI', [255, 0, 0]],
      ['GFP', [0, 255, 0]],
    ])
    expect(await planeIds(source, [1, 0])).toEqual([1000, 0])
  })

  test('a single plane at a TiffData IFD past unused IFDs', async () => {
    const xml = omeXml(
      'DimensionOrder="XYCZT" SizeX="64" SizeY="64" SizeC="3" SizeZ="1" SizeT="1" Type="uint8"',
      '<Channel ID="Channel:0:0" SamplesPerPixel="3"/><TiffData IFD="3"/>',
    )
    const file = writePlanes(
      [0, 1, 2, 3].map((id) => [rawLevel(id, 64, 64, 16)]),
      xml,
    )
    const { source } = await open(file)
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    expect(source.manifest.levels.length).toBe(1)
    const rgba = await source.fetchTileBytes(level, tile, 'ifd3')
    expect(pixel(rgba, 16, 1, 1)).toEqual([157, 5, 240, 255])
  })

  test('refuses a plane another file of a multi-file set holds', async () => {
    const td = (c: number, ifd: number, file: string, uuid: string) =>
      `<TiffData FirstC="${c}" IFD="${ifd}" PlaneCount="1"><UUID FileName="${file}">${uuid}</UUID></TiffData>`
    // This file's UUID: its IFDs.
    const own =
      TWO_CHANNELS +
      td(0, 1, 'ome.tif', 'urn:uuid:self') +
      td(1, 0, 'ome.tif', 'urn:uuid:self')
    expect(
      await planeIds(await openOme('XYCZT', [0, 1], { inner: own }), [0, 1]),
    ).toEqual([1000, 0])
    const split =
      TWO_CHANNELS +
      td(0, 0, 'ome.tif', 'urn:uuid:self') +
      td(1, 0, 'b.ome.tif', 'urn:uuid:b')
    await expect(openOme('XYCZT', [0, 1], { inner: split })).rejects.toThrow(
      /plane C1 Z0 T0 is in b\.ome\.tif; open that file/,
    )
  })

  test('several RGB channels: SizeC counts samples, channel 0 shows in colour', async () => {
    // SizeC 6 = 2 Channels of 3 samples; XYCZT, so z 1 is IFD 2.
    const xml = omeXml(
      'DimensionOrder="XYCZT" SizeX="64" SizeY="64" SizeC="6" SizeZ="2" SizeT="1" Type="uint8"',
      '<Channel ID="Channel:0:0" SamplesPerPixel="3"/><Channel ID="Channel:0:1" SamplesPerPixel="3"/><TiffData/>',
    )
    const file = writePlanes(
      [0, 1, 2, 3].map((id) => [rawLevel(id, 64, 64, 16)]),
      xml,
    )
    const server = rangeServer(file)
    const source = await TiffSlideSource.fromUrl('http://test/rgb.ome.tif', {
      fetch: server.fetchImpl,
      z: 1,
    })
    expect(source.fetchTileSamples).toBeUndefined()
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('missing tile')
    expect(level.codec).toBe('raw-rgba')
    const rgba = await source.fetchTileBytes(level, tile, 'rgb')
    expect(pixel(rgba, 16, 1, 1)).toEqual([...rgbAt(2, 1, 1), 255])
  })

  test('uint8 windows are the 2-98% range too; float32 is native, int32 quantized to uint16', async () => {
    const u8 = await openOme('XYCZT', [0, 1, 2, 3], { dtype: { bits: 8 } })
    expect(u8.manifest.levels[0]?.bitsStored).toBe(8)
    // Channel 1 holds 1100 % 256 + s = 76..110; u8 is not quantized.
    expect(u8.manifest.channelInfo?.[1]).toMatchObject({
      window: { calMin: bin(59, 76, 110), calMax: bin(941, 76, 110) },
    })
    expect(u8.manifest.channelInfo?.[1]?.storedToValue).toBeUndefined()
    expect(await planeIds(u8, [1])).toEqual([1000 % 256])
    // float32 stays float32: the window in data units, read back exact.
    const f32 = await openOme('XYCZT', [0, 1, 2, 3], {
      dtype: { bits: 32, sampleFormat: 3 },
    })
    expect(f32.manifest.dtype).toBe('float32')
    expect(f32.manifest.levels.map((l) => l.sampleType)).toEqual(['f32', 'f32'])
    expect(f32.manifest.channelInfo?.[0]).toEqual({
      name: 'DAPI',
      rgb: [255, 0, 0],
      active: true,
      window: { calMin: bin(59, 100, 134), calMax: bin(941, 100, 134) },
    })
    const fl = f32.manifest.levels[1]
    const ft = fl?.tiles[0]
    if (!fl || !ft || !f32.fetchTileSamples) throw new Error('no samples')
    const fr = await f32.fetchTileSamples(fl, ft, [1])
    expect(fr.samples).toBeInstanceOf(Float32Array)
    expect([fr.samples[0], fr.samples[17]]).toEqual([1100, 1102])
    const fslide = NVSlide.fromSource(f32)
    const [, l1] = await withFakeBitmaps(() =>
      fslide.loadSampleAt(2, 2, { level: 1 }),
    )
    expect(l1).toMatchObject({ value: 1102, stored: 1102, exact: false })
    const [, l0] = await withFakeBitmaps(() => fslide.loadSampleAt(0, 0))
    expect(l0).toMatchObject({ value: 1000, exact: true })
    // int32 is quantized over the sample's min..max 100..134, windowed to its
    // 2-98%. Divide before scaling (channelDisplay.ts), as Zarr.
    const i32 = await openOme('XYCZT', [0, 1, 2, 3], {
      dtype: { bits: 32, sampleFormat: 2 },
    })
    expect(i32.manifest.dtype).toBe('uint16')
    const stored = (v: number) => ((v - 100) / 34) * 65535
    expect(i32.manifest.channelInfo?.[0]).toMatchObject({
      window: {
        calMin: stored(bin(59, 100, 134)),
        calMax: stored(bin(941, 100, 134)),
      },
      storedToValue: { scale: 34 / 65535, offset: 100 },
    })
    // Channel 1's coarse range 1100..1134 spans 0..65535; level 0 holds 1000 (clamps to 0).
    const lv = i32.manifest.levels[1]
    const tile = lv?.tiles[0]
    if (!lv || !tile || !i32.fetchTileSamples) throw new Error('no samples')
    const r = await i32.fetchTileSamples(lv, tile, [1])
    expect([r.samples[0], r.samples[17]]).toEqual([
      0,
      Math.round((2 / 34) * 65535),
    ])
    // NVSlide.sampleAt maps stored samples back through storedToValue.
    const slide = NVSlide.fromSource(i32)
    const step = 34 / 65535
    const [, coarse] = await withFakeBitmaps(() =>
      slide.loadSampleAt(2, 2, { level: 1 }),
    )
    // Level 1 pixel (1, 1): 1100 + 2.
    expect(Math.abs((coarse?.value ?? 0) - 1102)).toBeLessThan(step / 2)
    expect([coarse?.exact, coarse?.clipped]).toEqual([false, undefined])
    // Level 0 holds 1000, below the range: stored 0, value the range's low end.
    const [, fine] = await withFakeBitmaps(() => slide.loadSampleAt(0, 0))
    expect(fine).toMatchObject({ value: 1100, exact: false, clipped: true })
  })

  test('RGB OME-TIFF and plain TIFF stay raw-rgba without channels', async () => {
    const xml = omeXml(
      'DimensionOrder="XYCZT" SizeX="1000" SizeY="700" SizeC="3" SizeZ="1" SizeT="1" Type="uint8"',
      '<Channel ID="Channel:0:0" SamplesPerPixel="3"/><TiffData/>',
    )
    // SizeC 3 without Channel elements, pyramid in the main chain.
    const bare = omeXml(
      'DimensionOrder="XYCZT" SizeX="1000" SizeY="700" SizeC="3" SizeZ="1" SizeT="1" Type="uint8"',
    )
    for (const file of [
      writePlanes([PYRAMID], xml),
      writePlanes(
        PYRAMID.map((l) => [l]),
        bare,
      ),
      writeTiff(PYRAMID),
    ]) {
      const { source } = await open(file)
      expect(source.fetchTileSamples).toBeUndefined()
      expect(source.manifest.channelInfo).toBeUndefined()
      expect(source.manifest.levels.map((l) => [l.width, l.codec])).toEqual([
        [1000, 'raw-rgba'],
        [500, 'raw-rgba'],
        [250, 'raw-rgba'],
      ])
    }
  })
})

// A grey 1-sample pyramid (grayLevel id 0): 40x32 and 20x16, 16 px tiles.
const grayPyramid = (dtype: object = {}) => [
  grayLevel(0, 0, 40, 32, dtype),
  grayLevel(0, 1, 20, 16, dtype),
]

const tileOf = (source: TiffSlideSource, level = 0, i = 0) => {
  const lv = source.manifest.levels[level]
  const tile = lv?.tiles[i]
  if (!lv || !tile) throw new Error('missing tile')
  return [lv, tile] as const
}

describe('single-channel grey TIFF', () => {
  test('serves raw-gray bytes with one channelInfo entry, no fetchTileSamples', async () => {
    const { source, server } = await open(writeTiff(grayPyramid()))
    const m = source.manifest
    expect(source.fetchTileSamples).toBeUndefined()
    expect([m.dtype, m.channels]).toEqual(['uint16', 'gray'])
    expect(
      m.levels.map((l) => [l.codec, l.bitsStored, l.sampleType, l.photometric]),
    ).toEqual([
      ['raw-gray', 16, undefined, 'MONOCHROME2'],
      ['raw-gray', 16, undefined, 'MONOCHROME2'],
    ])
    // Coarsest level 100 + s, s in 0..34 (see multi-channel windows).
    expect(m.channelInfo).toEqual([
      {
        name: 'gray',
        active: true,
        window: { calMin: bin(59, 100, 134), calMax: bin(941, 100, 134) },
      },
    ])
    // Open-time reads: header + IFD blocks, plus the coarse level's samples.
    expect(server.requests.length).toBeLessThanOrEqual(4)
    const [lv, tile] = tileOf(source, 0, 3) // (0, 1) of 3 x 2
    const bytes = await source.fetchTileBytes(lv, tile, 'g')
    const samples = new Uint16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.length / 2,
    )
    expect(samples.length).toBe(tile.width * tile.height)
    // id 0, level 0: (x + y) % 50 at x = 16 * tile.x.
    expect(samples[0]).toBe((16 * tile.x + 16 * tile.y) % 50)
    // NVSlide shows it grey, windowed, from the bytes path.
    const slide = NVSlide.fromSource(source)
    expect(slide.channels.map((c) => [c.name, c.colormap])).toEqual([
      ['gray', 'gray'],
    ])
  })

  test('one u8 grey image keeps 0-255 and reads no samples at open', async () => {
    const proto = GeoTIFFImage.prototype
    const real = proto.readRasters
    let reads = 0
    proto.readRasters = function (this: GeoTIFFImage, ...args: unknown[]) {
      reads++
      return (real as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof real
    try {
      const { source } = await open(writeTiff(grayPyramid({ bits: 8 })))
      expect(source.manifest.channelInfo?.[0]?.window).toEqual({
        calMin: 0,
        calMax: 255,
      })
      expect(reads).toBe(0)
      await open(writeTiff(grayPyramid())) // u16 still samples its coarse level
      expect(reads).toBeGreaterThan(0)
    } finally {
      proto.readRasters = real
    }
  })

  test('a 4-bit grey image windows 0-15, so its 15 shows white', async () => {
    const nibbles: Level = {
      width: 16,
      height: 16,
      tile: 16,
      compression: 1,
      photometric: 1,
      samples: 1,
      bits: 4,
      tiles: [new Uint8Array(128).fill(0xff)], // every sample 15
    }
    const { source } = await open(writeTiff([nibbles]))
    expect(source.manifest.channelInfo?.[0]?.window).toEqual({
      calMin: 0,
      calMax: 15,
    })
  })

  test('int16 and float32 stay native; int8 widens to int16; wider types quantize', async () => {
    const read = async (dtype: object) => {
      const { source } = await open(writeTiff(grayPyramid(dtype)))
      const [lv, tile] = tileOf(source, 1)
      const bytes = await source.fetchTileBytes(lv, tile, 't')
      return { source, lv, bytes }
    }
    const i16 = await read({ bits: 16, sampleFormat: 2 })
    expect([i16.source.manifest.dtype, i16.lv.sampleType]).toEqual([
      'int16',
      'i16',
    ])
    expect(new Int16Array(i16.bytes.slice().buffer)[1]).toBe(101)
    expect(i16.source.manifest.channelInfo?.[0]?.storedToValue).toBeUndefined()
    const i8 = await read({ bits: 8, sampleFormat: 2 })
    expect([i8.lv.sampleType, i8.lv.bitsStored, i8.bytes.length]).toEqual([
      'i16',
      16,
      16 * 16 * 2,
    ])
    expect(new Int16Array(i8.bytes.slice().buffer)[1]).toBe(101)
    const f32 = await read({ bits: 32, sampleFormat: 3 })
    expect([
      f32.source.manifest.dtype,
      f32.lv.sampleType,
      f32.lv.bitsStored,
    ]).toEqual(['float32', 'f32', 32])
    expect(new Float32Array(f32.bytes.slice().buffer)[1]).toBe(101)
    expect(f32.source.manifest.channelInfo?.[0]?.window).toEqual({
      calMin: bin(59, 100, 134),
      calMax: bin(941, 100, 134),
    })
    for (const dtype of [
      { bits: 32, sampleFormat: 1 },
      { bits: 32, sampleFormat: 2 },
      { bits: 64, sampleFormat: 3 },
    ]) {
      const q = await read(dtype)
      expect([q.source.manifest.dtype, q.lv.sampleType]).toEqual([
        'uint16',
        undefined,
      ])
      expect(q.source.manifest.channelInfo?.[0]?.storedToValue).toEqual({
        scale: 34 / 65535,
        offset: 100,
      })
      // Level 1 sample 1 = 101: stored round(1/34 * 65535).
      expect(new Uint16Array(q.bytes.slice().buffer)[1]).toBe(
        Math.round((1 / 34) * 65535),
      )
    }
  })

  test('WhiteIsZero is MONOCHROME1; an absent tile is zeros without decoding', async () => {
    const levels = grayPyramid({ photometric: 0, bits: 8 })
    const l0 = levels[0] as Level
    l0.tiles[1] = new Uint8Array(0)
    const tiff = await fromArrayBuffer(writeTiff(levels))
    let decodes = 0
    const pool = {
      decode: () => {
        decodes++
        throw new Error('decoder called')
      },
    } as unknown as Pool
    const source = await TiffSlideSource.fromGeoTIFF(tiff)
    expect(source.manifest.levels[0]?.photometric).toBe('MONOCHROME1')
    // After open (whose window read decodes the coarse level): tiles decode in `pool`.
    Object.assign(source, { pool })
    const [lv, absent] = tileOf(source, 0, 1)
    const bytes = await source.fetchTileBytes(lv, absent, 'empty')
    expect(bytes.length).toBe(16 * 16)
    expect(bytes.every((v) => v === 0)).toBe(true)
    expect(decodes).toBe(0)
  })

  test('palette and RGB stay raw-rgba; an OME C=1 grey plane names its channel', async () => {
    const colorMap = [
      ...Array.from({ length: 256 }, (_, i) => i * 257),
      ...Array(256).fill(0),
      ...Array(256).fill(65535),
    ]
    const palette = {
      ...grayLevel(0, 0, 40, 32, { bits: 8, photometric: 3 }),
      colorMap,
    }
    const { source: pal } = await open(writeTiff([palette]))
    expect([pal.manifest.levels[0]?.codec, pal.manifest.channelInfo]).toEqual([
      'raw-rgba',
      undefined,
    ])
    const xml = omeXml(
      'DimensionOrder="XYCZT" SizeX="40" SizeY="32" SizeC="1" SizeZ="1" SizeT="1" Type="uint16"',
      '<Channel ID="Channel:0:0" Name="DAPI &amp; co" SamplesPerPixel="1"/><TiffData/>',
    )
    const { source: ome } = await open(writePlanes([grayPyramid()], xml))
    expect(ome.manifest.levels[0]?.codec).toBe('raw-gray')
    expect(ome.manifest.channelInfo?.map((c) => c.name)).toEqual(['DAPI & co'])
  })

  test('attribution: text fields kept, a non-http url dropped', async () => {
    const tiff = await fromArrayBuffer(writeTiff(grayPyramid()))
    const source = await TiffSlideSource.fromGeoTIFF(tiff, {
      attribution: {
        title: 'Brain',
        url: 'javascript:alert(1)',
        license: 'CC0',
      },
    })
    expect(source.manifest.attribution).toEqual({
      title: 'Brain',
      license: 'CC0',
    })
    const plain = await TiffSlideSource.fromGeoTIFF(tiff, {
      attribution: { url: 'https://example.org/x' },
    })
    expect(plain.manifest.attribution).toEqual({ url: 'https://example.org/x' })
  })
})

test('pixel spacing: vendor metadata, OME-XML, then resolution tags; placeholders give none', async () => {
  // Golden: scratch/ruler-calibration-2026-11-12.md "Source spacing", in um [x, y].
  const philips = (order: string) =>
    `<DataObject ObjectType="DPUfsImport"><Attribute ${order}>&quot;0.000226891&quot; &quot;0.000226907&quot;</Attribute></DataObject>`
  const leica =
    '<scn><collection sizeX="30000000" sizeY="80000000">' +
    '<image><pixels sizeX="1616" sizeY="4668"/><view sizeX="30000000" sizeY="80000000" offsetX="0" offsetY="0"/></image>' +
    '<image><pixels sizeX="36832" sizeY="38000"/><view sizeX="18416000" sizeY="19000000" offsetX="9" offsetY="9"/></image>' +
    '</collection></scn>'
  const res = (x: number, unit?: number, y = x) => ({
    description: '',
    xResolution: x,
    yResolution: y,
    resolutionUnit: unit,
  })
  const rows: [string, TiffSpacingTags, number[] | undefined][] = [
    [
      'Aperio CMU-1',
      {
        description:
          'Aperio Image Library v10.0.51\r\n46920x33014 [0,100 46000x32914] (256x256) JPEG/RGB Q=30|AppMag = 20|MPP = 0.4990|Left = 25.6',
      },
      [0.499, 0.499],
    ],
    [
      'Aperio without MPP ignores tags',
      { ...res(25000, 3), description: 'Aperio Image Library v10' },
      undefined,
    ],
    [
      'OME nm, default unit',
      {
        description: omeXml(
          'PhysicalSizeX="400" PhysicalSizeXUnit="nm" PhysicalSizeY="0.5"',
        ),
      },
      [0.4, 0.5],
    ],
    [
      'OME units as XML entities',
      {
        description: omeXml(
          'PhysicalSizeX="0.25" PhysicalSizeXUnit="&#xB5;m" PhysicalSizeY="0.5" PhysicalSizeYUnit="&#181;m"',
        ),
      },
      [0.25, 0.5],
    ],
    [
      'OME without PhysicalSizeY: square pixels',
      {
        description: omeXml('PhysicalSizeX="0.25" PhysicalSizeXUnit="µm"'),
      },
      [0.25, 0.25],
    ],
    [
      'OME with a malformed PhysicalSizeY',
      {
        description: omeXml('PhysicalSizeX="0.25" PhysicalSizeY="abc"'),
      },
      undefined,
    ],
    [
      'Philips row\\col',
      { description: philips('Name="DICOM_PIXEL_SPACING" Group="0x0028"') },
      [0.226907, 0.226891],
    ],
    [
      'Philips-4 attribute order',
      { description: philips('Element="0x0030" Name="DICOM_PIXEL_SPACING"') },
      [0.226907, 0.226891],
    ],
    [
      'Philips representation 0 though listed after 1',
      {
        description: `<DataObject ObjectType="DPUfsImport">${[1, 0]
          .map(
            (n) =>
              `<DataObject ObjectType="PixelDataRepresentation"><Attribute Name="DICOM_PIXEL_SPACING">&quot;${n ? '0.001' : '0.00025'}&quot; &quot;${n ? '0.001' : '0.0005'}&quot;</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_NUMBER">${n}</Attribute></DataObject>`,
          )
          .join('')}</DataObject>`,
      },
      [0.5, 0.25],
    ],
    ['Leica main image, not the macro', { description: leica }, [0.5, 0.5]],
    [
      'Leica regions that disagree',
      {
        description: leica.replace(
          '</collection>',
          '<image><pixels sizeX="1000" sizeY="1000"/><view sizeX="1000000" sizeY="1000000" offsetX="9" offsetY="9"/></image></collection>',
        ),
      },
      undefined,
    ],
    [
      'Leica fluorescence region at another resolution',
      {
        description: leica.replace(
          '</collection>',
          '<image><pixels sizeX="1000" sizeY="1000"/><view sizeX="1000000" sizeY="1000000" offsetX="9" offsetY="9"/><illuminationSource>fluorescence</illuminationSource></image></collection>',
        ),
      },
      [0.5, 0.5],
    ],
    [
      'Leica fluorescence region opened as the widest image',
      {
        description: leica.replace(
          '</collection>',
          '<image><pixels sizeX="40000" sizeY="40000"/><view sizeX="40000000" sizeY="40000000" offsetX="9" offsetY="9"/><illuminationSource>fluorescence</illuminationSource></image></collection>',
        ),
        leicaRegion: 1,
      },
      [1, 1],
    ],
    [
      'Leica fluorescence-only image',
      {
        description:
          '<scn><collection sizeX="2000000" sizeY="2000000"><image><pixels sizeX="1000" sizeY="1000"/><view sizeX="500000" sizeY="500000" offsetX="1" offsetY="1"/><illuminationSource>fluorescence</illuminationSource></image></collection></scn>',
        leicaRegion: 0,
      },
      [0.5, 0.5],
    ],
    [
      'Leica regions that disagree on Y only',
      {
        description: leica.replace(
          '</collection>',
          '<image><pixels sizeX="1000" sizeY="1000"/><view sizeX="500000" sizeY="1000000" offsetX="9" offsetY="9"/></image></collection>',
        ),
      },
      undefined,
    ],
    [
      'Ventana iScan',
      {
        ...res(472.44, 3),
        description: 'Label_Image',
        xmp: '<iScan Magnification="40" ScanRes="0.25"/>',
      },
      [0.25, 0.25],
    ],
    [
      'Ventana iScan, single-quoted',
      { description: 'Label_Image', xmp: "<iScan ScanRes='0.25'/>" },
      [0.25, 0.25],
    ],
    [
      'Ventana with a bad ScanRes ignores tags',
      {
        ...res(25000, 3),
        description: 'Label_Image',
        xmp: '<iScan ScanRes="bad"/><EncodeInfo/><TileJointInfo/>',
      },
      undefined,
    ],
    ['Huron-1 (cm)', res(25000, 3), [0.4, 0.4]],
    ['Argos-1 (cm)', res(26109.381, 3), [0.383004]],
    ['Generic-TIFF 10 px/cm placeholder', res(10, 3), undefined],
    ['ResolutionUnit none', res(25000, 1), undefined],
    ['72 dpi default', res(72), undefined],
    ['300 dpi', res(300, 2), undefined],
    ['no tags', { description: '' }, undefined],
  ]
  for (const [name, tags, um] of rows)
    expect([
      name,
      tiffPixelSpacingMM(tags)?.map((v) => +(v * 1000).toPrecision(6)),
    ]).toEqual([name, um && [um[0], um[1] ?? um[0]]])
  // Wiring: the manifest carries it.
  const xml = omeXml(
    'DimensionOrder="XYCZT" SizeX="40" SizeY="32" SizeC="1" SizeZ="1" SizeT="1" Type="uint16" PhysicalSizeX="0.25" PhysicalSizeY="0.25"',
  )
  const server = rangeServer(writePlanes(grayPlanes([0]), xml))
  const source = await TiffSlideSource.fromUrl('http://test/s.ome.tif', {
    fetch: server.fetchImpl,
  })
  expect(source.manifest.pixelSpacingMM).toEqual([0.00025, 0.00025])
})

test('an unreadable resolution tag gives no spacing, never a failed open', async () => {
  const lv = {
    ...rawLevel(0, 16, 16, 16),
    // XResolution (RATIONAL) pointing past the end of the file.
    edit: (entries: number[][]) => {
      entries.push([282, 5, 1, 0x7ffffff0], [283, 5, 1, 0x7ffffff0])
    },
  }
  const source = await TiffSlideSource.fromGeoTIFF(
    await fromArrayBuffer(writeTiff([lv])),
  )
  expect(source.manifest.width).toBe(16)
  expect(source.manifest.pixelSpacingMM).toBeUndefined()
})

describe('OME-TIFF channel names', () => {
  test('names, colours, plane order and z step units (entities: core omeTiff.test)', async () => {
    const inner =
      '<Channel ID="Channel:0:0" Name="A" Color="-1" SamplesPerPixel="1"/>' +
      '<Channel ID="Channel:0:1" Name="B" Color="65535" SamplesPerPixel="1"/>' +
      '<Channel ID="Channel:0:2" SamplesPerPixel="1"/><Channel Color="bad" SamplesPerPixel="1"/><TiffData/>'
    const source = await openOme('XYCZT', [0, 1, 2, 3, 4, 5, 6, 7], { inner })
    expect(source.manifest.channelInfo?.map((c) => [c.name, c.rgb])).toEqual([
      ['A', [255, 255, 255]],
      ['B', [0, 0, 255]],
      ['Channel 3', undefined],
      ['Channel 4', undefined],
    ])
    const { source: one } = await open(
      writePlanes(
        [grayPyramid()],
        omeXml(
          'DimensionOrder="XYCZT" SizeX="40" SizeY="32" SizeC="1" SizeZ="1" SizeT="1" Type="uint16"',
          '<Channel ID="Channel:0:0" SamplesPerPixel="1"/><TiffData/>',
        ),
      ),
    )
    // A bad DimensionOrder reads as XYZCT (core parseOmeXml's fallback).
    const bad = await openOme('XYCZQ', [0, 1, 2, 3])
    expect([
      one.manifest.channelInfo?.map((c) => c.name),
      bad.planes,
      await planeIds(bad, [0, 1]),
    ]).toEqual([['gray'], { z: 2, t: 1 }, [0, 2000]])
    const zStep = async (pixels: string) =>
      (await openOme('XYCZT', [0, 1, 2, 3], { pixels })).planes?.zPositionsUm
    expect(
      await Promise.all(
        [
          'PhysicalSizeZ="2.5"',
          'PhysicalSizeZ="2.5" PhysicalSizeZUnit="&#181;m"',
          'PhysicalSizeZ="2.5" PhysicalSizeZUnit="um"',
          'PhysicalSizeZ="500" PhysicalSizeZUnit="nm"',
          'PhysicalSizeZ="0.002" PhysicalSizeZUnit="mm"',
          'PhysicalSizeZ="2.5" PhysicalSizeZUnit="parsnip"',
        ].map(zStep),
      ),
    ).toEqual([[0, 2.5], [0, 2.5], [0, 2.5], [0, 0.5], [0, 2], undefined])
  })
})

// Six u16 channels: the first MAX_DEFAULT_VISIBLE (4) visible.
async function openSix() {
  const channels = Array.from(
    { length: 6 },
    (_, c) => `<Channel ID="Channel:0:${c}" Name="c${c}" SamplesPerPixel="1"/>`,
  ).join('')
  const xml = omeXml(
    'DimensionOrder="XYCZT" SizeX="40" SizeY="32" SizeC="6" SizeZ="1" SizeT="1" Type="uint16"',
    `${channels}<TiffData/>`,
  )
  const server = rangeServer(writePlanes(grayPlanes([0, 1, 2, 3, 4, 5]), xml))
  const source = await TiffSlideSource.fromUrl('http://test/six.ome.tif', {
    fetch: server.fetchImpl,
  })
  const changed: Array<[number, object]> = []
  const { host } = fakeHost()
  host.channelInfoChanged = (i, patch) => changed.push([i, patch])
  source.bind(host)
  return { source, server, changed }
}

describe('visible channels first (hidden ranges on first show)', () => {
  test('open reads only the visible channels; a hidden one states its window before its first tile', async () => {
    const { source, server, changed } = await openSix()
    const info = source.manifest.channelInfo ?? []
    expect(info.map((c) => [c.active, !!c.window])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [false, false],
      [false, false],
    ])
    const atOpen = server.requests.length
    const [lv, tile] = tileOf(source)
    const get = source.fetchTileSamples
    if (!get) throw new Error('no samples')
    // Two tiles at once share one range read; one aborted leaves the other.
    const ctrl = new AbortController()
    const a = get(lv, tile, [4], ctrl.signal)
    const b = get(lv, tile, [4, 5])
    ctrl.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const r = await b
    expect(r.samples[0]).toBe(4000)
    expect(changed.map(([i]) => i).sort()).toEqual([4, 5])
    expect(changed[0]?.[1]).toEqual({
      window: {
        calMin: bin(
          59,
          (changed[0]?.[0] ?? 0) * 1000 + 100,
          (changed[0]?.[0] ?? 0) * 1000 + 134,
        ),
        calMax: bin(
          941,
          (changed[0]?.[0] ?? 0) * 1000 + 100,
          (changed[0]?.[0] ?? 0) * 1000 + 134,
        ),
      },
    })
    expect(info[4]?.window).toBeDefined()
    // Once read, never again.
    await get(lv, tile, [4])
    expect(changed.length).toBe(2)
    expect(atOpen).toBeGreaterThan(0)
  })
})

describe('OME-TIFF z/t planes (SlidePlaneCapable)', () => {
  test('prepares another plane metadata-only; one bound source serves both', async () => {
    // XYCZT, SizeZ 2: z 1 is IFDs 2 and 3.
    const source = await openOme('XYCZT', [0, 1, 2, 3])
    expect(source.planes).toEqual({ z: 2, t: 1 })
    expect(source.manifest.levels.map((l) => l.plane)).toEqual([
      { z: 0, t: 0 },
      { z: 0, t: 0 },
    ])
    const prepare = source.preparePlane
    if (!prepare) throw new Error('not plane capable')
    const z1 = await prepare({ z: 1, t: 0 })
    expect(z1.levels.map((l) => l.plane)).toEqual([
      { z: 1, t: 0 },
      { z: 1, t: 0 },
    ])
    expect(z1.channelInfo).toEqual(source.manifest.channelInfo)
    const get = source.fetchTileSamples
    if (!get) throw new Error('no samples')
    const lv1 = z1.levels[0]
    const t1 = lv1?.tiles[0]
    if (!lv1 || !t1) throw new Error('missing tile')
    expect((await get(lv1, t1, [0, 1])).samples[0]).toBe(2000)
    expect(await planeIds(source, [0, 1])).toEqual([0, 1000])
    await expect(prepare({ z: 2, t: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(prepare({ z: 0, t: 1 })).rejects.toBeInstanceOf(RangeError)
    await expect(
      prepare({ z: 1, t: 0 }, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('a plane whose pyramid differs is refused (F14); fixed TIFFs are not plane capable', async () => {
    // z 1's channel planes are 8-bit while z 0's are 16-bit.
    const source = await openOme('XYCZT', [0, 1, 2, 3], {
      dtype: (id: number) => (id >= 2 ? { bits: 8 } : {}),
    })
    await expect(source.preparePlane?.({ z: 1, t: 0 })).rejects.toBeInstanceOf(
      RangeError,
    )
    const { source: fixed } = await open(writeTiff(PYRAMID))
    expect([fixed.planes, fixed.preparePlane]).toEqual([undefined, undefined])
    expect(fixed.manifest.levels[0]?.plane).toBeUndefined()
  })
})

describe('Range replies', () => {
  test('the file size is learned only from a reply that proved itself', async () => {
    const file = writeTiff(PYRAMID)
    const server = rangeServer(file, { contentRange: 'none' })
    let bogus = false
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      bogus
        ? new Response(new Uint8Array(3), {
            status: 206,
            headers: { 'content-range': 'bytes 0-99/120' },
          })
        : server.fetchImpl(url, init)) as typeof fetch
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: fetchImpl,
    })
    const { client } = source as unknown as {
      client: { size?: number; request(init: RequestInit): Promise<unknown> }
    }
    bogus = true
    await expect(
      client.request({ headers: { Range: 'bytes=0-99' } }),
    ).rejects.toThrow()
    expect(client.size).toBeUndefined()
  })

  test('a short reply is refused when Content-Range or a known size says so (T2)', async () => {
    const file = writeTiff(PYRAMID)
    const server = rangeServer(file)
    const inner = server.fetchImpl
    let truncate = false
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const r = await inner(url as string, init)
      if (!truncate) return r
      const body = (await r.arrayBuffer()).slice(0, 1000)
      return new Response(body, { status: 206, headers: r.headers })
    }) as typeof fetch
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: fetchImpl,
    })
    truncate = true
    const [lv, tile] = tileOf(source, 0, 9)
    // geotiff reports the refusal as "Request failed"; unrefused, it would
    // decode 1000 bytes as a whole block.
    await expect(source.fetchTileBytes(lv, tile, 't')).rejects.toThrow()
    const { client } = source as unknown as { client: { lastError: Error } }
    expect(client.lastError.message).toMatch(
      /expected \d+ bytes, received 1000/,
    )
  })

  test('a short or misplaced reply is read once more with no-store, then served', async () => {
    const file = writeTiff(PYRAMID)
    const server = rangeServer(file)
    let spoil: 'short' | 'misplaced' | null = null
    const caches: (RequestCache | undefined)[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      caches.push(init?.cache)
      const r = await server.fetchImpl(url as string, init)
      const kind = spoil
      spoil = null
      if (kind === 'short')
        return new Response((await r.arrayBuffer()).slice(0, 1000), {
          status: 206,
          headers: r.headers,
        })
      if (kind === 'misplaced') {
        const headers = new Headers(r.headers)
        headers.set(
          'Content-Range',
          (headers.get('Content-Range') ?? '').replace(/^bytes \d+/, 'bytes 1'),
        )
        return new Response(await r.arrayBuffer(), { status: 206, headers })
      }
      return r
    }) as typeof fetch
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: fetchImpl,
    })
    for (const [i, kind] of [
      [9, 'short'],
      [20, 'misplaced'],
    ] as const) {
      caches.length = 0
      spoil = kind
      const [lv, tile] = tileOf(source, 0, i)
      const bytes = await source.fetchTileBytes(lv, tile, kind)
      expect(bytes.length).toBe(tile.width * tile.height * 4)
      expect(caches).toEqual([undefined, 'no-store'])
    }
  })

  test('without Content-Range: a correct length (T5) and a last block past EOF (T2b) succeed', async () => {
    const file = writeTiff(PYRAMID)
    const { source, server } = await open(file, undefined, {
      contentRange: 'none',
    })
    const [lv, tile] = tileOf(source, 0, 47)
    const bytes = await source.fetchTileBytes(lv, tile, 'last')
    expect(bytes.length).toBe(tile.width * tile.height * 4)
    // The last 64 KiB block ran past EOF: a short body, accepted.
    expect(server.requests.some(([, end]) => end === file.byteLength - 1)).toBe(
      true,
    )
  })

  test('a reply longer than the range is refused before its body is read', async () => {
    const file = writeTiff(PYRAMID)
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init?.headers).get('Range') ?? '',
      )
      const start = Number(m?.[1])
      const body = file.slice(start, start + 70000)
      return new Response(body, {
        status: 206,
        headers: { 'Content-Length': String(body.byteLength) },
      })
    }) as typeof fetch
    await expect(
      TiffSlideSource.fromUrl('http://test/slide.tif', { fetch: fetchImpl }),
    ).rejects.toThrow(/reply to bytes=0-65535 is too long/)
  })

  test('a reply without Content-Length is cut off past its range', async () => {
    let pulled = 0
    let cancelled = false
    const fetchImpl = (async () =>
      new Response(
        // 1 MiB, far past the 64 KiB range: a capped read stops early.
        new ReadableStream({
          pull(c) {
            if (++pulled > 64) c.close()
            else c.enqueue(new Uint8Array(16384))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 206 },
      )) as unknown as typeof fetch
    await expect(
      TiffSlideSource.fromUrl('http://test/slide.tif', { fetch: fetchImpl }),
    ).rejects.toThrow(/reply to bytes=0-65535 body too large/)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })

  test('an abort mid-body rejects AbortError (T8)', async () => {
    const file = writeTiff(PYRAMID)
    const server = rangeServer(file)
    let stall = false
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const r = await server.fetchImpl(url as string, init)
      if (!stall) return r
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(10))
          signal?.addEventListener('abort', () =>
            c.error(new DOMException('aborted', 'AbortError')),
          )
        },
      })
      return new Response(body, { status: 206, headers: r.headers })
    }) as typeof fetch
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: fetchImpl,
    })
    stall = true
    const ctrl = new AbortController()
    const [lv, tile] = tileOf(source, 0, 9)
    const read = source.fetchTileBytes(lv, tile, 'm', ctrl.signal)
    await Bun.sleep(10)
    ctrl.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('redirect reuse', () => {
  // canonical -> resolved: the first read redirects; later ones may go direct.
  function redirecting(file: ArrayBuffer, resolved: string) {
    const server = rangeServer(file)
    const hits = { canonical: 0, resolved: 0, expired: 0 }
    let refuse = 0
    let status = 403
    let down = false
    let expiredUpTo = 0
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      // A signed target: each canonical read signs it anew.
      if (typeof url === 'string' && url.startsWith(resolved)) {
        hits.resolved++
        if (down) throw new TypeError('Failed to fetch') // e.g. CORS on the CDN
        if (refuse > 0) {
          refuse--
          return new Response('refused', { status })
        }
        if (Number(/&n=(\d+)$/.exec(url)?.[1] ?? 0) <= expiredUpTo) {
          hits.expired++
          return new Response('expired', { status: 403 })
        }
        return server.fetchImpl(url, init)
      }
      hits.canonical++
      const r = await server.fetchImpl(url as string, init)
      Object.defineProperty(r, 'redirected', { value: true })
      Object.defineProperty(r, 'url', {
        value: `${resolved}&n=${hits.canonical}`,
      })
      return r
    }) as typeof fetch
    return {
      fetchImpl,
      hits,
      expire: (code = 403) => {
        status = code
        refuse = 1
      },
      breakTarget: () => (down = true),
      /** Every signature issued so far expires; later ones work. */
      expireIssued: () => {
        expiredUpTo = hits.canonical
      },
    }
  }

  test('a same-origin redirect is reused; an expired target falls back to the canonical URL once', async () => {
    const file = writeTiff(PYRAMID)
    const r = redirecting(file, 'http://test/signed/slide.tif?sig=1')
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: r.fetchImpl,
    })
    expect(r.hits.canonical).toBe(1)
    expect(r.hits.resolved).toBeGreaterThan(0)
    r.expire()
    const before = { ...r.hits }
    const [lv, tile] = tileOf(source, 0, 9)
    await source.fetchTileBytes(lv, tile, 'x')
    // 403 from the target, then the canonical URL re-resolves it.
    expect(r.hits.canonical).toBe(before.canonical + 1)
    expect(r.hits.resolved).toBeGreaterThan(before.resolved)
  })

  test('any failed reply from the target falls back to the canonical URL once', async () => {
    const file = writeTiff(PYRAMID)
    const r = redirecting(file, 'http://test/signed/slide.tif?sig=1')
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: r.fetchImpl,
    })
    r.expire(500)
    const before = r.hits.canonical
    const [lv, tile] = tileOf(source, 0, 9)
    const bytes = await source.fetchTileBytes(lv, tile, 'x')
    expect(bytes.length).toBe(tile.width * tile.height * 4)
    expect(r.hits.canonical).toBe(before + 1)
  })

  test('a target that keeps failing is not learned again', async () => {
    const file = writeTiff(PYRAMID)
    const r = redirecting(file, 'http://test/signed/slide.tif?sig=1')
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: r.fetchImpl,
    })
    r.breakTarget()
    for (const i of [9, 20, 31, 40]) {
      const [lv, tile] = tileOf(source, 0, i)
      await source.fetchTileBytes(lv, tile, `t${i}`)
    }
    // Two failed targets (learned once again after the first), then none.
    const after = r.hits.resolved
    const [lv, tile] = tileOf(source, 0, 44)
    await source.fetchTileBytes(lv, tile, 't44')
    expect(r.hits.resolved).toBe(after)
  })

  test('reads in flight on one expired target count one failure: reuse survives', async () => {
    const file = writeTiff(PYRAMID)
    const r = redirecting(file, 'http://test/signed/slide.tif?sig=1')
    const source = await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: r.fetchImpl,
    })
    // Three reads in flight together on the same (now expired) signature.
    const { client } = source as unknown as {
      client: { request(init: RequestInit): Promise<unknown> }
    }
    r.expireIssued()
    await Promise.all(
      [0, 1, 2].map((k) =>
        client.request({
          headers: { Range: `bytes=${k * 1000}-${k * 1000 + 99}` },
        }),
      ),
    )
    expect(r.hits.expired).toBe(3)
    // Relearned from the canonical reads; a later read uses the target again.
    const before = r.hits.resolved
    const [lv, tile] = tileOf(source, 0, 44)
    await source.fetchTileBytes(lv, tile, 't44')
    expect(r.hits.resolved).toBeGreaterThan(before)
  })

  test("a caller's fetch never reuses a cross-origin redirect; the default fetch does", async () => {
    const file = writeTiff(PYRAMID)
    const custom = redirecting(file, 'http://cdn.other/slide.tif?sig=1')
    await TiffSlideSource.fromUrl('http://test/slide.tif', {
      fetch: custom.fetchImpl,
    })
    expect(custom.hits.resolved).toBe(0)
    const plain = redirecting(file, 'http://cdn.other/slide.tif?sig=1')
    const saved = globalThis.fetch
    globalThis.fetch = plain.fetchImpl
    try {
      await TiffSlideSource.fromUrl('http://test/slide.tif')
    } finally {
      globalThis.fetch = saved
    }
    expect(plain.hits.canonical).toBe(1)
    expect(plain.hits.resolved).toBeGreaterThan(0)
  })
})

describe('TIFF source lifetime', () => {
  test('dispose rejects a pending tile read with AbortError (L4)', async () => {
    const { source, server } = await open(writeTiff(PYRAMID))
    const [lv, tile] = tileOf(source, 0, 9)
    server.hold = true
    const requested = new Promise<void>((resolve) => {
      server.onRequest = resolve
    })
    const read = source.fetchTileBytes(lv, tile, 'd')
    await requested
    source.dispose()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })

  test("dispose leaves the caller's Pool working (L5)", async () => {
    const pool = new Pool(0)
    let destroyed = false
    pool.destroy = async () => {
      destroyed = true
    }
    const file = writeTiff(PYRAMID)
    const first = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(file),
      { pool },
    )
    first.dispose()
    expect(destroyed).toBe(false)
    const second = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(file),
      { pool },
    )
    const [lv, tile] = tileOf(second)
    expect((await second.fetchTileBytes(lv, tile, 'p')).length).toBe(
      128 * 128 * 4,
    )
  })
})

describe('JPEG 2000 tiles', () => {
  const tileOf = async (source: TiffSlideSource, x: number, y: number) => {
    const level = source.manifest.levels[0]
    const tile = level?.tiles[y * level.columns + x]
    if (!level || !tile) throw new Error('missing tile')
    return source.fetchTileBytes(level, tile, `${x},${y}`)
  }

  test('fail clearly until registered, then decode through dcm2niix', async () => {
    const j2k: Level = {
      width: 16,
      height: 16,
      tile: 16,
      compression: 34712,
      photometric: 2,
      tiles: [J2K_TILE],
    }
    const { source } = await open(writeTiff([j2k]))
    await expect(tileOf(source, 0, 0)).rejects.toThrow(
      /JPEG 2000 \(TIFF compression 34712\) has no built-in decoder/,
    )
    registerDcm2niixTiffDecoders()
    const rgba = await tileOf(source, 0, 0)
    expect(pixel(rgba, 16, 0, 0)).toEqual([0, 0, 128, 255])
    expect(pixel(rgba, 16, 5, 9)).toEqual([80, 144, 128, 255])
    expect(pixel(rgba, 16, 15, 15)).toEqual([240, 240, 128, 255])
  })

  // OpenSlide samples (openslide.cs.cmu.edu/download/openslide-testdata/Aperio),
  // read from disk when present. Expected pixels: OpenSlide 4 slidetool;
  // dcm2niix's OpenJPEG lands within 1.
  const dir = process.env.OPENSLIDE_APERIO ?? '/Volumes/TB5/openslide/Aperio'
  const samples = [
    // 33003: half-width YCbCr chroma. Tile 256, (14, 18) at (3584, 4608).
    {
      file: 'JP2K-33003-1.svs',
      tile: [14, 18],
      tileWidth: 256,
      pixels: [
        [100, 40, 95, 56, 119],
        [246, 182, 244, 108, 156],
        [200, 100, 187, 138, 167],
      ],
    },
    // 33005: RGB with MCT. Tile 240, (29, 93) at (6960, 22320).
    {
      file: 'CMU-1-JP2K-33005.svs',
      tile: [29, 93],
      tileWidth: 240,
      pixels: [
        [90, 10, 187, 122, 160],
        [230, 70, 189, 138, 168],
        [140, 180, 199, 107, 147],
      ],
    },
  ]
  for (const { file, tile, tileWidth, pixels } of samples) {
    const path = `${dir}/${file}`
    const present = existsSync(path)
    if (!present) console.log(`skip ${file}: not at ${path} (OPENSLIDE_APERIO)`)
    test.skipIf(!present)(`matches OpenSlide on ${file}`, async () => {
      registerDcm2niixTiffDecoders() // also when run alone (-t)
      const source = await TiffSlideSource.fromGeoTIFF(await fromFile(path))
      const rgba = await tileOf(source, tile[0] ?? 0, tile[1] ?? 0)
      for (const [x = 0, y = 0, ...rgb] of pixels) {
        const got = pixel(rgba, tileWidth, x, y)
        rgb.forEach((v, c) => {
          expect(Math.abs((got[c] ?? 0) - v)).toBeLessThanOrEqual(1)
        })
      }
      source.dispose()
    })
  }
})

describe('vendor layouts', () => {
  // A level of solid tiles: tile i of `level` filled with value (40 * level + i).
  const solid = (
    level: number,
    width: number,
    height: number,
    tile = 16,
  ): Level => {
    const n = Math.ceil(width / tile) * Math.ceil(height / tile)
    return {
      width,
      height,
      tile,
      compression: 1,
      photometric: 2,
      tiles: Array.from({ length: n }, (_, i) =>
        new Uint8Array(tile * tile * 3).fill((40 * level + i) & 255),
      ),
    }
  }
  const fromBuffer = async (file: ArrayBuffer, options = {}) =>
    TiffSlideSource.fromGeoTIFF(await fromArrayBuffer(file), options)
  const firstByte = async (
    source: TiffSlideSource,
    level: number,
    x: number,
    y = 0,
  ) => {
    const l = source.manifest.levels[level]
    const tile = l?.tiles[y * (l?.columns ?? 0) + x]
    if (!l || !tile) throw new Error('no tile')
    return (await source.fetchTileBytes(l, tile, 't'))[0]
  }

  const ventanaXmp = `<EncodeInfo Ver="2"><SlideStitchInfo><ImageInfo AOIScanned="1" AOIIndex="0" NumRows="1" NumCols="3" Width="16" Height="16">
<TileJointInfo FlagJoined="1" Confidence="100" Direction="LEFT" Tile1="1" Tile2="2" OverlapX="4" OverlapY="0"/>
<TileJointInfo FlagJoined="1" Confidence="100" Direction="LEFT" Tile1="2" Tile2="3" OverlapX="0" OverlapY="0"/>
</ImageInfo></SlideStitchInfo><AoiOrigin><AOI0 OriginX="0" OriginY="0"/></AoiOrigin></EncodeInfo>`

  test('Ventana joints: placed by default, the grid with placement: false (PL2, PL10)', async () => {
    const file = writeTiff([
      { ...solid(0, 48, 16), ascii: { 700: ventanaXmp } },
      solid(1, 24, 8),
    ])
    const plain = await fromBuffer(file, { placement: false })
    expect(plain.manifest.width).toBe(48)
    expect(plain.manifest.levels.some((l) => l.placement)).toBe(false)
    // Off: byte-for-byte the manifest of the same file without XMP.
    const noXmp = await fromBuffer(
      writeTiff([solid(0, 48, 16), solid(1, 24, 8)]),
    )
    expect(JSON.stringify(plain.manifest)).toBe(JSON.stringify(noXmp.manifest))
    const placed = await fromBuffer(file)
    expect([placed.manifest.width, placed.manifest.height]).toEqual([44, 16])
    expect(placed.manifest.levels[0]?.width).toBe(48) // storage grid kept (F7)
    expect(placed.manifest.levels[0]?.placement?.pieces[1]).toEqual({
      tile: 1,
      sx: 2,
      sy: 0,
      sw: 14,
      sh: 16,
      dx: 14,
      dy: 0,
    })
    expect(placed.manifest.levels[1]?.placement?.width).toBe(22)
    // The residual of every joined seam is visible to the caller.
    expect(plain.placementReport).toBeUndefined()
    const seams = placed.placementReport?.seams ?? []
    expect(seams.length).toBeGreaterThan(0)
    expect(seams.every((m) => m.rx === 0 && m.ry === 0)).toBe(true)
  })

  test('an XMP past 16 MiB is not read: placement skipped with a warning', async () => {
    const huge = ventanaXmp + ' '.repeat(17 << 20)
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const s = await fromBuffer(
      writeTiff([{ ...solid(0, 48, 16), ascii: { 700: huge } }]),
    )
    warn.mockRestore()
    expect(s.manifest.width).toBe(48)
    expect(s.placementReport?.warning).toMatch(/XMP not read: tag 700 over/)
  })

  test('Ventana joints that do not resolve keep the grid with a warning', async () => {
    const bad = ventanaXmp.replace(
      'Direction="LEFT" Tile1="1"',
      'Direction="DIAGONAL" Tile1="1"',
    )
    const warn = console.warn
    const warnings: unknown[] = []
    console.warn = (m: unknown) => warnings.push(m)
    try {
      const s = await fromBuffer(
        writeTiff([{ ...solid(0, 48, 16), ascii: { 700: bad } }]),
      )
      expect(s.manifest.width).toBe(48)
      expect(s.manifest.levels[0]?.placement).toBeUndefined()
      expect(s.placementReport?.warning).toMatch(/joint 1-2/)
    } finally {
      console.warn = warn
    }
    expect(String(warnings[0])).toMatch(
      /Ventana tile joints not applied: joint 1-2/,
    )
  })

  test('Trestle overlaps: every level kept, placed at its stitched size', async () => {
    const file = writeTiff([
      {
        ...solid(0, 64, 32, 32),
        ascii: { 270: 'Objective Power=10;OverlapsXY= 16 16' },
      },
      // Its own mosaic: not the base aspect, so not a level without placement.
      solid(1, 48, 16),
    ])
    expect(
      (await fromBuffer(file, { placement: false })).manifest.levels.length,
    ).toBe(1)
    const s = await fromBuffer(file)
    expect(s.manifest.levels.length).toBe(2)
    expect([s.manifest.width, s.manifest.height]).toEqual([48, 32])
    expect(s.manifest.levels[0]?.placement?.pieces).toEqual([
      { tile: 0, sx: 0, sy: 0, sw: 24, sh: 32, dx: 0, dy: 0 },
      { tile: 1, sx: 8, sy: 0, sw: 24, sh: 32, dx: 24, dy: 0 },
    ])
    // Level 1 states no overlap: its 3 tiles abut.
    expect(s.manifest.levels[1]?.placement?.width).toBe(48)
  })

  test('Argos z-stack: the middle plane by default, the others by preparePlane', async () => {
    const xml =
      '<Argos.Scan.Metadata><ZRange>2</ZRange><MinZ>-1</MinZ><MaxZ>1</MaxZ></Argos.Scan.Metadata>'
    const plane = (z: number): Level[] => [
      solid(z * 2, 32, 32),
      solid(z * 2 + 1, 16, 16),
    ]
    const levels = [...plane(0), ...plane(1), ...plane(2)]
    levels[0] = { ...(levels[0] as Level), ascii: { 65000: xml } }
    const s = await fromBuffer(writeTiff(levels))
    expect(s.planes).toEqual({ z: 3, t: 1 })
    expect(s.manifest.levels[0]?.plane).toEqual({ z: 1, t: 0 })
    expect(await firstByte(s, 0, 1)).toBe(81) // plane 1, level 0, tile 1
    const m0 = await s.preparePlane?.({ z: 0, t: 0 })
    const l = m0?.levels[1]
    expect(
      l &&
        (
          await s.fetchTileBytes(
            l,
            l.tiles[0] as NonNullable<(typeof l.tiles)[0]>,
            't',
          )
        )[0],
    ).toBe(40)
    await expect(
      s.preparePlane?.({ z: 3, t: 0 }) ?? Promise.resolve(),
    ).rejects.toThrow(RangeError)
    // An explicit z opens that plane: its manifest, pixels and the slide's plane.
    const z2 = await fromBuffer(writeTiff(levels), { z: 2 })
    expect(z2.manifest.levels[0]?.plane).toEqual({ z: 2, t: 0 })
    expect(await firstByte(z2, 0, 1)).toBe(161) // plane 2, level 0, tile 1
    expect(NVSlide.fromSource(z2).planeIndex).toEqual({ z: 2, t: 0 })
  })

  test('Ventana iScan: levels padded to 8 px blocks keep their true size', async () => {
    // 64x40 / 2 = 32x20 stored 32x24, / 4 = 16x10 stored 16x16; a tiled 16x48
    // label is not a level.
    const level = (n: number, w: number, h: number) => ({
      ...solid(n, w, h),
      ascii: { 270: `level=${n - 1} mag=${40 >> (n - 1)} quality=90` },
    })
    const levels = [
      solid(0, 64, 40),
      solid(1, 16, 48),
      level(2, 32, 24),
      level(3, 16, 16),
    ]
    const m = (await fromBuffer(writeTiff(levels))).manifest
    expect(m.levels.map((l) => [l.width, l.height, l.downsample])).toEqual([
      [64, 40, 1],
      [32, 20, 2],
      [16, 10, 4],
    ])
    // An unmarked tiled macro the size of a padded level is not one.
    const macro = [solid(0, 64, 40), solid(1, 32, 24)]
    const plain = (await fromBuffer(writeTiff(macro))).manifest
    expect(plain.levels.map((l) => l.width)).toEqual([64])
  })

  test('Philips: a padded level at a stated factor of 3', async () => {
    const rep = (n: number, c: number, r: number, s: number) =>
      `<DataObject ObjectType="PixelDataRepresentation"><Attribute Name="DICOM_PIXEL_SPACING">&quot;${s}&quot; &quot;${s}&quot;</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_COLUMNS">${c}</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_NUMBER">${n}</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_ROWS">${r}</Attribute></DataObject>`
    const xml = `<DataObject ObjectType="DPUfsImport">${rep(0, 112, 64, 0.00025)}${rep(1, 48, 32, 0.00075)}</DataObject>`
    // 100x60 / 3 = 34x20, padded to 16 px tiles: 48x32.
    const levels = [solid(0, 100, 60), { ...solid(1, 48, 32), subfileType: 1 }]
    expect((await fromBuffer(writeTiff(levels))).manifest.levels.length).toBe(1)
    levels[0] = { ...(levels[0] as Level), ascii: { 270: xml } }
    const m = (await fromBuffer(writeTiff(levels))).manifest
    expect(m.levels.map((l) => [l.width, l.height, l.downsample])).toEqual([
      [100, 60, 1],
      [34, 20, 3],
    ])
  })

  test('Leica spacing comes from the regions opened, not their sizes', async () => {
    // um per pixel over 250 nm collection px: brightfield 0.5, fluorescence 1.
    const image = (w: number, h: number, ifd: number, x: number, um: number) =>
      `<image><pixels sizeX="${w}" sizeY="${h}"><dimension r="0" ifd="${ifd}" /></pixels><view sizeX="${w * um * 1000}" sizeY="${h * um * 1000}" offsetX="${x}" offsetY="0" /><illuminationSource>${um === 1 ? 'fluorescence' : 'brightfield'}</illuminationSource></image>`
    const open = async (
      xml: string,
      sizes: [number, number][],
      placement: boolean,
    ) =>
      (
        await fromBuffer(
          writeTiff(
            sizes.map(([w, h], i) => ({
              ...solid(i, w, h),
              ...(i ? {} : { ascii: { 270: xml } }),
            })),
          ),
          { placement },
        )
      ).manifest.pixelSpacingMM
    const scn = (body: string) =>
      `<scn><collection sizeX="1000000" sizeY="1000000">${body}</collection></scn>`
    // Two 16x16 brightfield regions compose to 32x16, a fluorescence region's size.
    const composed = scn(
      image(16, 16, 0, 0, 0.5) +
        image(16, 16, 1, 20000, 0.5) +
        image(32, 16, 2, 40000, 1),
    )
    const sizes: [number, number][] = [
      [16, 16],
      [16, 16],
      [32, 16],
    ]
    expect(await open(composed, sizes, true)).toEqual([0.0005, 0.0005])
    expect(await open(composed, sizes, false)).toEqual([0.001, 0.001])
    // Same-size regions at different resolutions.
    const twins = scn(image(16, 16, 0, 0, 0.5) + image(16, 16, 1, 20000, 1))
    const both: [number, number][] = [
      [16, 16],
      [16, 16],
    ]
    expect(await open(twins, both, false)).toEqual([0.0005, 0.0005])
    expect(await open(twins, both, true)).toEqual([0.0005, 0.0005])
  })

  test('Leica regions: side by side in one grid, placed by their views', async () => {
    const image = (w: number, h: number, ifd: number, x: number, y: number) =>
      `<image><pixels sizeX="${w}" sizeY="${h}"><dimension sizeX="${w}" sizeY="${h}" r="0" ifd="${ifd}" /></pixels><view sizeX="${w * 250}" sizeY="${h * 250}" offsetX="${x}" offsetY="${y}" spacingZ="0" /><illuminationSource>brightfield</illuminationSource></image>`
    const xml = `<?xml version="1.0"?><scn><collection sizeX="100000" sizeY="100000">${image(16, 48, 0, 0, 0).replace('sizeX="4000" sizeY="12000"', 'sizeX="100000" sizeY="100000"')}${image(32, 32, 1, 10000, 0)}${image(32, 16, 2, 20000, 4000)}</collection></scn>`
    const levels = [
      { ...solid(0, 16, 48), ascii: { 270: xml } },
      solid(1, 32, 32),
      solid(2, 32, 16),
    ]
    const plain = await fromBuffer(writeTiff(levels), { placement: false })
    expect(plain.manifest.width).toBe(32)
    expect(plain.manifest.levels[0]?.placement).toBeUndefined()
    const s = await fromBuffer(writeTiff(levels))
    const l0 = s.manifest.levels[0]
    expect([l0?.columns, l0?.rows]).toEqual([4, 2])
    // Region 2 has one row of tiles: its second row is a hole.
    expect(l0?.tiles[6]).toBeNull()
    expect(await firstByte(s, 0, 1, 1)).toBe(43) // region 1, tile (1,1)
    expect(await firstByte(s, 0, 3)).toBe(81) // region 2, tile (1,0)
    // Collection px of 250 nm: region 2 at (40, 16), extent 72 x 32.
    expect([s.manifest.width, s.manifest.height]).toEqual([72, 32])
    expect(l0?.placement?.pieces.find((p) => p.tile === 2)).toMatchObject({
      dx: 40,
      dy: 16,
    })
    // A tile in no region (the hole) reads absent, with one warning.
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (m: unknown) => warned.push(m)
    try {
      for (const _ of [0, 1]) {
        const hole = await s.fetchTileBytes(
          l0 as NonNullable<typeof l0>,
          { x: 2, y: 1, width: 16, height: 16 },
          'hole',
        )
        expect([hole.length, hole.some((v) => v !== 0)]).toEqual([1024, false])
      }
    } finally {
      console.warn = warn
    }
    expect(warned.length).toBe(1)
  })
})

// 32x16 baseline JPEG, 8x8 MCUs, a restart every 2 MCUs (cjpeg -restart 2B):
// 2 intervals per MCU row, 2 rows; intervals start at these strip offsets.
const NDPI_JPEG = Uint8Array.from(
  atob(
    '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQACADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAC/9oADAMBAAIRAxEAPwD4/wBJ+FPT9z+lfttbOPM+Ky3P9veOy0n4Vfd/c/pXhVs48z9Vy3P9veP/0PB9J+FPT9z+lfl9bOPM/ovLc/2947PSfhT0/c/pXh1s48z9Vy3P9veP/9GxpPwq+7+5/Ssq2ceZ/HeW59tqdnpPwp6fuf0rw62ceZ+rZbn22p//0vUNJ+FPT9z+lfx9WzjzM8tz/bU7PSfhV939z+leHWzjzP1XLc/21P/Z',
  ),
  (c) => c.charCodeAt(0),
)
const STARTS = [611, 655, 698, 739]
// A JPEG strip as NDPI writes one: strip tags instead of tile tags.
const ndpiStrip = (jpeg: Uint8Array, lens: number): Level => ({
  width: 32,
  height: 16,
  tile: 16,
  compression: 7,
  photometric: 6,
  tiles: [jpeg],
  float: { 65421: lens },
  longs: lens > 0 ? { 65426: STARTS } : {},
  edit: (e) => {
    for (const x of e) {
      if (x[0] === 322)
        x[0] = 278 // RowsPerStrip (16)
      else if (x[0] === 324) x[0] = 273
      else if (x[0] === 325) x[0] = 279
    }
    e.splice(
      e.findIndex((x) => x[0] === 323),
      1,
    )
  },
})

describe('NDPI virtual tiles', () => {
  test('levels are the magnified strips, read as JPEG tiles of whole intervals', async () => {
    const s = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(
        writeTiff([ndpiStrip(NDPI_JPEG, 20), ndpiStrip(NDPI_JPEG, -1)]),
      ),
    )
    const l0 = s.manifest.levels[0]
    expect(s.manifest.levels.length).toBe(1) // the macro (lens -1) is not a level
    expect(
      l0 && [
        l0.codec,
        l0.columns,
        l0.rows,
        l0.tiles[0]?.width,
        l0.tiles[0]?.height,
      ],
    ).toEqual(['image/jpeg', 1, 1, 32, 16])
    // All four intervals, renumbered as stored: the strip's JPEG itself.
    const bytes =
      l0 &&
      (await s.fetchTileBytes(
        l0,
        l0.tiles[0] as NonNullable<(typeof l0.tiles)[0]>,
        't',
      ))
    expect(bytes).toEqual(NDPI_JPEG)
  })
})

describe('NDPI level size and offsets', () => {
  test('the level size is the TIFF ImageWidth/ImageLength, not the 16-bit SOF', async () => {
    const jpeg = NDPI_JPEG.slice()
    // SOF0 at 0xffc0: height then width. A level past 65535 px wraps there.
    const sof = jpeg.findIndex((v, i) => v === 0xff && jpeg[i + 1] === 0xc0)
    jpeg[sof + 7] = 0
    jpeg[sof + 8] = 0 // width 0, as 65536 + 0 would store
    const s = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(writeTiff([ndpiStrip(jpeg, 20)])),
    )
    const l0 = s.manifest.levels[0]
    expect(l0 && [l0.width, l0.columns, l0.tiles[0]?.width]).toEqual([
      32, 1, 32,
    ])
    const bytes =
      l0 &&
      (await s.fetchTileBytes(
        l0,
        l0.tiles[0] as NonNullable<(typeof l0.tiles)[0]>,
        't',
      ))
    expect(bytes).toEqual(NDPI_JPEG)
  })

  test('a failed offset-table read is retried by the next tile', async () => {
    const s = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(writeTiff([ndpiStrip(NDPI_JPEG, 20)])),
    )
    const l0 = s.manifest.levels[0]
    if (!l0) throw new Error('no level')
    const { opened } = s as unknown as {
      opened: { pyramids: { img: GeoTIFFImage }[][] }
    }
    const dir = opened.pyramids[0]?.[0]?.img.fileDirectory
    if (!dir) throw new Error('no image')
    const real = dir.loadValue.bind(dir)
    let fail = true
    dir.loadValue = ((tag: unknown) => {
      if (tag === 65426 && fail) {
        fail = false
        return Promise.reject(new Error('read failed'))
      }
      return real(tag as never)
    }) as typeof dir.loadValue
    const tile = l0.tiles[0] as NonNullable<(typeof l0.tiles)[0]>
    await expect(s.fetchTileBytes(l0, tile, 'a')).rejects.toThrow('read failed')
    expect(await s.fetchTileBytes(l0, tile, 'b')).toEqual(NDPI_JPEG)
  })
})

describe('NDPI hostile offsets', () => {
  const open = async () => {
    const s = await TiffSlideSource.fromGeoTIFF(
      await fromArrayBuffer(writeTiff([ndpiStrip(NDPI_JPEG, 20)])),
    )
    const l0 = s.manifest.levels[0]
    if (!l0) throw new Error('no level')
    const { opened, tiff } = s as unknown as {
      opened: {
        pyramids: {
          ndpi: {
            strip: number
            count: number
            starts?: unknown
            jpeg?: unknown
          }
        }[][]
      }
      tiff: {
        source: { fetch: (s: { offset: number; length: number }[]) => unknown }
      }
    }
    const ndpi = opened.pyramids[0]?.[0]?.ndpi
    if (!ndpi) throw new Error('no NDPI level')
    const lengths: number[] = []
    const spans: { offset: number; length: number }[] = []
    const real = tiff.source.fetch.bind(tiff.source)
    tiff.source.fetch = (spansIn, ...rest: unknown[]) => {
      for (const sp of spansIn) {
        lengths.push(sp.length)
        spans.push(sp)
      }
      return (real as (...a: unknown[]) => unknown)(spansIn, ...rest)
    }
    const tile = l0.tiles[0] as NonNullable<(typeof l0.tiles)[0]>
    return { s, l0, tile, ndpi, lengths, spans }
  }

  test('a short restart table fails the tile, with no NaN offsets', async () => {
    const { s, l0, tile, ndpi } = await open()
    ndpi.starts = Promise.resolve([611])
    await expect(s.fetchTileBytes(l0, tile, 't')).rejects.toThrow(
      '1 restart offsets for 4 intervals',
    )
  })

  test('offsets past the strip are clamped to it: no read runs past the strip', async () => {
    const { s, l0, tile, ndpi, spans } = await open()
    ndpi.starts = Promise.resolve([4e9, 655, 698, 739])
    await s.fetchTileBytes(l0, tile, 't').catch(() => {})
    expect(spans.length).toBeGreaterThan(0)
    for (const sp of spans) {
      expect(sp.length).toBeGreaterThanOrEqual(0)
      expect(sp.offset + sp.length).toBeLessThanOrEqual(ndpi.strip + ndpi.count)
    }
  })

  test('a strip without restart markers past the cap is refused unread', async () => {
    const { s, l0, tile, ndpi, lengths } = await open()
    ndpi.jpeg = undefined
    ndpi.count = 2 ** 32
    await expect(s.fetchTileBytes(l0, tile, 't')).rejects.toThrow(
      'without restart markers',
    )
    expect(lengths).toEqual([])
  })
})

// Advisory: the real Ventana-1.bif when present.
const BIF = '/Users/chris/src/mono/scratch/ventana/Ventana-1.bif'
describe.skipIf(!existsSync(BIF))('Ventana-1.bif placement (advisory)', () => {
  test('placed 23432 x 21504; off, the storage grid', async () => {
    const tiff = await fromFile(BIF)
    const plain = await TiffSlideSource.fromGeoTIFF(tiff, { placement: false })
    expect(plain.manifest.width).toBe(24576)
    const placed = await TiffSlideSource.fromGeoTIFF(tiff)
    expect([placed.manifest.width, placed.manifest.height]).toEqual([
      23432, 21504,
    ])
    const l3 = placed.manifest.levels[3]?.placement?.pieces.filter(
      (p) => p.tile === 0,
    )
    expect(l3?.map((p) => [p.sx, p.sw, p.dx])).toEqual([
      [0, 510.5, 0],
      [513.5, 509, 510.5],
    ])
    placed.dispose()
  })
})
