# NiiVue Monorepo

Monorepo for the [NiiVue](https://github.com/niivue) ecosystem — browser-based medical image visualization.

## Packages

| Package | Description | npm |
|---|---|---|
| [`@niivue/niivue`](packages/niivue) | Core WebGPU/WebGL2 medical image viewer | [![npm](https://img.shields.io/npm/v/@niivue/niivue/next)](https://www.npmjs.com/package/@niivue/niivue) |
| [`@niivue/nvreact`](packages/nv-react) | React bindings for NiiVue | [![npm](https://img.shields.io/npm/v/@niivue/nvreact/next)](https://www.npmjs.com/package/@niivue/nvreact) |
| [`@niivue/nv-web-component`](packages/nv-web-component) | Lit-based Web Components for NiiVue | [![npm](https://img.shields.io/npm/v/@niivue/nv-web-component/next)](https://www.npmjs.com/package/@niivue/nv-web-component) |
| [`@niivue/nv-ext-drawing`](packages/nv-ext-drawing) | Drawing interpolation and segmentation tools | [![npm](https://img.shields.io/npm/v/@niivue/nv-ext-drawing/next)](https://www.npmjs.com/package/@niivue/nv-ext-drawing) |
| [`@niivue/nv-ext-image-processing`](packages/nv-ext-image-processing) | Image processing (Otsu thresholding, haze removal, etc.) | [![npm](https://img.shields.io/npm/v/@niivue/nv-ext-image-processing/next)](https://www.npmjs.com/package/@niivue/nv-ext-image-processing) |
| [`@niivue/nv-ext-save-html`](packages/nv-ext-save-html) | Export a NiiVue scene as a self-contained HTML file | [![npm](https://img.shields.io/npm/v/@niivue/nv-ext-save-html/next)](https://www.npmjs.com/package/@niivue/nv-ext-save-html) |
| [`@niivue/nv-ext-dcm2niix`](packages/nv-ext-dcm2niix) | DICOM-to-NIfTI conversion in the browser via the dcm2niix WASM build | [![npm](https://img.shields.io/npm/v/@niivue/nv-ext-dcm2niix/next)](https://www.npmjs.com/package/@niivue/nv-ext-dcm2niix) |
| [`@niivue/web-bridge`](packages/niivue-web-bridge) | Typed two-way JSON-envelope bridge between a NiiVue web view and a native (WKWebView) host | — |
| [`NiiVueKit`](packages/niivue-swift) | Swift package (`BridgeCore` + `NiiVueKit`) pairing with `@niivue/web-bridge` to embed NiiVue in SwiftUI apps via `WKWebView` | — |
| [`@niivue/dev-images`](packages/dev-images) | Shared test volumes, meshes, and tractography files (Git LFS) | — |
| [`ipyniivue`](packages/ipyniivue) | Jupyter widget wrapping NiiVue (anywidget) — Python wheel | [![PyPI](https://img.shields.io/pypi/v/ipyniivue)](https://pypi.org/project/ipyniivue/) |

## Apps

| App | Description |
|---|---|
| [`demo-ext-drawing`](apps/demo-ext-drawing) | Demo app for the drawing extension |
| [`demo-ext-image-processing`](apps/demo-ext-image-processing) | Demo app for the image processing extension |
| [`demo-ext-save-html`](apps/demo-ext-save-html) | Demo app for the save-to-HTML extension |
| [`demo-ext-dcm2niix`](apps/demo-ext-dcm2niix) | Demo app for the dcm2niix DICOM-to-NIfTI extension |
| [`demo-nv-web-component`](apps/demo-nv-web-component) | Demo app for the Web Components package |
| [`medgfx`](apps/medgfx) | Native macOS/iOS SwiftUI app embedding NiiVue in a WebView |

## Getting Started

Use the hot-reloadable live demos for local development—they provide the fastest feedback loop while working on the project.

```bash
git clone git@github.com:niivue/mono.git
cd mono
bun install
bunx nx build niivue
git lfs install
git lfs pull
bun run dev
```

Core commands include

```bash
bun install                # Install all dependencies
bunx nx build <project>    # Build a single project (builds deps first)
bunx nx run-many -t build  # Build all projects
bunx nx run-many -t test   # Run all tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup, tooling, and development instructions.

## Releasing and Publishing

Packages are versioned and published using [Nx Release](https://nx.dev/features/manage-releases) and `bun publish`. Ensure you are logged in to npm (`npm login`) and have publish access to the `@niivue` scope.

```bash
# 1. Version — bumps package.json and updates workspace deps
#    Use --first-release if no git tags exist yet for the project
bunx nx release version <version> --projects=<project>

# 2. Changelog (optional) — generate from conventional commits
bunx nx release changelog <version> --projects=<project>

# 3. Build
bunx nx run-many -t build --projects=<project1>,<project2>

# 4. Publish — run from each package directory
#    bun publish resolves workspace:* dependencies automatically
cd packages/<project> && bun publish --tag next --access public
```

Use `--tag next` for prerelease versions (e.g. `1.0.0-rc.1`). Omit `--tag` for stable releases (defaults to `latest`). The `--access public` flag is required for scoped `@niivue/*` packages.

## GitHub Pages

Pushing to `main` automatically builds and deploys all examples and demo apps to GitHub Pages. To preview the site locally:

```bash
.github/build-pages.sh --serve   # build and serve at http://localhost:8080/mono/
```
