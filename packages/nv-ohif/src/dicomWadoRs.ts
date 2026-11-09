// Pure helpers for pulling original DICOM P10 bytes out of a DICOMweb (WADO-RS)
// data source — the input dcm2niix needs (whole DICOM files, not decoded pixels).
//
// OHIF/cornerstone hands each instance a `wadors:` imageId that points at the
// *frame* resource, e.g.
//   wadors:https://host/dicomweb/studies/S/series/SE/instances/I/frames/1
// The full instance (header + pixel data) lives one level up, at the WADO-RS
// "retrieve instance" resource:
//   https://host/dicomweb/studies/S/series/SE/instances/I
// requested with `Accept: multipart/related; type="application/dicom"`, which
// returns the DICOM object(s) as a multipart/related body. These two functions
// derive that URL and unpack that body; both are pure so they can be unit-tested.

/**
 * The http(s) URL a cornerstone imageId names, its loader scheme stripped. A
 * relative root (OHIF's `wadoRoot: '/dicomweb'` gives `wadors:/dicomweb/...`)
 * resolves against the document base, as the browser and cornerstone's loader
 * resolve it (a `<base>` or nested route differs from the page URL). Null for
 * anything else.
 */
export function imageIdUrl(imageId: string): string | null {
  try {
    const url = new URL(
      imageId.replace(/^(wadors|dicomweb|wadouri):/i, ''),
      globalThis.document?.baseURI ?? globalThis.location?.href,
    )
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

/**
 * Turn a cornerstone `wadors:`/`dicomweb:` frame imageId into the WADO-RS
 * retrieve-instance URL. Returns null if the id is not an http(s) DICOMweb
 * instance reference.
 */
export function retrieveInstanceUrlFromImageId(imageId: string): string | null {
  const raw = imageIdUrl(imageId)
  if (!raw) return null
  // Keep everything up to and including `/instances/<uid>`, dropping any
  // `/frames/...` (or other sub-resource) suffix.
  const m = raw.match(/^(.*\/instances\/[^/?#]+)(?:[/?#].*)?$/i)
  return m?.[1] ?? null
}

/** Extract the boundary token from a multipart/related Content-Type header. */
export function multipartBoundary(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
  const b = m?.[1] ?? m?.[2]
  return b ? b.trim() : null
}

/**
 * Recover the boundary from a multipart body's opening delimiter line
 * (`--<boundary>\r\n`). The browser `fetch` API commonly exposes the response
 * Content-Type as bare `multipart/related` with the `boundary` parameter
 * stripped, so we fall back to reading it off the body.
 */
export function boundaryFromBody(bytes: Uint8Array): string | null {
  if (bytes[0] !== 0x2d || bytes[1] !== 0x2d) return null // must start with "--"
  let end = 2
  const limit = Math.min(bytes.length, 256)
  while (end < limit && bytes[end] !== 0x0d && bytes[end] !== 0x0a) end++
  if (end <= 2) return null
  return new TextDecoder('latin1').decode(bytes.subarray(2, end))
}

function indexOfSubarray(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * Split a multipart/related body into its part bodies (raw bytes, headers
 * stripped). If the response is actually single-part `application/dicom`
 * (some servers ignore the multipart Accept), the whole body is returned as
 * one part.
 */
export function parseMultipartRelated(
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): Uint8Array[] {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  // The browser often strips the boundary from the Content-Type; recover it from
  // the body's opening delimiter line. Without this, a boundary-less multipart
  // response would be returned whole (headers included), corrupting the pixels.
  const boundary = multipartBoundary(contentType) ?? boundaryFromBody(bytes)
  if (!boundary) {
    return bytes.length > 0 ? [bytes] : []
  }

  // RFC 2046 5.1.1: a delimiter is CRLF "--" boundary, then "--" (closing)
  // or optional padding and CRLF. The CRLF belongs to the delimiter, so a
  // boundary-like run inside binary part data is not one.
  const encoder = new TextEncoder()
  const delimiter = encoder.encode(`\r\n--${boundary}`)
  const crlfcrlf = encoder.encode('\r\n\r\n')
  // Whether the delimiter whose CRLF is at `at` ends as a delimiter must.
  // Closing: "--", padding, then CRLF or the end of the body. Otherwise:
  // padding, then CRLF. Anything else is part data.
  const ends = (at: number): boolean => {
    let i = at + delimiter.length
    const closing = bytes[i] === 0x2d && bytes[i + 1] === 0x2d
    if (closing) i += 2
    while (bytes[i] === 0x20 || bytes[i] === 0x09) i++
    if (closing && i === bytes.length) return true
    return bytes[i] === 0x0d && bytes[i + 1] === 0x0a
  }
  const nextDelimiter = (from: number): number => {
    let i = indexOfSubarray(bytes, delimiter, from)
    while (i !== -1 && !ends(i)) i = indexOfSubarray(bytes, delimiter, i + 1)
    return i
  }

  const parts: Uint8Array[] = []
  // The first delimiter may open the body, with no CRLF before it.
  const opens =
    delimiter.subarray(2).every((b, k) => bytes[k] === b) && ends(-2)
  let at = opens ? -2 : nextDelimiter(0)
  while (at !== -1) {
    const partStart = at + delimiter.length
    // The closing delimiter is `--<boundary>--`; stop there.
    if (bytes[partStart] === 0x2d && bytes[partStart + 1] === 0x2d) break

    const headerEnd = indexOfSubarray(bytes, crlfcrlf, partStart)
    if (headerEnd === -1) break
    const bodyStart = headerEnd + crlfcrlf.length
    // The part ends at the next delimiter's CRLF.
    const next = nextDelimiter(bodyStart)
    if (next === -1) break
    if (next > bodyStart) parts.push(bytes.slice(bodyStart, next))
    at = next
  }
  return parts
}
