# medgfx

Native macOS/iOS SwiftUI app that embeds [`@niivue/niivue`](../../packages/niivue) in a WebView.

## Structure

- `medgfx/` — Native SwiftUI app (macOS/iOS) wrapping the web view
- `web/` — Vite web app loaded by the native shell
- `medgfx.xcodeproj/` — Xcode project

## Getting Started (web)

```bash
bun install              # From monorepo root
bunx nx dev medgfx-web   # Start dev server
```

## Build (web)

```bash
bunx nx build medgfx-web
```

## Build (app)

Open `medgfx.xcodeproj` in Xcode. Copy `Signing.xcconfig.sample` to `Signing.local.xcconfig` and set your `DEVELOPMENT_TEAM` before building.
