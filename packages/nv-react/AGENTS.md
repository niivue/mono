# AGENTS.md — @niivue/nvreact

Guidelines for AI coding agents operating in this repository.

## Tooling

Use **Bun** for everything. Never use Node.js, npm, Vite, Webpack, or esbuild.

```sh
bun install              # install dependencies
bun run build:package    # full build (build:lib + build:types)
bun run build:lib        # bundle src/lib.ts -> dist/lib.js (ESM)
bun run build:types      # emit .d.ts files via tsc -p tsconfig.build.json
bun test                 # run all tests (Bun's built-in test runner)
bun test src/foo.test.ts # run a single test file
bun test --grep "name"   # run tests matching a pattern
```

Test files use `bun:test` (`describe`, `test`/`it`, `expect`). Place tests next to
source files as `*.test.ts` or `*.test.tsx`.

### Example app

```sh
bun run example:setup    # pack library tarball and install into example-app
bun run example:dev      # setup + start dev server
```

After UI changes, start the dev server and visually verify with a browser or
Chrome DevTools MCP.

## Project structure

```
src/
  lib.ts                 # Public API barrel — all exports go here
  nvscene-controller.ts  # Core controller class (instances, layout, volumes)
  nvscene.tsx            # <NvScene> multi-viewer container
  nvviewer.tsx           # <NvViewer> standalone declarative viewer
  hooks.ts               # useScene, useNiivue, useSceneEvent
  context.tsx            # NvSceneProvider, useSceneContext
  layouts.ts             # Grid layout presets (1x1, 1x2, 2x2, …)
  types.ts               # Shared types and event map
example-app/             # Demo app consuming the library via tarball
```

## Code style

No automated formatter or linter is configured. Follow the conventions below
consistently.

### Formatting

- 2-space indentation
- Always use semicolons
- Double quotes for strings (`"`)
- Trailing commas in multi-line constructs
- ESM only (`"type": "module"` in package.json)

### Imports

1. CSS imports first (if any)
2. React / React-DOM
3. External packages (`@niivue/niivue`)
4. Internal modules (`./foo`)

Use explicit `type` keyword for type-only imports — `verbatimModuleSyntax` is
enabled and enforces this:

```ts
import { Niivue, type NVConfigOptions } from "@niivue/niivue";
import type { CSSProperties } from "react";
```

Relative imports use `./` prefix with no file extensions.

### TypeScript

- **Strict mode** is on (`strict: true` plus `noUncheckedIndexedAccess`)
- Use `interface` for object shapes; use `type` for aliases, unions, function
  signatures, and derived types
- Never use `any` — use `unknown` for error parameters and untyped data
- Prefer `Partial<T>` for optional config objects
- Generics with constraints for event systems:
  `<E extends keyof NvSceneEventMap>`
- Non-null assertion `!` is acceptable only where the value is guaranteed

### Naming conventions

| Element | Style | Examples |
|---|---|---|
| Files (library) | lowercase kebab-case | `nvscene-controller.ts` |
| Files (React entry) | PascalCase | `App.tsx` |
| Components | PascalCase, `Nv` prefix | `NvScene`, `NvViewer` |
| Hooks | camelCase, `use` prefix | `useScene`, `useNiivue` |
| Interfaces / Types | PascalCase, no `I` prefix | `ViewerState`, `LayoutConfig` |
| Constants | camelCase | `defaultLayouts` |
| Private class fields | `private` keyword, camelCase | `private listeners` |
| Unused parameters | underscore prefix | `_containerElement` |
| Enum-like re-exports | UPPER_SNAKE (from niivue) | `SLICE_TYPE`, `DRAG_MODE` |

### Exports

- **Named exports only** in library code — no default exports
- Barrel re-exports in `lib.ts` with separate `export { }` and `export type { }`
  blocks
- The example app's `App.tsx` may use both named and default exports

### React patterns

- Arrow function components for library components (`NvScene`, `NvViewer`)
- Function declarations for hooks and the main app component
- Destructure props in the function signature
- `useSyncExternalStore` for subscribing to the controller's external state
- `useRef` for DOM refs, mutable values, and stable callback references
- Callback ref pattern to avoid stale closures:
  ```ts
  const cbRef = useRef(callback);
  cbRef.current = callback;
  ```
- `useCallback` for event handlers passed to children
- Always return cleanup functions from `useEffect`
- Comment when dependency arrays are intentionally sparse: `// intentionally stable`
- `createContext(null)` + guard hook pattern (throw if used outside provider)

### Error handling

- `throw new Error("descriptive message")` for programmer errors
- `try/catch/finally` for async operations, re-throw after cleanup
- Catch parameters typed as `unknown`: `.catch((err: unknown) => { ... })`
- Emit errors through the event system: `this.emit("error", index, err)`
- Optional chaining for optional callbacks: `onErrorRef.current?.(err)`

### Comments

- JSDoc `/** ... */` for exported APIs and public constants
- Inline `//` for implementation notes
- Section dividers in large files: `// --- Section Name ---`

## Key APIs

- **`NvSceneController`** — the only class; manages Niivue instances, layout,
  broadcasting, and volume loading. Implements `subscribe`/`getSnapshot` for
  `useSyncExternalStore`.
- **`NvScene`** — renders a controller's viewers in a CSS grid
- **`NvViewer`** — standalone viewer with declarative `volumes` prop (auto-diffs)
- **`useScene(controller?, layouts?, viewerDefaults?)`** — creates or wraps a
  controller, returns `{ scene, snapshot }`
- **`useNiivue(scene, index)`** — access raw `Niivue` instance at a viewer index
- **`useSceneEvent(scene, event, callback)`** — subscribe to controller events

### Events (NvSceneEventMap)

`viewerCreated`, `viewerRemoved`, `locationChange`, `imageLoaded`, `error`,
`volumeAdded`, `volumeRemoved`

## Build & publish

```sh
bun run build:package
bun publish --access public
```

## Peer dependencies

`@niivue/niivue`, `react ^19`, `react-dom ^19`
