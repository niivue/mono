import { afterEach, describe, expect, it } from 'bun:test'
import {
  fetchWsiThumbnailObjectUrl,
  frameEncoding,
  pickThumbnailInstance,
  rawImageInfo,
} from './wsiThumbnail'

const JPEG = '1.2.840.10008.1.2.4.50'
const BASE = 'https://dicom.example.com/studies/S/series/Se/instances'

function frameId(sop: string): string {
  return `wadors:${BASE}/${sop}/frames/1`
}

// VOLUME tiers + LABEL / OVERVIEW / THUMBNAIL side images, as a real SM series carries.
function instances(): Record<string, unknown>[] {
  return [
    {
      ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
      NumberOfFrames: 600,
      Rows: 240,
      Columns: 240,
      SamplesPerPixel: 3,
      PhotometricInterpretation: 'RGB',
      TransferSyntaxUID: JPEG,
      imageId: frameId('volume'),
    },
    {
      ImageType: 'DERIVED\\PRIMARY\\LABEL\\NONE',
      NumberOfFrames: 1,
      Rows: 716,
      Columns: 666,
      SamplesPerPixel: 3,
      PhotometricInterpretation: 'RGB',
      imageId: frameId('label'),
    },
    {
      ImageType: 'DERIVED\\PRIMARY\\OVERVIEW\\NONE',
      NumberOfFrames: 1,
      Rows: 629,
      Columns: 1600,
      SamplesPerPixel: 3,
      PhotometricInterpretation: 'RGB',
      imageId: frameId('overview'),
    },
    {
      ImageType: 'DERIVED\\PRIMARY\\THUMBNAIL\\RESAMPLED',
      NumberOfFrames: 1,
      Rows: 100,
      Columns: 100,
      SamplesPerPixel: 3,
      PhotometricInterpretation: 'RGB',
      imageId: frameId('thumb'),
    },
  ]
}

describe('pickThumbnailInstance', () => {
  it('prefers the OVERVIEW instance', () => {
    const inst = pickThumbnailInstance(instances())
    expect(inst?.imageId).toBe(frameId('overview'))
  })

  it('prefers a THUMBNAIL when there is no OVERVIEW', () => {
    const inst = pickThumbnailInstance(
      instances().filter((i) => !String(i.ImageType).includes('OVERVIEW')),
    )
    expect(inst?.imageId).toBe(frameId('thumb'))
  })

  it('falls back to a LABEL only when nothing better exists', () => {
    const inst = pickThumbnailInstance([
      {
        ImageType: 'DERIVED\\PRIMARY\\LABEL\\NONE',
        NumberOfFrames: 1,
        imageId: frameId('label'),
      },
    ])
    expect(inst?.imageId).toBe(frameId('label'))
  })

  it('prefers a non-LABEL side image over a LABEL', () => {
    const inst = pickThumbnailInstance([
      { ImageType: 'LABEL', NumberOfFrames: 1, imageId: frameId('label') },
      { ImageType: 'OTHER', NumberOfFrames: 1, imageId: frameId('other') },
    ])
    expect(inst?.imageId).toBe(frameId('other'))
  })

  it('skips instances without an imageId', () => {
    const inst = pickThumbnailInstance([
      { ImageType: 'OVERVIEW', NumberOfFrames: 1 },
    ])
    expect(inst).toBeUndefined()
  })

  it('returns undefined for an empty series', () => {
    expect(pickThumbnailInstance([])).toBeUndefined()
  })
})

