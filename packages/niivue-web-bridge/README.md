# @niivue/web-bridge

JS/TS half of the typed two-way bridge between a [NiiVue](../niivue) web view and a native WKWebView host.

Pairs with the Swift package `packages/niivue-swift/` (products `BridgeCore` + `NiiVueKit`). Together they let a SwiftUI app drive a NiiVue instance running inside `WKWebView` via a single JSON envelope protocol, with no app-specific plumbing.

## Wire format

```ts
type Envelope =
  | { kind: 'call',   id: string, method: string, payload: unknown }
  | { kind: 'result', id: string, ok: true,  value: unknown }
  | { kind: 'result', id: string, ok: false, error: string }
  | { kind: 'event',  name: string, payload: unknown }
```

- JS -> native via `window.webkit.messageHandlers[handlerName].postMessage(env)`.
- native -> JS via `window[jsGlobalName].__receive(env)`.
- The `handlerName` and `jsGlobalName` are configurable (see `BridgeOptions`); they must match the `BridgeConfig` passed on the Swift side.

## Usage

```ts
import NiiVue from '@niivue/niivue'
import { createBridge } from '@niivue/web-bridge/bridge'
import { wireNiiVueToBridge } from '@niivue/web-bridge/niivue-controller'

const nv = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
const bridge = createBridge() // defaults to handlerName: 'niivue'
wireNiiVueToBridge(nv, bridge)
await nv.attachToCanvas(document.getElementById('gl1') as HTMLCanvasElement)
bridge.emit('ready', { backend: nv.backend })
```

## Public API

Each module is a named subpath export (no barrel file):

- `@niivue/web-bridge/bridge` -- `Bridge`, `createBridge(options)`, wire types (`Envelope`, `BridgeOptions`).
- `@niivue/web-bridge/niivue-controller` -- `wireNiiVueToBridge(nv, bridge, options?)`. Registers `loadVolume`, `setBackend`, the generic prop-bridge, and forwards `locationChange`.
- `@niivue/web-bridge/prop-bridge` -- `wirePropBridge(nv, bridge, options?)`. Generic `setProp` / `getProps` / `propChange` path. Called by `wireNiiVueToBridge`; exported for hosts that don't want the rest.
- `@niivue/web-bridge/prop-allowlist` -- `DEFAULT_PROP_ALLOWLIST`, `PropAllowlist`, `PropKind`, `coerce`.

## Custom allow-list

```ts
import { DEFAULT_PROP_ALLOWLIST } from '@niivue/web-bridge/prop-allowlist'
import { wireNiiVueToBridge } from '@niivue/web-bridge/niivue-controller'

wireNiiVueToBridge(nv, bridge, {
  allowlist: {
    ...DEFAULT_PROP_ALLOWLIST,
    crosshairColor: { kind: 'rgba', emitOnChange: true },
  },
})
```

Add the matching cell on the Swift side (`NiiVueProp<[Double]>(path: "crosshairColor", initial: [1,0,0,1])`) and it round-trips. Prefer passing the cell via `NiiVueModel(bridge:, extraCells:)` at init-time so it's visible to the automatic `hydrate()` on `ready`.

## Development

This package exposes a `development` condition in `package.json#exports` pointing at `src/`, so Vite-based consumers (`apps/medgfx/web`) get instant edits without a prior `nx build`. For production builds (`nx build niivue-web-bridge`), Vite emits one `.js` + `.d.ts` per entry.

## Tests

```bash
cd packages/niivue-web-bridge
bun test
```

Covers envelope round-trip, handler registration (including the duplicate-throws precondition), event fanout, `coerce()` matrix, and the prop-bridge echo-suppression guard. A `window = globalThis` shim is loaded via `bunfig.toml` so the browser-flavoured `resolveNativeSink` works outside a DOM.
