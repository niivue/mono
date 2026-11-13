# Build

Moved from `packages/niivue/AGENTS.md`; read it when working on the build, the dev servers or packaging. Paths are relative to `packages/niivue`.

## Build commands

Package manager is **Bun**. Never use `npm`/`npx`/`pnpm`/`yarn`.

The version is pinned in the repo-root `.bun-version` (every workflow reads it via
`oven-sh/setup-bun`'s `bun-version-file`); match it locally with
`curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat "$(git rev-parse --show-toplevel)/.bun-version")"`. An older
Bun silently diverges: it rewrites `bun.lock` to an older format, does not hoist
`bun-types` (so several projects fail `typecheck` with TS2688), and lacks
`DecompressionStream`, which fails any test that decodes a gzipped fixture.

```bash
bun install                          # Install dependencies
bun run dev                          # Hot-reload dev server at localhost:5273
bun run build                        # Library build to ./dist (vite.config.lib.ts, ES)
bun run build:examples               # Examples site build (vite.config.examples.ts)
bun run deploy                       # Production examples-site build (GitHub Pages)
bun run demo                         # Build examples and serve with vite preview
bun run lint                         # Biome check (src/)
bun run lint:fix                     # Biome check --fix
bun run typecheck                    # tsc --noEmit
```

From the monorepo root, use Nx instead:

```bash
bunx nx build niivue
bunx nx test niivue
bunx nx typecheck niivue
bunx nx lint niivue
```

**Before committing**, run the root AGENTS.md "Before finishing a task" sequence (codespell included); `bun run lint:fix && bun run typecheck` is the quick local pass.

`bun run dev` serves `examples/` from source (the pages `import '../src/index.ts'`), so dev and the examples build run the same files.

`bunx nx dev niivue` (same steps as `bun run dev`, including `gen-fixtures`, but on `vite.config.js`'s port 8080) also serves the `SITE_APPS` demo apps under `/<app>/`, with `@niivue/niivue` and its subpath entries aliased to `src/`, so an app never runs a stale `dist`. A missing app file is a 404, not the SPA fallback, and an extensionless one (zarr metadata, chunks) is sent as bytes.

Library packaging: `bun run build` emits `dist/niivue.js` (both backends), `dist/niivue.webgpu.js` (WebGPU-only), and `dist/niivue.webgl2.js` (WebGL2-only), exported as `@niivue/niivue`, `@niivue/niivue/webgpu`, and `@niivue/niivue/webgl2`.

It then runs `build:standalone` (`vite.config.standalone.ts`), which writes a self-contained copy of the same entries to `dist/standalone/` with every dependency bundled in, for pages with no bundler (see README "Without a bundler"). `scripts/check-standalone.ts` fails the build if any non-relative import or `import.meta.url` asset reference appears there (for example an `external` added to that config, or an asset emitted as a file instead of inlined). `bun run examples:standalone` serves `examples/standalone/index.html` against it on port 5403.
