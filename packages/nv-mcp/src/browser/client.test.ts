import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test'

import {
  AgentClient,
  agentUrls,
  CONNECT_MS,
  RETRY_MS,
  serve,
  TAB_ID_KEY,
  tabId,
} from './client'

/** A WebSocket whose other end is the test. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static opened: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  constructor(readonly url: string) {
    super()
    FakeSocket.opened.push(this)
  }
  send(text: string) {
    this.sent.push(text)
  }
  close() {
    this.readyState = FakeSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
  /** The server accepting. */
  accept() {
    this.readyState = FakeSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }
  /** The server refusing, or going away. */
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
  /** The server writing. */
  receive(text: string) {
    this.dispatchEvent(new MessageEvent('message', { data: text }))
  }
  /** The last answer written, parsed. */
  async lastReply(): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 0))
    return JSON.parse(this.sent[this.sent.length - 1])
  }
}

const Socket = FakeSocket as unknown as typeof WebSocket

const state = () => ({ volume: 'v', crosshair: { mm: [1, 2, 3] }, plane: null })

function client(
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  extra = {},
) {
  return new AgentClient(handlers, {
    urls: ['ws://one/agent', 'ws://two/app'],
    id: 'tab-1',
    title: () => 'brainsonify',
    url: () => 'http://localhost:4200/?agent',
    state,
    WebSocket: Socket,
    ...extra,
  })
}

beforeEach(() => {
  FakeSocket.opened = []
  spyOn(console, 'info').mockImplementation(() => {})
  spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  mock.restore()
  jest.useRealTimers()
})

describe('serve', () => {
  it("answers a method with its handler's result, and a throw or unknown method with words", async () => {
    const handlers = {
      where_am_i: () => ({ here: true }),
      go: async (p: Record<string, unknown>) => `went ${p.to}`,
      bad: () => {
        throw new Error('no volume')
      },
    }
    expect(
      await serve(handlers, { id: 1, method: 'where_am_i', params: {} }),
    ).toEqual({ id: 1, result: { here: true } })
    expect(
      await serve(handlers, { id: 2, method: 'go', params: { to: 'x' } }),
    ).toEqual({ id: 2, result: 'went x' })
    expect(await serve(handlers, { id: 3, method: 'bad', params: {} })).toEqual(
      { id: 3, error: 'no volume' },
    )
    expect(
      await serve(handlers, { id: 4, method: 'shout', params: {} }),
    ).toEqual({ id: 4, error: 'Unknown method shout.' })
    expect(
      await serve(handlers, { id: 5, method: 'toString', params: {} }),
    ).toEqual({ id: 5, error: 'Unknown method toString.' })
  })
})

