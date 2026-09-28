import { describe, expect, it } from 'bun:test'
import type { TabState } from '../protocol'
import { type AppSocket, Bridge, NO_APP } from './bridge'

/** Requests written to the socket go to `sent`; the welcome, to `welcomes`. */
type Fake = AppSocket & { sent: string[]; welcomes: string[] }

const socket = (): Fake => {
  const s: Fake = {
    sent: [],
    welcomes: [],
    send: (text: string) => sort(s, text),
  }
  return s
}

/** Files the text where it belongs, and says whether it is a request to answer. */
function sort(s: Fake, text: string): boolean {
  const message = JSON.parse(text) as { welcome?: { id: string } }
  if (message.welcome) {
    s.welcomes.push(message.welcome.id)
    return false
  }
  s.sent.push(text)
  return true
}

/** Lets the bridge's own awaits run, so a call has been written before the test answers it. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const state = (extra: Partial<TabState> = {}): TabState => ({
  volume: 'mni152.nii.gz',
  crosshair: { mm: [0, 0, 0] },
  plane: { name: 'off', depth: 2, azimuth: 0, elevation: 0 },
  ...extra,
})

/** Connects a tab that says hello, and answers as `answer` says. */
function tab(
  bridge: Bridge,
  id: string,
  title: string,
  answer: (
    method: string,
    params: Record<string, unknown>,
  ) => unknown = () => ({ ok: true }),
  tabState: TabState = state(),
  reconnect = false,
): Fake {
  const s: Fake = {
    sent: [],
    welcomes: [],
    send(text: string) {
      if (!sort(s, text)) return
      const request = JSON.parse(text) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      queueMicrotask(() =>
        bridge.receive(
          s,
          JSON.stringify({
            id: request.id,
            result: answer(request.method, request.params),
            state: tabState,
            tab: { title, url: 'http://x' },
          }),
        ),
      )
    },
  }
  bridge.attach(s)
  bridge.receive(
    s,
    JSON.stringify({
      hello: {
        id,
        title,
        url: 'http://x',
        state: tabState,
        ...(reconnect ? { reconnect } : {}),
      },
    }),
  )
  return s
}

