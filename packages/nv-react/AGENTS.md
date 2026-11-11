# AGENTS.md — @niivue/nvreact

Guidelines for AI coding agents operating in the `@niivue/nvreact` package — lightweight React bindings for [NiiVue](https://github.com/niivue/niivue) providing multi-instance scene management, declarative hooks, and a standalone viewer component.

## Tooling

Use **Bun** for everything. Never use Node.js, npm, Vite (directly), Webpack, or esbuild for packaging. `vite` is used for the dev server only.

```sh
bun install              # install dependencies
bun run dev              # dev server (vite)
bun run build:package    # full library build (build:lib + build:types)
bun run build:lib        # bundle src/lib.ts -> dist/lib.js (ESM, externals: react, react-dom, @niivue/niivue)
bun run build:types      # emit .d.ts files via tsc -p tsconfig.build.json
bun test                 # run all tests (Bun's built-in test runner)
bun test src/foo.test.ts # run a single test file
bun test --grep "name"   # run tests matching a pattern
```

Test files use `bun:test` (`describe`, `test`/`it`, `expect`). Place tests next to source files as `*.test.ts` or `*.test.tsx`. `bunfig.toml` preloads `./src/happydom.ts` and `./src/testing-library.ts` so JSDOM-style APIs are available in tests.

From the monorepo root, use Nx:

```sh
bunx nx build nv-react
bunx nx test nv-react
bunx nx typecheck nv-react
bunx nx lint nv-react
```

After UI changes, start the dev server (`bun run dev`) and visually verify with a browser or Chrome DevTools MCP.

## Project structure

```
src/                    # Library source (published as @niivue/nvreact)
  lib.ts                # Public API entry point — all exports (barrel, biome-ignore on noBarrelFile)
  nvscene.tsx           # <NvScene> — multi-viewer container bound to a controller
  nvviewer.tsx          # <NvViewer> — standalone single-instance viewer with declarative volumes
  hooks.ts              # useScene, useNiivue, useSceneEvent
  context.tsx           # NvSceneProvider, useSceneContext
  App.tsx               # In-package demo component
  frontend.tsx          # Demo entry point (React root)
  index.html            # Demo HTML shell
  happydom.ts           # Test preload — registers happy-dom globals
  testing-library.ts    # Test preload — @testing-library/jest-dom matchers
  __mocks__/            # Test mocks
e2e/                    # Playwright end-to-end tests (scaffolding)
scripts/                # Package scripts
```

## Key APIs

- **`NvSceneController`** — manages Niivue instances, layout, broadcasting, and volume loading. Implements `subscribe`/`getSnapshot` for `useSyncExternalStore`. It, the grid layouts and `NvSceneEventMap` live in `@niivue/niivue/scene` (shared with `@niivue/nv-web-component`, tested there); `lib.ts` re-exports them.
- **`NvScene`** — React component that renders a controller's viewers in a CSS grid.
- **`NvViewer`** — standalone viewer with declarative `volumes` prop (auto-diffs).
- **`useScene(controller?, layouts?, viewerDefaults?)`** — creates or wraps a controller, returns `{ scene, snapshot }` via `useSyncExternalStore`.
- **`useNiivue(scene, index)`** — access raw `Niivue` instance at a viewer index.
- **`useSceneEvent(scene, event, callback)`** — subscribe to controller events with auto-cleanup.

### Events (`NvSceneEventMap`)

`viewerCreated`, `viewerRemoved`, `locationChange`, `imageLoaded`, `error`, `volumeAdded`, `volumeRemoved`.

## Code style

Linting/formatting is **Biome**, applied repo-wide via the monorepo root `biome.json`. The Nx `lint` / `format` targets run Biome against this package. See the root `AGENTS.md` for the full rule list.

### Formatting (enforced by Biome)

- 2-space indentation
- **No semicolons** (as needed only)
- **Single quotes** for strings
- Trailing commas in multi-line constructs
- ESM only (`"type": "module"` in `package.json`)

### Imports

1. CSS imports first (if any)
2. React / React-DOM
3. External packages (`@niivue/niivue`)
4. Internal modules (`./foo`)

Use the explicit `type` keyword for type-only imports — `verbatimModuleSyntax` is enabled and enforces this:

```ts
import { Niivue, type NVConfigOptions } from '@niivue/niivue'
import type { CSSProperties } from 'react'
```

Relative imports use `./` prefix with no file extensions.

### TypeScript

- **Strict mode** is on (`strict: true` plus `noUncheckedIndexedAccess`)
- Use `interface` for object shapes; use `type` for aliases, unions, function signatures, and derived types
- Never use `any` — use `unknown` for error parameters and untyped data (Biome `noExplicitAny` is an error repo-wide)
- Prefer `Partial<T>` for optional config objects
- Generics with constraints for event systems: `<E extends keyof NvSceneEventMap>`
- Non-null assertion `!` is **disallowed** by Biome (`noNonNullAssertion`) — restructure instead

### Naming conventions

| Element | Style | Examples |
|---|---|---|
| Files (library) | lowercase kebab-case | `nvviewer-options.ts` |
| Files (React entry) | PascalCase | `App.tsx` |
| Components | PascalCase, `Nv` prefix | `NvScene`, `NvViewer` |
| Hooks | camelCase, `use` prefix | `useScene`, `useNiivue` |
| Interfaces / types | PascalCase, no `I` prefix | `ViewerState`, `LayoutConfig` |
| Constants | camelCase | `defaultLayouts` |
| Private class fields | `private` keyword, camelCase | `private listeners` |
| Unused parameters | underscore prefix | `_containerElement` |
| Enum-like re-exports | UPPER_SNAKE (from niivue) | `SLICE_TYPE`, `DRAG_MODE` |

### Exports

- **Named exports only** in library code — no default exports
- Barrel re-exports in `lib.ts` with separate `export { }` and `export type { }` blocks. The barrel file is the single exception to Biome's `noBarrelFile` rule and carries a `biome-ignore` directive.
- `src/App.tsx` (the in-package demo) may use both named and default exports

### React patterns

- Arrow function components for library components (`NvScene`, `NvViewer`)
- Function declarations for hooks and the main app component
- Destructure props in the function signature
- `useSyncExternalStore` for subscribing to the controller's external state
- `useRef` for DOM refs, mutable values, and stable callback references
- Callback ref pattern to avoid stale closures:
  ```ts
  const cbRef = useRef(callback)
  cbRef.current = callback
  ```
- `useCallback` for event handlers passed to children
- Always return cleanup functions from `useEffect`
- Comment when dependency arrays are intentionally sparse: `// intentionally stable`
- `createContext(null)` + guard hook pattern (throw if used outside provider)

### Error handling

- `throw new Error('descriptive message')` for programmer errors
- `try/catch/finally` for async operations, re-throw after cleanup
- Catch parameters typed as `unknown`: `.catch((err: unknown) => { ... })`
- Emit errors through the event system: `this.emit('error', index, err)`
- Optional chaining for optional callbacks: `onErrorRef.current?.(err)`

### Comments

- JSDoc `/** ... */` for exported APIs and public constants
- Inline `//` for implementation notes
- Section dividers in large files: `// --- Section Name ---`

## Verification

Always verify UI changes with a browser or Chrome DevTools (MCP). After modifying components, start the dev server (`bun run dev`), navigate to the demo, and take screenshots to confirm the result.

## Build & publish

```sh
bun run build:package
bun publish --access public
```

## Peer dependencies

`@niivue/niivue` (workspace), `react ^19`, `react-dom ^19`.
