# AGENTS.md — AI Agent Instructions for NiiVue Monorepo

## Project overview

NiiVue is a browser-based medical image visualization ecosystem. This monorepo contains the core WebGPU/WebGL2 viewer, React bindings, extension libraries, and demo applications. The stack is TypeScript, Vite, Bun (package manager + runtime), Biome (lint/format), and Nx (task orchestration + caching). There is scaffolding for Python/Pixi projects for the future. 

See `README.md` for a package overview and `CONTRIBUTING.md` for detailed development docs.

## Workspace layout

```
packages/       # Libraries (publishable). See each package's README for details.
apps/           # Demo applications (private, not published). See each app's README.
nx-tools/       # Custom Nx plugins and scripts (boundary checks, Pixi plugin, release)
```

- Each `packages/*` and `apps/*` directory has its own `README.md`, `package.json`, `project.json`, and `tsconfig.json`.
- When working on a specific package or app, read its README first.

### Tags

Every project has two tags in its `project.json`:

- **`type:app`** or **`type:lib`** — apps live in `apps/`, libs live in `packages/`.
- **`lang:typescript`** or **`lang:python`** — all current projects are `lang:typescript`.

### Workspace links

Dependencies between packages use `"workspace:*"` in `package.json`. Bun resolves these from the workspace root. The root `package.json` declares workspaces:

```json
"workspaces": ["apps/*", "packages/*"]
```

## Commands

**Package manager: Bun.** Always use `bun` and `bunx`, not `npm`/`npx`/`pnpm`/`yarn`.

```bash
bun install                          # Install all dependencies

bunx nx build <project>              # Single project (builds deps first)
bunx nx run-many -t build            # All projects
bunx nx affected -t build            # Only projects affected by current changes

bunx nx test <project>               # Single project
bunx nx affected -t test             # Only affected

bunx nx lint <project>               # Single project (Biome)
bunx nx affected -t lint             # Only affected

bunx nx typecheck <project>          # Single project (tsc --noEmit)
bunx nx affected -t typecheck        # Only affected

bunx nx format <project>             # Auto-fix formatting (Biome)

bunx nx dev <project>                # Start dev server

bun run check-boundaries             # Enforce module boundary rules
bunx nx reset                        # Clear Nx cache
```

Prefer `nx affected` over `nx run-many` when working on a branch.

## Creating new code

### When to create a new lib vs. app

- **Library** (`packages/`): reusable code published or consumed by other workspace projects. Tag `type:lib`.
- **Application** (`apps/`): runnable demo or standalone app, not imported by others. Tag `type:app`.

### Steps to add a new TypeScript project

1. Create directory under `apps/` or `packages/`.
2. Add `package.json` with `"type": "module"`. Use `workspace:*` for internal deps.
3. Add `tsconfig.json` — copy from an existing project (there is no shared `tsconfig.base.json`).
4. Add `project.json` following the pattern of an existing project. Required fields:
   - `name`, `projectType` (`"library"` or `"application"`),
   - `tags` (e.g. `["type:lib", "lang:typescript"]`),
   - `targets` — at minimum `build`, `lint`, `format`, `typecheck`
5. Run `bun install` from the repo root.

This repo does **not** use Nx generators. Projects are created manually.

## Module boundaries

Enforced by `nx-tools/check-boundaries.js`. Run with `bun run check-boundaries`.

1. **No project may depend on an app.** Only libs (`type:lib`) are allowed as dependencies.
2. **Libs cannot depend on apps.**
3. **No cross-language dependencies.** TypeScript ↔ Python imports are forbidden.

## Code style

### Biome (sole linter/formatter)

Configured in root `biome.json`. Applies to all projects.

| Rule | Setting |
|------|---------|
| Indent | 2 spaces |
| Quotes | Single quotes |
| Semicolons | As needed (no mandatory semicolons) |
| `noExplicitAny` | **Error** — do not use `any` |
| `noNonNullAssertion` | **Error** — do not use `!` postfix |
| `noBarrelFile` | **Error** — do not create barrel/index re-export files |
| `noDoubleEquals` | **Error** — use `===` not `==` |
| `noUnusedVariables` | **Error** — prefix intentionally unused vars with `_` |
| `noUnusedImports` | **Error** — remove unused imports |
| `useImportType` | **Error** — use `import type` for type-only imports |
| Import sorting | Enabled via `organizeImports` assist |

**No emoji in source, scripts, or generated reports.** This includes status icons (traffic lights, check marks) in CI output, markdown summaries, and log messages. Use plain text.

### TypeScript

