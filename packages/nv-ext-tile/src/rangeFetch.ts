// Range-reply checks shared by the TIFF and Zarr fetch paths. Each caller
// keeps its own policy: which replies it refuses and with what message.

/**
 * The custom fetch every slide source option takes, e.g. one that adds auth
 * headers or signs URLs. `globalThis.fetch` satisfies it.
 */
export type SlideFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * `f`, else the global fetch, safe to store and call as a method: a native
 * fetch called with another receiver throws "Illegal invocation".
 */
export const slideFetch = (f?: SlideFetch): SlideFetch =>
  f ? (url, init) => f(url, init) : globalThis.fetch.bind(globalThis)

/** A read's signal: the caller's, if any, plus the source's lifetime. */
export const linked = (
  signal: AbortSignal | undefined,
  closed: AbortSignal,
): AbortSignal => (signal ? AbortSignal.any([signal, closed]) : closed)

/** Aborts when any given signal does; undefined when none is given. */
export function anySignal(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal | undefined {
  const given = signals.filter((s): s is AbortSignal => !!s)
  return given.length > 1 ? AbortSignal.any(given) : given[0]
}

export type RangeReplyError =
  | { kind: 'whole-file' }
  | { kind: 'misplaced'; got: string; want: string }

/**
 * Why `response` cannot answer a read sent with Range header `range` (null:
 * not ranged), else null.
 * - 'whole-file': a 200 to a ranged read, i.e. the server ignored Range and
 *   sends the whole file. Both callers refuse it: no source wants a multi-GB
 *   slide or a whole shard per read.
 * - 'misplaced': with `checkStart`, Content-Range starts elsewhere than the
 *   requested `bytes=N-`. Content-Range is absent cross-origin unless the
 *   server exposes it; then the reply is trusted.
 */
export function rangeReplyError(
  response: Response,
  range: string | null,
  checkStart = false,
): RangeReplyError | null {
  if (range === null) return null
  if (response.status === 200) return { kind: 'whole-file' }
  if (!checkStart) return null
  const got = /^bytes (\d+)-/.exec(
    response.headers.get('Content-Range') ?? '',
  )?.[1]
  const want = /^bytes=(\d+)-/.exec(range)?.[1]
  return got !== undefined && want !== undefined && got !== want
    ? { kind: 'misplaced', got, want }
    : null
}

/** Cancels the body (so the connection is released) and throws `message`. */
export async function refuseReply(
  response: Response,
  message: string,
): Promise<never> {
  await response.body?.cancel()
  throw new Error(message)
}

// 64 MB: far beyond a tile, manifest or scanner ICC profile (Leica's is 13 MB);
// matches ManifestRangeSource's profile cap and the dcm2niix decoder's input cap.
export const MAX_BODY = 64 * 1024 * 1024

/** A response body, refused past `max` whether or not Content-Length says so. */
export async function readCapped(
  response: Response,
  what: string,
  max = MAX_BODY,
): Promise<Uint8Array> {
  const refused = !response.ok
    ? `${what} HTTP ${response.status}`
    : Number(response.headers.get('content-length')) > max
      ? `${what} body too large`
      : undefined
  if (refused) {
    // An unread body keeps its connection downloading.
    await response.body?.cancel()
    throw new Error(refused)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
      await reader.cancel()
      throw new Error(`${what} body too large`)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
