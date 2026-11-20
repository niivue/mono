import { afterEach, expect, test } from 'bun:test'
import { idcS3Files } from './idcS3'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// IDC's SQL index locates the series; S3 lists and serves its instances.
function serve(instanceCount: number): string[] {
  const urls: string[] = []
  globalThis.fetch = (async (input: string) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/v3/sql'))
      return Response.json({
        rows: [
          {
            aws_bucket: 'idc-open-data',
            crdc_series_uuid: 'u1',
            instanceCount,
          },
        ],
      })
    if (url.includes('/?list-type=2'))
      return new Response(
        '<ListBucketResult><Key>u1/a.dcm</Key><Key>u1/b.dcm</Key></ListBucketResult>',
      )
    return new Response(url.endsWith('a.dcm') ? 'A' : 'B')
  }) as unknown as typeof fetch
  return urls
}

test('an IDC series comes whole from S3; a partial display set falls back', async () => {
  serve(2)
  const files = await idcS3Files('1.2.3', 2)
  expect(files?.map((f) => f.name)).toEqual(['a.dcm', 'b.dcm'])
  expect(await files?.[1]?.text()).toBe('B')
  // OHIF split the series (2 instances indexed, 1 in the display set).
  const urls = serve(2)
  expect(await idcS3Files('1.2.3', 1)).toBeNull()
  expect(urls.some((u) => u.includes('amazonaws'))).toBe(false)
})

// External audit: one failed GET stops the rest before DICOMweb takes over.
test('a failed S3 object stops further S3 downloads', async () => {
  const urls: string[] = []
  let release = () => {}
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/v3/sql'))
      return Response.json({
        rows: [
          { aws_bucket: 'idc-b', crdc_series_uuid: 'u', instanceCount: 5 },
        ],
      })
    if (url.includes('/?list-type=2'))
      return new Response(
        ['a', 'b', 'c', 'd', 'e'].map((k) => `<Key>u/${k}.dcm</Key>`).join(''),
      )
    if (url.endsWith('a.dcm')) return new Response('', { status: 503 })
    // b is slow, and aborted with its siblings.
    return new Promise<Response>((resolve, reject) => {
      release = () => resolve(new Response('B'))
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
  }) as unknown as typeof fetch
  expect(await idcS3Files('1.2.3', 5, { concurrency: 2 })).toBeNull()
  release()
  await new Promise((r) => setTimeout(r, 10))
  expect(
    urls.filter((u) => u.endsWith('.dcm')).map((u) => u.slice(-5)),
  ).toEqual(['a.dcm', 'b.dcm'])
})

test('an already aborted signal sends no request', async () => {
  const urls = serve(2)
  const ac = new AbortController()
  ac.abort()
  await expect(idcS3Files('1.2.3', 2, { signal: ac.signal })).rejects.toThrow()
  expect(urls).toEqual([])
})
