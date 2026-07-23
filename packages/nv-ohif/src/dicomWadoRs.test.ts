import { describe, expect, it } from 'bun:test'
import {
  multipartBoundary,
  parseMultipartRelated,
  retrieveInstanceUrlFromImageId,
} from './dicomWadoRs'

describe('retrieveInstanceUrlFromImageId', () => {
  const base = 'https://host/dicomweb/studies/1.2/series/3.4/instances/5.6'

  it('strips the wadors scheme and the /frames suffix', () => {
    expect(retrieveInstanceUrlFromImageId(`wadors:${base}/frames/1`)).toBe(base)
  })

  it('handles a dicomweb scheme and a plain instance URL', () => {
    expect(retrieveInstanceUrlFromImageId(`dicomweb:${base}`)).toBe(base)
    expect(retrieveInstanceUrlFromImageId(base)).toBe(base)
  })

  it('drops query/hash after the instance uid', () => {
    expect(
      retrieveInstanceUrlFromImageId(`wadors:${base}/frames/1?foo=bar`),
    ).toBe(base)
  })

  it('rejects non-http and non-instance ids', () => {
    expect(retrieveInstanceUrlFromImageId('')).toBeNull()
    expect(retrieveInstanceUrlFromImageId('dicomfile:/local/a.dcm')).toBeNull()
    expect(
      retrieveInstanceUrlFromImageId(
        'wadors:https://host/dicomweb/studies/1.2',
      ),
    ).toBeNull()
  })
})

describe('multipartBoundary', () => {
  it('reads quoted and unquoted boundaries', () => {
    expect(
      multipartBoundary(
        'multipart/related; type="application/dicom"; boundary="abc123"',
      ),
    ).toBe('abc123')
    expect(
      multipartBoundary(
        'multipart/related; boundary=abc123; type="application/dicom"',
      ),
    ).toBe('abc123')
  })

  it('returns null when absent', () => {
    expect(multipartBoundary('application/dicom')).toBeNull()
  })
})

// Build a multipart/related body from raw part payloads, the way a WADO-RS
// server would frame `application/dicom` parts.
function buildMultipart(boundary: string, payloads: Uint8Array[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (const payload of payloads) {
    chunks.push(
      enc.encode(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`),
    )
    chunks.push(payload)
    chunks.push(enc.encode('\r\n'))
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

describe('parseMultipartRelated', () => {
  it('extracts each part body byte-exact (incl. binary bytes)', () => {
    const a = new Uint8Array([0x44, 0x49, 0x43, 0x4d, 0x00, 0x0d, 0x0a, 0xff])
    const b = new Uint8Array([1, 2, 3, 4, 5])
    const body = buildMultipart('BOUNDARY', [a, b])
    const parts = parseMultipartRelated(
      body,
      'multipart/related; type="application/dicom"; boundary=BOUNDARY',
    )
    expect(parts.length).toBe(2)
    expect(Array.from(parts[0] ?? [])).toEqual(Array.from(a))
    expect(Array.from(parts[1] ?? [])).toEqual(Array.from(b))
  })

  it('recovers the boundary from the body when the Content-Type omits it', () => {
    // Browsers commonly expose the response Content-Type as bare
    // `multipart/related` with the boundary stripped.
    const a = new Uint8Array([0x44, 0x49, 0x43, 0x4d, 0x00, 0xff])
    const body = buildMultipart('BOUNDARY', [a])
    const parts = parseMultipartRelated(body, 'multipart/related')
    expect(parts.length).toBe(1)
    expect(Array.from(parts[0] ?? [])).toEqual(Array.from(a))
  })

  it('falls back to the whole body when not multipart', () => {
    const raw = new Uint8Array([9, 8, 7])
    const parts = parseMultipartRelated(raw, 'application/dicom')
    expect(parts.length).toBe(1)
    expect(Array.from(parts[0] ?? [])).toEqual([9, 8, 7])
  })

  it('returns empty for an empty non-multipart body', () => {
    expect(
      parseMultipartRelated(new Uint8Array(), 'application/dicom'),
    ).toEqual([])
  })
})
