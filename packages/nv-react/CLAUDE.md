# @niivue/nvreact

Lightweight React bindings for [Niivue](https://github.com/niivue/niivue) — multi-instance scene management, declarative hooks, and a standalone viewer component.

## Tooling

Use Bun for everything. Do not use Node.js, npm, vite, webpack, or esbuild.

- `bun install` — install dependencies
- `bun run build:package` — build library (`build:lib` + `build:types`)
- `bun run build:lib` — bundle `src/lib.ts` to `dist/lib.js` (ESM, externals: react, react-dom, @niivue/niivue)
- `bun run build:types` — emit declaration files via `tsc -p tsconfig.build.json`
- `bun test` — run tests
- `bun run example:setup` — pack library and install into example app
- `bun run example:dev` — setup + start example app dev server

## Project structure

```
src/                    # Library source (published as @niivue/nvreact)
  lib.ts                # Public API entry point — all exports
  nvscene-controller.ts # Core controller: manages Niivue instances, layout, broadcasting, volumes
  nvscene.tsx           # <NvScene> — multi-viewer container bound to a controller
  nvviewer.tsx          # <NvViewer> — standalone single-instance viewer with declarative volumes
  hooks.ts              # useScene, useNiivue, useSceneEvent
  context.tsx           # NvSceneProvider, useSceneContext
  layouts.ts            # Grid layout presets (1x1, 1x2, 2x2, etc.)
  types.ts              # Shared types and event map
example-app/            # Demo app consuming the library via tarball
  src/App.tsx           # Main demo component (NvScene + NvViewer modes)
  src/index.ts          # Bun.serve() entry point
```

## Key APIs

- **`NvSceneController`** — manages multiple Niivue instances, layout switching, broadcasting, volume loading
- **`NvScene`** — React component that renders a controller's viewers in a grid
- **`NvViewer`** — standalone component with declarative `volumes` prop (auto-diffs)
- **`useScene(controller?, layouts?, viewerDefaults?)`** — creates/wraps a controller, subscribes via `useSyncExternalStore`
- **`useNiivue(scene, index)`** — access raw `Niivue` instance at viewer index
- **`useSceneEvent(scene, event, callback)`** — subscribe to controller events with auto-cleanup

## Events (NvSceneEventMap)

`viewerCreated`, `viewerRemoved`, `locationChange`, `imageLoaded`, `error`, `volumeAdded`, `volumeRemoved`

## Build & publish

```sh
bun run build:package
bun publish --access public
```

## Verification

Always use Chrome DevTools (MCP) to verify UI changes work correctly. After modifying the example app or components, start the dev server (`bun run example:dev`), navigate to the app, and take screenshots to confirm the result.

## Peer dependencies

`@niivue/niivue`, `react ^19`, `react-dom ^19`
