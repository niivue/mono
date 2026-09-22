# medgfx

A native SwiftUI app for **macOS**, **iOS**, **iPadOS** and **visionOS** (configured, untested) that hosts [NiiVue](https://github.com/niivue/niivue) (a WebGPU/WebGL2 medical image viewer) inside a single `WKWebView`. All UI chrome and data handling are native SwiftUI; the webview is strictly a rendering surface and communicates with the Swift side through a typed two-way bridge.

## Directory layout

```
apps/medgfx/
├── .gitignore                     macOS (.DS_Store) + Xcode (xcuserdata/, *.xcuserstate) noise
├── medgfx.xcodeproj/              Xcode project (targets: medgfx, QuickLookPreview,
│                                  medgfxTests, medgfxUITests)
│                                  References the Swift package at ../../packages/niivue-swift
│                                  via XCLocalSwiftPackageReference (product: NiiVueKit).
├── medgfx/                        Swift target sources (target name: medgfx)
│   ├── medgfxApp.swift              @main entry — WindowGroup { ContentView() }
│   ├── ContentView.swift            Layout shell — NiiVueWebView + inspector + footer
│   ├── AboutView.swift              macOS About window — version, authors, project links
│   ├── AboutAuthors.generated.swift generated contributor names (do not edit directly)
│   ├── Info.plist                   ATS exception for localhost (needed in Debug only)
│   ├── medgfx.entitlements          App Sandbox + Outgoing Network only
│                                    (hardened runtime is a build setting)
│   ├── mni152.nii.gz                Bundled sample volume (LFS-tracked, 4.1 MB)
│   ├── Assets.xcassets/             App icon + accent color
│   └── Inspector/                   App-specific display inspector (not part of NiiVueKit)
│       ├── InspectorContainer.swift Scrollable disclosure-section host
│       ├── InspectorSectionViews.swift Focused Layout / Guides / Appearance / 3D / Advanced views
│       ├── InspectorSettings.swift  Typed setting vocabulary, choices, and bindings
│       ├── ViewerLayoutContext.swift Central layout state, precedence, and transitions
│       └── PanelHelpers.swift       Shared setting-aware picker, toggle, and slider controls
├── QuickLookPreview/              macOS Quick Look extension (appex target). See below.
│   ├── PreviewViewController.swift  NSViewController + QLPreviewingController
│   ├── PreviewSchemeHandler.swift   bundled assets + the one previewed document
│   ├── PreviewFileKind.swift        which files we draw, decided by filename
│   ├── GzipPeek.swift               streaming inflate bound (size guard only)
│   ├── Info.plist                   NSExtension + QLSupportedContentTypes
│   └── QuickLookPreview.entitlements
├── scripts/
│   ├── install-quicklook.sh       build, register, prove which binary Finder uses
│   ├── check-preview-file-kind.sh runs the routing self-check
│   ├── check-gzip-bound.sh        decompression-bound regression
│   ├── *.swift                    the checks themselves
│   ├── generate-about-authors.ts  generate About authors from medgfx Git history
│   └── about-author-name-map.json override Git identities with display names
├── medgfxTests/                   (unused, Xcode-generated)
├── medgfxUITests/                 (unused, Xcode-generated)
└── web/                           Nx TS project "medgfx-web"
    ├── index.html                   Full-viewport <canvas id="gl1"> host
    ├── src/
    │   ├── main.ts                  App page: NiiVue + bridge, emits 'ready'
    │   ├── quicklook.ts             Quick Look preview page (no bridge; see below)
    │   └── preview-metadata.ts      describeVolume / describeMesh for the strip
    ├── vite.config.ts               Port 8083, COOP/COEP headers, base: './',
    │                                resolves the `development` export condition of
    │                                @niivue/web-bridge so the dev server uses source.
    ├── tsconfig.json
    ├── package.json                 deps: @niivue/niivue, @niivue/web-bridge (both workspace:*)
    ├── quicklook.html              Quick Look preview page (second Vite entry)
    ├── tests/                      Playwright checks for the preview page
    └── project.json                 Nx targets: dev, build, typecheck, lint, format, e2e
```

The reusable bridge code lives in two packages under `packages/`:

- **`packages/niivue-swift/`** (Swift Package, products `BridgeCore` + `NiiVueKit`) — owns `Bridge`, `BridgeConfig`, `WebAssetHandler`, `NiiVueWebView`, `NiiVueModel`, `NiiVueProp`, `NiiVueEnums`, and the wire types. Also has an optional bundled web app slot under `Sources/NiiVueKit/Resources/WebApp/` (gitignored; regenerate with `scripts/build-web.sh`, consumed via `BridgeConfig.niiVueKitBundled`). `apps/medgfx/` does *not* use that slot — it ships its own web bundle via a Run Script phase.
- **`packages/niivue-web-bridge/`** (`@niivue/web-bridge`) — owns `bridge.ts`, `prop-bridge.ts`, `prop-allowlist.ts`, `niivue-controller.ts`.

`apps/medgfx/` is a consumer of both. Its Xcode project stores a relative-path `XCLocalSwiftPackageReference` to `../../packages/niivue-swift`; its web app depends on `@niivue/web-bridge` via `workspace:*`.

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
- JS → Swift: `window.webkit.messageHandlers.niivue.postMessage(envelope)` → delivered to `WKScriptMessageHandler` in `NiiVueWebView.Coordinator` → forwarded to `Bridge.receive(rawBody:)`.
- Swift → JS: `webView.evaluateJavaScript("window.__niivueBridge.__receive(<jsonLiteral>)")`.

(Handler name and JS global are configurable via `BridgeConfig`; medgfx uses `BridgeConfig.default`, which pins them to `niivue` / `__niivueBridge` / scheme `niivue-app://`. Matches the defaults of `@niivue/web-bridge`.)

**API is symmetric on both sides:**

| Operation | JS (`@niivue/web-bridge/bridge`) | Swift (`BridgeCore.Bridge`) |
|---|---|---|
| Invoke remote, await reply | `bridge.call<Out>(method, payload): Promise<Out>` | `try await bridge.call(method, payload) as Out` |
| Register a handler the other side can `call` | `bridge.handle(method, (payload) => result)` | `bridge.handle(method) { payload in ... }` |
| Fire-and-forget event | `bridge.emit(name, payload)` | `bridge.emit(name, payload)` |
| Listen for events | `bridge.on(name, handler)` | `bridge.on(name) { data in ... }` |

**Correlation:** pending `call`s are tracked by a UUID id, resolved on the matching `result` envelope. Errors cross the wire as strings; the receiver rethrows (`Error` in JS, `BridgeError.remote(String)` in Swift).

**Ready handshake:** when the webview finishes initialising, `main.ts` calls `bridge.emit('ready')`. Swift's `Bridge` buffers any outbound `call`/`emit` made before `ready` and flushes them on receipt. This avoids a race where SwiftUI wants to push data before the webview's JS is running.

**Binary data:** `Uint8Array`/`Data` are sent as base64 strings inside the JSON payload. This is a known cost, not a design — see "Deferred debt". The Quick Look extension does *not* use it; it serves the file over a scheme handler instead.

### Adding a new bridge method

**Most of the time you don't need one.** NiiVue property getters/setters are already covered by the generic `setProp` / `getProps` / `propChange` path — see "Property sync" below. Only reach for a bespoke bridge method when:

- The operation is a NiiVue *method*, not a property (e.g. `loadImage`, `reinitializeView`, `createEmptyDrawing`).
- The payload isn't a single JSON-scalar/array (e.g. binary bytes, multi-arg method call).
- The operation is async and you need the result in Swift (property writes are fire-and-forget).

When you do need a bespoke method:

1. Pick a direction. Swift→JS: register the handler on the JS side with `bridge.handle('foo', ...)` (typically in `packages/niivue-web-bridge/src/niivue-controller.ts`). JS→Swift: register it on the Swift side with `bridge.handle("foo") { ... }` (typically in `ContentView` or on `NiiVueModel`).
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

For properties already in `NiiVueModel`'s built-in list, just bind them (e.g. `Toggle(..., isOn: model.binding(\.isColorbarVisible))`). For new properties:

1. Add one line to `packages/niivue-web-bridge/src/prop-allowlist.ts` (extends `DEFAULT_PROP_ALLOWLIST`, or pass a custom map to `wireNiiVueToBridge`):
   ```ts
   crosshairColor: { kind: 'rgba', emitOnChange: true },
   ```
`kind` controls coercion on the JS side: `boolean`, `number`, `enum`, `string`, `rgba`, or `json` for structured Codable values such as `customLayout` tiles.
2. Register an extra cell on `NiiVueModel` at init time (preferred — the cell is then visible to the automatic `hydrate()` on `ready`):
   ```swift
   let crosshair = NiiVueProp<[Double]>(path: "crosshairColor", initial: [1, 0, 0, 1])
   let model = NiiVueModel(bridge: bridge, extraCells: [crosshair])
   ```
   `model.registerExtra(_:)` exists for post-init registration, but cells added that way miss the first hydrate.
3. Bind it in any panel:
   ```swift
   ColorPicker("Crosshair", selection: ...)  // see InspectorSectionViews for rgba↔Color conversion
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
| **Release** | `niivue-app://app/index.html` | `Contents/Resources/WebApp/` inside the `.app` | No |

The loader URL is chosen at runtime by `NiiVueWebView.initialURL()`: in DEBUG builds it uses `BridgeConfig.devServerURL` if set (medgfx sets it via `.withDevServer(port: 8083)` on `ContentView.init`), otherwise the bundled URL. `BridgeConfig.default` leaves `devServerURL` nil, so consumers that don't opt in get RELEASE-shaped behaviour everywhere.

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
2. At runtime, `WKWebView` requests `niivue-app://app/index.html`.
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
  - Toolbar with a single Add Image menu, a shared view-mode picker, and inspector visibility controls.
  - Thin footer with status text (`model.lastStatus`) and the most recent `locationChange.string` (`model.locationText`).
- `NiiVueModel` (from `NiiVueKit`) — `@MainActor @Observable` view-model. Owns every allow-listed NiiVue property as a `NiiVueProp<Value>` cell plus transient state (`isReady`, `currentBackend`, `isSwitchingBackend`, `lastStatus`, `locationText`). Subscribes once to `ready` / `propChange` / `backendChange` / `locationChange` events; fans out inbound updates to the right cell by path via a `[String: any AnyPropCell]` dispatch table.
- `NiiVueProp<Value>` (from `NiiVueKit`) — single bound property cell. Stores current value, has an injected `pusher` closure that fires on write (the model uses this to call `setProp` over the bridge), and an `applyFromJS(_:)` entry point for inbound updates that bypasses the pusher.
- `InspectorContainer` — one scrollable display inspector with native disclosure sections. Layout and Guides & Labels start expanded; Image Appearance, 3D View, and implementation-oriented Advanced controls use progressive disclosure. Context-dependent controls stay in place and become disabled when inapplicable. Lives in this app; NiiVueKit does not ship inspector UI.
- `InspectorSettings` — the single typed registry for clinician-facing titles, help, choices, and bindings. Direct property bindings use `NiiVueModel` cell key paths instead of repeating strings in views. Both the toolbar and inspector consume this registry.
- `ViewerLayoutContext` — the single source of truth for built-in, mosaic, and custom-layout precedence and 3D applicability. Its `NiiVueModel` extension owns mutually exclusive layout transitions and normalizes empty custom layouts.
- `NiiVueWebView` (from `NiiVueKit`) — a thin `UIViewRepresentable` (iOS/iPadOS) / `NSViewRepresentable` (macOS) wrapper around `WKWebView`. Handles configuration, script message handler registration, custom scheme handler registration, inspector toggle, and initial URL selection. Exposes no SwiftUI state — all app state flows through the `Bridge`.
- `Bridge` (from `BridgeCore`) is a `@MainActor` reference type, stored in `@State` (not `@StateObject`, since nothing publishes).

### Responsive layout

The inspector surfaces differently by form factor:

| Platform / size class | Inspector presentation | Detection |
|---|---|---|
| macOS | Inline trailing sidebar (`HStack`-nested), collapsed from window toolbar button | `#if os(macOS)` |
| iPad + iPhone Plus landscape (regular width) | Inline trailing sidebar, toggled from navigation bar button | `@Environment(\.horizontalSizeClass) == .regular` |
| iPhone / iPad Slide Over (compact width) | `.sheet` with medium/large detents + Done button | `horizontalSizeClass == .compact` |

`useInlineInspector` in `ContentView` is the single source of truth and drives both the inline branch and the `sheetBinding`. The iOS branch wraps the root in `NavigationStack` so the `.toolbar { ToolbarItem(placement: .primaryAction) }` actually has somewhere to render — without this, iPad shows no toggle at all. `navigationBarTitleDisplayMode` is iOS-only and only referenced inside the `#if os(iOS)` branches.

### Adding an inspector setting

1. Add one typed `NiiVueSetting<Value>` entry in `InspectorSettings.swift`. For direct properties, supply the `NiiVueModel` property-cell key path; do not repeat a raw NiiVue path in UI code.
2. Put the control in the appropriate focused view in `InspectorSectionViews.swift`. Use `SettingToggle`, `SettingPicker`, or `sliderRow(setting:model:range:format:)` from `PanelHelpers.swift` so titles, help, choices, and bindings come from the registry.
3. For an enum backed by a raw property cell, use the typed model binding in the registry entry, following `panelArrangement` or `threeDPanel`.
4. Layout presets that write `mosaicString` or `customLayout` must use the transition methods in `ViewerLayoutContext.swift`, which clear competing layouts and synchronize the toolbar view mode.
5. Only add a new disclosure group when the setting does not fit Layout, Guides & Labels, Image Appearance, 3D View, or Advanced. Add its `InspectorSectionID` metadata and focused section view separately.

## Current bridge method surface

| Direction | Kind | Name | Payload | Purpose |
|---|---|---|---|---|
| Swift → JS | `call` | `loadVolume` | `{ name: string, bytesBase64: string }` | JS decodes, calls `nv.loadImage(file)` |
| Swift → JS | `call` | `setProp` | `{ path: string, value: unknown }` | Generic NiiVue property write (allow-listed paths only) |
| Swift → JS | `call` | `getProps` | `{}` | Returns snapshot of every allow-listed property, used for hydration after `ready` / backend switch |
| Swift → JS | `call` | `setBackend` | `{ backend: 'webgl2'\|'webgpu' }` | Calls `nv.reinitializeView({ backend })`; loaded data is retained and re-rendered, and the reply reports the backend that actually ended up active (NiiVue may downgrade) |
| JS → Swift | `emit` | `ready` | `{ backend: 'webgpu' \| 'webgl2' }` | Webview finished init; Swift reads `backend` into `NiiVueModel.currentBackend` |
| JS → Swift | `emit` | `propChange` | `{ path, value }` | Fired from NiiVue's `change` event when an allow-listed property changes |
| JS → Swift | `emit` | `backendChange` | `{ backend }` | Fired after a successful `setBackend` so Swift state follows |
| JS → Swift | `emit` | `imageLoaded` | `{ name, kind }` | Fired after NiiVue successfully loads a volume, mesh, or signal, including its built-in canvas drag and drop |
| JS → Swift | `emit` | `locationChange` | `{ mm, voxel, string }` | NiiVue crosshair moved |

The bridge itself doesn't hardcode any names — `niivue-controller.ts` is the canonical JS registration site and `NiiVueModel.swift` is the canonical Swift registration site. For property-sync work, prefer the prop-bridge path (one line in `prop-allowlist.ts` + one line in `NiiVueModel.swift`) over a new bespoke method.

## Quick Look extension (macOS)

A separate appex target that previews medical images in Finder. Ported from the
Catalyst app at `~/src/ios`. It shares the web build (`quicklook.html` is the
second Vite entry, so NiiVue ships once as a common chunk) but **not** the
bridge: the preview is read-only and single-shot, and `BridgeCore.Bridge` has
no generation scoping, which every async channel in the controller depends on.
It talks to `window.niivuePreview` over a `qlPreview` message handler.

**Routing is by filename** (`PreviewFileKind`), following MIQ and NIfTIViewQL,
the two shipping macOS Quick Look extensions for these formats:

- macOS resolves a file's type from the **last** extension component only, so a
  `.nii.gz` is always plain gzip. Claiming `public.gzip` +
  `org.gnu.gnu-zip-archive` in `QLSupportedContentTypes` is the only route by
  which the commonest neuroimaging format can reach the extension at all.
  Confirmed: `mdls` reports `org.gnu.gnu-zip-archive` for a `.nii.gz`.
- That makes us a candidate previewer for **every gzip on the machine**, so
  `PreviewFileKind` declines anything whose name we do not claim, before any
  file I/O. A foreign `.tar.gz` keeps whatever preview it had. Do not relax it.
- There is deliberately **no compound `nii.gz` UTI**. It registers and never
  matches, for the reason above; MIQ and NIfTIViewQL both ship one and it is
  dead config in both, invisible only because they claim generic gzip too.

Content is still read for one thing: `GzipPeek.inflatedSize` bounds how far a
compressed payload may expand, unconditionally.

`limitFrames4D` now bounds *decoding* (it bounded only retention until the
loader fix), so a 4D preview inflates one frame rather than the series — a
105-frame DWI went from 601 MB peak RSS to 55 MB. The native bound is still
required, and the reasons matter because a stale note here once licensed an
attempt to skip it: the partial reader is NIfTI-only, it returns nil on any
miss and the caller then full-loads unbounded, and NiiVue selects it by
FILENAME — so gzip content under an unrecognised name is inflated whole
whatever the bytes say.

Verify routing without Xcode: `./scripts/check-preview-file-kind.sh` (26
assertions). It lives outside `QuickLookPreview/` on purpose — that directory is
a synchronized group, so anything inside it is compiled into the appex.

**Non-obvious, each cost real time:**

- **`import QuickLookUI`.** `QLPreviewingController` is in `QuickLook` on
  Catalyst but `QuickLookUI` on macOS. Without it: "cannot find type in scope".
- **`platformFilters = (macos,)` — the plural array form.** The singular
  `platformFilter` that the Catalyst project uses is silently ignored here, and
  the iOS build fails with "contains embedded content built for the macOS
  platform". Exit gate: an iOS build must succeed and `medgfx.app/PlugIns` must
  not exist.
- **`com.apple.security.network.client` is mandatory in the appex entitlements**
  and has nothing to do with networking. Without it WebKit's content process
  dies before any navigation and the preview is a black rectangle. The extension
  stays offline by construction instead: bundled assets, self-only CSP,
  navigation restricted to the app scheme.
- **Registration moves silently.** Any second copy of the app can win it — an
  old DerivedData tree, an archive, or simply the Debug build sitting beside the
  Release one. Finder will preview with a binary from hours ago while you
  conclude your change did not work. This happened twice during the port. Always
  use `install-quicklook.sh`, which evicts other copies, asserts exactly one
  registration, and hashes the shipped page against the one just built.
- **`os_log` from a Quick Look appex does not reach `log show`.** Debug builds
  append a build-stamped line to
  `~/Library/Containers/com.niivue.medgfx.QuickLookPreview/Data/tmp/quicklook-preview.log`.
  Release has no such log; use `install-quicklook.sh --which` instead.
- **Do NOT suppress text selection in the preview page.** WebKit starts a
  document selection on a drag NiiVue does not `preventDefault`, and that
  selection is what absorbs the gesture — without it the drag falls through to
  the host, which moves the window. `user-select: none` and a capture-phase
  `preventDefault` were each tried and each *introduced* the bug they looked
  unrelated to. The tint is killed two ways that both leave the selection free
  to form: `::selection { background: transparent }` and a `selectionchange`
  listener that clears any range. Verified on both the Catalyst and native
  macOS hosts; do not remove either half.
- **The document route must keep `.` unescaped.** `NVMesh.loadMesh` reads the
  reader extension from the URL and ignores the `name` passed with it, falling
  back to the MZ3 reader on an unknown extension — so a fully-escaped route
  makes `.mz3` work by accident while every other mesh format fails.
- **`attachToCanvas` replaces the canvas element**, so `quicklook.ts` resolves
  it by `id` at every use. Do not add a `ResizeObserver`; NiiVue installs its
  own and owns `devicePixelRatio`.
- **Crosshair and `meshXRay` are off on the mesh branch only.** Both are right
  for a volume and wrong for geometry: the crosshair marks a slice position that
  does not exist and shows as red stubs through the surface, and `meshXRay`
  redraws the mesh over itself with depth testing disabled, washing out surfaces
  and desaturating tract colour. Safe to clear there *only* because that branch
  has no 2D tiles — `is3DCrosshairVisible` gates every crosshair, not just 3D.

## Deferred debt

Known, deliberate, and not blocking. Each is a decision, not an oversight.

- **The app's `loadVolume` still sends volume bytes as base64** through a JS
  source string handed to `evaluateJavaScript` — roughly +33% plus several
  copies. `PreviewSchemeHandler`'s document route is the fix and is already in
  the tree. The original iOS plan is explicit that the host should own this
  transport and that Quick Look should reuse it; in medgfx that is inverted. Do
  it when a volume is measurably slow.
- **The inflate bound covers the OUTER gzip member only.** It is called
  unconditionally on content (never gated on the filename — that was a real
  hole, see below), but NiiVue inflates in places this cannot see: NRRD's
  `encoding: gz` data section, GIFTI `GZipBase64Binary` DataArrays, and every
  entry of a `.trx` ZIP. A bomb nested inside one of those is not bounded.
  Fixing it means bounding inside NiiVue, not here.
- **The bound must never be waived on a PREDICTION about the browser.** An
  attempt to skip it when a NIfTI header looked like it would be partial-loaded
  was withdrawn: NiiVue does not partial-load from `loadVolumes` at all (the
  worker full-decodes and `loadBridge.ts:60` drops the frame limit), and even if
  it did, its eligibility is chosen by FILENAME while the native gate reads
  CONTENT — so gzip content named `.nii` passed the gate and was fully inflated.
  Native code must not mirror loader policy; the component that decodes owns it.
- **A name-based gate must never sit in front of a content-based defence.**
  `GzipPeek` used to run only when the *filename* ended in `.gz`/`.mgz`, while
  every decoder downstream switches on the `1f 8b` magic bytes. `cp bomb.gz
  bomb.nii` therefore skipped the bound entirely and NiiVue inflated 1 GiB in
  the content process. `scripts/check-gzip-bound.sh` is the regression.
- **One residual fail-open path** in `GzipPeek.inflatedSize`: a mid-stream
  decoder stall or error allows the file. Failing closed there would refuse
  legitimate volumes whenever Apple's decoder disagrees with the browser's, and
  no triggering input has been constructed. The I/O paths do fail closed.
- **`PreviewSchemeHandler.serve` has no total-byte bound and blocks on a FIFO.**
  A named pipe called `x.nii` reports size 0, passes the cap, and parks a
  global-queue thread. The preview still completes via the load timeout.
- **`maxDecodedBytes` is not calibrated.** It counts decoded *file* bytes, but
  NiiVue also allocates `Float32Array(nVox3D*3)` + `Uint8Array(nVox3D*4)`, so
  for uint8 data the content-process peak is roughly **17x** what the gate
  counts. Conservative in the right direction; a real number needs a device
  measurement. Consequence: an oversize legitimate 4D series is refused outright
  rather than shown at frame zero.
- **Preview teardown does not release the NiiVue instance or the `WKWebView`.**
  The WebGL context, decoded volume and 3D textures live until the controller
  deallocates. Bounded by preview lifetime. `webView.load(about:blank)` is not
  available as a fix — the navigation delegate allows only the app scheme.
- **Ad-hoc signing leaves `com.apple.security.get-task-allow`** in the built
  entitlements. Harmless locally, must not ship.
- **No detached formats.** NIfTI `.hdr`/`.img`, `.mhd`, AFNI `.HEAD`/`.BRIK`,
  `.nhdr` are out: `.hdr` resolves to `public.radiance` and `.img` to
  `com.apple.disk-image-udif`, and rendering a detached pair needs sibling read
  access Quick Look does not grant. Self-contained `.mha`/`.nrrd` are fine.
- **MRtrix `.mif` is not claimed.** NiiVue can read it, but it is not in the v1
  format set and no `org.mrtrix.mif` UTI is declared, so a bare `.mif` could not
  route here anyway. Add the UTI and the `PreviewFileKind` entries together.

## Common commands

```bash
# Web app — run from the repo root
bunx nx dev medgfx-web        # Vite dev server on http://localhost:8083 (HMR)
bunx nx build medgfx-web      # Production build -> apps/medgfx/web/dist/
bunx nx typecheck medgfx-web
bunx nx lint medgfx-web
bunx nx format medgfx-web
bunx nx e2e medgfx-web        # 88 Quick Look page checks (needs a browser, see below)

# Native app About metadata — run from the repo root
bun apps/medgfx/scripts/generate-about-authors.ts

# Quick Look — from apps/medgfx/
./scripts/install-quicklook.sh          # build Release, register, prove which copy
./scripts/install-quicklook.sh --debug  # Debug build, which has the trace log
./scripts/install-quicklook.sh --which  # who is registered / running right now
./scripts/check-preview-file-kind.sh    # routing self-check, no Xcode needed
./scripts/check-gzip-bound.sh           # decompression bound, at the real call site

# Xcode — from apps/medgfx/. The signing overrides are required: this machine
# has no Mac Development certificate, and the app's entitlements otherwise
# demand a provisioning profile. Ad-hoc is enough for Finder to run an appex.
xcodebuild -project medgfx.xcodeproj -scheme medgfx \
  -configuration Debug -destination 'platform=macOS,arch=arm64' \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER="" build

xcodebuild -project medgfx.xcodeproj -scheme medgfx \
  -configuration Debug -destination 'generic/platform=iOS Simulator' build
```

## About author generation

`medgfx/AboutAuthors.generated.swift` is generated from the Git author names of
commits that touch `apps/medgfx`. Before finishing changes to medgfx, run
`bun apps/medgfx/scripts/generate-about-authors.ts` from the repository root and
include any generated update. New contributors are appended automatically in
first-contribution order.

Do not edit the generated Swift file directly. If a Git author name or username
should appear as a person's real name, add an override to
`scripts/about-author-name-map.json`, then rerun the generator. Keep aliases for
the same person mapped to one display name so the generated list de-duplicates
them.

`Signing.local.xcconfig` must exist even for ad-hoc builds — the project
references it as a base configuration and errors out when it is missing. Copy
`Signing.xcconfig.sample`.

`nx e2e` needs a Playwright browser. It is `e2e`, **not** `test`, so CI's
`nx run-many -t test` does not try to run it — same convention as
`packages/niivue`. If Playwright's pinned revision is not downloaded, point it
at any headless shell already on the machine:

```bash
# Command substitution, not a bare glob: shells do not expand `*` inside a
# variable assignment, so the literal path would be exported and the launch fails.
PLAYWRIGHT_CHROMIUM_PATH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell | head -1) \
  bunx nx e2e medgfx-web
```

## Gotchas and lessons learned

- **"Waiting for webview…" forever in Debug** — almost always means the sandboxed app can't reach `localhost:8083`. Check `com.apple.security.network.client` is in the entitlements and that the entitlements file is actually wired into the target via `CODE_SIGN_ENTITLEMENTS`.
- **Blank webview in Release** — either `web/dist/` wasn't rebuilt or the WebApp folder didn't reach `Contents/Resources/`. Verify `Resources/WebApp/index.html` exists inside the built `.app`.
- **`bunx: command not found` in the Run Script** — Xcode.app doesn't inherit the shell PATH. The script explicitly prepends `~/.bun/bin`. If you switch tool managers, update the PATH line.
- **Content-hashed vite filenames** — `assets/index-*.js` changes every build. Don't add individual hashed files to Xcode as file references; rely on the Run Script's `rsync` to mirror the whole `dist/` tree.
- **SharedArrayBuffer / crossOriginIsolated** — both Debug (vite dev headers) and Release (`WebAssetHandler` headers) must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Verify in Safari Web Inspector → Network → Response Headers and in the Console via `self.crossOriginIsolated === true`.
- **Modern Xcode file-system-synchronized groups** — `medgfx/` and `QuickLookPreview/` are both `PBXFileSystemSynchronizedRootGroup`s, so Swift files dropped anywhere inside them are compiled without editing `project.pbxproj`. That cuts both ways: a scratch or test file left in either directory ships in the product. The web app is *not* synchronized — it reaches the bundle only through the Run Script phase.
- **SourceKit / live-editor diagnostics lag with synchronized groups** — when adding files in a new subdirectory, your editor (VS Code / Cursor / Xcode indexer) may scream "Cannot find type 'NiiVueModel' in scope" across every cross-file reference for several minutes. `xcodebuild` is the source of truth; if it builds, the code is correct. Don't chase phantom SourceKit errors unless `xcodebuild` also fails.
- **iPad inspector missing entirely** — if a toolbar item on iOS/iPadOS doesn't appear, it's almost certainly because the view isn't inside a `NavigationStack`. macOS renders `.toolbar` into the window chrome automatically, iOS does not. Wrap the iOS branch in `NavigationStack { ... }` and the toolbar button reappears.
- **`#if os(iPadOS)` is not a thing** — Swift treats iPadOS as iOS. Use `@Environment(\.horizontalSizeClass)` (regular vs compact) to distinguish iPad from iPhone at runtime, not compile-time conditionals.
- **LFS for bundled sample volumes** — `mni152.nii.gz` is Git LFS-tracked. Without `git lfs install` you clone the 3-line pointer file, Xcode bundles *that* as the sample, and Load-sample fails at runtime with no obvious cause.
- **`project.pbxproj`, `contents.xcworkspacedata` and `xcshareddata/xcschemes/` must stay tracked.** Dropping any of them breaks the build for other contributors. `.gitignore` covers per-user Xcode state, build output, and `Signing.local.xcconfig` — which is *why* that file is absent from a fresh clone and must be created by hand.
- **`packages/niivue-swift/Sources/NiiVueKit/Resources/WebApp/` is gitignored.** Only the placeholder `README.md` inside that directory is tracked. The prebuilt web bundle is a generated artifact with content-hashed filenames (~900 KB per build); committing it would balloon git history every rebuild. medgfx doesn't need it — its Run Script phase ships `apps/medgfx/web/dist/` into `Contents/Resources/WebApp/` and `BridgeConfig.default` reads from `Bundle.main`. Only consumers opting into `BridgeConfig.niiVueKitBundled` (`.module`) need to run `packages/niivue-swift/scripts/build-web.sh` once locally. A blank webview with 404s on `niivue-app://app/index.html` for a `niiVueKitBundled` consumer is the signal to run it.