describe('frameEncoding', () => {
  it('detects JPEG (FFD8) and PNG (89 50 4E) signatures', () => {
    expect(frameEncoding(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(frameEncoding(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png')
  })

  it('reports raw for uncompressed pixel bytes', () => {
    expect(frameEncoding(new Uint8Array([0x00, 0x01, 0x01, 0x00]))).toBe('raw')
  })
})

describe('rawImageInfo', () => {
  const rgb = {
    Rows: 4,
    Columns: 5,
    SamplesPerPixel: 3,
    PhotometricInterpretation: 'RGB',
  }

  it('accepts an 8-bit RGB frame whose byte length matches', () => {
    expect(rawImageInfo(rgb, 4 * 5 * 3)).toEqual({
      width: 5,
      height: 4,
      channels: 3,
    })
  })

  it('accepts a grayscale (1-channel) frame', () => {
    expect(
      rawImageInfo({ Rows: 4, Columns: 5, SamplesPerPixel: 1 }, 4 * 5),
    ).toEqual({ width: 5, height: 4, channels: 1 })
  })

  it('rejects a byte length that does not match the dimensions', () => {
    expect(rawImageInfo(rgb, 4 * 5 * 3 + 1)).toBeNull()
  })

  it('rejects a non-RGB photometric for a 3-channel frame', () => {
    expect(
      rawImageInfo({ ...rgb, PhotometricInterpretation: 'YBR_FULL_422' }, 60),
    ).toBeNull()
  })

  it('rejects an unsupported channel count', () => {
    expect(
      rawImageInfo({ Rows: 4, Columns: 5, SamplesPerPixel: 4 }, 80),
    ).toBeNull()
  })
})

describe('fetchWsiThumbnailObjectUrl', () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  afterEach(() => {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
  })

  function multipart(boundary: string, part: Uint8Array) {
    const enc = new TextEncoder()
    const head = enc.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`)
    const tail = enc.encode(`\r\n--${boundary}--\r\n`)
    const body = new Uint8Array(head.length + part.length + tail.length)
    body.set(head, 0)
    body.set(part, head.length)
    body.set(tail, head.length + part.length)
    return body
  }

  function respondWith(boundary: string, part: Uint8Array) {
    return (url: string, init?: RequestInit) => {
      lastUrl = url
      lastHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(
        new Response(multipart(boundary, part), {
          status: 200,
          headers: {
            'content-type': `multipart/related; type="image/jpeg"; boundary=${boundary}`,
          },
        }),
      )
    }
  }

  let lastUrl = ''
  let lastHeaders: Record<string, string> = {}

  it('returns a Blob URL for an encoded (JPEG) frame, from the picked instance', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    let blobType = ''
    globalThis.fetch = respondWith('Bnd', jpeg) as typeof fetch
    URL.createObjectURL = ((blob: Blob) => {
      blobType = blob.type
      return 'blob:mock'
    }) as typeof URL.createObjectURL

    const src = await fetchWsiThumbnailObjectUrl(instances(), {
      Authorization: 'Bearer t',
    })
    expect(src).toBe('blob:mock')
    expect(blobType).toBe('image/jpeg')
    // OVERVIEW is picked; the wadors: scheme is stripped before fetch.
    expect(lastUrl).toBe(`${BASE}/overview/frames/1`)
    expect(lastHeaders.Authorization).toBe('Bearer t')
  })

  it('returns null for a raw frame when no canvas is available (test runtime)', async () => {
    // 1600x629x3 raw RGB bytes: matches the OVERVIEW dimensions but cannot be
    // painted without a DOM canvas, so the fetch degrades to null here. (The
    // raw-decode path itself is exercised live in the app.)
    const raw = new Uint8Array(3).fill(0x40) // signature only; length checked after
    globalThis.fetch = respondWith('Bnd', raw) as typeof fetch
    const src = await fetchWsiThumbnailObjectUrl([
      {
        ImageType: 'OVERVIEW',
        NumberOfFrames: 1,
        Rows: 1,
        Columns: 1,
        SamplesPerPixel: 3,
        PhotometricInterpretation: 'RGB',
        imageId: frameId('overview'),
      },
    ])
    expect(src).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('nope', { status: 404 }),
      )) as unknown as typeof fetch
    expect(await fetchWsiThumbnailObjectUrl(instances())).toBeNull()
  })

  it('returns null when no instance has an imageId', async () => {
    let fetched = false
    globalThis.fetch = (() => {
      fetched = true
      return Promise.resolve(new Response('', { status: 200 }))
    }) as unknown as typeof fetch
    expect(
      await fetchWsiThumbnailObjectUrl([
        { ImageType: 'OVERVIEW', NumberOfFrames: 1 },
      ]),
    ).toBeNull()
    expect(fetched).toBe(false)
  })
})
