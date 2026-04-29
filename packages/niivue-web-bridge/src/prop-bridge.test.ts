/**
 * Tests for the generic setProp / getProps / propChange wiring.
 *
 * We don't pull in the real NiiVue here -- we substitute a minimal fake
 * that supports the 3 things prop-bridge touches: property read/write,
 * addEventListener('change'), and dispatching a CustomEvent-shaped object.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Bridge, type Envelope } from './bridge'
import { DEFAULT_PROP_ALLOWLIST } from './prop-allowlist'
import { wirePropBridge } from './prop-bridge'

type ChangeListener = (e: {
  detail: { property: string; value: unknown }
}) => void

class FakeNiiVue {
  // Real NiiVue dispatches 'change' synchronously inside property setters.
  // Mirror that so the echo-suppression guard in prop-bridge works as it
  // would in production.
  private _isColorbarVisible = false
  private _gamma = 1
  private _backgroundColor = [0, 0, 0, 1]
  private listeners: ChangeListener[] = []

  get isColorbarVisible() {
    return this._isColorbarVisible
  }
  set isColorbarVisible(v: boolean) {
    this._isColorbarVisible = v
    this.fireChange('isColorbarVisible', v)
  }

  get gamma() {
    return this._gamma
  }
  set gamma(v: number) {
    this._gamma = v
    this.fireChange('gamma', v)
  }

  get backgroundColor() {
    return this._backgroundColor
  }
  set backgroundColor(v: number[]) {
    this._backgroundColor = v
    this.fireChange('backgroundColor', v)
  }

  addEventListener(_name: string, fn: ChangeListener) {
    this.listeners.push(fn)
  }

  fireChange(property: string, value: unknown) {
    for (const fn of this.listeners) fn({ detail: { property, value } })
  }
}

type MockHost = {
  messages: Envelope[]
  deliver: (env: Envelope) => void
}

function installMockHost(): MockHost {
  const messages: Envelope[] = []
  // biome-ignore lint/suspicious/noExplicitAny: global shim for tests
  const w = globalThis as any
  w.webkit = {
    messageHandlers: {
      niivue: { postMessage: (msg: Envelope) => messages.push(msg) },
    },
  }
  return {
    messages,
    deliver: (env) => {
      // biome-ignore lint/suspicious/noExplicitAny: global shim for tests
      ;(w.__niivueBridge as any).__receive(env)
    },
  }
}

describe('wirePropBridge', () => {
  let nv: FakeNiiVue
  let bridge: Bridge
  let host: MockHost

  beforeEach(() => {
    host = installMockHost()
    nv = new FakeNiiVue()
    bridge = new Bridge()
    // biome-ignore lint/suspicious/noExplicitAny: FakeNiiVue stands in for the real type
    wirePropBridge(nv as any, bridge)
  })

  test('setProp coerces and writes to the instance', async () => {
    host.deliver({
      kind: 'call',
      id: 'c-1',
      method: 'setProp',
      payload: { path: 'isColorbarVisible', value: 1 },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(nv.isColorbarVisible).toBe(true)
    expect(host.messages[0]).toMatchObject({
      kind: 'result',
      id: 'c-1',
      ok: true,
    })
  })

  test('setProp rejects paths not in the allow-list', async () => {
    host.deliver({
      kind: 'call',
      id: 'c-2',
      method: 'setProp',
      payload: { path: 'notAllowed', value: true },
    })
    await Promise.resolve()
    expect(host.messages[0]).toMatchObject({
      kind: 'result',
      id: 'c-2',
      ok: false,
    })
  })

  test('inbound setProp does NOT echo as propChange', async () => {
    host.deliver({
      kind: 'call',
      id: 'c-3',
      method: 'setProp',
      payload: { path: 'gamma', value: 2 },
    })
    await Promise.resolve()
    await Promise.resolve()
    // The assignment inside the setProp handler synchronously fires the
    // native change event via our fake setter. The prop-bridge's `applying`
    // guard must swallow that event so it doesn't echo back.
    const events = host.messages.filter((m) => m.kind === 'event')
    expect(events.length).toBe(0)
  })

  test('JS-initiated change is forwarded as propChange', () => {
    nv.fireChange('gamma', 1.5)
    const event = host.messages.find(
      (m) => m.kind === 'event' && m.name === 'propChange',
    )
    expect(event).toBeDefined()
    if (event?.kind !== 'event') throw new Error('expected event')
    expect(event.payload).toEqual({ path: 'gamma', value: 1.5 })
  })

  test('getProps returns a snapshot of every allow-listed path', async () => {
    host.deliver({ kind: 'call', id: 'c-4', method: 'getProps', payload: {} })
    await Promise.resolve()
    await Promise.resolve()
    const reply = host.messages[0]
    expect(reply.kind).toBe('result')
    if (reply.kind !== 'result' || !reply.ok)
      throw new Error('expected ok result')
    const snapshot = reply.value as Record<string, unknown>
    for (const path of Object.keys(DEFAULT_PROP_ALLOWLIST)) {
      expect(path in snapshot).toBe(true)
    }
  })

  test('changes to properties not in the allow-list are not forwarded', () => {
    nv.fireChange('someOtherProp', 42)
    expect(host.messages.find((m) => m.kind === 'event')).toBeUndefined()
  })
})
