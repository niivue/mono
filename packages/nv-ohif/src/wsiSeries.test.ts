import { describe, expect, it } from 'bun:test'
import { wsiFetch, wsiRetrieveBulkData, wsiSeriesSlide } from './wsiSeries'

// nv-ext-tile's DICOM-WSI fixtures, as PS3.18 DICOM JSON.
const DIR = `${import.meta.dir}/../../nv-ext-tile/fixtures/dicom-wsi`
const instance = async (name: string): Promise<Record<string, unknown>> => ({
  ...(await Bun.file(`${DIR}/${name}.json`).json()),
  imageId: 'wadors:https://h/dicomweb/studies/1/series/2/instances/3/frames/1',
})

describe('wsiSeriesSlide', () => {
  it('returns the slide and its series URL', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('bot')] })
    expect('slide' in r && r.seriesUrl).toBe(
      'https://h/dicomweb/studies/1/series/2',
    )
  })

  it('refuses several optical paths rather than showing the first', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('paths')] })
    expect('note' in r && r.note).toContain('2 optical paths')
  })

  it('refuses several focal planes rather than showing the first', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('planes')] })
    expect('note' in r && r.note).toContain('2 focal planes')
  })

  it('takes the series URL past a side image that names no series', async () => {
    const r = wsiSeriesSlide({
      instances: [
        { imageId: 'wadouri:https://h/side.dcm' },
        await instance('bot'),
      ],
    })
    expect('slide' in r && r.seriesUrl).toBe(
      'https://h/dicomweb/studies/1/series/2',
    )
  })

  it('notes imageIds that name no WADO-RS series', async () => {
    const r = wsiSeriesSlide({
      instances: [{ ...(await instance('bot')), imageId: 'wadouri:x.dcm' }],
    })
    expect('note' in r && r.note).toContain('WADO-RS series')
  })

  it('notes a series without tiled levels', () => {
    const r = wsiSeriesSlide({ instances: [] })
    expect('note' in r && r.note).toContain('no tiled (VOLUME) pyramid levels')
  })
})

describe('wsiRetrieveBulkData', () => {
  it('is undefined without retrieve.bulkDataURI', () => {
    expect(wsiRetrieveBulkData(undefined, '1')).toBeUndefined()
    expect(wsiRetrieveBulkData({ retrieve: {} }, '1')).toBeUndefined()
  })

  it('retrieves through the data source', async () => {
    const asked: unknown[] = []
    const buf = new Uint8Array([7]).buffer
    const retrieve = wsiRetrieveBulkData(
      {
        retrieve: {
          bulkDataURI: async (o: unknown) => {
            asked.push(o)
            return buf
          },
        },
      },
      '1',
    )
    expect(await retrieve?.('https://h/bulk')).toBe(buf)
    expect(asked).toEqual([
      { StudyInstanceUID: '1', BulkDataURI: 'https://h/bulk' },
    ])
  })

  it('rejects on abort without waiting for the data source', async () => {
    const retrieve = wsiRetrieveBulkData(
      { retrieve: { bulkDataURI: () => new Promise(() => {}) } },
      '1',
    )
    const abort = new AbortController()
    const pending = retrieve?.('https://h/bulk', abort.signal)
    abort.abort()
    expect(await pending?.catch((e: DOMException) => e.name)).toBe('AbortError')
    await expect(retrieve?.('https://h/bulk', abort.signal)).rejects.toThrow()
  })
})

describe('wsiFetch', () => {
  it('adds the current token to each request and keeps the source init', async () => {
    const seen: Record<string, string>[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)
      return new Response()
    }) as typeof fetch
    let token = 'a'
    const services = {
      userAuthenticationService: {
        getAuthorizationHeader: () => ({ Authorization: `Bearer ${token}` }),
      },
    }
    try {
      const f = wsiFetch({ services })
      await f('u', { headers: { Accept: 'x' } })
      token = 'b'
      await f('u', { headers: { Accept: 'x' } })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen).toEqual([
      { Accept: 'x', Authorization: 'Bearer a' },
      { Accept: 'x', Authorization: 'Bearer b' },
    ])
  })
})
