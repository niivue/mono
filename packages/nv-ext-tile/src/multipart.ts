// multipart/related bodies (PS3.18 8.7), as WADO-RS returns frames and bulk data.

/** Extract the boundary token from a multipart/related Content-Type header. */
function multipartBoundary(contentType: string): string | null {
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
function boundaryFromBody(bytes: Uint8Array): string | null {
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

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((b, i) => bytes[i] === b)
}

/**
 * Split a multipart/related body into its part bodies (raw bytes, headers
 * stripped). If the response is actually single-part (some servers ignore the
 * multipart Accept), the whole body is returned as one part.
 */
export function parseMultipartRelated(
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): Uint8Array[] {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  // Without the body fallback, a boundary-less multipart response would be
  // returned whole (headers included), corrupting the pixels.
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
  // Whether the delimiter whose CRLF is at `at` ends as one must: optional
  // "--" (closing), space/tab padding, then CRLF (or, closing, the body end).
  const ends = (at: number): boolean => {
    let i = at + delimiter.length
    const closing = bytes[i] === 0x2d && bytes[i + 1] === 0x2d
    if (closing) i += 2
    while (bytes[i] === 0x20 || bytes[i] === 0x09) i++
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return true
    return closing && i === bytes.length
  }
  const nextDelimiter = (from: number): number => {
    let i = indexOfSubarray(bytes, delimiter, from)
    while (i !== -1 && !ends(i)) i = indexOfSubarray(bytes, delimiter, i + 1)
    return i
  }

  const parts: Uint8Array[] = []
  // The first delimiter may open the body, with no CRLF before it.
  const opens = startsWith(bytes, delimiter.subarray(2)) && ends(-2)
  let at = opens ? -2 : nextDelimiter(0)
  while (at !== -1) {
    const partStart = at + delimiter.length
    if (bytes[partStart] === 0x2d && bytes[partStart + 1] === 0x2d) break

    const headerEnd = indexOfSubarray(bytes, crlfcrlf, partStart)
    if (headerEnd === -1) break
    const bodyStart = headerEnd + crlfcrlf.length
    const next = nextDelimiter(bodyStart)
    if (next === -1) break
    if (next > bodyStart) parts.push(bytes.slice(bodyStart, next))
    at = next
  }
  return parts
}