describe('AgentClient', () => {
  it('says hello with its id, title, address and state as soon as the socket opens', () => {
    const status = mock()
    const c = client({}, { onStatus: status })
    c.attach()
    const socket = FakeSocket.opened[0]
    expect(socket.url).toBe('ws://one/agent')
    socket.accept()
    expect(JSON.parse(socket.sent[0])).toEqual({
      hello: {
        id: 'tab-1',
        title: 'brainsonify',
        url: 'http://localhost:4200/?agent',
        state: state(),
      },
    })
    expect(status).toHaveBeenCalledWith(true)
    expect(c.connected).toBe(true)
  })

  it('answers each request with the result, the tab, and the state, and ignores junk', async () => {
    const c = client({
      where_am_i: () => ({ here: true }),
      fail: () => Promise.reject(new Error('nope')),
    })
    c.attach()
    const socket = FakeSocket.opened[0]
    socket.accept()
    socket.receive('not json')
    socket.receive(JSON.stringify({ noId: true }))
    socket.receive(JSON.stringify({ id: 7, method: 'where_am_i', params: {} }))
    expect(await socket.lastReply()).toEqual({
      id: 7,
      result: { here: true },
      tab: { title: 'brainsonify', url: 'http://localhost:4200/?agent' },
      state: state(),
    })
    socket.receive(JSON.stringify({ id: 8, method: 'fail', params: {} }))
    expect(await socket.lastReply()).toMatchObject({ id: 8, error: 'nope' })
    expect(socket.sent).toHaveLength(3)
  })

  it('tries each address in turn with a backoff that settles, then resets it on connecting', () => {
    jest.useFakeTimers()
    const status = mock()
    const c = client({}, { onStatus: status })
    c.attach()
    FakeSocket.opened[0].drop()
    expect(FakeSocket.opened).toHaveLength(1)
    jest.advanceTimersByTime(RETRY_MS.first)
    expect(FakeSocket.opened).toHaveLength(2)
    expect(FakeSocket.opened[1].url).toBe('ws://two/app')
    FakeSocket.opened[1].drop()
    jest.advanceTimersByTime(RETRY_MS.first * 2 - 1)
    expect(FakeSocket.opened).toHaveLength(2)
    jest.advanceTimersByTime(1)
    expect(FakeSocket.opened).toHaveLength(3)
    expect(FakeSocket.opened[2].url).toBe('ws://one/agent')
    for (let i = 0; i < 8; i++) {
      FakeSocket.opened[FakeSocket.opened.length - 1].drop()
      jest.advanceTimersByTime(RETRY_MS.longest)
    }
    expect(console.warn).toHaveBeenCalledTimes(1)
    const last = FakeSocket.opened[FakeSocket.opened.length - 1]
    last.accept()
    expect(status).toHaveBeenLastCalledWith(true)
    last.drop()
    expect(status).toHaveBeenLastCalledWith(false)
    jest.advanceTimersByTime(RETRY_MS.first)
    expect(FakeSocket.opened.length).toBeGreaterThan(10)
    c.detach()
    const count = FakeSocket.opened.length
    jest.advanceTimersByTime(RETRY_MS.longest * 2)
    expect(FakeSocket.opened).toHaveLength(count)
  })

  it('gives up on an address that neither opens nor closes and tries the next', () => {
    jest.useFakeTimers()
    const status = mock()
    const c = client({}, { onStatus: status })
    c.attach()
    jest.advanceTimersByTime(CONNECT_MS - 1)
    expect(FakeSocket.opened).toHaveLength(1)
    expect(FakeSocket.opened[0].readyState).toBe(FakeSocket.CONNECTING)
    jest.advanceTimersByTime(1)
    expect(FakeSocket.opened[0].readyState).toBe(FakeSocket.CLOSED)
    jest.advanceTimersByTime(RETRY_MS.first)
    expect(FakeSocket.opened).toHaveLength(2)
    expect(FakeSocket.opened[1].url).toBe('ws://two/app')
    FakeSocket.opened[1].accept()
    expect(status).toHaveBeenLastCalledWith(true)
    // The deadline is cleared on opening: a slow but live socket stays up.
    jest.advanceTimersByTime(CONNECT_MS * 2)
    expect(FakeSocket.opened[1].readyState).toBe(FakeSocket.OPEN)
    expect(FakeSocket.opened).toHaveLength(2)
    c.detach()
  })

  it('says it is reconnecting when it comes back on a new socket, and not on the first', () => {
    jest.useFakeTimers()
    const c = client()
    c.attach()
    const first = FakeSocket.opened[0]
    first.accept()
    expect(JSON.parse(first.sent[0]).hello.reconnect).toBeUndefined()
    first.drop()
    jest.advanceTimersByTime(RETRY_MS.first)
    const second = FakeSocket.opened[1]
    second.accept()
    expect(JSON.parse(second.sent[0]).hello).toMatchObject({
      id: 'tab-1',
      reconnect: true,
    })
    c.detach()
  })

  it('takes the id the server welcomes it with, keeps it for a reload, and says hello with it from then on', () => {
    jest.useFakeTimers()
    const store = new Map<string, string>([[TAB_ID_KEY, 'tab-1']])
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    const c = client({}, { id: undefined, storage })
    expect(c.id).toBe('tab-1')
    c.attach()
    const first = FakeSocket.opened[0]
    first.accept()
    first.receive(JSON.stringify({ welcome: { id: 'tab-1' } }))
    expect(c.id).toBe('tab-1')
    first.receive(JSON.stringify({ welcome: { id: 'tab-1-2' } }))
    expect(c.id).toBe('tab-1-2')
    expect(store.get(TAB_ID_KEY)).toBe('tab-1-2')
    expect(first.sent).toHaveLength(1)
    first.drop()
    jest.advanceTimersByTime(RETRY_MS.first)
    const second = FakeSocket.opened[1]
    second.accept()
    expect(JSON.parse(second.sent[0]).hello).toMatchObject({
      id: 'tab-1-2',
      reconnect: true,
    })
    c.detach()
  })

  it('takes a welcomed id without touching storage when the id was given', () => {
    const store = new Map<string, string>([[TAB_ID_KEY, 'kept']])
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    const c = client({}, { storage })
    c.attach()
    const socket = FakeSocket.opened[0]
    socket.accept()
    socket.receive(JSON.stringify({ welcome: { id: 'tab-1-2' } }))
    expect(c.id).toBe('tab-1-2')
    expect(store.get(TAB_ID_KEY)).toBe('kept')
    c.detach()
  })

  it('does not answer on a socket it has left', async () => {
    const c = client({
      slow: () => new Promise((r) => setTimeout(() => r('late'), 5)),
    })
    c.attach()
    const socket = FakeSocket.opened[0]
    socket.accept()
    socket.receive(JSON.stringify({ id: 1, method: 'slow', params: {} }))
    c.detach()
    await new Promise((r) => setTimeout(r, 10))
    expect(socket.sent).toHaveLength(1)
  })
})

describe('tabId', () => {
  it('keeps one id per storage and makes one up without storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    const first = tabId(storage)
    expect(first).toMatch(/^[0-9a-z-]{4,8}$/i)
    expect(tabId(storage)).toBe(first)
    expect(store.get(TAB_ID_KEY)).toBe(first)
    const other = tabId(null)
    expect(other).not.toBe(first)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(tabId(broken)).toMatch(/^[0-9a-z-]{4,8}$/i)
  })
})

describe('agentUrls', () => {
  it("tries the page's own origin first, then the server, and only the server from a file", () => {
    expect(
      agentUrls({ protocol: 'http:', host: 'localhost:4200' } as Location),
    ).toEqual(['ws://localhost:4200/agent', 'ws://127.0.0.1:4242/app'])
    expect(
      agentUrls({ protocol: 'https:', host: 'x.dev' } as Location)[0],
    ).toBe('wss://x.dev/agent')
    expect(agentUrls({ protocol: 'file:', host: '' } as Location)).toEqual([
      'ws://127.0.0.1:4242/app',
    ])
  })
})
