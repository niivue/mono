// Range-reply checks shared by the TIFF and Zarr fetch paths. Each caller
// keeps its own policy: which replies it refuses and with what message.

import { readCapped, type SlideFetch, settleBy } from '@niivue/niivue'

/**
 * `f`, else the global fetch, safe to store and call as a method: a native
 * fetch called with another receiver throws "Illegal invocation". `f` is held
 * to its signal as a native fetch is, since it may ignore it.
 */
export const slideFetch = (f?: SlideFetch): SlideFetch =>
  f
    ? (url, init) => heldTo(f(url, init), init?.signal)
    : globalThis.fetch.bind(globalThis)

/**
 * `reply` held to `signal`: it rejects on abort (a late reply's body is
 * cancelled), and so does every later read of its body.
 */
async function heldTo(
  reply: Promise<Response>,
  signal?: AbortSignal | null,
): Promise<Response> {
  if (!signal) return reply
  const response = await settleBy(signal, reply, (late) => {
    late.body?.cancel().catch(() => {})
  })
  if (!response.body) return response
  const held = new Response(
    response.body.pipeThrough(new TransformStream(), { signal }),
    response,
  )
  // A new Response has neither; the TIFF client reads them to follow a redirect.
  return Object.defineProperties(held, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  })
}

/** Aborts when any given signal does; undefined when none is given. */
export function anySignal(
  ...signals: [...(AbortSignal | null | undefined)[], AbortSignal]
): AbortSignal
export function anySignal(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal | undefined
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
 * - 'misplaced': Content-Range starts elsewhere than the requested `bytes=N-`.
 *   Content-Range is absent cross-origin unless the server exposes it; then
 *   the reply is trusted.
 */
export function rangeReplyError(
  response: Response,
  range: string | null,
): RangeReplyError | null {
  if (range === null) return null
  if (response.status === 200) return { kind: 'whole-file' }
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

/** A response body (core's readCapped), refused unless the status is OK. */
export async function readOk(
  response: Response,
  what: string,
  max = MAX_BODY,
): Promise<Uint8Array> {
  if (!response.ok)
    await refuseReply(response, `${what} HTTP ${response.status}`)
  return readCapped(response, max)
}
