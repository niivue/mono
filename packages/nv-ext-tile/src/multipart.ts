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
