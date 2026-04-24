/**
 * Typed two-way bridge between the webview and the native host.
 *
 * Wire format (both directions):
 *   { kind: 'call',   id, method, payload }
 *   { kind: 'result', id, ok: true,  value }
 *   { kind: 'result', id, ok: false, error }
 *   { kind: 'event',  name, payload }
 *
 * Transport:
 *   JS → native: window.webkit.messageHandlers.medgfx.postMessage(envelope)
 *   native → JS: native calls window.__medgfxBridge.__receive(envelope)
 *
 * In a regular browser (no native host), a dev shim logs outbound messages
 * so the web app still runs for local development.
 */

export type CallEnvelope = {
  kind: 'call'
  id: string
  method: string
  payload: unknown
}

export type ResultEnvelope =
  | { kind: 'result'; id: string; ok: true; value: unknown }
  | { kind: 'result'; id: string; ok: false; error: string }

export type EventEnvelope = {
  kind: 'event'
  name: string
  payload: unknown
}

export type Envelope = CallEnvelope | ResultEnvelope | EventEnvelope

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type CallHandler = (payload: unknown) => unknown | Promise<unknown>
type EventHandler = (payload: unknown) => void

type NativeSink = (envelope: Envelope) => void

function resolveNativeSink(): NativeSink {
  type WebkitWindow = Window & {
    webkit?: {
      messageHandlers?: {
        medgfx?: { postMessage: (msg: unknown) => void }
      }
    }
  }
  const w = window as WebkitWindow
  const handler = w.webkit?.messageHandlers?.medgfx
  if (handler) return (env) => handler.postMessage(env)
  // Dev shim — runs in a regular browser (no native host).
  return (env) => {
    console.info('[medgfx-bridge:dev-shim] →', env)
  }
}

export class Bridge {
  private readonly sendToNative: NativeSink
  private readonly pending = new Map<string, Pending>()
  private readonly callHandlers = new Map<string, CallHandler>()
  private readonly eventHandlers = new Map<string, Set<EventHandler>>()

  constructor() {
    this.sendToNative = resolveNativeSink()
    // Expose a stable receiver for the native side.
    type BridgeWindow = Window & {
      __medgfxBridge?: { __receive: (env: Envelope) => void }
    }
    ;(window as BridgeWindow).__medgfxBridge = {
      __receive: (env) => this.receive(env),
    }
  }

  /** Invoke a handler on the native side and await its reply. */
  call<Out = unknown>(method: string, payload: unknown = {}): Promise<Out> {
    const id = crypto.randomUUID()
    return new Promise<Out>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as Out),
        reject,
      })
      this.sendToNative({ kind: 'call', id, method, payload })
    })
  }

  /** Fire-and-forget event to the native side. */
  emit(name: string, payload: unknown = {}): void {
    this.sendToNative({ kind: 'event', name, payload })
  }

  /** Register a handler the native side can invoke via `call`. */
  handle(method: string, handler: CallHandler): void {
    if (this.callHandlers.has(method)) {
      throw new Error(`medgfx-bridge: handler already registered for '${method}'`)
    }
    this.callHandlers.set(method, handler)
  }

  /** Subscribe to events emitted by the native side. Returns an unsubscribe fn. */
  on(event: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(event)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(event, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  private receive(env: Envelope): void {
    switch (env.kind) {
      case 'result':
        this.handleResult(env)
        return
      case 'call':
        void this.handleCall(env)
        return
      case 'event':
        this.handleEvent(env)
        return
    }
  }

  private handleResult(env: ResultEnvelope): void {
    const pending = this.pending.get(env.id)
    if (!pending) return
    this.pending.delete(env.id)
    if (env.ok) pending.resolve(env.value)
    else pending.reject(new Error(env.error))
  }

  private async handleCall(env: CallEnvelope): Promise<void> {
    const handler = this.callHandlers.get(env.method)
    if (!handler) {
      this.sendToNative({
        kind: 'result',
        id: env.id,
        ok: false,
        error: `no handler registered for '${env.method}'`,
      })
      return
    }
    try {
      const value = await handler(env.payload)
      this.sendToNative({ kind: 'result', id: env.id, ok: true, value })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.sendToNative({ kind: 'result', id: env.id, ok: false, error: msg })
    }
  }

  private handleEvent(env: EventEnvelope): void {
    const set = this.eventHandlers.get(env.name)
    if (!set) return
    for (const h of set) {
      try {
        h(env.payload)
      } catch (err) {
        console.error(`[medgfx-bridge] event handler '${env.name}' threw`, err)
      }
    }
  }
}

export const bridge = new Bridge()
