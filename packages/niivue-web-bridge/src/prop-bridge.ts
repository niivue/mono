/**
 * Generic property sync between a NiiVue instance and a native host.
 *
 *   native -> JS: bridge.call('setProp',  { path, value })
 *   native -> JS: bridge.call('getProps', {})                 // snapshot
 *   JS -> native: bridge.emit('propChange', { path, value })
 *
 * Only properties listed in the active allow-list are writable/observable.
 */

import type NiiVue from '@niivue/niivue'
import type { Bridge } from './bridge'
import {
  coerce,
  DEFAULT_PROP_ALLOWLIST,
  type PropAllowlist,
} from './prop-allowlist'

type Nv = InstanceType<typeof NiiVue>

export type SetPropPayload = {
  path: string
  value: unknown
}

export type PropChangePayload = {
  path: string
  value: unknown
}

export type WirePropBridgeOptions = {
  /**
   * Allow-list of properties exposed to the native host. Defaults to
   * `DEFAULT_PROP_ALLOWLIST`. Pass a full map to replace, or spread it:
   *   `{ ...DEFAULT_PROP_ALLOWLIST, crosshairColor: { kind: 'rgba' } }`.
   */
  allowlist?: PropAllowlist
}

export function wirePropBridge(
  nv: Nv,
  bridge: Bridge,
  options: WirePropBridgeOptions = {},
): void {
  const allowlist = options.allowlist ?? DEFAULT_PROP_ALLOWLIST

  // Guards so inbound writes from native don't echo back as propChange events
  // and cause feedback loops in the native view-model.
  let applying = false

  bridge.handle('setProp', async (raw) => {
    const { path, value } = raw as SetPropPayload
    const spec = allowlist[path]
    if (!spec) {
      throw new Error(`property '${path}' is not in the allow-list`)
    }
    const coerced = coerce(spec.kind, value)
    applying = true
    try {
      // Runtime type-narrowing: the allow-list is the source of truth for
      // which paths are safe to write.
      ;(nv as unknown as Record<string, unknown>)[path] = coerced
    } finally {
      applying = false
    }
    return { ok: true }
  })

  // Return the full snapshot of allow-listed properties. Useful for the
  // native side to hydrate its view-model on startup or after reinit.
  bridge.handle('getProps', async () => {
    const snapshot: Record<string, unknown> = {}
    for (const path of Object.keys(allowlist)) {
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
    const spec = allowlist[detail.property]
    if (!spec || spec.emitOnChange === false) return
    bridge.emit('propChange', { path: detail.property, value: detail.value })
  })
}