- **Target:** ESNext, **strict mode** enabled everywhere.
- **Path alias:** `@/*` → `./src/*` (used in some packages — check the project's `tsconfig.json`).
- TypeScript is only used for type checking (`tsc --noEmit`), not compilation.

### Commit messages

Conventional commits format. Used by Nx Release for automatic versioning.

```
feat: add new colormap support
fix: handle null volume in loader
chore: update dev dependencies
feat!: redesign public API   (breaking change)
```

## Testing

- Tests are co-located with source files as `*.test.ts` / `*.test.tsx`.
- Test runners vary by project — check the project's `project.json` `test` target.
- **`packages/niivue`** uses the **Bun test runner** (`bun test`). Coverage is enabled by default via `bunfig.toml` and outputs both a console summary (`text`) and `lcov` report to `coverage/`. No coverage thresholds are configured.
- Other packages may use different test runners — always check `project.json`.

```bash
bunx nx test <project>               # Run a project's tests via Nx
cd packages/niivue && bun test       # Run niivue tests directly with coverage
```

## Before finishing a task

Run this sequence from the repo root. All commands must exit 0.

```bash
bunx nx affected -t format
bunx nx affected -t lint
bunx nx affected -t typecheck
bunx nx affected -t test
bunx nx affected -t build
bun run check-boundaries
```

If `nx affected` doesn't detect changes (e.g., on the default branch), target specific projects:

```bash
bunx nx run <project>:lint
bunx nx run <project>:typecheck
bunx nx run <project>:test
bunx nx run <project>:build
```

## NiiVue feature parity

The `@niivue/niivue` package in this repo is a complete rewrite of the old niivue package (`~/github/niivue/niivue/packages/niivue`). The new package does **not** aim for API compatibility — the public API is different and that is expected. However, most features from the old package should eventually be available in the new one. See `packages/niivue/FEATURE_PARITY.md` for a detailed tracking table of which features are present, missing, or deferred. Consult it before implementing features.

## Releases

Managed via Nx Release with conventional commits (config in root `nx.json`):

- **TypeScript packages:** Independent versioning, tags as `{projectName}@{version}`
- **Python packages:** Independent versioning with Pixi version actions
- Project-level changelogs are auto-generated

## Do not touch

- **`bun.lock`** — managed by Bun. Never edit manually.
- **`node_modules/`**, **`.nx/`**, **`dist/`**, **`.pixi/`** — generated/cached. Gitignored.
- **`packages/niivue/src/assets/fonts/index.ts`** and **`packages/niivue/src/assets/matcaps/index.ts`** — auto-generated by `scripts/generate-assets.js`.
- **`CHANGELOG.md` files** — auto-generated by Nx Release.
- **`packages/dev-images/images/**`** — Git LFS–tracked binary files. Do not add/modify without Git LFS.
- **`nx-tools/`** — infrastructure scripts. Modify only if asked

## Gotchas

- **No barrel files.** Biome enforces `noBarrelFile: "error"`. Auto-generated asset index files in `packages/niivue/src/assets/` are the sole exception.
- **`niivue` build requires codegen first.** The Nx target handles this automatically (`npm run codegen:assets && vite build`), but if you run Vite manually, run `node scripts/generate-assets.js` first.
- **`workspace:*` peer dependencies.** Extensions and `nv-react` declare `@niivue/niivue` as a peer dep — the local copy is used in dev, but consumers must install it themselves.
- **GitHub Pages deployment.** Pushing to `main` builds all examples and demo apps and deploys to GitHub Pages via `.github/workflows/niivue-ghpages.yml`. The build script is `.github/build-pages.sh` — run it locally with `--serve` to preview. Vite configs read the `VITE_BASE` env var to set the base path and rewrite absolute `/volumes/` and `/meshes/` URLs in bundled JS.
- **CI workflows.** `.github/workflows/pr_gate.yml` runs lint, typecheck, and test across all projects (`nx run-many`) on every push and PR to `main`. `codespell.yml` spell-checks `packages/niivue` (ignore list lives in the workflow file). Only the niivue package emits lcov coverage; `.github/scripts/lcov-to-summary.ts` (run with Bun) parses it and appends a markdown table to `$GITHUB_STEP_SUMMARY`. CI helper scripts live in `.github/scripts/` and are written in TypeScript, executed with `bun`.
- **No shared `tsconfig.base.json`.** Each project has its own `tsconfig.json`. Copy from an existing project when creating a new one.
- **Git LFS required for test images.** `packages/dev-images/images/` uses LFS. Run `git lfs pull` if files are pointers.
- **Feature parity tracking.** `packages/niivue/FEATURE_PARITY.md` tracks which features from the old NiiVue exist in the rewrite. Consult before implementing features.
