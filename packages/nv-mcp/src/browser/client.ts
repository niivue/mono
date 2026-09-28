/**
 * The page's end of the socket: a stand-in for a hand.
 *
 * The server holds the door open for agents; this end holds the scene. On
 * connecting, the page says hello with an id that survives a reload of the
 * same tab, so the server can tell a tab that came back from a new one; the
 * server welcomes it with the id it will go by, which is its own unless a
 * live tab already holds it, as a duplicated tab's does. Each tool call
 * then arrives as one JSON request, is put to a handler, and is
 * answered with one JSON response carrying the result or the reason it
 * could not be done, plus the tab's title and where the scene stands, so
 * the server can name who answered and notice a reset. The connection is
 * kept up for as long as the client is attached: a server that is not
 * running yet, or restarts, is retried with a backoff that settles at half
 * a minute. An address that neither opens nor refuses within a few seconds
 * (a proxy that took the upgrade and hung) is given up on the same way, so
 * the next one gets its turn.
 */

import {
  type AgentRequest,
  type AgentResponse,
  type Hello,
  isWelcome,
  type TabState,
} from '../protocol'
import type { Handlers } from './scene'

/** Where the server itself listens for pages. */
export const AGENT_URL = 'ws://127.0.0.1:4242/app'

/** The path a dev server proxies to the server, on the page's own origin. */
export const AGENT_PATH = '/agent'

/** The key the tab's id is kept under in `sessionStorage`. */
export const TAB_ID_KEY = 'nv-mcp.tab'

/**
 * The addresses to try, in turn: the page's own origin first, since a browser
 * that allows a page one origin only (Claude's built-in pane) can reach
 * nothing else, then the server directly, for a build served without the
 * proxy in front of it. A page opened from a file has no origin to try.
 */
export function agentUrls(loc: Location = location): string[] {
  if (!loc.protocol.startsWith('http')) return [AGENT_URL]
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  return [`${scheme}://${loc.host}${AGENT_PATH}`, AGENT_URL]
}

/** How long to wait before the first retry, and the longest wait after that. */
export const RETRY_MS = { first: 1000, longest: 30000 } as const

/** How long an address gets to open before it is closed and the next one tried. */
export const CONNECT_MS = 5000

/** Where a tab's id is kept between its reloads. */
export type IdStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * This tab's id: kept in `sessionStorage`, which a browser scopes to one
 * tab and keeps across its reloads but does not copy to a new tab, other
 * than by duplicating it; the server catches that case and hands the copy
 * an id of its own. Made up fresh when storage is not available.
 */
export function tabId(storage: IdStorage | null = sessionStore()): string {
  try {
    const kept = storage?.getItem(TAB_ID_KEY)
    if (kept) return kept
    const fresh = freshId()
    storage?.setItem(TAB_ID_KEY, fresh)
    return fresh
  } catch {
    return freshId()
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function freshId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return (random ?? Math.random().toString(36).slice(2)).slice(0, 8)
}

export interface ClientOptions {
  /** The addresses to try in turn; `agentUrls()` otherwise. */
  urls?: readonly string[]
  /** The id to say hello with, used as given; `tabId()` otherwise. */
  id?: string
  /** Where `tabId()` keeps the id, and a spare one the server hands out; `sessionStorage` otherwise. */
  storage?: IdStorage | null
  /** What the tab is called now; `document.title` otherwise. */
  title?: () => string
  /** Where the page is; `location.href` otherwise. */
  url?: () => string
  /** Where the scene stands, for the hello and each answer's envelope. */
  state: () => TabState
  /** Told when the server is reached and when it is lost, for a status line. */
  onStatus?: (connected: boolean) => void
  /** A `WebSocket` to use instead of the page's; for tests. */
  WebSocket?: typeof WebSocket
}

/**
 * Puts one request to the handlers and shapes the answer. Anything thrown
 * becomes the error text the agent reads, so handlers throw in words.
 */
export async function serve(
  handlers: Handlers,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { id, method, params } = request
  try {
    const handler = Object.hasOwn(handlers, method)
      ? handlers[method]
      : undefined
    if (!handler) throw new Error(`Unknown method ${String(method)}.`)
    return { id, result: await handler(params ?? {}) }
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) }
  }
}

