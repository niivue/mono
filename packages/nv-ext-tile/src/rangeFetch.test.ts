import { describe, expect, test } from 'bun:test'
import {
  anySignal,
  rangeReplyError,
  refuseReply,
  slideFetch,
} from './rangeFetch'
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
    expect(rangeReplyError(reply(404), 'bytes=0-3')).toBeNull()
  })

  test('a stated Content-Range start must match the request', () => {
    const bad = reply(206, 'bytes 1-4/9')
    expect(rangeReplyError(bad, 'bytes=0-3')).toEqual({
      kind: 'misplaced',
      got: '1',
      want: '0',
    })
    expect(rangeReplyError(reply(206, 'bytes 0-3/9'), 'bytes=0-3')).toBeNull()
    // Hidden cross-origin, or a suffix range: trusted.
    expect(rangeReplyError(reply(206), 'bytes=0-3')).toBeNull()
    expect(rangeReplyError(bad, 'bytes=-4')).toBeNull()
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

describe('slideFetch with a fetch that ignores its signal', () => {
  // A 206 whose body sends one byte then stalls; `cancelled` once cancelled.
  const stalled = () => {
    const state = { cancelled: false }
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]))
        },
        cancel() {
          state.cancelled = true
        },
      }),
      { status: 206 },
    )
    return { state, response }
  }
  const settled = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => 'resolved',
        (e: Error) => e.name,
      ),
      new Promise((r) => setTimeout(() => r('pending'), 100)),
    ])
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test('a reply after the abort is refused and its body cancelled', async () => {
    const late = stalled()
    let release = (_: Response) => {}
    const ac = new AbortController()
    const reply = slideFetch(() => new Promise((r) => (release = r)))('u', {
      signal: ac.signal,
    })
    ac.abort()
    release(late.response)
    expect(await settled(reply)).toBe('AbortError')
    await tick()
    expect(late.state.cancelled).toBe(true)
  })

  test('an abort during a stalled body rejects the read and cancels it', async () => {
    const body = stalled()
    const ac = new AbortController()
    const response = await slideFetch(async () => body.response)('u', {
      signal: ac.signal,
    })
    const read = response.arrayBuffer()
    await tick()
    ac.abort()
    expect(await settled(read)).toBe('AbortError')
    expect(body.state.cancelled).toBe(true)
  })

  test('the held reply keeps status, headers, url and redirected', async () => {
    const original = new Response('ab', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-1/9' },
    })
    Object.defineProperties(original, {
      url: { value: 'https://h.test/moved' },
      redirected: { value: true },
    })
    const r = await slideFetch(async () => original)('u', {
      signal: new AbortController().signal,
    })
    expect([
      r.status,
      r.headers.get('Content-Range'),
      r.url,
      r.redirected,
    ]).toEqual([206, 'bytes 0-1/9', 'https://h.test/moved', true])
    expect(await r.text()).toBe('ab')
  })
})
