/**
 * The bridge between an agent's tool call and the tab that answers it.
 *
 * Each page connects over a socket, says hello with a stable id and its
 * title, and stays connected; the server holds those sockets here as tabs.
 * A call is one request written to one tab and one response read back,
 * matched by id. The server does nothing itself: every answer comes from
 * a page, which is where the volume and the atlas are.
 *
 * Which tab answers: the one `use_tab` chose, for as long as it is there;
 * otherwise the only tab connected; otherwise the tab that answered last,
 * if it is still connected. With several tabs and no history a call fails
 * with the list, since guessing which window a person is looking at is
 * worse than asking. A tab that reloads comes back with the same id and is
 * picked up again where it was, and the next call is told that the scene
 * started over, with what it was showing before. A tab that was duplicated
 * arrives with the original's id while the original is still here; it is
 * given a spare id and told, and both are listed, since either may be the
 * one a person is looking at.
 *
 * Calls to one tab go one at a time, in the order they were made. The
 * page's handlers all change the one scene, and two loads or moves running
 * at once would race each other in it; an agent that fires several tools
 * together still gets each answered against the scene the one before left.
 */

import {
  type AgentRequest,
  type AgentResponse,
  type Hello,
  isHello,
  type TabState,
  type Welcome,
} from '../protocol'

/** Anything that can carry text to a page. `Bun.serve`'s socket does. */
export interface AppSocket {
  send(text: string): unknown
}

/** A connected tab, as `list_tabs` reports it. */
export interface TabInfo {
  id: string
  title: string
  url: string
  /** Milliseconds since the epoch when this connection said hello. */
  connectedAt: number
}

export interface TabListing extends TabInfo {
  /** Whether a call now would go to this tab. */
  bound: boolean
  /** Where the scene stood at its last answer, or at hello. */
  state: TabState | null
}

/** What the server knows about a tab that came back after going away. */
export interface ResetReport {
  reloadedAt: number
  /** The scene at the tab's last answer before it went, if it ever answered. */
  before: TabState | null
  /** The scene as the tab reconnected. */
  after: TabState | null
}

/** One tool call's answer, with who gave it. */
export interface CallResult {
  result: unknown
  tab: TabInfo
  /** Set on the first call after the answering tab reloaded, then cleared. */
  reloaded: ResetReport | null
}

interface Tab extends TabInfo {
  socket: AppSocket
  state: TabState | null
  reset: ResetReport | null
}

interface Pending {
  tab: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** How long a call may take before the agent is told the page did not answer. */
export const CALL_TIMEOUT_MS = 15000

/** How long a call waits for a tab that just went away to come back, as a reload does. */
export const RETURN_GRACE_MS = 5000

/** How long a gone tab is remembered, so a slow reload is still a reload. */
const REMEMBER_LOST_MS = 10 * 60 * 1000

/** What a call fails with while no tab is connected; `BridgeOptions.noTabHint` adds the app's own advice. */
export const NO_APP = 'No NiiVue tab is connected.'

export interface BridgeOptions {
  timeoutMs?: number
  returnGraceMs?: number
  /** Appended to `NO_APP`, for example how to open the page. */
  noTabHint?: string
  now?: () => number
}

export class Bridge {
  private readonly tabs = new Map<string, Tab>()
  private readonly bySocket = new Map<AppSocket, string>()
  private readonly lost = new Map<
    string,
    { at: number; state: TabState | null }
  >()
  private readonly pending = new Map<number, Pending>()
  private readonly returning: Array<{
    id: string
    resolve: (tab: Tab | null) => void
  }> = []
  /** The last call queued to each tab, which the next one waits behind. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private chosen: string | null = null
  private lastUsed: string | null = null
  private nextId = 1
  private readonly timeoutMs: number
  private readonly returnGraceMs: number
  private readonly now: () => number
  /** The whole message a call fails with while no tab is connected. */
  readonly noApp: string

  constructor(options: BridgeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS
    this.returnGraceMs = options.returnGraceMs ?? RETURN_GRACE_MS
    this.noApp = options.noTabHint ? `${NO_APP} ${options.noTabHint}` : NO_APP
    this.now = options.now ?? Date.now
  }

  /** Whether any tab has said hello. */
  get connected(): boolean {
    return this.tabs.size > 0
  }

