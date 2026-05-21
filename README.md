# NiiVue Monorepo

Monorepo for the [NiiVue](https://github.com/niivue) ecosystem — browser-based medical image visualization.

## Packages

<table>
  <thead>
    <tr>
      <th width="260">Package</th>
      <th>Description</th>
      <th>npm</th>
    </tr>
  </thead>
  <tbody>
    <tr><td><a href="packages/niivue"><code>@niivue/niivue</code></a></td><td>Core WebGPU/WebGL2 medical image viewer</td><td><a href="https://www.npmjs.com/package/@niivue/niivue"><img src="https://img.shields.io/npm/v/@niivue/niivue/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-react"><code>@niivue/nvreact</code></a></td><td>React bindings for NiiVue</td><td><a href="https://www.npmjs.com/package/@niivue/nvreact"><img src="https://img.shields.io/npm/v/@niivue/nvreact/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-web-component"><code>@niivue/nv-web-component</code></a></td><td>Lit-based Web Components for NiiVue</td><td><a href="https://www.npmjs.com/package/@niivue/nv-web-component"><img src="https://img.shields.io/npm/v/@niivue/nv-web-component/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-ext-drawing"><code>@niivue/nv-ext-drawing</code></a></td><td>Drawing interpolation and segmentation tools</td><td><a href="https://www.npmjs.com/package/@niivue/nv-ext-drawing"><img src="https://img.shields.io/npm/v/@niivue/nv-ext-drawing/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-ext-image-processing"><code>@niivue/nv-ext-image-processing</code></a></td><td>Image processing (Otsu thresholding, haze removal, etc.)</td><td><a href="https://www.npmjs.com/package/@niivue/nv-ext-image-processing"><img src="https://img.shields.io/npm/v/@niivue/nv-ext-image-processing/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-ext-save-html"><code>@niivue/nv-ext-save-html</code></a></td><td>Export a NiiVue scene as a self-contained HTML file</td><td><a href="https://www.npmjs.com/package/@niivue/nv-ext-save-html"><img src="https://img.shields.io/npm/v/@niivue/nv-ext-save-html/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-ext-dcm2niix"><code>@niivue/nv-ext-dcm2niix</code></a></td><td>DICOM-to-NIfTI conversion in the browser via the dcm2niix WASM build</td><td><a href="https://www.npmjs.com/package/@niivue/nv-ext-dcm2niix"><img src="https://img.shields.io/npm/v/@niivue/nv-ext-dcm2niix/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/nv-ext-niimath"><code>@niivue/nv-ext-niimath</code></a></td><td>niimath pipelines in the browser via the niimath WASM build</td><td><a href="https://www.npmjs.com/package/@niivue/nv-ext-niimath"><img src="https://img.shields.io/npm/v/@niivue/nv-ext-niimath/next" alt="npm"></a></td></tr>
    <tr><td><a href="packages/niivue-web-bridge"><code>@niivue/web-bridge</code></a></td><td>Typed two-way JSON-envelope bridge between a NiiVue web view and a native (WKWebView) host</td><td>—</td></tr>
    <tr><td><a href="packages/niivue-swift"><code>NiiVueKit</code></a></td><td>Swift package (<code>BridgeCore</code> + <code>NiiVueKit</code>) pairing with <code>@niivue/web-bridge</code> to embed NiiVue in SwiftUI apps via <code>WKWebView</code></td><td>—</td></tr>
    <tr><td><a href="packages/dev-images"><code>@niivue/dev-images</code></a></td><td>Shared test volumes, meshes, and tractography files (Git LFS)</td><td>—</td></tr>
    <tr><td><a href="packages/ipyniivue"><code>ipyniivue</code></a></td><td>Jupyter widget wrapping NiiVue (anywidget) — Python wheel</td><td><a href="https://pypi.org/project/ipyniivue/"><img src="https://img.shields.io/pypi/v/ipyniivue" alt="PyPI"></a></td></tr>
  </tbody>
</table>

## Apps

<table>
  <thead>
    <tr>
      <th width="260">App</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr><td><a href="apps/demo-ext-drawing"><code>demo-ext-drawing</code></a></td><td>Demo app for the drawing extension</td></tr>
    <tr><td><a href="apps/demo-ext-image-processing"><code>demo-ext-image-processing</code></a></td><td>Demo app for the image processing extension</td></tr>
    <tr><td><a href="apps/demo-ext-save-html"><code>demo-ext-save-html</code></a></td><td>Demo app for the save-to-HTML extension</td></tr>
    <tr><td><a href="apps/demo-ext-dcm2niix"><code>demo-ext-dcm2niix</code></a></td><td>Demo app for the dcm2niix DICOM-to-NIfTI extension</td></tr>
    <tr><td><a href="apps/demo-ext-fullstack"><code>demo-ext-fullstack</code></a></td><td>Fullstack demo wiring NiiVue to a Bun server that runs the <code>niimath</code> native binary</td></tr>
    <tr><td><a href="apps/demo-ext-niimath"><code>demo-ext-niimath</code></a></td><td>Browser-only demo running niimath as WASM via <a href="https://www.npmjs.com/package/@niivue/niimath"><code>@niivue/niimath</code></a></td></tr>
    <tr><td><a href="apps/demo-nv-web-component"><code>demo-nv-web-component</code></a></td><td>Demo app for the Web Components package</td></tr>
    <tr><td><a href="apps/iiif-volumetric-server"><code>iiif-volumetric-server</code></a></td><td>IIIF Image API + Presentation API server for volumetric NIfTI and OME-Zarr fixtures</td></tr>
    <tr><td><a href="apps/iiif-volumetric-demo"><code>iiif-volumetric-demo</code></a></td><td>Browser demos for the IIIF volumetric server, including slices, volume sheets, fly-through, desktop, and OME-Zarr views</td></tr>
    <tr><td><a href="apps/medgfx"><code>medgfx</code></a></td><td>Native macOS/iOS SwiftUI app embedding NiiVue in a WebView</td></tr>
  </tbody>
</table>

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
