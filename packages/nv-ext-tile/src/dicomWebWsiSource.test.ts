import { afterEach, describe, expect, test } from 'bun:test'
import type { NVSlideTileManifest } from '@niivue/niivue'
import { type DicomJsonSlide, indexDicomWsiMetadata } from './dicomJson'
import { DicomWebWsiSource } from './dicomWebWsiSource'
import { parseMultipartRelated } from './multipart'

const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`
const SERIES = 'https://pacs.test/dicomweb/studies/1.2.3.1/series/1.2.3.2'

type Json = Record<string, unknown>
const json = async (name: string): Promise<Json> =>
  Bun.file(`${DIR}/${name}.json`).json()

async function slideOf(
  name: string,
  edit: (o: Json) => void = () => {},
): Promise<DicomJsonSlide> {
  const o = await json(name)
  edit(o)
  const slide = indexDicomWsiMetadata([o]).slides[0]
  if (!slide) throw new Error(`${name} indexed no slide`)
  return slide
}

const enc = new TextEncoder()
function multipart(payload: Uint8Array, boundary = 'B0UND'): Uint8Array {
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--\r\n`)
  const out = new Uint8Array(head.length + payload.length + tail.length)
  out.set(head)
  out.set(payload, head.length)
  out.set(tail, head.length + payload.length)
  return out
}

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 2, 0xff, 0xd9,
])
const JLS = new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0, 2, 0xff, 0xd9])

interface Call {
  url: string
  headers: Record<string, string>
}
let calls: Call[] = []
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  calls = []
})

/** Answers every request with `respond(url)`, recording its URL and headers. */
function serve(respond: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = String(input)
    calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
    })
    return respond(url)
  }) as typeof fetch
}
const part = (bytes: Uint8Array) =>
  new Response(multipart(bytes), {
    headers: { 'content-type': 'multipart/related; boundary=B0UND' },
  })

const firstTile = (s: DicomWebWsiSource) => {
  const level = s.manifest.levels[0]
  const tile = level?.tiles.find((t): t is NVSlideTileManifest => !!t)
  if (!level || !tile) throw new Error('no tile')
  return { level, tile }
}

