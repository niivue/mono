import { describe, expect, test } from 'bun:test'
import { anySignal, rangeReplyError, refuseReply } from './rangeFetch'
import { omeZarrFetchStore } from './zarr/omeZarrLoader'

const reply = (status: number, contentRange?: string) =>
  new Response(new Uint8Array(4), {
    status,
    headers: contentRange ? { 'Content-Range': contentRange } : {},
  })

describe('rangeReplyError', () => {
  test('a 200 to a ranged read is the whole file; unranged reads pass', () => {
    expect(rangeReplyError(reply(200), 'bytes=0-3')).toEqual({
      kind: 'whole-file',
    })
    expect(rangeReplyError(reply(200), null)).toBeNull()
    expect(rangeReplyError(reply(206), 'bytes=0-3')).toBeNull()
    // Not a range verdict: the caller decides on 404 / 5xx.
    expect(rangeReplyError(reply(404), 'bytes=0-3', true)).toBeNull()
  })

  test('checkStart compares the Content-Range start when stated', () => {
    const bad = reply(206, 'bytes 1-4/9')
    expect(rangeReplyError(bad, 'bytes=0-3')).toBeNull()
    expect(rangeReplyError(bad, 'bytes=0-3', true)).toEqual({
      kind: 'misplaced',
      got: '1',
      want: '0',
    })
    expect(
      rangeReplyError(reply(206, 'bytes 0-3/9'), 'bytes=0-3', true),
    ).toBeNull()
    // Hidden cross-origin, or a suffix range: trusted.
    expect(rangeReplyError(reply(206), 'bytes=0-3', true)).toBeNull()
    expect(rangeReplyError(bad, 'bytes=-4', true)).toBeNull()
  })
})

test('refuseReply cancels the body and throws', async () => {
  const r = reply(200)
  let cancelled = false
  const body = r.body
  if (!body) throw new Error('no body')
  body.cancel = async () => {
    cancelled = true
  }
  await expect(refuseReply(r, 'nope')).rejects.toThrow('nope')
  expect(cancelled).toBe(true)
})

test('anySignal: none, one passed through, several combined', () => {
  expect(anySignal(null, undefined)).toBeUndefined()
  const a = new AbortController()
  expect(anySignal(a.signal, null)).toBe(a.signal)
  const b = new AbortController()
  const both = anySignal(a.signal, b.signal)
  expect(both?.aborted).toBe(false)
  b.abort()
  expect(both?.aborted).toBe(true)
})

test('omeZarrFetchStore refuses a 206 from the wrong offset (SRC-18)', async () => {
  const store = omeZarrFetchStore(
    'http://x/s',
    async () =>
      new Response(new Uint8Array(8), {
        status: 206,
        headers: { 'Content-Range': 'bytes 5-12/99' },
      }),
  )
  await expect(
    store.getRange('/0/c/0/0', { offset: 0, length: 8 }),
  ).rejects.toThrow('answered bytes 5- to bytes=0-7')
})
