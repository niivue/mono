# medgfx

A native SwiftUI app for **macOS**, **iOS**, and **iPadOS** that hosts [NiiVue](https://github.com/niivue/niivue) (a WebGPU/WebGL2 medical image viewer) inside a single `WKWebView`. All UI chrome and data handling are native SwiftUI; the webview is strictly a rendering surface and communicates with the Swift side through a typed two-way bridge.

## Directory layout

```
apps/medgfx/
├── .gitignore                     macOS (.DS_Store) + Xcode (xcuserdata/, *.xcuserstate) noise
├── medgfx.xcodeproj/              Xcode project (targets: medgfx, medgfxTests, medgfxUITests)
├── medgfx/                        Swift target sources (target name: medgfx)
│   ├── medgfxApp.swift              @main entry — WindowGroup { ContentView() }
│   ├── ContentView.swift            Layout shell — WebView + inspector + footer
│   ├── Info.plist                   ATS exception for localhost (needed in Debug only)
│   ├── medgfx.entitlements          App Sandbox + Outgoing Network + hardened runtime
│   ├── mni152.nii.gz                Bundled sample volume (LFS-tracked, 4.1 MB)
│   ├── Assets.xcassets/             App icon + accent color
│   ├── WebView/
│   │   ├── NiiVueWebView.swift      UIView/NSView Representable wrapping WKWebView
│   │   ├── WebAssetHandler.swift    WKURLSchemeHandler for `medgfx://app/` (Release)
│   │   └── Bridge.swift             Swift side of the typed envelope bridge
│   ├── NiiVue/
│   │   ├── NiiVueModel.swift        @Observable view-model; owns Bridge + prop cells
│   │   ├── NiiVueProp.swift         Generic property cell used by the model
│   │   └── NiiVueEnums.swift        SliceType / MultiplanarType / ShowRender / Backend
│   └── Inspector/
│       ├── InspectorPanel.swift     Protocol + AnyInspectorPanel type eraser
│       ├── InspectorContainer.swift Segmented picker + active panel host
│       ├── PanelHelpers.swift       Shared `section()` + `sliderRow()` builders
│       └── Panels/
│           ├── ViewLayoutPanel.swift  Backend, slice type, multiplanar, hero, mosaic
│           ├── ChromePanel.swift      Colorbar / orient cube / crosshair / ruler toggles
│           └── ScenePanel.swift       Background color, gamma, camera (azimuth/elevation)
├── medgfxTests/                   (unused, Xcode-generated)
├── medgfxUITests/                 (unused, Xcode-generated)
└── web/                           Nx TS project "medgfx-web"
    ├── index.html                   Full-viewport <canvas id="gl1"> host
    ├── src/
    │   ├── main.ts                  Instantiates NiiVue, wires bridge, emits 'ready'
    │   ├── bridge.ts                JS side of the typed envelope bridge
    │   ├── niivue-controller.ts     Registers loadVolume / setBackend; delegates to prop-bridge
    │   ├── prop-bridge.ts           Generic setProp / getProps / propChange wiring
    │   └── prop-allowlist.ts        Allow-listed NiiVue properties + coercion kinds
    ├── vite.config.ts               Port 8083, COOP/COEP headers, base: './'
    ├── tsconfig.json
    ├── package.json                 deps: @niivue/niivue (workspace:*)
    └── project.json                 Nx targets: dev, build, typecheck, lint, format
```

The web app is a first-class Nx workspace (`medgfx-web`). The root `package.json` declares `apps/medgfx/web` as a workspace so `bun install` picks it up. Nx discovers `project.json` automatically.

## Architecture in one sentence

A Swift `WKWebView` loads a vanilla-TS Vite app that renders NiiVue into a full-viewport canvas; a shared JSON envelope protocol lets Swift and JS call each other and exchange events, with binary data (e.g. volume bytes) crossing as base64.

## The bridge

Single wire format in both directions:

```ts
type Envelope =
  | { kind: 'call',   id: string, method: string, payload: unknown }
  | { kind: 'result', id: string, ok: true,  value: unknown }
  | { kind: 'result', id: string, ok: false, error: string }
  | { kind: 'event',  name: string, payload: unknown }
```

**Transport:**
- JS → Swift: `window.webkit.messageHandlers.medgfx.postMessage(envelope)` → delivered to `WKScriptMessageHandler` in `NiiVueWebView.Coordinator` → forwarded to `Bridge.receive(rawBody:)`.
- Swift → JS: `webView.evaluateJavaScript("window.__medgfxBridge.__receive(<jsonLiteral>)")`.

**API is symmetric on both sides:**

| Operation | JS (`bridge.ts`) | Swift (`Bridge.swift`) |
|---|---|---|
| Invoke remote, await reply | `bridge.call<Out>(method, payload): Promise<Out>` | `try await bridge.call(method, payload) as Out` |
| Register a handler the other side can `call` | `bridge.handle(method, (payload) => result)` | `bridge.handle(method) { payload in ... }` |
| Fire-and-forget event | `bridge.emit(name, payload)` | `bridge.emit(name, payload)` |
| Listen for events | `bridge.on(name, handler)` | `bridge.on(name) { data in ... }` |

**Correlation:** pending `call`s are tracked by a UUID id, resolved on the matching `result` envelope. Errors cross the wire as strings; the receiver rethrows (`Error` in JS, `BridgeError.remote(String)` in Swift).

**Ready handshake:** when the webview finishes initialising, `main.ts` calls `bridge.emit('ready')`. Swift's `Bridge` buffers any outbound `call`/`emit` made before `ready` and flushes them on receipt. This avoids a race where SwiftUI wants to push data before the webview's JS is running.

**Binary data:** `Uint8Array`/`Data` are sent as base64 strings inside the JSON payload. Fine for the current PoC (single-volume load); a side channel can be added later if a payload ever bottlenecks.

### Adding a new bridge method

**Most of the time you don't need one.** NiiVue property getters/setters are already covered by the generic `setProp` / `getProps` / `propChange` path — see "Property sync" below. Only reach for a bespoke bridge method when:

- The operation is a NiiVue *method*, not a property (e.g. `loadImage`, `reinitializeView`, `createEmptyDrawing`).
- The payload isn't a single JSON-scalar/array (e.g. binary bytes, multi-arg method call).
- The operation is async and you need the result in Swift (property writes are fire-and-forget).

When you do need a bespoke method:

1. Pick a direction. Swift→JS: register the handler on the JS side with `bridge.handle('foo', ...)` (typically in `niivue-controller.ts`). JS→Swift: register it on the Swift side with `bridge.handle("foo") { ... }` (typically in `ContentView` or a dedicated controller).
2. Call it from the other side: `bridge.call('foo', payload)` / `try await bridge.call("foo", payload)`.
3. Payload and return types are plain JSON-serialisable structures. Define matching `Encodable`/`Decodable` Swift structs and TS types; the bridge itself is name-agnostic.

### Property sync — the one-line-per-control path

The generic prop bridge covers every NiiVue property whose value is a JSON scalar, string, or small array (boolean, number, enum-as-number, string, rgba tuple). It's the preferred way to expose a new control because adding one is a two-edit change — no new bridge method, no new envelope types, no new handler plumbing.

**Flow:**

```
SwiftUI control → model.<prop>.value = x → pusher closure → bridge.call('setProp', {path,value})
                                         → JS allow-list check → nv[path] = coerced(value)

NiiVue emits 'change' → prop-bridge forwards as propChange → model dispatches to cell by path
                     → cell._value updates → @Observable re-renders SwiftUI
```

An `isApplyingFromJS` guard in the model and a corresponding `applying` flag in `prop-bridge.ts` prevent echo loops when inbound updates arrive.

**To expose a new NiiVue property as a SwiftUI control:**

1. Add one line to `web/src/prop-allowlist.ts`:
   ```ts
   crosshairColor: { kind: 'rgba', emitOnChange: true },
   ```
   `kind` controls coercion on the JS side: `boolean`, `number`, `enum`, `string`, or `rgba`.
2. Add one line to `NiiVueModel.swift` (and register it in the init block):
   ```swift
   let crosshairColor: NiiVueProp<[Double]> = NiiVueProp(path: "crosshairColor", initial: [1,0,0,1])
   // in init: register(crosshairColor) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
   ```
3. Bind it in any panel:
   ```swift
   ColorPicker("Crosshair", selection: ...)  // see ScenePanel for rgba↔Color conversion
   // or: Toggle(..., isOn: model.binding(\.someBool))
   // or: Slider(value: model.binding(\.someDouble), in: 0...1)
   ```

`model.binding(\.keyPath)` returns a `Binding<Value>` that works directly with SwiftUI controls.

**When the allow-list approach isn't enough:**

- NiiVue getters that have no setter (e.g. `backend`) — write a dedicated method like `setBackend` that calls the relevant NiiVue action (`reinitializeView`) and emits a typed change event (`backendChange`) so Swift can mirror.
- Enums whose wire value is a number but whose Swift type is a Swift `enum`: declare a raw-Int `NiiVueProp<Int>` on the model (e.g. `sliceTypeRaw`) plus a typed computed var (`sliceType: SliceType`) that wraps it. See `NiiVueModel.sliceType` for the pattern.

## Build configurations

The app has exactly two moving parts:

| Config | Webview loads | Web assets come from | Needs dev server? |
|---|---|---|---|
| **Debug** | `http://localhost:8083/` | Vite dev server (HMR) | Yes — `bunx nx dev medgfx-web` |
| **Release** | `medgfx://app/index.html` | `Contents/Resources/WebApp/` inside the `.app` | No |

The loader URL is chosen at compile time via `#if DEBUG` in `NiiVueWebView.initialURL()`.

### Debug flow

1. In a terminal: `bunx nx dev medgfx-web` — Vite serves on `http://localhost:8083/` with `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (required for `crossOriginIsolated` → `SharedArrayBuffer`, which NiiVue's worker paths rely on).
2. In Xcode: run the `medgfx` scheme (default config: Debug).
3. `WKWebView` loads `http://localhost:8083/`. HMR works — edit anything under `web/src/` or `web/index.html` and the webview reloads automatically.
4. TS compile errors show up in the dev server terminal; Swift compile errors show up in Xcode.

### Release flow

No external dev server needed. A Run Script build phase on the `medgfx` target does everything:

1. Run Script phase **"Build and embed medgfx-web"** (defined in `project.pbxproj`):
   - Exits early if `CONFIGURATION != Release`.
   - Augments `PATH` with `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` because Xcode.app's script environment doesn't inherit the user shell's PATH.
   - `cd` to the monorepo root and runs `bunx nx build medgfx-web`, producing `apps/medgfx/web/dist/`.
   - `rsync -a --delete` copies `web/dist/` into `$BUILT_PRODUCTS_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/WebApp/` — on macOS this is `medgfx.app/Contents/Resources/WebApp/`, on iOS/iPadOS this is `medgfx.app/WebApp/`.
2. At runtime, `WKWebView` requests `medgfx://app/index.html`.
3. `WebAssetHandler` (registered via `WKWebViewConfiguration.setURLSchemeHandler`) resolves the request path against `Bundle.main.resourceURL!.appendingPathComponent("WebApp")` and returns the bytes with the required response headers (COOP/COEP/CORP, correct MIME type).

The custom scheme exists specifically because `loadFileURL:` cannot set response headers. Without COOP/COEP, `crossOriginIsolated` is false, `SharedArrayBuffer` is disabled, and NiiVue's worker-accelerated paths silently degrade.

### Critical Xcode project settings

- **`ENABLE_USER_SCRIPT_SANDBOXING = NO`** (project-wide). The build script needs to read from `~/.bun` and write to `DerivedData`; user-script sandboxing blocks both.
- **`ENABLE_APP_SANDBOX = YES`** + `com.apple.security.network.client` in `medgfx.entitlements`. The sandbox is on, but outgoing network is explicitly enabled so Debug can reach `localhost:8083`. Release doesn't need outgoing network (everything is bundled) but leaving it on is harmless.
- **`CODE_SIGN_ENTITLEMENTS = medgfx/medgfx.entitlements`** — make sure this field is set per configuration so your entitlements actually get applied. Xcode will silently fall back to a default entitlements set if this is missing.
- **`NSAppTransportSecurity` exception for `localhost`** in `Info.plist` — required for Debug to hit the http dev server. No exception needed for Release.
- **Run Script phase ordering** — must run after Compile Sources and Copy Bundle Resources but before code signing. Xcode signs after the last phase, and the WebApp folder must be present before signing or it won't be part of the sealed bundle.
- **Web Inspector** — `webView.isInspectable = true` is set in Debug (requires iOS 16.4+ / macOS 13.3+). Right-click the webview → Inspect Element opens Safari Web Inspector.

## SwiftUI shape

- `medgfxApp.swift` — `@main` with a single `WindowGroup { ContentView() }`. No SwiftData, no custom Scene wiring.
- `ContentView.swift` — owns `@State` instances of `Bridge` and `NiiVueModel` (the model holds a reference to the same bridge). Renders the layout shell:
  - `NiiVueWebView(bridge: bridge)` filling the main area (the dominant element).
  - Trailing `InspectorContainer` or bottom sheet (see "Responsive layout" below).
  - Footer with "Load sample" button, status text (`model.lastStatus`), and the most recent `locationChange.string` (`model.locationText`).
- `NiiVueModel` — `@MainActor @Observable` view-model. Owns every allow-listed NiiVue property as a `NiiVueProp<Value>` cell plus transient state (`isReady`, `currentBackend`, `isSwitchingBackend`, `lastStatus`, `locationText`). Subscribes once to `ready` / `propChange` / `backendChange` / `locationChange` events; fans out inbound updates to the right cell by path via a `[String: any AnyPropCell]` dispatch table.
- `NiiVueProp<Value>` — single bound property cell. Stores current value, has an injected `pusher` closure that fires on write (the model uses this to call `setProp` over the bridge), and an `applyFromJS(_:)` entry point for inbound updates that bypasses the pusher.
- `InspectorContainer` — segmented picker over an array of `AnyInspectorPanel` + a `ScrollView` hosting the active panel. Panels are registered in `InspectorPanels.all`; adding one is a one-line append.
- `NiiVueWebView` — a thin `UIViewRepresentable` (iOS/iPadOS) / `NSViewRepresentable` (macOS) wrapper around `WKWebView`. Handles configuration, script message handler registration, custom scheme handler registration, inspector toggle, and initial URL selection. Exposes no SwiftUI state — all app state flows through the `Bridge`.
- `Bridge` is a `@MainActor` reference type, stored in `@State` (not `@StateObject`, since nothing publishes).

### Responsive layout

The inspector surfaces differently by form factor:

| Platform / size class | Inspector presentation | Detection |
|---|---|---|
| macOS | Inline trailing sidebar (`HStack`-nested), collapsed from window toolbar button | `#if os(macOS)` |
| iPad + iPhone Plus landscape (regular width) | Inline trailing sidebar, toggled from navigation bar button | `@Environment(\.horizontalSizeClass) == .regular` |
| iPhone / iPad Slide Over (compact width) | `.sheet` with medium/large detents + Done button | `horizontalSizeClass == .compact` |

`useInlineInspector` in `ContentView` is the single source of truth and drives both the inline branch and the `sheetBinding`. The iOS branch wraps the root in `NavigationStack` so the `.toolbar { ToolbarItem(placement: .primaryAction) }` actually has somewhere to render — without this, iPad shows no toggle at all. `navigationBarTitleDisplayMode` is iOS-only and only referenced inside the `#if os(iOS)` branches.

### Adding an inspector panel

1. Create `medgfx/Inspector/Panels/FooPanel.swift` implementing `InspectorPanel` (`id`, `title`, `systemImage`, `body(model:)`).
2. Use `section("TITLE") { ... }` and `sliderRow(label:binding:range:format:)` from `PanelHelpers.swift` for consistent styling.
3. Bind controls via `model.binding(\.someProp)` for generic cells or a dedicated typed binding (`model.sliceTypeBinding`) for enum cells.
4. Register the panel by appending `AnyInspectorPanel(FooPanel())` to `InspectorPanels.all` in `InspectorContainer.swift`.

## Current bridge method surface

| Direction | Kind | Name | Payload | Purpose |
|---|---|---|---|---|
| Swift → JS | `call` | `loadVolume` | `{ name: string, bytesBase64: string }` | JS decodes, calls `nv.loadImage(file)` |
| Swift → JS | `call` | `setProp` | `{ path: string, value: unknown }` | Generic NiiVue property write (allow-listed paths only) |
| Swift → JS | `call` | `getProps` | `{}` | Returns snapshot of every allow-listed property, used for hydration after `ready` / backend switch |
| Swift → JS | `call` | `setBackend` | `{ backend: 'webgl2'\|'webgpu' }` | Calls `nv.reinitializeView({ backend })`; reply reports the backend that actually ended up active (NiiVue may downgrade) |
| JS → Swift | `emit` | `ready` | `{ backend: 'webgpu' \| 'webgl2' }` | Webview finished init; Swift reads `backend` into `NiiVueModel.currentBackend` |
| JS → Swift | `emit` | `propChange` | `{ path, value }` | Fired from NiiVue's `change` event when an allow-listed property changes |
| JS → Swift | `emit` | `backendChange` | `{ backend }` | Fired after a successful `setBackend` so Swift state follows |
| JS → Swift | `emit` | `locationChange` | `{ mm, voxel, string }` | NiiVue crosshair moved |

The bridge itself doesn't hardcode any names — `niivue-controller.ts` is the canonical JS registration site and `NiiVueModel.swift` is the canonical Swift registration site. For property-sync work, prefer the prop-bridge path (one line in `prop-allowlist.ts` + one line in `NiiVueModel.swift`) over a new bespoke method.

## Common commands

```bash
# Web app — run from the repo root
bunx nx dev medgfx-web        # Vite dev server on http://localhost:8083 (HMR)
bunx nx build medgfx-web      # Production build -> apps/medgfx/web/dist/
bunx nx typecheck medgfx-web
bunx nx lint medgfx-web
bunx nx format medgfx-web

# Xcode — from apps/medgfx/
xcodebuild -project medgfx.xcodeproj -scheme medgfx \
  -configuration Debug -destination 'platform=macOS,arch=arm64' build

xcodebuild -project medgfx.xcodeproj -scheme medgfx \
  -configuration Release -destination 'platform=macOS,arch=arm64' build

xcodebuild -project medgfx.xcodeproj -scheme medgfx \
  -configuration Debug -destination 'generic/platform=iOS Simulator' build
```

## Gotchas and lessons learned

- **"Waiting for webview…" forever in Debug** — almost always means the sandboxed app can't reach `localhost:8083`. Check `com.apple.security.network.client` is in the entitlements and that the entitlements file is actually wired into the target via `CODE_SIGN_ENTITLEMENTS`.
- **Blank webview in Release** — either (a) `web/dist/` wasn't rebuilt, or (b) the WebApp folder didn't make it into `Contents/Resources/`. Check the Run Script phase output in the Report Navigator, and open the `.app` bundle (`Show Package Contents`) to verify `Resources/WebApp/index.html` exists.
- **`bunx: command not found` in the Run Script** — Xcode.app doesn't inherit the shell PATH. The script explicitly prepends `~/.bun/bin`. If you switch tool managers, update the PATH line.
- **Content-hashed vite filenames** — `assets/index-*.js` changes every build. Don't add individual hashed files to Xcode as file references; rely on the Run Script's `rsync` to mirror the whole `dist/` tree.
- **SharedArrayBuffer / crossOriginIsolated** — both Debug (vite dev headers) and Release (`WebAssetHandler` headers) must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Verify in Safari Web Inspector → Network → Response Headers and in the Console via `self.crossOriginIsolated === true`.
- **Modern Xcode file-system-synchronized groups** — this project uses `PBXFileSystemSynchronizedRootGroup` for `medgfx/`, so new Swift files dropped into `medgfx/WebView/`, `medgfx/NiiVue/`, `medgfx/Inspector/`, or `medgfx/Inspector/Panels/` are picked up automatically without editing `project.pbxproj`. The web app is *not* a synchronized group — it's referenced exclusively through the Run Script phase and the `WKURLSchemeHandler`.
- **SourceKit / live-editor diagnostics lag with synchronized groups** — when adding files in a new subdirectory, your editor (VS Code / Cursor / Xcode indexer) may scream "Cannot find type 'NiiVueModel' in scope" across every cross-file reference for several minutes. `xcodebuild` is the source of truth; if it builds, the code is correct. Don't chase phantom SourceKit errors unless `xcodebuild` also fails.
- **iPad inspector missing entirely** — if a toolbar item on iOS/iPadOS doesn't appear, it's almost certainly because the view isn't inside a `NavigationStack`. macOS renders `.toolbar` into the window chrome automatically, iOS does not. Wrap the iOS branch in `NavigationStack { ... }` and the toolbar button reappears.
- **`#if os(iPadOS)` is not a thing** — Swift treats iPadOS as iOS. Use `@Environment(\.horizontalSizeClass)` (regular vs compact) to distinguish iPad from iPhone at runtime, not compile-time conditionals.
- **LFS for bundled sample volumes** — `mni152.nii.gz` in the Swift target is Git LFS-tracked via the root `.gitattributes` pattern `apps/medgfx/medgfx/**/*.nii.gz`. LFS deduplicates by content hash, so the same bytes shared with `packages/dev-images/images/volumes/mni152.nii.gz` cost zero extra LFS storage. Contributors need `git lfs install` once per machine — otherwise they'll clone the 3-line pointer file, Xcode will happily bundle that pointer as the "sample", and the Load-sample button will fail at runtime.
- **`apps/medgfx/.gitignore`** — excludes `.DS_Store`, `xcuserdata/`, and `*.xcuserstate` (per-user Xcode window/breakpoint state). `project.pbxproj`, `contents.xcworkspacedata`, and `xcshareddata/xcschemes/` must stay tracked — dropping any of them breaks the build for other contributors.
