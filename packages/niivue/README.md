# NiiVueGPU

NiiVue is a tool for visualizing volumes, meshes, and tractography streamlines commonly used in neuroimaging. The original NiiVue project evolved organically, resulting in tightly coupled model, view, and controller components. This repository refactors the codebase to improve maintainability and to support emerging technologies such as WebGPU.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- A browser with WebGPU support (Chrome, Firefox). Safari works if you have a recent MacOS (version 26) or iOS. Older browsers will fall back to the WebGL2 renderer.

### Build Commands

```bash
bun install          # Install dependencies
bun run dev          # Hot-reload dev server
bun run build        # Library build to ./dist (published npm package)
bun run deploy       # Production examples-site build to ./dist (GitHub Pages)
bun run demo         # Build examples site and serve locally
bun run lint         # ESLint check
bun run lint:fix     # ESLint auto-fix
bun run typecheck    # TypeScript type checking (tsc --noEmit)
```

### Perf builds (benchmarking only)

The renderer carries optional `performance.mark`/`measure` instrumentation
(`src/view/NVPerfMarks.ts`) consumed by the in-browser benchmark harness
at `examples/benchmark.html`. It is gated on a build-time constant
`__NIIVUE_PERF__`, injected by Vite's `define` and driven by the
`NIIVUE_PERF=1` env var.

**Default builds (`bun run build`, `bun run dev`, `bun run deploy`) set
the flag to `false`, so esbuild dead-code-eliminates every perf-mark
body. Production bundles pay zero runtime cost — the perf code does
not exist in shipped output.**

Use the perf scripts only when running the harness:

```bash
bun run dev:perf            # dev server with marks armed (opens benchmark.html)
bun run build:perf          # lib build with marks armed
bun run build:examples:perf # static examples site with marks armed
```

See `benchmarks/README.md` for the full benchmarking workflow.

### Development Workflows

- **`bun run dev`** — Runs the `demos/` pages with hot reloading. A Vite plugin intercepts `import '../dist/niivuegpu.mjs'` and redirects it to source, so demo scripts stay identical to the deployed versions but get full HMR. Asset directories in `demos/` are symlinked to `public/` on first run.
- **`bun run demo`** — Builds the library to `demos/dist/`, copies assets, and serves with `http-server`. Use this to test the actual built output or before deploying to GitHub Pages.

## Usage

Add a `<canvas>` to your page and attach NiiVueGPU to it:

```html
<canvas id="gl1"></canvas>
<script type="module">
  import NiiVue from 'niivuegpu'

  const nv = new NiiVue()
  await nv.attachToCanvas(document.getElementById('gl1'))
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
</script>
```

### Backend-specific distributions

By default, `niivuegpu` includes both backends (WebGPU + WebGL2 fallback):

```js
import NiiVue from 'niivuegpu'
```

You can also import backend-only builds to reduce package size:

```js
import NiiVueWebGPU from 'niivuegpu/webgpu' // WebGPU-only
import NiiVueWebGL2 from 'niivuegpu/webgl2' // WebGL2-only
```

In backend-only builds, selecting the missing backend throws an explicit error.

### Load a mesh

```js
await nv.loadMeshes([{ url: '/meshes/brain.mz3' }])
```

### Change slice type and colormap

```js
nv.sliceType = 3                        // 0=Axial, 1=Coronal, 2=Sagittal, 3=Multi, 4=Render
nv.setVolume(0, { colormap: 'hot' })    // apply colormap to first volume
```

### Configuration options

Pass options to the constructor to customize the viewer:

```js
const nv = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0, 0, 0, 1],
  clipPlaneColor: [1, 1, 1, 0.5],
})
```

### Testing

The package includes a unit test suite for non-rendering (server-side) logic using the [Bun test runner](https://bun.sh/docs/cli/test). Tests are co-located with source files as `*.test.ts`.

```bash
bun test                # Run all tests with coverage
bun test src/drawing/   # Run tests in a specific directory
bun test --watch        # Watch mode
```

Coverage is enabled by default (configured in `bunfig.toml`) and outputs both a console summary and an `lcov` report to `coverage/`. Tested modules include:

- **Drawing tools** — RLE codec, pen/line/flood-fill, undo stack
- **Annotations** — undo/redo, point-in-polygon, slice projection, shape selection
- **Math/transforms** — vox↔mm conversions, spherical coordinates, slice plane equations
- **Volume utilities** — intensity range calculation, NIfTI header creation, voxel lookup, reorientation
- **Colormaps** — LUT generation, label colormap construction
- **Mesh I/O** — STL/OBJ writers, STL/OFF readers (roundtrip tests)

To run tests via Nx from the monorepo root:

```bash
bunx nx test niivue
```

### Architecture

The codebase is written in **TypeScript** and follows an MVC pattern with dual rendering backends (WebGPU and WebGL2). See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation, directory structure, code style, and module naming conventions.

### Dependencies

- [nifti-reader-js](https://github.com/rii-mango/NIFTI-Reader-JS) — NIfTI file parsing
- [gl-matrix](https://glmatrix.net/) — Vector/matrix math (vec3, vec4, mat3, mat4)
- [cbor-x](https://github.com/nicolo-ribaudo/cbor-x) — CBOR encoding/decoding for document save/load and ITK-Wasm (.iwi.cbor) format support
