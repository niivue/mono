/**
 * Generic property sync between NiiVue and the native host.
 *
 *   Native → JS: bridge.call('setProp', { path, value })
 *   JS → Native: bridge.emit('propChange', { path, value })
 *
 * Only properties listed in PROP_ALLOWLIST are writable/observable.
 */

import type NiiVue from '@niivue/niivue'
import type { Bridge } from './bridge'
import { coerce, PROP_ALLOWLIST } from './prop-allowlist'

type Nv = InstanceType<typeof NiiVue>

export type SetPropPayload = {
  path: string
  value: unknown
}

export type PropChangePayload = {
  path: string
  value: unknown
}

export function wirePropBridge(nv: Nv, bridge: Bridge): void {
  // A guard so inbound writes from native don't echo back as propChange events
  // and cause feedback loops in the Swift view-model.
  let applying = false

  bridge.handle('setProp', async (raw) => {
    const { path, value } = raw as SetPropPayload
    const spec = PROP_ALLOWLIST[path]
    if (!spec) {
      throw new Error(`property '${path}' is not in the allow-list`)
    }
    const coerced = coerce(spec.kind, value)
    applying = true
    try {
      // Runtime type-narrowing: we intentionally erase the generic type here
      // since the allow-list is the source of truth for what's safe.
      ;(nv as unknown as Record<string, unknown>)[path] = coerced
    } finally {
      applying = false
    }
    return { ok: true }
  })

  // Return the full snapshot of allow-listed properties. Useful for Swift
  // to hydrate its view-model on startup.
  bridge.handle('getProps', async () => {
    const snapshot: Record<string, unknown> = {}
    for (const path of Object.keys(PROP_ALLOWLIST)) {
      snapshot[path] = (nv as unknown as Record<string, unknown>)[path]
    }
    return snapshot
  })

  nv.addEventListener('change', (event) => {
    if (applying) return
    const detail = (event as CustomEvent).detail as {
      property?: string
      value?: unknown
    }
    if (!detail?.property) return
    const spec = PROP_ALLOWLIST[detail.property]
    if (!spec || spec.emitOnChange === false) return
    bridge.emit('propChange', { path: detail.property, value: detail.value })
  })
}