  /** A socket opened. Nothing is known about it until it says hello. */
  attach(_socket: AppSocket): void {
    // Kept for symmetry with detach; a page that never says hello is simply never a tab.
  }

  /** A socket closed. If it was a tab, the tab is remembered for a while in case it is a reload. */
  detach(socket: AppSocket): void {
    const id = this.bySocket.get(socket)
    if (id === undefined) return
    this.bySocket.delete(socket)
    const tab = this.tabs.get(id)
    if (!tab || tab.socket !== socket) return
    this.tabs.delete(id)
    this.lost.set(id, { at: this.now(), state: tab.state })
    this.failPending(
      id,
      `The tab "${tab.title}" disconnected before it answered.`,
    )
  }

  /** Text from a socket: a hello, or a response to an open call. Anything else is dropped. */
  receive(socket: AppSocket, text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (isHello(message)) {
      this.greet(socket, message)
      return
    }
    const response = message as AgentResponse
    const id = this.bySocket.get(socket)
    if (id === undefined) return
    const tab = this.tabs.get(id)
    if (!tab || tab.socket !== socket) return
    if (response.tab) {
      tab.title = response.tab.title
      tab.url = response.tab.url
    }
    if (response.state) tab.state = response.state
    const waiting = this.pending.get(response.id)
    if (!waiting || waiting.tab !== id) return
    this.pending.delete(response.id)
    clearTimeout(waiting.timer)
    if (response.error !== undefined) waiting.reject(new Error(response.error))
    else waiting.resolve(response.result)
  }

  /** Every connected tab, oldest first. */
  list(): TabListing[] {
    const bound = this.boundNow()
    return [...this.tabs.values()]
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map(({ id, title, url, connectedAt, state }) => ({
        id,
        title,
        url,
        connectedAt,
        state,
        bound: id === bound,
      }))
  }

  /** Makes this tab the one that answers, until it is gone for good or another is chosen. */
  use(id: string): TabInfo {
    const tab = this.tabs.get(id)
    if (!tab) {
      throw new Error(
        `No connected tab has the id "${id}". ${this.describeTabs()}`,
      )
    }
    this.chosen = id
    return info(tab)
  }

  /**
   * Puts one tool call to the answering tab and waits for its answer. The
   * tab is chosen now; the request is written once every call queued to
   * that tab before it has been answered, or has failed.
   */
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<CallResult> {
    const chosen = await this.target()
    const ahead = this.queues.get(chosen.id) ?? Promise.resolve()
    const turn = ahead
      .catch(() => undefined)
      .then(() => this.sendWhenLive(chosen, method, params))
    this.queues.set(chosen.id, turn)
    let answered: { tab: Tab; result: unknown }
    try {
      answered = await turn
    } finally {
      if (this.queues.get(chosen.id) === turn) this.queues.delete(chosen.id)
    }
    const { tab, result } = answered
    this.lastUsed = tab.id
    const reloaded = tab.reset
    tab.reset = null
    return { result, tab: info(tab), reloaded }
  }

  /**
   * Writes the request to the tab once its turn comes: to its connection
   * now, which may be a newer one than when the call was queued, or to
   * the one it comes back on if it is mid-reload.
   */
  private async sendWhenLive(
    chosen: Tab,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ tab: Tab; result: unknown }> {
    const tab = this.tabs.get(chosen.id) ?? (await this.awaitReturn(chosen.id))
    if (!tab) {
      throw new Error(
        `The tab "${chosen.title}" disconnected before ${method} was sent.`,
      )
    }
    return { tab, result: await this.send(tab, method, params) }
  }