describe('DicomWebWsiSource', () => {
  test('fetches each tile by WADO-RS frame URL with headers read per request', async () => {
    serve(() => part(JPEG))
    let token = 'a'
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
      headers: () => ({ Authorization: `Bearer ${token}` }),
    })
    expect(calls).toEqual([]) // the syntax is indexed: no probe
    expect(s.manifest.levels[0]?.codec).toBe('image/jpeg')
    const { level, tile } = firstTile(s)
    expect(await s.fetchTileBytes(level, tile, '')).toEqual(JPEG)
    token = 'b'
    await s.fetchTileBytes(level, tile, '')
    expect(calls[0]?.url).toBe(
      `${SERIES}/instances/1.2.3.10/frames/${tile.frame}`,
    )
    expect(calls[0]?.headers.Accept).toBe(
      'multipart/related; type="image/jpeg"',
    )
    expect(calls.map((c) => c.headers.Authorization)).toEqual([
      'Bearer a',
      'Bearer b',
    ])
  })

  test('keeps a query on the series URL after the frame number', async () => {
    serve(() => part(JPEG))
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: `${SERIES}?access_token=t`,
    })
    const { level, tile } = firstTile(s)
    await s.fetchTileBytes(level, tile, '')
    expect(calls[0]?.url).toEndWith(`/frames/${tile.frame}?access_token=t`)
  })

  test('drops trailing slashes on the series URL and encodes the instance UID', async () => {
    serve(() => part(JPEG))
    const slide = await slideOf('bot', (o) => {
      const paths = (o['00480105'] as { Value: Json[] }).Value
      ;(paths[0] as Json)['00282000'] = { vr: 'OB', BulkDataURI: 'bulk/icc' }
    })
    ;(slide.instances[0] as { id: string }).id = '../../x?y=1#'
    const s = await DicomWebWsiSource.open(slide, {
      seriesUrl: `${SERIES}//?t=1`,
    })
    const { level, tile } = firstTile(s)
    await s.fetchTileBytes(level, tile, '')
    await s.fetchIccProfile()
    expect(calls.map((c) => c.url)).toEqual([
      `${SERIES}/instances/..%2F..%2Fx%3Fy%3D1%23/frames/${tile.frame}?t=1`,
      `${SERIES}/bulk/icc?t=1`,
    ])
  })

  test('probes one frame per level when the metadata states no transfer syntax', async () => {
    serve(() => part(JLS))
    const slide = await slideOf('bot', (o) => {
      delete o['00020010']
    })
    expect(slide.instances[0]?.transferSyntax).toBe('')
    const s = await DicomWebWsiSource.open(slide, { seriesUrl: SERIES })
    expect(calls.length).toBe(slide.levels.length)
    expect(calls[0]?.headers.Accept).toContain('transfer-syntax=*')
    expect(s.manifest.levels[0]?.codec).toBe('image/jls')
    expect(s.manifest.levels[0]?.transferSyntaxUid).toBe(
      '1.2.840.10008.1.2.4.80',
    )
  })

  /** bot plus its second level, both without a stated transfer syntax. */
  async function twoLevels(): Promise<DicomJsonSlide> {
    const os = [await json('bot'), await json('bot-l1')]
    for (const o of os) delete o['00020010']
    const slide = indexDicomWsiMetadata(os).slides[0]
    if (slide?.levels.length !== 2) throw new Error('expected two levels')
    return slide
  }

  test('sniffs all levels concurrently', async () => {
    const release: (() => void)[] = []
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) =>
        release.push(() => resolve(part(JLS))),
      )) as unknown as typeof fetch
    const opened = DicomWebWsiSource.open(await twoLevels(), {
      seriesUrl: SERIES,
    })
    await Bun.sleep(0)
    const inFlight = release.length
    for (const r of release) r()
    expect(inFlight).toBe(2)
    const s = await opened
    expect(s.manifest.levels.map((l) => l.codec)).toEqual([
      'image/jls',
      'image/jls',
    ])
  })

  test('assumes JPEG Baseline when the server refuses the sniff', async () => {
    serve(() => new Response('no', { status: 406 }))
    const s = await DicomWebWsiSource.open(await twoLevels(), {
      seriesUrl: SERIES,
    })
    expect(calls.length).toBe(2)
    expect(s.manifest.levels.map((l) => l.transferSyntaxUid)).toEqual([
      '1.2.840.10008.1.2.4.50',
      '1.2.840.10008.1.2.4.50',
    ])
    expect(s.manifest.levels[0]?.codec).toBe('image/jpeg')
    serve(() => part(JPEG))
    const { level, tile } = firstTile(s)
    expect(await s.fetchTileBytes(level, tile, '')).toEqual(JPEG)
    expect(calls[2]?.headers.Accept).toBe(
      'multipart/related; type="image/jpeg"',
    )
  })

  test('rejects a sniff the server refuses for another reason (401)', async () => {
    serve(() => new Response('no', { status: 401 }))
    await expect(
      DicomWebWsiSource.open(await twoLevels(), { seriesUrl: SERIES }),
    ).rejects.toThrow('WSI frame HTTP 401')
  })

  test('rejects an aborted sniff with AbortError', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        ),
      )) as unknown as typeof fetch
    const ac = new AbortController()
    const opened = DicomWebWsiSource.open(
      await twoLevels(),
      { seriesUrl: SERIES },
      ac.signal,
    )
    ac.abort()
    expect(((await opened.catch((e) => e)) as Error).name).toBe('AbortError')
  })

  test('rejects sniffed bytes that are no supported codec, and network errors', async () => {
    serve(() => part(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))
    const slide = await twoLevels()
    await expect(
      DicomWebWsiSource.open(slide, { seriesUrl: SERIES }),
    ).rejects.toThrow('not JPEG')
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError('Failed to fetch'),
      )) as unknown as typeof fetch
    await expect(
      DicomWebWsiSource.open(slide, { seriesUrl: SERIES }),
    ).rejects.toThrow('Failed to fetch')
  })

  test('refuses a JPEG-LS tile the server transcoded', async () => {
    serve(() => part(JPEG))
    const s = await DicomWebWsiSource.open(await slideOf('mono12'), {
      seriesUrl: SERIES,
    })
    const { level, tile } = firstTile(s)
    expect(level.codec).toBe('image/jls')
    await expect(s.fetchTileBytes(level, tile, '')).rejects.toThrow(
      'transcoded',
    )
  })

  test('caps a body by Content-Length and while streaming', async () => {
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
    })
    const { level, tile } = firstTile(s)
    serve(
      () =>
        new Response('x', { headers: { 'content-length': String(65 << 20) } }),
    )
    await expect(s.fetchTileBytes(level, tile, '')).rejects.toThrow('too large')
    const mb = new Uint8Array(1 << 20)
    let sent = 0
    serve(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (sent++ < 65) c.enqueue(mb)
              else c.close()
            },
          }),
        ),
    )
    await expect(s.fetchTileBytes(level, tile, '')).rejects.toThrow('too large')
  })

  test('cancels a refused body', async () => {
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
    })
    const { level, tile } = firstTile(s)
    let cancelled = 0
    const body = () =>
      new ReadableStream({
        pull() {},
        cancel() {
          cancelled++
        },
      })
    serve(() => new Response(body(), { status: 503 }))
    await expect(s.fetchTileBytes(level, tile, '')).rejects.toThrow('HTTP 503')
    serve(
      () =>
        new Response(body(), {
          headers: { 'content-length': String(65 << 20) },
        }),
    )
    await expect(s.fetchTileBytes(level, tile, '')).rejects.toThrow('too large')
    expect(cancelled).toBe(2)
  })

  test('passes the abort signal to fetch', async () => {
    serve(() => part(JPEG))
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
    })
    const { level, tile } = firstTile(s)
    const ac = new AbortController()
    ac.abort()
    await expect(s.fetchTileBytes(level, tile, '', ac.signal)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test('serves an inline ICC profile without a request', async () => {
    serve(() => part(JPEG))
    const s = await DicomWebWsiSource.open(await slideOf('planes'), {
      seriesUrl: SERIES,
    })
    expect((await s.fetchIccProfile())?.length).toBeGreaterThan(0)
    expect(calls).toEqual([])
  })

  test('fetches bulk ICC data relative to the series, with auth only on its origin', async () => {
    const icc = new Uint8Array([1, 2, 3])
    serve(() => part(icc))
    const headers = () => ({ Authorization: 'Bearer a' })
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
      headers,
    })
    expect(await s.fetchIccProfile()).toEqual(icc)
    expect(calls[0]?.url).toBe(`${SERIES}/bulk/1.2.3.10/00282000`)
    expect(calls[0]?.headers.Authorization).toBe('Bearer a')

    const elsewhere = await DicomWebWsiSource.open(
      await slideOf('bot', (o) => {
        const paths = (o['00480105'] as { Value: Json[] }).Value
        ;(paths[0] as Json)['00282000'] = {
          vr: 'OB',
          BulkDataURI: 'https://cdn.test/icc',
        }
      }),
      { seriesUrl: SERIES, headers },
    )
    expect(await elsewhere.fetchIccProfile()).toEqual(icc)
    expect(calls[1]?.url).toBe('https://cdn.test/icc')
    expect(calls[1]?.headers.Authorization).toBeUndefined()
  })

  test('carries a series query to same-origin bulk ICC data only', async () => {
    serve(() => part(new Uint8Array([1])))
    const withBulk = (uri: string) =>
      slideOf('bot', (o) => {
        const paths = (o['00480105'] as { Value: Json[] }).Value
        ;(paths[0] as Json)['00282000'] = { vr: 'OB', BulkDataURI: uri }
      })
    const options = { seriesUrl: `${SERIES}?access_token=t` }
    for (const uri of ['bulk/icc', 'bulk/icc?v=1', 'https://cdn.test/icc'])
      await (
        await DicomWebWsiSource.open(await withBulk(uri), options)
      ).fetchIccProfile()
    expect(calls.map((c) => c.url)).toEqual([
      `${SERIES}/bulk/icc?access_token=t`,
      `${SERIES}/bulk/icc?v=1`,
      'https://cdn.test/icc',
    ])
  })

  test('resolves a relative series URL against the page', async () => {
    serve(() => part(JPEG))
    const g = globalThis as { location?: unknown }
    const saved = g.location
    g.location = { href: 'https://pacs.test/viewer/' }
    try {
      const s = await DicomWebWsiSource.open(await slideOf('bot'), {
        seriesUrl: '/dicomweb/s?t=1',
        headers: () => ({ Authorization: 'Bearer a' }),
      })
      const { level, tile } = firstTile(s)
      await s.fetchTileBytes(level, tile, '')
      await s.fetchIccProfile()
    } finally {
      g.location = saved
    }
    expect(calls[0]?.url).toStartWith('https://pacs.test/dicomweb/s/instances/')
    expect(calls[1]?.url).toBe(
      'https://pacs.test/dicomweb/s/bulk/1.2.3.10/00282000?t=1',
    )
    expect(calls[1]?.headers.Authorization).toBe('Bearer a')
  })

  test('retrieves bulk ICC data through the host hook when given', async () => {
    serve(() => part(JPEG))
    const asked: string[] = []
    const s = await DicomWebWsiSource.open(await slideOf('bot'), {
      seriesUrl: SERIES,
      retrieveBulkData: async (url) => {
        asked.push(url)
        return new Uint8Array([7]).buffer
      },
    })
    expect(await s.fetchIccProfile()).toEqual(new Uint8Array([7]))
    expect(asked).toEqual([`${SERIES}/bulk/1.2.3.10/00282000`])
    expect(calls).toEqual([])
  })
})

