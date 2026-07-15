# NiiVue

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
bun run lint         # Biome check
bun run lint:fix     # Biome auto-fix
bun run typecheck    # TypeScript type checking (tsc --noEmit)
```

### Perf instrumentation

The renderer carries `performance.mark`/`measure` instrumentation
(`src/view/NVPerfMarks.ts`) gated on a single runtime flag. Consumers:

- **App code:** `nv.perf.enabled = true`, then listen for the
  `perfFrame` event to receive `{ tag, cpuMs, submitMs, totalMs, phases }`
  per render. Tag user-driven frames via `nv.perf.tagFrame('myAction')`
  before mutating state.
- **Benchmark harness** at `examples/benchmark.html` flips the same
  flag and reads `consumeFrameStats()` plus the `niivue:render-*`
  PerformanceObserver entries.

When `enabled` is `false` every helper bails on its first line; cost
in production is one well-predicted branch per call site. See
`benchmarks/README.md` for the harness workflow.

### Development Workflows

- **`bun run dev`** — Runs the `demos/` pages with hot reloading. A Vite plugin intercepts `import '../dist/niivue.js'` and redirects it to source, so demo scripts stay identical to the deployed versions but get full HMR. Asset directories in `demos/` are symlinked to `public/` on first run.
- **`bun run demo`** — Builds the library to `demos/dist/`, copies assets, and serves with `http-server`. Use this to test the actual built output or before deploying to GitHub Pages.

## Usage

Add a `<canvas>` to your page and attach NiiVue to it:

```html
<canvas id="gl1"></canvas>
<script type="module">
  import NiiVue from '@niivue/niivue'

  const nv = new NiiVue()
  await nv.attachToCanvas(document.getElementById('gl1'))
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
</script>
```

### Backend-specific distributions

By default, `@niivue/niivue` includes both backends (WebGPU + WebGL2 fallback):

```js
import NiiVue from '@niivue/niivue'
```

You can also import backend-only builds to reduce package size:

```js
import NiiVueWebGPU from '@niivue/niivue/webgpu' // WebGPU-only
import NiiVueWebGL2 from '@niivue/niivue/webgl2' // WebGL2-only
```

In backend-only builds, selecting the missing backend throws an explicit error.

### Load a mesh

```js
await nv.loadMeshes([{ url: '/meshes/brain.mz3' }])
```

### Signals (physio and spectroscopy)

Alongside spatial volumes and meshes, NiiVue can load **signals** — a third,
non-spatial data class shown as 2-D line plots rather than slices. Two kinds are
supported: `physio` (BIDS time-series TSV) and `spectroscopy` (NIfTI-MRS complex
FID). Sibling `.json` sidecars are fetched automatically for axis metadata
(sampling rate / StartTime for physio, SpectrometerFrequency / ResonantNucleus
for spectroscopy).

```js
// BIDS physio (auto-fetches the sibling .json sidecar)
await nv.loadSignals([{ url: '/signals/recording_physio.tsv.gz' }])

// NIfTI-MRS spectroscopy; setSignal drives the on-demand FFT + ppm windowing
await nv.loadSignals([{ url: '/signals/svs_se_30.nii.gz' }])
nv.setSignal(0, { display: { average: true, mode: 'real', ppmRange: [1.9, 3.3] } })
```

NIfTI files are routed to the signal loader when they have no spatial extent
(dim1-3 == 1, dim4 > 1); pass `asSignal` to override. MRS sidecar/header fields do
**not** affect routing — a spatial spectroscopic image (MRSI/CSI) carries them too,
so it stays on the volume path.

A physio signal can be associated with a 4D volume by passing `attachToId` (the
volume's id). The graph then shows the crosshair BOLD time-course together with
each physio trace at its native sampling rate on a shared time axis, clamped to
the imaging window; clicking the graph scrubs the volume to the nearest frame.

A dense signal graph can be panned and zoomed via on-graph buttons (the view
follows the cursor on wheel/frame steps) or the controller API (`graphZoom`,
`graphPan`); `graphLineWidth` / `graphLineAlpha` tune trace thickness and opacity
for overlapping series, and `graphShowVolumeTimecourse` toggles the BOLD trace.
Missing physio samples are left as gaps and marked with a short tick along the
bottom axis (the "missing-data rug").

Signals can carry **annotations** — text labels anchored to a position in the
graph's own data units (e.g. ppm for spectroscopy). They translate as the x-axis
window is panned/zoomed and are hidden when out of range. A `y` of `-Infinity` or
`+Infinity` pins the label to the bottom or top of the plot. Annotations render on
the signal graph (spectrum / physio plot); they are not currently drawn on the
volume+physio association time-course view.

```js
// Label metabolite peaks pinned to the bottom of the spectrum
await nv.loadSignals([{
  url: '/signals/svs_se_30.nii.gz',
  annotations: [
    { text: 'NAA', x: 2.0, y: -Infinity },
    { text: 'Cr',  x: 3.0, y: -Infinity },
    { text: 'Cho', x: 3.2, y: -Infinity },
  ],
}])
nv.setSignal(0, { annotations: [/* replace the full set */] })
```

See `examples/svs.html` (spectroscopy, with NAA/Cr/Cho annotations and a scene
selector pairing the spectrum with the participant's T2w and an outline-shaded
"voxel" marker at the sampling location), `examples/physio.html` (physio), and
`examples/physio.bold.html` (a task-fMRI run with per-trace fMRI/respiratory/
cardiac toggles, on-graph pan/zoom, and a volume+physio association graph) for
interactive demos.

#### Spatial spectroscopic imaging (MRSI/CSI)

A complex 4-D NIfTI-MRS volume (dim1-3 = space, dim4 = FID) stays on the volume
path and is driven by the core `MrsScene` controller: it loads an anatomy
reference plus the MRSI grid, shows the crosshair-voxel spectrum (which tracks
the crosshair like the FSLeyes MRS plugin), and generates ppm-band metabolite
maps. See `examples/mrsi.html`. The spectral transforms and the `MrsScene`
controller are ported from
[fsleyes-plugin-mrs](https://git.fmrib.ox.ac.uk/fsl/fsleyes/fsleyes-plugin-mrs)
(BSD-3-Clause); see `PORTING.md` for the function-by-function provenance map.

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