describe('Bridge', () => {
  it('refuses a call when no tab has said hello', async () => {
    const bridge = new Bridge()
    bridge.attach(socket())
    expect(bridge.connected).toBe(false)
    await expect(bridge.call('where_am_i')).rejects.toThrow(NO_APP)
  })

  it('writes a request with a fresh id and resolves with the matching response and the tab', async () => {
    const bridge = new Bridge()
    const app = socket()
    bridge.attach(app)
    bridge.receive(
      app,
      JSON.stringify({
        hello: { id: 't1', title: 'one', url: 'http://x', state: state() },
      }),
    )
    const call = bridge.call('go_to_region', { region: 'Insula_L' })
    await tick()
    expect(JSON.parse(app.sent[0])).toEqual({
      id: 1,
      method: 'go_to_region',
      params: { region: 'Insula_L' },
    })
    bridge.receive(app, JSON.stringify({ id: 99, result: 'not mine' }))
    bridge.receive(app, 'not json')
    bridge.receive(app, JSON.stringify({ id: 1, result: { landed: true } }))
    const answer = await call
    expect(answer.result).toEqual({ landed: true })
    expect(answer.tab).toMatchObject({ id: 't1', title: 'one' })
    expect(answer.reloaded).toBeNull()
  })

  it("rejects with the page's error text", async () => {
    const bridge = new Bridge()
    tab(bridge, 't1', 'one')
    const app = socket()
    bridge.attach(app)
    bridge.receive(
      app,
      JSON.stringify({
        hello: { id: 't2', title: 'two', url: 'http://x', state: state() },
      }),
    )
    bridge.use('t2')
    const call = bridge.call('go_to_region', { region: 'nowhere' })
    await tick()
    bridge.receive(app, JSON.stringify({ id: 1, error: 'No region matches' }))
    await expect(call).rejects.toThrow('No region matches')
  })

  it('times out a call the page never answers', async () => {
    const bridge = new Bridge({ timeoutMs: 20 })
    const app = socket()
    bridge.attach(app)
    bridge.receive(
      app,
      JSON.stringify({
        hello: { id: 't1', title: 'one', url: 'http://x', state: state() },
      }),
    )
    await expect(bridge.call('list_regions')).rejects.toThrow(
      '"one" did not answer list_regions',
    )
  })

  it('puts calls to one tab one at a time, in order, however many arrive at once', async () => {
    const bridge = new Bridge()
    const answers: Array<() => void> = []
    const s: Fake = {
      sent: [],
      welcomes: [],
      send(text: string) {
        if (!sort(s, text)) return
        const request = JSON.parse(text) as { id: number; method: string }
        answers.push(() =>
          bridge.receive(
            s,
            JSON.stringify({ id: request.id, result: request.method }),
          ),
        )
      },
    }
    bridge.attach(s)
    bridge.receive(
      s,
      JSON.stringify({ hello: { id: 't1', title: 'one', url: 'http://x' } }),
    )
    const methods = () =>
      s.sent.map((text) => (JSON.parse(text) as { method: string }).method)

    const first = bridge.call('load_volume', { url: 'a' })
    const second = bridge.call('go_to_region', { region: 'b' })
    const third = bridge.call('screenshot')
    await tick()
    expect(methods()).toEqual(['load_volume'])
    answers.shift()?.()
    await tick()
    expect(methods()).toEqual(['load_volume', 'go_to_region'])
    expect((await first).result).toBe('load_volume')
    answers.shift()?.()
    await tick()
    expect(methods()).toEqual(['load_volume', 'go_to_region', 'screenshot'])
    expect((await second).result).toBe('go_to_region')
    answers.shift()?.()
    expect((await third).result).toBe('screenshot')
  })

  it('sends the next call once the one ahead of it fails', async () => {
    const bridge = new Bridge({ timeoutMs: 20 })
    const s: Fake = {
      sent: [],
      welcomes: [],
      send(text: string) {
        if (!sort(s, text)) return
        const request = JSON.parse(text) as { id: number; method: string }
        // The first call is never answered, so it times out; the rest are.
        if (request.method === 'load_volume') return
        queueMicrotask(() =>
          bridge.receive(s, JSON.stringify({ id: request.id, result: 'ok' })),
        )
      },
    }
    bridge.attach(s)
    bridge.receive(
      s,
      JSON.stringify({ hello: { id: 't1', title: 'one', url: 'http://x' } }),
    )
    const first = bridge.call('load_volume', { url: 'a' })
    const second = bridge.call('where_am_i')
    await tick()
    expect(s.sent.length).toBe(1)
    await expect(first).rejects.toThrow('did not answer load_volume')
    expect((await second).result).toBe('ok')
    expect(s.sent.length).toBe(2)
  })

  it('answers from the only tab, then asks for a choice once there are two', async () => {
    const bridge = new Bridge()
    tab(bridge, 't1', 'one', () => 'from one')
    expect((await bridge.call('where_am_i')).result).toBe('from one')
    tab(bridge, 't2', 'two', () => 'from two')
    // The tab that answered before keeps answering.
    expect((await bridge.call('where_am_i')).tab.id).toBe('t1')
    expect(bridge.list().map((t) => [t.id, t.bound])).toEqual([
      ['t1', true],
      ['t2', false],
    ])
  })

  it('with two tabs and no history, fails with the list until use_tab chooses', async () => {
    const bridge = new Bridge()
    tab(bridge, 't1', 'one', () => 'from one')
    tab(bridge, 't2', 'two', () => 'from two')
    await expect(bridge.call('where_am_i')).rejects.toThrow(
      /2 tabs are connected.*t1 "one".*t2 "two".*use_tab/,
    )
    expect(bridge.list().every((t) => !t.bound)).toBe(true)
    expect(bridge.use('t2')).toMatchObject({ id: 't2', title: 'two' })
    expect((await bridge.call('where_am_i')).result).toBe('from two')
    expect(bridge.list().find((t) => t.bound)?.id).toBe('t2')
    expect(() => bridge.use('t9')).toThrow(/No connected tab has the id "t9"/)
  })

  it('keeps the chosen tab across another tab connecting and the other closing', async () => {
    const bridge = new Bridge()
    const one = tab(bridge, 't1', 'one', () => 'from one')
    tab(bridge, 't2', 'two', () => 'from two')
    bridge.use('t1')
    tab(bridge, 't3', 'three', () => 'from three')
    expect((await bridge.call('where_am_i')).result).toBe('from one')
    bridge.detach(one)
    // Gone for good: the choice lapses and the call says so.
    await expect(new Bridge({ returnGraceMs: 0 }).call('x')).rejects.toThrow(
      NO_APP,
    )
    const b2 = new Bridge({ returnGraceMs: 0 })
    const s1 = tab(b2, 't1', 'one')
    tab(b2, 't2', 'two')
    b2.use('t1')
    b2.detach(s1)
    await expect(b2.call('where_am_i')).rejects.toThrow(
      /chosen with use_tab \(t1\) is no longer connected/,
    )
  })

  it('fails what is pending when its tab goes, and ignores a stale socket', async () => {
    const bridge = new Bridge()
    const app = socket()
    bridge.attach(app)
    bridge.receive(
      app,
      JSON.stringify({
        hello: { id: 't1', title: 'one', url: 'http://x', state: state() },
      }),
    )
    const call = bridge.call('where_am_i')
    await tick()
    bridge.detach(app)
    await expect(call).rejects.toThrow('"one" disconnected before it answered')
    expect(bridge.connected).toBe(false)
    bridge.detach(app)
    bridge.receive(app, JSON.stringify({ id: 1, result: 'late' }))
    expect(bridge.connected).toBe(false)
  })

  it('re-binds a reloaded tab by id and reports the reset once, with the state before and after', async () => {
    const clock = { t: 1000 }
    const bridge = new Bridge({ now: () => clock.t })
    const before = state({
      crosshair: { mm: [-38, -22, 5] },
      plane: { name: 'left', depth: 0, azimuth: 270, elevation: 0 },
      sounding: true,
    })
    const first = tab(bridge, 't1', 'one', () => 'before', before)
    await bridge.call('where_am_i')
    bridge.detach(first)
    clock.t = 2000
    const fresh = state({ sounding: false })
    tab(bridge, 't1', 'one', () => 'after', fresh)
    const answer = await bridge.call('where_am_i')
    expect(answer.result).toBe('after')
    expect(answer.tab.id).toBe('t1')
    expect(answer.reloaded).toEqual({ reloadedAt: 2000, before, after: fresh })
    expect((await bridge.call('where_am_i')).reloaded).toBeNull()
  })

  it('waits for a tab mid-reload rather than failing the call in the gap', async () => {
    const bridge = new Bridge({ returnGraceMs: 500 })
    const first = tab(bridge, 't1', 'one', () => 'before')
    await bridge.call('where_am_i')
    bridge.detach(first)
    const during = bridge.call('where_am_i')
    tab(bridge, 't1', 'one', () => 'after')
    const answer = await during
    expect(answer.result).toBe('after')
    expect(answer.reloaded).not.toBeNull()
  })

  it('gives up on a tab that does not come back within the grace', async () => {
    const bridge = new Bridge({ returnGraceMs: 20 })
    const first = tab(bridge, 't1', 'one')
    bridge.detach(first)
    await expect(bridge.call('where_am_i')).rejects.toThrow(NO_APP)
  })

  it('welcomes each tab with the id it goes by', () => {
    const bridge = new Bridge()
    const one = tab(bridge, 't1', 'one')
    const two = tab(bridge, 't2', 'two')
    expect(one.welcomes).toEqual(['t1'])
    expect(two.welcomes).toEqual(['t2'])
    expect(one.sent).toHaveLength(0)
  })

  it('takes the same page back on a new socket when it says it reconnected, before the old socket closes', async () => {
    const bridge = new Bridge()
    const old = socket()
    bridge.attach(old)
    bridge.receive(
      old,
      JSON.stringify({
        hello: { id: 't1', title: 'one', url: 'http://x', state: state() },
      }),
    )
    const stuck = bridge.call('where_am_i')
    await tick()
    const again = tab(
      bridge,
      't1',
      'one again',
      () => 'new socket',
      state(),
      true,
    )
    expect(again.welcomes).toEqual(['t1'])
    await expect(stuck).rejects.toThrow('reconnected before it answered')
    const answer = await bridge.call('where_am_i')
    expect(answer.result).toBe('new socket')
    // The page did not reload, so nothing started over.
    expect(answer.reloaded).toBeNull()
    bridge.detach(old)
    expect(bridge.connected).toBe(true)
    expect(bridge.list()).toHaveLength(1)
  })

  it('keeps a live tab and gives a fresh page with its id a spare one, so both can be driven', async () => {
    const bridge = new Bridge()
    const original = tab(bridge, 't1', 'one', () => 'original')
    // The duplicate: a fresh load whose copied sessionStorage says t1.
    const copy = tab(bridge, 't1', 'one (copy)', () => 'copy')
    expect(copy.welcomes).toEqual(['t1-2'])
    expect(original.welcomes).toEqual(['t1'])
    expect(bridge.list()).toMatchObject([
      { id: 't1', title: 'one', bound: false },
      { id: 't1-2', title: 'one (copy)', bound: false },
    ])
    await expect(bridge.call('where_am_i')).rejects.toThrow(
      '2 tabs are connected and none is chosen',
    )
    bridge.use('t1')
    expect((await bridge.call('where_am_i')).result).toBe('original')
    expect(copy.sent).toHaveLength(0)
    bridge.use('t1-2')
    const answer = await bridge.call('where_am_i')
    expect(answer.result).toBe('copy')
    expect(answer.tab.id).toBe('t1-2')
    expect(answer.reloaded).toBeNull()
    // A third copy, and a copy of the copy, each get the next spare id.
    expect(tab(bridge, 't1', 'one (copy 2)').welcomes).toEqual(['t1-3'])
    expect(tab(bridge, 't1-2', 'copy of copy').welcomes).toEqual(['t1-2-2'])
    bridge.detach(original)
    expect(bridge.list().map((t) => t.id)).toEqual(['t1-2', 't1-3', 't1-2-2'])
  })

  it('reloads a spare id as any other, and the copy comes back as itself', async () => {
    const bridge = new Bridge({ returnGraceMs: 50 })
    tab(bridge, 't1', 'one')
    const copy = tab(bridge, 't1', 'one (copy)')
    bridge.use('t1-2')
    await bridge.call('where_am_i')
    bridge.detach(copy)
    const back = tab(bridge, 't1-2', 'one (copy)', () => 'back')
    expect(back.welcomes).toEqual(['t1-2'])
    const answer = await bridge.call('where_am_i')
    expect(answer.result).toBe('back')
    expect(answer.reloaded).not.toBeNull()
  })

  it('does not report a reset for a page that reconnects after its socket dropped', async () => {
    const bridge = new Bridge()
    const one = tab(bridge, 't1', 'one')
    bridge.detach(one)
    tab(bridge, 't1', 'one', () => 'again', state(), true)
    const answer = await bridge.call('where_am_i')
    expect(answer.result).toBe('again')
    expect(answer.reloaded).toBeNull()
  })

  it('sends a call that names its tab there, whatever is chosen, and leaves the choice alone', async () => {
    const bridge = new Bridge()
    tab(bridge, 't1', 'one', () => 'from one')
    tab(bridge, 't2', 'two', () => 'from two')
    bridge.use('t1')
    const named = await bridge.call('where_am_i', {}, 't2')
    expect(named.result).toBe('from two')
    expect(named.tab.id).toBe('t2')
    expect(bridge.list().find((t) => t.bound)?.id).toBe('t1')
    expect((await bridge.call('where_am_i')).tab.id).toBe('t1')
  })

  it('fails a call that names a tab nobody has, listing the tabs and both ways to pick one', async () => {
    const bridge = new Bridge()
    tab(bridge, 't1', 'one')
    await expect(bridge.call('where_am_i', {}, 'nope')).rejects.toThrow(
      /^No connected tab has the id "nope"\. Connected: t1 "one" \(answering\)\. Call use_tab with the id to drive, or pass it as tab\.$/,
    )
    const empty = new Bridge()
    await expect(empty.call('where_am_i', {}, 'nope')).rejects.toThrow(
      `No connected tab has the id "nope". ${NO_APP}`,
    )
  })

  it('waits for a named tab that is mid-reload, as it does for the answering one', async () => {
    const bridge = new Bridge({ returnGraceMs: 500 })
    tab(bridge, 't1', 'one', () => 'other')
    const second = tab(bridge, 't2', 'two', () => 'before')
    await bridge.call('where_am_i', {}, 't2')
    bridge.detach(second)
    const during = bridge.call('where_am_i', {}, 't2')
    tab(bridge, 't2', 'two', () => 'after')
    const answer = await during
    expect(answer.result).toBe('after')
    expect(answer.tab.id).toBe('t2')
    expect(answer.reloaded).not.toBeNull()
  })

  it('takes the title and state from each answer, so a renamed tab lists under its new name', async () => {
    const bridge = new Bridge()
    const app = socket()
    bridge.attach(app)
    bridge.receive(
      app,
      JSON.stringify({
        hello: { id: 't1', title: 'old', url: 'http://x', state: state() },
      }),
    )
    const call = bridge.call('where_am_i')
    await tick()
    const moved = state({ crosshair: { mm: [1, 2, 3] } })
    bridge.receive(
      app,
      JSON.stringify({
        id: 1,
        result: 1,
        tab: { title: 'new', url: 'http://y' },
        state: moved,
      }),
    )
    await call
    expect(bridge.list()[0]).toMatchObject({
      title: 'new',
      url: 'http://y',
      state: moved,
    })
  })
})