  private greet(socket: AppSocket, { hello }: Hello): void {
    this.forget()
    let id = hello.id
    let reset: ResetReport | null = null
    const previous = this.tabs.get(id)
    if (previous && !hello.reconnect) {
      // A page loaded fresh with an id a live tab holds: a browser copies
      // sessionStorage into a duplicated tab. Either may be the one a person
      // is looking at, so the newcomer gets a spare id, which the welcome
      // below tells it, and the original goes on as it was.
      id = this.spareId(hello.id)
    } else if (previous) {
      // The same page again on a new socket: it lost its old one, whose
      // close has not arrived here. The new connection is the live one, and
      // the scene is as it was, so there is no reset to report.
      this.bySocket.delete(previous.socket)
      this.failPending(
        id,
        `The tab "${previous.title}" reconnected before it answered.`,
      )
    } else {
      const gone = this.lost.get(id)
      if (gone && !hello.reconnect) {
        reset = {
          reloadedAt: this.now(),
          before: gone.state,
          after: hello.state,
        }
      }
    }
    this.lost.delete(id)
    const tab: Tab = {
      id,
      title: hello.title,
      url: hello.url,
      connectedAt: this.now(),
      socket,
      state: hello.state ?? null,
      reset,
    }
    this.tabs.set(id, tab)
    this.bySocket.set(socket, id)
    const welcome: Welcome = { welcome: { id } }
    try {
      socket.send(JSON.stringify(welcome))
    } catch {
      // A socket that cannot be written closes, and detach takes it from here.
    }
    for (let i = this.returning.length - 1; i >= 0; i--) {
      if (this.returning[i].id === id)
        this.returning.splice(i, 1)[0].resolve(tab)
    }
  }

  /** An id near `base` that no tab holds, held, was chosen, or answered last. */
  private spareId(base: string): string {
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`
      if (
        !this.tabs.has(candidate) &&
        !this.lost.has(candidate) &&
        candidate !== this.chosen &&
        candidate !== this.lastUsed
      ) {
        return candidate
      }
    }
  }

  /** The tab a call goes to now, waiting briefly for one that is mid-reload. */
  private async target(): Promise<Tab> {
    if (this.chosen !== null) {
      const chosen =
        this.tabs.get(this.chosen) ?? (await this.awaitReturn(this.chosen))
      if (chosen) return chosen
      const id = this.chosen
      this.chosen = null
      throw new Error(
        `The tab chosen with use_tab (${id}) is no longer connected. ${this.describeTabs()}`,
      )
    }
    if (this.tabs.size === 1) return [...this.tabs.values()][0]
    if (this.lastUsed !== null) {
      const last =
        this.tabs.get(this.lastUsed) ??
        (this.tabs.size === 0 ? await this.awaitReturn(this.lastUsed) : null)
      if (last) return last
    }
    if (this.tabs.size === 0) throw new Error(this.noApp)
    throw new Error(
      `${this.tabs.size} tabs are connected and none is chosen. ${this.describeTabs()}`,
    )
  }

  /** Resolves with the tab when it says hello again within the grace, else null. */
  private awaitReturn(id: string): Promise<Tab | null> {
    if (!this.lost.has(id)) return Promise.resolve(null)
    return new Promise((resolve) => {
      const entry = { id, resolve }
      this.returning.push(entry)
      setTimeout(() => {
        const at = this.returning.indexOf(entry)
        if (at >= 0) {
          this.returning.splice(at, 1)
          resolve(null)
        }
      }, this.returnGraceMs)
    })
  }

  private send(
    tab: Tab,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++
    const request: AgentRequest = { id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `The tab "${tab.title}" did not answer ${method} within ${this.timeoutMs / 1000} seconds.`,
          ),
        )
      }, this.timeoutMs)
      this.pending.set(id, { tab: tab.id, resolve, reject, timer })
      try {
        tab.socket.send(JSON.stringify(request))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private boundNow(): string | null {
    if (this.chosen !== null && this.tabs.has(this.chosen)) return this.chosen
    if (this.tabs.size === 1) return [...this.tabs.keys()][0]
    if (this.lastUsed !== null && this.tabs.has(this.lastUsed))
      return this.lastUsed
    return null
  }

  private describeTabs(): string {
    const tabs = this.list()
    if (tabs.length === 0) return this.noApp
    const lines = tabs.map(
      (tab) => `${tab.id} "${tab.title}"${tab.bound ? ' (answering)' : ''}`,
    )
    return `Connected: ${lines.join('; ')}. Call use_tab with the id to drive.`
  }

  private failPending(tab: string, reason: string): void {
    for (const [id, waiting] of this.pending) {
      if (waiting.tab !== tab) continue
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  /** Drops gone tabs too old to be a reload. */
  private forget(): void {
    const cutoff = this.now() - REMEMBER_LOST_MS
    for (const [id, entry] of this.lost)
      if (entry.at < cutoff) this.lost.delete(id)
  }
}

function info({ id, title, url, connectedAt }: Tab): TabInfo {
  return { id, title, url, connectedAt }
}
