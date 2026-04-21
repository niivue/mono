# NiiVue Monorepo

Monorepo for the NiiVue ecosystem — browser-based medical image visualization.

## Structure

```
packages/       # Libraries (publishable)
  niivue/       # @niivue/niivue — Core WebGPU/WebGL2 medical image viewer
  nv-react/     # @niivue/nvreact — React bindings for NiiVue
  nv-ext-drawing/   # @niivue/nv-ext-drawing — Drawing & segmentation tools
  nv-ext-image-processing/ # @niivue/nv-ext-image-processing — Image processing
  nv-ext-save-html/ # @niivue/nv-ext-save-html — Export scene as HTML
  dev-images/   # @niivue/dev-images — Shared test images (Git LFS)
apps/           # Applications (not published)
  demo-ext-drawing/          Drawing extension demo
  demo-ext-image-processing/ Image processing extension demo
  demo-ext-save-html/        Save-to-HTML extension demo
nx-tools/       # Custom Nx plugins and scripts
```

## Tooling

- **Monorepo orchestration:** [Nx](https://nx.dev) — task running, caching, dependency graph
- **Package manager:** Bun (workspaces defined in root `package.json`)
- **Linting/formatting:** Biome
- **TypeScript builds:** Bun bundler (nv-react), Vite (niivue)

## Common Commands

```bash
bun install               # Install all dependencies
bunx nx build <project>   # Build a single project (builds deps first)
bunx nx run-many -t build # Build all projects
bunx nx run-many -t test  # Run all tests
bunx nx run-many -t lint  # Lint all projects
bunx nx run-many -t typecheck  # Type-check all projects
bun run check-boundaries  # Enforce module boundary rules
```

## Nx Targets

All projects support these targets (defined in `project.json` per package):

| Target      | Description                          |
|-------------|--------------------------------------|
| `build`     | Production build (depends on `^build`) |
| `dev`       | Development server                   |
| `test`      | Run tests                            |
| `typecheck` | TypeScript type checking             |
| `lint`      | Biome linting                        |
| `format`    | Biome auto-formatting                |

## Module Boundaries

Enforced by `nx-tools/check-boundaries.js`:

1. Apps can depend on libs, but **not** on other apps
2. Libs cannot depend on apps
3. Python and TypeScript projects cannot cross-depend

## Dependency Graph

- `@niivue/nvreact` depends on `@niivue/niivue` (workspace link)
- Nx automatically builds dependencies first via `"dependsOn": ["^build"]`

## NiiVue Feature Parity

The `@niivue/niivue` package in this repo is a complete rewrite of the old niivue package (`~/github/niivue/niivue/packages/niivue`). The new package does not aim for API compatibility — the public API is different and that is expected. However, most features from the old package should eventually be available in the new one. See `packages/niivue/FEATURE_PARITY.md` for a detailed tracking table of which features are present, missing, or deferred.

## Releases

Managed via Nx Release with conventional commits:

- **TypeScript packages:** Independent versioning, tags as `{projectName}@{version}`
- **Python packages:** Independent versioning with pixi version actions
- Project-level changelogs are auto-generated