describe('parseMultipartRelated', () => {
  test('extracts parts byte-exact, with or without the boundary in Content-Type', () => {
    const a = new Uint8Array([0x44, 0x00, 0x0d, 0x0a, 0xff])
    expect(
      parseMultipartRelated(
        multipart(a, 'XY'),
        'multipart/related; boundary="XY"',
      ),
    ).toEqual([a])
    expect(
      parseMultipartRelated(multipart(a, 'XY'), 'multipart/related'),
    ).toEqual([a])
  })

  test('reads a boundary only after CRLF, as a delimiter line', () => {
    const a = enc.encode('abc--boundXYZ\r\n--boundary-ish')
    expect(
      parseMultipartRelated(multipart(a, 'bound'), 'multipart/related'),
    ).toEqual([a])
    // One '-' or "--" plus other bytes after the boundary is part data.
    const c = enc.encode('one\r\n--bound--X\r\ntwo\r\n--bound-\r\n')
    expect(
      parseMultipartRelated(multipart(c, 'bound'), 'multipart/related'),
    ).toEqual([c])
    // A closing delimiter may end the body with no CRLF.
    expect(
      parseMultipartRelated(
        enc.encode('--bound\r\n\r\nthree\r\n--bound--'),
        'multipart/related; boundary=bound',
      ),
    ).toEqual([enc.encode('three')])
    // Padding after the opening delimiter is not part of a recovered boundary.
    expect(
      parseMultipartRelated(
        enc.encode('--B \t\r\nX: y\r\n\r\none\r\n--B--\r\n'),
        'multipart/related',
      ),
    ).toEqual([enc.encode('one')])
    // A preamble before the first delimiter, two parts, transport padding.
    const b = enc.encode('two')
    const body = enc.encode(
      'preamble\r\n--bound\r\n\r\nabc--bound\r\n--bound \r\nX: y\r\n\r\ntwo\r\n--bound--',
    )
    expect(
      parseMultipartRelated(body, 'multipart/related; boundary=bound'),
    ).toEqual([enc.encode('abc--bound'), b])
  })

  test('returns a single-part body whole, and nothing for an empty one', () => {
    expect(parseMultipartRelated(JPEG, 'image/jpeg')).toEqual([JPEG])
    expect(parseMultipartRelated(new Uint8Array(), 'image/jpeg')).toEqual([])
  })
})
