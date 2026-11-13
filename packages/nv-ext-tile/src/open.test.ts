import { describe, expect, spyOn, test } from 'bun:test'
import NiiVue, { ManifestRangeSource, NVSlide } from '@niivue/niivue'
import { readAssociatedImage } from './dicomAssociated'
import { DicomWsiSource } from './dicomWsiSource'
import {
  openSlide,
  resolveSlideSource,
  SLIDE_SOURCE_KIND,
  sniffSlide,
} from './open'
import type { SlideFetch } from './rangeFetch'
import { TiffSlideSource } from './tiff'

// Bun has no FileReader; geotiff-rs's fromBlob reads a File through one.
class BlobReader {
  result: ArrayBuffer | null = null
  onload: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onabort: (() => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then((b) => {
      this.result = b
      this.onload?.()
    }, this.onerror)
  }
  abort(): void {}
}
;(globalThis as { FileReader?: unknown }).FileReader ??= BlobReader

const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`
const dcm = async (...names: string[]) =>
  Promise.all(
    names.map(
      async (n) => new File([await Bun.file(`${DIR}/${n}`).arrayBuffer()], n),
    ),
  )

/** A one-tile 16x16 8-bit RGB uncompressed little-endian TIFF. */
function tinyTiff(dicm = false): Uint8Array<ArrayBuffer> {
  const side = 16
  const pixels = side * side * 3
  const entries: [number, number, number, number][] = [
    [256, 3, 1, side], // ImageWidth
    [257, 3, 1, side], // ImageLength
    [258, 3, 1, 8], // BitsPerSample (one value applies to every sample)
    [259, 3, 1, 1], // Compression none
    [262, 3, 1, 2], // RGB
    [277, 3, 1, 3], // SamplesPerPixel
    [322, 3, 1, side], // TileWidth
    [323, 3, 1, side], // TileLength
    [324, 4, 1, 0], // TileOffsets, patched below
    [325, 4, 1, pixels], // TileByteCounts
  ]
  const ifd = 140 // past a 132-byte DICOM preamble + DICM slot
  const data = ifd + 2 + entries.length * 12 + 4
  const b = new Uint8Array(data + pixels)
  const v = new DataView(b.buffer)
  b.set([0x49, 0x49, 42, 0])
  v.setUint32(4, ifd, true)
  if (dicm) b.set([0x44, 0x49, 0x43, 0x4d], 128)
  v.setUint16(ifd, entries.length, true)
  for (const [i, [tag, type, count, value]] of entries.entries()) {
    const at = ifd + 2 + i * 12
    v.setUint16(at, tag, true)
    v.setUint16(at + 2, type, true)
    v.setUint32(at + 4, count, true)
    const val = tag === 324 ? data : value
    if (type === 3) v.setUint16(at + 8, val, true)
    else v.setUint32(at + 8, val, true)
  }
  b.fill(200, data)
  return b
}

const noFetch: SlideFetch = () => {
  throw new Error('fetched')
}

/** A one-level 4x4 hosted range manifest. */
const rangeManifest = (tiles: object[] = []) => ({
  id: 'm',
  format: 'dicom-wsi-range-v1',
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
      codec: 'image/jpeg',
      fileUrl: 'l0.dcm',
      tiles,
    },
  ],
})

describe('sniffSlide', () => {
  test('names a URL by its path without a read', async () => {
    const cases: [string, string][] = [
      ['https://h.test/a.zarr', 'zarr'],
      ['https://h.test/a.ome.zarr/', 'zarr'],
      ['https://h.test/store/', 'zarr'],
      ['https://h.test/a.dzi', 'dzi'],
      ['https://h.test/m.json?x=1', 'manifest'],
      ['https://h.test/CMU-1.svs', 'tiff'],
      ['https://h.test/Ventana-1.bif', 'tiff'],
    ]
    for (const [url, kind] of cases)
      expect(await sniffSlide(url, { fetch: noFetch })).toBe(kind as never)
  })

  test('probes an unnamed URL with one bounded Range read through the custom fetch', async () => {
    const seen: (string | null)[] = []
    const reply =
      (
        body: Uint8Array<ArrayBuffer> | string,
        type = 'application/octet-stream',
      ) =>
      (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('Range'))
        return Promise.resolve(
          new Response(body, {
            status: 206,
            headers: { 'content-type': type },
          }),
        )
      }
    expect(
      await sniffSlide('https://h.test/blob', { fetch: reply(tinyTiff()) }),
    ).toBe('tiff')
    expect(
      await sniffSlide('https://h.test/blob', {
        fetch: reply('{"levels":[]}', 'application/json'),
      }),
    ).toBe('manifest')
    expect(
      await sniffSlide('https://h.test/blob', {
        fetch: reply('<Image TileSize="256"/>', 'application/xml'),
      }),
    ).toBe('dzi')
    expect(seen).toEqual(['bytes=0-131', 'bytes=0-131', 'bytes=0-131'])
    await expect(
      sniffSlide('https://h.test/blob', { fetch: reply('GIF89a') }),
    ).rejects.toThrow('not a TIFF')
  })

  test('an unnamed URL probe settles on abort though the fetch ignores it', async () => {
    const settled = (p: Promise<unknown>) =>
      Promise.race([
        p.then(
          () => 'resolved',
          (e: Error) => e.name,
        ),
        new Promise((r) => setTimeout(() => r('pending'), 100)),
      ])
    let cancelled = false
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      }),
      { status: 206 },
    )
    for (const fetch of [
      () => new Promise<Response>(() => {}),
      async () => stalled,
    ]) {
      const ac = new AbortController()
      const sniffed = sniffSlide('https://host.test/unknown', {
        fetch,
        signal: ac.signal,
      })
      await new Promise((r) => setTimeout(r, 0))
      ac.abort()
      expect(await settled(sniffed)).toBe('AbortError')
    }
    expect(cancelled).toBe(true)
  })

  test('reads files by magic bytes; several files are a DICOM folder', async () => {
    const tiff = new File([tinyTiff()], 'x.dat')
    const dual = new File([tinyTiff(true)], 'y.dat')
    const [bot] = await dcm('bot.dcm')
    expect(await sniffSlide(tiff)).toBe('tiff')
    expect(await sniffSlide(dual)).toBe('dicom-tiff')
    expect(await sniffSlide([bot as File])).toBe('dicom')
    expect(await sniffSlide([tiff, dual])).toBe('dicom')
  })
})

describe('openSlide', () => {
  test('a DICOM folder lists every slide and opens none', async () => {
    const files = await dcm('paths.dcm', 'not-dicom.dcm')
    const opened = await openSlide(files)
    expect(opened.kind).toBe('dicom')
    expect(opened.index?.skipped.map((s) => s.file)).toEqual(['not-dicom.dcm'])
    expect(opened.candidates.length).toBe(opened.index?.slides.length ?? -1)
    expect(opened.candidates.length).toBeGreaterThan(1)
    expect(opened.candidates[1]?.slide).toBe(opened.index?.slides[1])
    const source = await opened.candidates[1]?.open()
    expect(source).toBeInstanceOf(DicomWsiSource)
    expect(source?.manifest.id).toBe(
      `${opened.index?.slides[1]?.series}/${opened.index?.slides[1]?.opticalPath}/${opened.index?.slides[1]?.focalPlane}`,
    )
  })

  test('one local TIFF is one candidate', async () => {
    const opened = await openSlide(new File([tinyTiff()], 'one.tif'))
    expect(opened.kind).toBe('tiff')
    expect(opened.candidates.map((c) => c.label)).toEqual(['one.tif'])
    const source = await opened.candidates[0]?.open()
    expect(source).toBeInstanceOf(TiffSlideSource)
    expect(source?.manifest.width).toBe(16)
    source?.dispose?.()
  })

  test('a dual-personality file with no DICOM slide opens as its TIFF', async () => {
    const opened = await openSlide(new File([tinyTiff(true)], 'dual.tif'))
    expect(opened.kind).toBe('tiff')
    expect(opened.index?.slides).toEqual([])
    expect(await opened.candidates[0]?.open()).toBeInstanceOf(TiffSlideSource)
  })

  test('a hosted manifest reply is refused past 64 MiB, Content-Length or not', async () => {
    let pulled = 0
    const fetch: SlideFetch = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (++pulled > 100) c.close()
            else c.enqueue(new Uint8Array(1 << 20))
          },
        }),
      )
    const opened = await openSlide('https://h.test/s/m.json', { fetch })
    await expect(opened.candidates[0]?.open()).rejects.toThrow(
      'Slide manifest body too large',
    )
    expect(pulled).toBeLessThanOrEqual(66)
  })

  describe('a hosted manifest with a fetch that ignores its signal', () => {
    const manifest = {
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
          codec: 'image/jpeg',
          fileUrl: 'l0.dcm',
          tiles: [{ x: 0, y: 0, width: 4, height: 4, offset: 0, length: 4 }],
        },
      ],
    }
    // A reply whose body never ends; `cancelled` once its stream is cancelled.
    const endless = () => {
      const state = { cancelled: false }
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            state.cancelled = true
          },
        }),
      )
      return { state, response }
    }
    const settled = (p: Promise<unknown> | undefined) =>
      Promise.race([
        p?.then(
          () => 'resolved',
          (e: Error) => e.name,
        ),
        new Promise((r) => setTimeout(() => r('pending'), 100)),
      ])
    const tick = () => new Promise((r) => setTimeout(r, 0))

    test('an aborted open rejects though the manifest arrives', async () => {
      const fetch: SlideFetch = async () => Response.json(manifest)
      const opened = await openSlide('https://h.test/s/m.json', { fetch })
      expect(
        await settled(opened.candidates[0]?.open(AbortSignal.abort())),
      ).toBe('AbortError')
    })

    test('an abort during a stalled body rejects and cancels it', async () => {
      const reply = endless()
      const fetch: SlideFetch = async (url) =>
        url.endsWith('.json')
          ? reply.response
          : new Response(null, { status: 404 })
      const opened = await openSlide('https://h.test/s/m.json', { fetch })
      const ac = new AbortController()
      const pending = opened.candidates[0]?.open(ac.signal)
      await tick()
      ac.abort()
      expect(await settled(pending)).toBe('AbortError')
      expect(reply.state.cancelled).toBe(true)
    })

    test('a reply after the abort is refused and its body cancelled', async () => {
      let release = (_: Response) => {}
      const fetch: SlideFetch = () => new Promise((r) => (release = r))
      const opened = await openSlide('https://h.test/s/m.json', { fetch })
      const ac = new AbortController()
      const pending = opened.candidates[0]?.open(ac.signal)
      await tick()
      ac.abort()
      const late = endless()
      release(late.response)
      expect(await settled(pending)).toBe('AbortError')
      await tick()
      expect(late.state.cancelled).toBe(true)
    })
  })

  test('a hosted manifest reads through the custom fetch, relative to its URL', async () => {
    const urls: string[] = []
    const manifest = {
      ...rangeManifest([
        { x: 0, y: 0, width: 4, height: 4, offset: 10, length: 4 },
      ]),
      attribution: { credit: 'm', url: 'javascript:alert(1)' },
    }
    const fetch: SlideFetch = async (url) => {
      urls.push(url)
      return url.endsWith('.json')
        ? Response.json(manifest)
        : new Response(new Uint8Array(4), { status: 206 })
    }
    const own = await openSlide('https://h.test/s/m.json', { fetch })
    const ownSource = await own.candidates[0]?.open()
    // The manifest's own attribution is untrusted: a javascript: url is dropped.
    expect(ownSource?.manifest.attribution).toEqual({ credit: 'm' })
    urls.length = 0
    const opened = await openSlide('https://h.test/s/m.json', {
      fetch,
      attribution: { credit: 'c' },
    })
    expect(opened.kind).toBe('manifest')
    const source = await opened.candidates[0]?.open()
    expect(source).toBeInstanceOf(ManifestRangeSource)
    expect(source?.manifest.attribution).toEqual({ credit: 'c' })
    source?.bind({
      resolveUrl: (u) => u,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent() {},
      updateRangeEvent() {},
      channelInfoChanged() {},
    })
    const level = source?.manifest.levels[0]
    if (!source || !level) throw new Error('no level')
    await source.fetchTileBytes(level, level.tiles[0] as never, 'L0')
    expect(urls).toEqual(['https://h.test/s/m.json', 'https://h.test/s/l0.dcm'])
  })

  test('a document reopens a URL slide by its descriptor, never a local one', async () => {
    const manifest = rangeManifest()
    const urls: string[] = []
    const fetch: SlideFetch = async (url) => {
      urls.push(url)
      return Response.json(manifest)
    }
    const url = 'https://h.test/s/m.json'
    const opened = await (await openSlide(url, { fetch })).candidates[0]?.open()
    const descriptor = opened?.descriptor
    expect(descriptor).toEqual({
      kind: SLIDE_SOURCE_KIND,
      url,
      params: { format: 'manifest' },
    })
    if (!descriptor) throw new Error('no descriptor')
    const resolve = resolveSlideSource({ fetch })
    const signal = new AbortController().signal
    urls.length = 0
    const again = await resolve(descriptor, {
      signal,
      streamed: false,
      slide: true,
    })
    expect(again).toBeInstanceOf(ManifestRangeSource)
    expect((again as { descriptor?: unknown }).descriptor).toEqual(descriptor)
    expect(urls).toEqual([url])
    // A volume restore, or a file this page cannot reach again, is not ours.
    expect(resolve(descriptor, { signal, streamed: false })).toBeNull()
    const local = await (
      await openSlide(new File([tinyTiff()], 'one.tif'))
    ).candidates[0]?.open()
    expect(local?.descriptor?.params).toEqual({ format: 'tiff', local: true })
    if (!local?.descriptor) throw new Error('no descriptor')
    expect(
      resolve(local.descriptor, { signal, streamed: false, slide: true }),
    ).toBeNull()
    local.dispose?.()
  })

  test("a hosted manifest's same-origin baseUrl survives a saved document", async () => {
    const base = rangeManifest([
      { x: 0, y: 0, width: 4, height: 4, offset: 10, length: 4 },
    ])
    // NVSlide needs one plane per DICOM-WSI level.
    const manifest = {
      ...base,
      levels: base.levels.map((l) => ({
        ...l,
        plane: { z: 0, t: 0 },
        opticalPaths: 1,
        focalPlanes: 1,
      })),
    }
    const urls: string[] = []
    const fetch: SlideFetch = async (url) => {
      urls.push(url)
      return url.endsWith('.json')
        ? Response.json(manifest)
        : new Response(new Uint8Array(4), { status: 206 })
    }
    // NiiVue schedules renders with requestAnimationFrame, absent under bun.
    const g = globalThis as Record<string, unknown>
    const had = { raf: g.requestAnimationFrame, cancel: g.cancelAnimationFrame }
    g.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)
    g.cancelAnimationFrame = clearTimeout
    const save = async (baseUrl: string) => {
      const nv = new NiiVue({ backend: 'webgl2' })
      const src = await (
        await openSlide('https://h.test/s/m.json', { fetch, baseUrl })
      ).candidates[0]?.open()
      if (!src) throw new Error('no source')
      nv.setSlidePlane(NVSlide.fromSource(src), {
        pixelToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      })
      const bytes = nv.serializeDocument({ format: 'json' })
      nv.destroy()
      return bytes
    }
    const reopen = async (bytes: Uint8Array) => {
      const nv = new NiiVue({ backend: 'webgl2' })
      const resolve = resolveSlideSource({ fetch })
      let reopened: unknown = null
      await nv.loadDocument(new File([new Uint8Array(bytes)], 'doc.nvd'), {
        resolveSource: (d, ctx) => {
          const r = resolve(d, ctx)
          reopened = r
          return r
        },
      })
      const again = (await reopened) as ManifestRangeSource | null
      const level = again?.manifest.levels[0]
      if (!again || !level) throw new Error('no level')
      urls.length = 0
      await again.fetchTileBytes(level, level.tiles[0] as never, 'L0')
      nv.destroy()
      return urls[0]
    }
    try {
      const same = await save('https://h.test/data/?sig=secret')
      // Saved as a path: no host, query or credentials.
      expect(new TextDecoder().decode(same)).toContain('"baseUrl":"/data/"')
      expect(new TextDecoder().decode(same)).not.toContain('secret')
      expect(await reopen(same)).toBe('https://h.test/data/l0.dcm')
      // A cross-origin base is not saved: tiles resolve against the manifest.
      const cross = await save('https://cdn.test/data/')
      expect(new TextDecoder().decode(cross)).not.toContain('cdn.test')
      expect(await reopen(cross)).toBe('https://h.test/s/l0.dcm')
    } finally {
      g.requestAnimationFrame = had.raf
      g.cancelAnimationFrame = had.cancel
    }
  })

  test('the resolver reopens a DZI with the global fetch and a TIFF with its saved placement', async () => {
    const signal = new AbortController().signal
    const ctx = { signal, streamed: false, slide: true }
    const resolve = resolveSlideSource({ fetch: () => Promise.reject() })
    const dziUrl = 'https://h.test/a.dzi'
    const globalFetch = spyOn(globalThis, 'fetch').mockImplementation(((
      _u: string,
    ) => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch)
    const fromUrl = spyOn(TiffSlideSource, 'fromUrl').mockImplementation(() =>
      Promise.reject(new Error('stub')),
    )
    try {
      const dzi = {
        kind: SLIDE_SOURCE_KIND,
        url: dziUrl,
        params: { format: 'dzi' },
      }
      await expect(resolve(dzi, ctx)).rejects.not.toThrow('no custom fetch')
      expect(globalFetch.mock.calls[0]?.[0]).toBe(dziUrl)
      const local = await (
        await openSlide(new File([tinyTiff()], 'one.tif'), {
          tiff: { placement: false },
        })
      ).candidates[0]?.open()
      expect(local?.descriptor?.params).toEqual({
        format: 'tiff',
        local: true,
        placement: false,
      })
      local?.dispose?.()
      const tif = {
        kind: SLIDE_SOURCE_KIND,
        url: 'https://h.test/a.tif',
        params: { format: 'tiff', placement: false },
      }
      await expect(resolve(tif, ctx)).rejects.toThrow('stub')
      expect(fromUrl.mock.calls[0]?.[1]?.placement).toBe(false)
    } finally {
      globalFetch.mockRestore()
      fromUrl.mockRestore()
    }
  })

  test('a custom fetch reaches a Zarr store; DZI refuses one', async () => {
    const urls: string[] = []
    const fetch: SlideFetch = async (url) => {
      urls.push(url)
      return new Response('', { status: 404 })
    }
    const zarr = await openSlide('https://h.test/a.zarr', { fetch })
    await expect(zarr.candidates[0]?.open()).rejects.toThrow()
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://h.test/a.zarr/'))).toBe(true)
    const dzi = await openSlide('https://h.test/a.dzi', { fetch })
    await expect(dzi.candidates[0]?.open()).rejects.toThrow('no custom fetch')
  })

  test('the Zarr adapter hands a plain init, so a spreading auth wrapper keeps signal and headers', async () => {
    const seen: RequestInit[] = []
    const base: SlideFetch = async () => new Response('', { status: 404 })
    // An auth wrapper of the common shape: spread init, add a header.
    const fetch: SlideFetch = (url, init) => {
      const spread = { ...init, headers: { ...init?.headers, Auth: 'x' } }
      seen.push(spread)
      return base(url, spread)
    }
    const ac = new AbortController()
    const zarr = await openSlide('https://h.test/a.zarr', {
      fetch,
      signal: ac.signal,
    })
    await expect(zarr.candidates[0]?.open()).rejects.toThrow()
    expect(seen.length).toBeGreaterThan(0)
    for (const init of seen) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.method).toBe('GET')
    }
  })

  test('several local TIFFs, and TIFFs beside a DICOM folder, are all listed', async () => {
    const a = new File([tinyTiff()], 'a.tif')
    const b = new File([tinyTiff()], 'b.tif')
    const two = await openSlide([a, b])
    expect(two.kind).toBe('tiff')
    expect(two.candidates.map((c) => c.label)).toEqual(['a.tif', 'b.tif'])
    const mixed = await openSlide([a, ...(await dcm('paths.dcm'))])
    expect(mixed.kind).toBe('dicom')
    // Input order: the TIFF given first is listed first, and last when given last.
    expect(mixed.candidates[0]?.label).toBe('a.tif')
    const after = await openSlide([...(await dcm('paths.dcm')), a])
    expect(after.candidates.at(-1)?.label).toBe('a.tif')
    expect(after.candidates[0]?.kind).toBe('dicom')
    expect(mixed.candidates.filter((c) => c.kind === 'tiff').length).toBe(1)
    expect(mixed.candidates.filter((c) => c.kind === 'dicom').length).toBe(
      mixed.index?.slides.length ?? -1,
    )
    expect(mixed.index?.skipped).toEqual([])
  })

  test('same-named files stay distinct: the slide opens, and input order holds', async () => {
    const same = async (n: string) =>
      new File([await Bun.file(`${DIR}/${n}`).arrayBuffer()], 'same.dcm')
    const tif = new File([tinyTiff()], 'same.dcm')
    const opened = await openSlide([
      tif,
      await same('bot.dcm'),
      await same('bot-l1.dcm'),
    ])
    expect(opened.candidates.map((c) => c.kind)).toEqual(['tiff', 'dicom'])
    expect(opened.index?.slides[0]?.instances.length).toBe(2)
    const source = await opened.candidates[1]?.open()
    expect(source?.manifest.levels.length).toBe(2)
    source?.dispose?.()
  })

  test('an associated image reads against the input files when a TIFF shares its name', async () => {
    const label = new File(
      [await Bun.file(`${DIR}/label.dcm`).arrayBuffer()],
      'a.dcm',
    )
    const files = [new File([tinyTiff()], 'a.dcm'), label]
    const [image] = (await openSlide(files)).index?.associated ?? []
    if (!image) throw new Error('label')
    expect((await readAssociatedImage(image, files)).width).toBe(16)
  })

  test('the open signal and the candidate signal both abort', async () => {
    const ac = new AbortController()
    const opened = await openSlide(new File([tinyTiff()], 'one.tif'), {
      signal: ac.signal,
    })
    ac.abort()
    await expect(
      opened.candidates[0]?.open(new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('a DICOM candidate honours the open and candidate signals', async () => {
    const ac = new AbortController()
    const opened = await openSlide(await dcm('bot.dcm'), { signal: ac.signal })
    const candidate = opened.candidates[0]
    const cancel = new AbortController()
    cancel.abort()
    await expect(candidate?.open(cancel.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    ac.abort()
    await expect(candidate?.open()).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test("a manifest's tile file on another origin never reaches the caller's fetch", async () => {
    const manifest = {
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
          codec: 'image/jpeg',
          fileUrl: 'https://cdn.other/l0.dcm',
          tiles: [{ x: 0, y: 0, width: 4, height: 4, offset: 10, length: 4 }],
        },
      ],
    }
    const authed: string[] = []
    const fetch: SlideFetch = async (url) => {
      authed.push(url)
      return Response.json(manifest)
    }
    const plain: [string, RequestInit | undefined][] = []
    const saved = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      plain.push([url, init])
      return new Response(new Uint8Array(4), { status: 206 })
    }) as typeof globalThis.fetch
    try {
      const opened = await openSlide('https://h.test/s/m.json', { fetch })
      const source = await opened.candidates[0]?.open()
      source?.bind({
        resolveUrl: (u) => u,
        addWireBytes() {},
        rangeHit() {},
        rangeFallback() {},
        pushRangeEvent() {},
        updateRangeEvent() {},
        channelInfoChanged() {},
      })
      const level = source?.manifest.levels[0]
      if (!source || !level) throw new Error('no level')
      await source.fetchTileBytes(level, level.tiles[0] as never, 'L0')
    } finally {
      globalThis.fetch = saved
    }
    expect(authed).toEqual(['https://h.test/s/m.json'])
    expect(plain.map(([u, i]) => [u, i?.credentials])).toEqual([
      ['https://cdn.other/l0.dcm', 'omit'],
    ])
  })

  test("a tile on the manifest's origin gets the caller's fetch with a cross-origin baseUrl", async () => {
    const manifest = {
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
          codec: 'image/jpeg',
          fileUrl: 'https://auth.test/tile.bin',
          tiles: [{ x: 0, y: 0, width: 4, height: 4, offset: 10, length: 4 }],
        },
      ],
    }
    const authed: string[] = []
    const fetch: SlideFetch = async (url) => {
      authed.push(url)
      return url.endsWith('.json')
        ? Response.json(manifest)
        : new Response(new Uint8Array(4), { status: 206 })
    }
    const opened = await openSlide('https://auth.test/m.json', {
      fetch,
      baseUrl: 'https://cdn.test/tiles/',
    })
    const source = await opened.candidates[0]?.open()
    source?.bind({
      resolveUrl: (u) => u,
      addWireBytes() {},
      rangeHit() {},
      rangeFallback() {},
      pushRangeEvent() {},
      updateRangeEvent() {},
      channelInfoChanged() {},
    })
    const level = source?.manifest.levels[0]
    if (!source || !level) throw new Error('no level')
    await source.fetchTileBytes(level, level.tiles[0] as never, 'L0')
    expect(authed).toEqual([
      'https://auth.test/m.json',
      'https://auth.test/tile.bin',
    ])
  })

  test('TIFF options pass through', async () => {
    const opened = await openSlide(new File([tinyTiff()], 'one.tif'), {
      tiff: { id: 'named' },
    })
    const source = await opened.candidates[0]?.open()
    expect(source?.manifest.id).toBe('named')
    source?.dispose?.()
  })

  test('the signal aborts a DICOM index', async () => {
    const files = await dcm('bot.dcm')
    const ac = new AbortController()
    ac.abort()
    await expect(openSlide(files, { signal: ac.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    )
  })
})