export class AgentClient {
  private ownId: string
  private readonly storage: IdStorage | null
  private readonly urls: readonly string[]
  private readonly Socket: typeof WebSocket
  private socket: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private wait: number = RETRY_MS.first
  private attached = false
  /** Which of the addresses the next attempt goes to. */
  private attempt = 0
  /** Whether the settled retry has been reported since the last connection. */
  private reported = false
  /** Whether this page has reached the server before, so a new socket is a reconnect. */
  private connectedBefore = false

  constructor(
    private readonly handlers: Handlers,
    private readonly options: ClientOptions,
  ) {
    this.storage =
      options.id === undefined ? (options.storage ?? sessionStore()) : null
    this.ownId = options.id ?? tabId(this.storage)
    this.urls = options.urls ?? agentUrls()
    this.Socket = options.WebSocket ?? WebSocket
  }

  /** The id the server lists this tab under. */
  get id(): string {
    return this.ownId
  }

  /** Whether the server is reached now. */
  get connected(): boolean {
    return this.socket?.readyState === this.Socket.OPEN
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.connect()
  }

  detach(): void {
    this.attached = false
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.socket?.close()
    this.socket = null
  }

  private title(): string {
    return (
      this.options.title?.() ??
      (typeof document === 'undefined' ? 'niivue' : document.title || 'niivue')
    )
  }

  private url(): string {
    return (
      this.options.url?.() ??
      (typeof location === 'undefined' ? '' : location.href)
    )
  }

  private hello(): Hello {
    return {
      hello: {
        id: this.ownId,
        title: this.title(),
        url: this.url(),
        state: this.options.state(),
        ...(this.connectedBefore ? { reconnect: true } : {}),
      },
    }
  }

  /** Takes the id the server welcomed this tab with, and keeps it where a reload will find it. */
  private welcomed(id: string): void {
    if (id === this.ownId) return
    console.info(
      `nv-mcp: another tab already holds the id ${this.ownId}; this one is ${id}`,
    )
    this.ownId = id
    try {
      this.storage?.setItem(TAB_ID_KEY, id)
    } catch {
      // Without storage the id lasts as long as the page does, as a fresh one would.
    }
  }

  private connect(): void {
    if (!this.attached) return
    const url = this.urls[this.attempt++ % this.urls.length]
    let socket: WebSocket
    try {
      socket = new this.Socket(url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket
    const deadline = setTimeout(() => {
      // Closing a socket that is still connecting fails it, which fires
      // `close`, so the retry below moves on to the next address.
      if (this.socket === socket) socket.close()
    }, CONNECT_MS)
    socket.addEventListener('open', () => {
      clearTimeout(deadline)
      this.wait = RETRY_MS.first
      this.reported = false
      socket.send(JSON.stringify(this.hello()))
      this.connectedBefore = true
      console.info(`nv-mcp: agent server connected at ${url}`)
      this.options.onStatus?.(true)
    })
    socket.addEventListener('message', (event) => {
      void this.handle(String(event.data)).then((response) => {
        if (
          response &&
          this.socket === socket &&
          socket.readyState === this.Socket.OPEN
        ) {
          socket.send(JSON.stringify(response))
        }
      })
    })
    socket.addEventListener('close', () => {
      clearTimeout(deadline)
      if (this.socket !== socket) return
      this.socket = null
      this.options.onStatus?.(false)
      this.scheduleRetry()
    })
    // A refused connection closes too, so the close handler does the retrying.
    socket.addEventListener('error', () => {})
  }

  private scheduleRetry(): void {
    if (!this.attached || this.retry !== null) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, this.wait)
    this.wait = Math.min(RETRY_MS.longest, this.wait * 2)
    // The browser logs each refused attempt on its own; one line says what
    // they mean, once the retry has settled at its slowest.
    if (this.wait === RETRY_MS.longest && !this.reported) {
      this.reported = true
      console.warn(
        `nv-mcp: no agent server at ${this.urls.join(' or ')}; ` +
          `still trying every ${RETRY_MS.longest / 1000} s.`,
      )
    }
  }

  private async handle(text: string): Promise<AgentResponse | null> {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return null
    }
    if (isWelcome(message)) {
      this.welcomed(message.welcome.id)
      return null
    }
    const request = message as AgentRequest
    if (typeof request?.id !== 'number') return null
    const response = await serve(this.handlers, request)
    let state: TabState | undefined
    try {
      state = this.options.state()
    } catch {
      state = undefined
    }
    return { ...response, tab: { title: this.title(), url: this.url() }, state }
  }
}
