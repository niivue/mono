# NiiVueKit

Swift half of the typed two-way bridge between a SwiftUI host and a [NiiVue](../niivue) web view. Pairs with the `@niivue/web-bridge` npm package ([`packages/niivue-web-bridge/`](../niivue-web-bridge/)).

This package is **not published**. It is consumed locally by `apps/medgfx/` via an Xcode local-package reference. To use it in another Xcode project inside this monorepo, add it with **File > Add Package Dependencies > Add Local...** and point at `packages/niivue-swift/`.

## Products

- **`BridgeCore`** -- transport-level envelope bridge. Zero NiiVue knowledge. Useful on its own if you want to reuse the protocol for a non-NiiVue WKWebView app.
- **`NiiVueKit`** -- `BridgeCore` + `NiiVueWebView` (SwiftUI) + `NiiVueModel` (`@Observable` view-model) + enums + wire types + a prebuilt default web bundle under `Resources/WebApp/`. The common import for apps that embed a NiiVue web view.

## Minimal usage

There are two ways to wire up the webview, depending on where the web bundle lives.

### Option A -- you ship your own web bundle (e.g. via a Run Script phase)

Works exactly like `apps/medgfx/`: a Run Script phase copies `web/dist/` into `Contents/Resources/WebApp/`, and `BridgeConfig.default` (`.resourceBundle = .main`) serves it.

```swift
import SwiftUI
import NiiVueKit

struct ContentView: View {
    @State private var bridge = Bridge(config: .default)
    @State private var model: NiiVueModel

    init() {
        let b = Bridge(config: .default)
        _bridge = State(initialValue: b)
        _model = State(initialValue: NiiVueModel(bridge: b))
    }

    var body: some View {
        NiiVueWebView(bridge: bridge)
            .task {
                if let url = Bundle.main.url(forResource: "scan", withExtension: "nii.gz") {
                    try? await model.loadVolume(url: url)
                }
            }
    }
}
```

To enable the Vite dev server in DEBUG builds, layer on `withDevServer(port:)`:

```swift
let config = BridgeConfig.default.withDevServer(port: 8083)
let bridge = Bridge(config: config)
```

### Option B -- zero config, use the bundled default web app

`NiiVueKit` is *set up* to ship a prebuilt copy of `medgfx-web` under `Sources/NiiVueKit/Resources/WebApp/`, addressable via `BridgeConfig.niiVueKitBundled` (`.resourceBundle = .module`). The bundle itself is **not committed** -- you have to generate it once locally:

```bash
packages/niivue-swift/scripts/build-web.sh
```

Then:

```swift
let bridge = Bridge(config: .niiVueKitBundled)
```

Why not committed: Vite emits content-hashed filenames, so every rebuild would add ~900 KB of new text blobs to git history. The script is fast (~2s on a warm cache) and only needs to run once per clone (or whenever `@niivue/niivue` / `@niivue/web-bridge` / `medgfx-web` change). If the directory is empty (only the placeholder README), `BridgeConfig.niiVueKitBundled` returns 404s for every asset request and the webview stays blank -- that's the signal to run the script.

You still need to register handler names on the JS side that match `BridgeConfig.default` (the built-in bundle uses `niivue` / `__niivueBridge` / `niivue-app://`).

## Rebuilding the bundled web app

```bash
packages/niivue-swift/scripts/build-web.sh
```

Builds `medgfx-web` and rsyncs `apps/medgfx/web/dist/` into `Sources/NiiVueKit/Resources/WebApp/`. The result is **gitignored** -- each contributor runs this locally once. The placeholder `Resources/WebApp/README.md` is preserved across runs (and excluded from the SPM `.copy` via `Package.swift#exclude`) so the SPM resource declaration always has a directory to resolve.

The pinned `@niivue/niivue` version is exposed at runtime as `NiiVueKit.niiVueVersion`; update it (in `Sources/NiiVueKit/BridgeConfig+Bundled.swift`) whenever you rebuild against a new `@niivue/niivue` release.

### CI note

Anything that does `swift build` / `swift test` against `NiiVueKit` does not require the bundle -- the tests don't touch `WebAssetHandler`. But a CI job that exercises `BridgeConfig.niiVueKitBundled` end-to-end (or a consumer app relying on it) must run `scripts/build-web.sh` before `swift build`.

## Architecture

See the app-level overview in [`apps/medgfx/AGENTS.md`](../../apps/medgfx/AGENTS.md) for the wire protocol, the property-sync path, and the DEBUG/RELEASE loader flow. This package is the generic extraction of that code.

## Tests

```bash
cd packages/niivue-swift
swift test
```

`BridgeCoreTests` covers envelope round-trip, `AnyJSON` decoding, the ready handshake (queue flushes on `ready`), `ok:false` result propagation to `BridgeError.remote`, and the U+2028 / U+2029 escape step. `NiiVueKitTests` drives a mock `Bridge` (via the internal `_testOutboundSink` hook) through `NiiVueModel` to verify outbound `setProp`, inbound `propChange` with echo-suppression, the automatic `hydrate()` on `ready`, and init-time `extraCells`.
