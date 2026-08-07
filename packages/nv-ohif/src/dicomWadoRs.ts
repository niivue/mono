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
 * Turn a cornerstone `wadors:`/`dicomweb:` frame imageId into the WADO-RS
 * retrieve-instance URL. Returns null if the id is not an http(s) DICOMweb
 * instance reference.
 */
export function retrieveInstanceUrlFromImageId(imageId: string): string | null {
  if (!imageId) return null
  // cornerstone prefixes the real URL with a loader scheme; strip known ones.
  const raw = imageId.replace(/^(wadors|dicomweb|wadouri):/i, '')
  if (!/^https?:\/\//i.test(raw)) return null
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

  const encoder = new TextEncoder()
  const delimiter = encoder.encode(`--${boundary}`)
  const crlfcrlf = encoder.encode('\r\n\r\n')

  const parts: Uint8Array[] = []
  let cursor = indexOfSubarray(bytes, delimiter, 0)
  while (cursor !== -1) {
    const partStart = cursor + delimiter.length
    // The closing delimiter is `--<boundary>--`; stop there.
    if (bytes[partStart] === 0x2d && bytes[partStart + 1] === 0x2d) break

    const headerEnd = indexOfSubarray(bytes, crlfcrlf, partStart)
    const next = indexOfSubarray(bytes, delimiter, partStart)
    if (headerEnd === -1 || next === -1) break

    const bodyStart = headerEnd + crlfcrlf.length
    let bodyEnd = next
    // Strip the CRLF that precedes the next boundary line.
    if (bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2
    if (bodyEnd > bodyStart) parts.push(bytes.slice(bodyStart, bodyEnd))

    cursor = next
  }
  return parts
}
