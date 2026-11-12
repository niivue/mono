// Range-reply checks shared by the TIFF and Zarr fetch paths. Each caller
// keeps its own policy: which replies it refuses and with what message.

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
