# AGENTS.md

Guidance for AI coding agents working in the NiiVueGPU package (`@niivue/niivue`).

## Project overview

NiiVueGPU is a WebGPU-based neuroimaging visualization library (volumes + meshes) with a WebGL2 fallback. Written in TypeScript, MVC architecture with dual rendering backends.

## Build commands

Package manager is **Bun**. Never use `npm`/`npx`/`pnpm`/`yarn`.

```bash
bun install                          # Install dependencies
bun run dev                          # Hot-reload dev server at localhost:8080
bun run build                        # Library build to ./dist (vite.config.lib.ts, ES)
bun run build:examples               # Examples site build (vite.config.examples.ts)
bun run deploy                       # Production examples-site build (GitHub Pages)
bun run demo                         # Build examples and serve with http-server
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

**Before committing**, run `bun run lint:fix && bun run typecheck` (or `bunx nx lint niivue && bunx nx typecheck niivue`).

`bun run dev` uses a Vite plugin (`vite.config.dev.js`) to redirect `import '../dist/niivuegpu.mjs'` to source for HMR, so the same HTML/JS files work in dev and production.

Library packaging: `bun run build` emits `dist/niivuegpu.js` (both backends), `dist/niivuegpu.webgpu.js` (WebGPU-only), and `dist/niivuegpu.webgl2.js` (WebGL2-only), exported as `niivuegpu`, `niivuegpu/webgpu`, and `niivuegpu/webgl2`.

## Testing

Unit tests for non-rendering (server-side) logic run on the **Bun test runner**. Tests are co-located with source files as `*.test.ts`.

```bash
bun test                 # Run all tests with coverage
bun test src/drawing/    # Run tests in a specific directory
bun test --watch         # Watch mode
bunx nx test niivue      # From monorepo root, via Nx
```

Coverage is enabled by default via `bunfig.toml` (reporters: `text` + `lcov`, output at `coverage/`). The `coverage/` directory is gitignored. No coverage thresholds are configured.

### What's tested

- **Drawing tools** (`src/drawing/`) — RLE codec, pen/line/flood-fill, undo stack
- **Annotations** (`src/annotation/`) — undo/redo, point-in-polygon, slice projection, shape selection and control points
- **Math/transforms** (`src/math/`) — vox↔mm, spherical coordinates, slice plane equations, screen unprojection
- **Volume utilities** (`src/volume/`) — intensity range, NIfTI header creation, voxel lookup, reorientation, modulation
- **Colormaps** (`src/cmap/`) — LUT generation, label colormap construction
- **Constants** (`src/NVConstants.ts`) — PAQD detection, slice type dimension mapping
- **Mesh I/O** (`src/mesh/`) — STL/OBJ writers, STL/OFF readers (roundtrip tests)
- **View utilities** (`src/view/`) — mm-to-canvas projection

### What's NOT yet covered by unit tests

The following modules require a browser or GPU context and are not covered by the Bun unit test suite. Rendering tests using Playwright are planned.

- `gl/`, `wgpu/` — GPU shader/rendering code
- `NVControl*.ts`, `NVLoader.ts` — DOM/canvas/fetch dependencies
- `control/` — Mouse/keyboard interaction handlers
- `view/NVRenderer.ts`, `view/NVFont.ts` — Rendering pipeline
- `workers/` — Web Worker code
- `codecs/NVGz.ts`, `codecs/NVZip.ts` — DecompressionStream (browser API)

### Writing new tests

- Co-locate tests next to source: `src/foo/bar.ts` → `src/foo/bar.test.ts`
- Import from `bun:test`: `import { describe, expect, test } from 'bun:test'`
- Use the `@/*` path alias for cross-directory imports (resolved via `bunfig.toml`)
- Follow AAA pattern (Arrange, Act, Assert) with one behavior per test
- Test the public contract, not private internals

Rendering changes must be verified manually via the interactive demos (`bun run dev` or `bun run demo`) until Playwright coverage lands.

## Architecture (MVC)

```
NiiVueGPU (controller) - src/NVControl.ts
├── control/           - src/control/ (event handling, view lifecycle)
├── NVModel (data)     - src/NVModel.ts
└── NVViewGPU (WebGPU) - src/wgpu/NVViewGPU.ts
    or NVViewGL (WebGL2) - src/gl/NVViewGL.ts
```

**Data flow:** User interactions → NiiVueGPU → model updates + `drawScene()` → `requestAnimationFrame` → view.render()

**Model-View separation:** Model is GPU-agnostic (only data). Views receive model read-only. Controller owns mutations. GPU resources are view-owned. This enables backend switching without data loss.

### Key source files

| File | Role |
|------|------|
| `NVControl.ts` | Controller — public API, reactive proxy groups, delegates to `control/` |
| `NVControlBase.ts` | Controller base — reactive proxy groups, all getters/setters/methods |
| `NVModel.ts` | Data model — 8 config groups, volumes, meshes, clip planes |
| `NVTypes.ts` | TypeScript interfaces (`NVImage`, `NVMesh`, config group types, `NiiVueOptions`) |
| `NVConstants.ts` | Runtime constants/enums + group defaults (`LAYOUT_DEFAULTS`, `UI_DEFAULTS`, etc.) |
| `NVDocument.ts` | Document save/load (NVD format v7, CBOR-encoded) |
| `control/view.ts` | View lifecycle (attach, recreate, reinitialize) |
| `control/interactions.ts` | Event handling (mouse, keyboard, drag-drop, resize) |
| `control/dragModes.ts` | Drag mode handlers — contrast, measurement, angle, pan, windowing |
| `view/NVSliceLayout.ts` | Slice layout engine — mosaic, hero, multiplanar tile computation |
| `wgpu/NVViewGPU.ts` | WebGPU renderer with compute pipelines |
| `gl/NVViewGL.ts` | WebGL2 fallback (substantially complete) |
| `NVEvents.ts` | Event types — `NVEventMap`, typed `CustomEvent` dispatching |
| `annotation/` | Vector annotation system — shapes, clipping, undo/redo |

Both backends have matching render layers: `mesh`, `font`, `line`, `colorbar`, `orient`, `crosshair`, `thumbnail` — each in `wgpu/` and `gl/` directories. All render entities extend `NVRenderer` (`src/view/NVRenderer.ts`) with `init()` (stores GPU context, sets `isReady`), `draw()` (guarded by `isReady`), and parameterless `destroy()` (uses stored context). Stateless utilities remain module-level exports.

```typescript
// Base class — shared lifecycle contract
export abstract class NVRenderer {
  private _isReady = false
  get isReady(): boolean { return this._isReady }
  protected set isReady(value: boolean) { this._isReady = value }
  abstract init(...args: unknown[]): void | Promise<void>
  abstract draw(...args: unknown[]): void
  abstract destroy(): void
  resize(..._args: unknown[]): void {}  // no-op default
}
```

Key conventions: `init()` stores the GPU context, `destroy()` is parameterless (uses stored context), `isReady` (public get, protected set) guards all draw calls.

**Colorbar layout:** The colorbar block allocator reads the actual rasterized font size via an optional `ColorbarLayout.fontPx` field. Each backend's resize path threads `fontRenderer.fontPx` through so `resolveFontSize` can pick `max(actual, legacy)` — defaults keep the pre-audit look while a cranked-up `fontScale` grows the allocation to avoid overflow. Bottom cushion scales as `max(1, 0.1 * fontSize)`, and single-row colorbars no longer allocate a spurious trailing `gap`.

**Fonts (Unicode):**
- `src/view/NVFont.ts` parses atlases sparsely by Unicode code point, and `buildTextLayout` iterates strings by code point (not UTF-8 bytes), so CJK and other non-Latin glyphs render correctly when present in the atlas. Swap the active font at runtime via `nv1.setFont(nextFont)` for an in-memory atlas, or `nv1.setFontFromUrl({ atlas, metrics })` to fetch a PNG+JSON pair from URLs — both rebuild the view because the atlas texture is GPU-owned.
- The only bundled font is `ubuntu` (ASCII), re-exported from `src/assets/fonts/index.ts` and used as the default by `NVControlBase`. Community atlases (including CJK-capable fonts like Poem) live at `https://github.com/niivue/fonts` and are fetched on demand via `setFontFromUrl` — see `examples/font.html`. `scripts/generate-assets.js` writes one wrapper per `*.json` + `*.png` pair in `src/assets/fonts/` and regenerates the barrel.

**Remote assets (fonts, colormaps, matcaps):** The controller exposes URL-aware loaders so apps can pull assets from CDNs at runtime: `nv1.setFontFromUrl({ atlas, metrics })` (options-object — atlas/metrics can't transpose silently), `nv1.addColormap(name, cmap)` / `nv1.addColormapFromUrl(url, name?)` (registers a `{ R, G, B, A?, I?, labels? }` LUT visible to volumes, mesh layers, colorbars, connectomes, tracts; name derived from filename if omitted, dispatches `colormapAdded`), and the existing `nv1.loadMatcap(nameOrUrl)`. Cross-origin image loads go through `applyCORS(img)` in `src/NVLoader.ts`, which unconditionally sets `img.crossOrigin = 'anonymous'` before `img.src =` in the four image loaders (WebGPU `bitmap2texture`, WebGL2 matcap/thumbnail/font). This is spec-safe for same-origin, `blob:`, and `data:`, and enables GPU texture uploads from hosts like `raw.githubusercontent.com` — provided the server sends `Access-Control-Allow-Origin`.

**Multi-instance isolation:** Shared GPU modules use `WeakMap<GPUDevice|WebGL2RenderingContext, ...>` to cache resources per device/context. Their `destroy(device)` / `destroy(gl)` functions take the device/context parameter to clean up per-instance resources.

**Scene synchronization:** `broadcastTo(targets?, opts?)` syncs scene state between controller instances. `SyncOpts` controls granularity: `'3d'`, `'2d'`, `clipPlane`, `sliceType`, `calMin`, `calMax`. Uses `_syncDirty` flag to prevent bidirectional race conditions.

**Shared canvas (bounds):** Multiple instances can share a `<canvas>` via normalized `[[x1,y1],[x2,y2]]` bounds (`NVBounds` type, y=0 bottom, y=1 top). WebGL2 uses scissor-based clipping with `preserveDrawingBuffer: true`. WebGPU renders to intermediate textures then copies to canvas at bounds offset, with `SharedGPUContext` sharing device across instances. `canvasInstances` WeakMap in `viewBoth.ts` tracks siblings. `clientToBoundsPixel()` transforms full-canvas coords to bounds-local for hit testing.

**Future opportunity — WebGPU `clip-distances`:** a commented-out block in `src/wgpu/NVViewGPU.ts` (just above `requestDevice`) sketches a hardware-accelerated mesh clip plane path gated on the `clip-distances` feature. Adapter support is still patchy (notably Safari), so the code is parked. Activation guidance lives next to the block.

## API conventions

See `docs/api.md` for full style guide and `docs/convert.md` for old→new property mapping.

### Naming rules

- **Booleans** use verb prefixes: `isColorbarVisible`, `isRadiological`, `isEnabled`
- **camelCase** throughout: `calMin`, `calMax`, `crosshairPos` (not `cal_min`)
- **Drop redundant prefixes** when context is provided by the group: `model.draw.penValue` not `model.draw.drawPenValue`

### Model organization — 8 config groups

The model is organized into 8 semantic config groups:

| Group | Purpose | Example properties |
|-------|---------|-------------------|
| `scene` | Camera, crosshair, clip planes, background | `azimuth`, `elevation`, `backgroundColor`, `scaleMultiplier` |
| `layout` | Slice type, mosaic, multiplanar, hero, tiling | `sliceType`, `mosaicString`, `heroFraction`, `isRadiological` |
| `ui` | Visual chrome: colorbars, orient labels, fonts | `isColorbarVisible`, `crosshairWidth`, `fontScale`, `placeholderText` |
| `volume` | Global volume rendering settings | `illumination`, `isNearestInterpolation`, `outlineWidth` |
| `mesh` | Global mesh rendering settings | `xRay`, `thicknessOn2D` |
| `draw` | Drawing/annotation settings | `isEnabled`, `penValue`, `opacity` |
| `annotation` | Vector annotation settings | `isEnabled`, `activeLabel`, `activeGroup`, `brushRadius` |
| `interaction` | Drag modes, mouse behavior | `primaryDragMode`, `isSnapToVoxelCenters` |

Properties that don't belong in any group (computed geometry, data arrays, transient state) stay on the model root.

### Controller API — flat getters/setters

The controller exposes flat property getters/setters. Each setter automatically triggers `drawScene()`:

```js
nv1.azimuth = 110                 // triggers drawScene()
nv1.isColorbarVisible = true      // triggers drawScene()
nv1.drawPenValue = 3              // triggers drawScene()
nv1.volumeIllumination = 0.6      // triggers drawScene()
nv1.meshXRay = 0.1                // triggers drawScene()
```

**Prefix rules:** Scene/layout/UI/interaction properties have no prefix. Volume, mesh, draw, and annotation properties are prefixed (`volume`, `mesh`, `draw`, `annotation`). Boolean `is`/`has` comes after domain prefix: `volumeIsAlphaClipDark`, `drawIsEnabled`.

Multiple sets in the same synchronous block = one render (RAF batching).

### Constructor (flat options)

```js
const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  isColorbarVisible: true,
  volumeIllumination: 0.6,
  meshXRay: 0.1,
  drawPenSize: 5,
  primaryDragMode: DRAG_MODE.crosshair,
})
nv1.addEventListener('locationChange', (e) => {
  const location = e.detail  // NiiVueLocation
})
```

### Methods vs property setters

Use **property setters** for single-value global config (`nv1.azimuth = 110`).

Use **methods** for:
- Async operations: `loadVolumes()`, `loadMeshes()`
- Actions: `drawUndo()`, `createEmptyDrawing()`, `destroy()`
- Multi-target: `setVolume(idx, opts)`, `setFrame4D(id, frame)`
- Special formats: `setClipPlane([depth, azimuth, elevation])`
- IO: `saveDocument()`, `loadDocument()`

### Events (EventTarget API)

NiiVueGPU extends `EventTarget`. Use `addEventListener`/`removeEventListener` for all notifications:

```js
nv1.addEventListener('locationChange', (e) => { ... })  // crosshair moved
nv1.addEventListener('volumeLoaded', (e) => { ... })    // volume finished loading
nv1.addEventListener('clipPlaneChange', (e) => { ... }) // clip plane adjusted
```

See `docs/events.md` for the full event catalog and detail types.

### Per-item options (unified load + update)

```js
await nv1.loadVolumes([{ url: '...', calMin: 30, calMax: 80, isColorbarVisible: false }])
nv1.setVolume(0, { calMin: 40, colormap: 'hot' })
```

Same pattern for meshes, layers, tracts, connectomes.

## Code style and conventions

Linting/formatting is **Biome**, configured in the monorepo root `biome.json`. See the root `AGENTS.md` for the full rule list; key rules enforced here:

- No semicolons, 2-space indent, strict equality (`===`), single quotes
- `noExplicitAny`, `noNonNullAssertion`, `noBarrelFile`, `noUnusedVariables`, `useImportType` are all errors
- Unused params prefixed with `_`
- **No emoji** in source, scripts, or generated reports

### TypeScript

- **Strict mode** is enabled (strict null checks, no implicit any, etc.)
- **Target**: ESNext with bundler module resolution
- **WebGPU types**: `@webgpu/types` for GPU API type definitions
- Run `bun run typecheck` to validate — this runs `tsc --noEmit`

### Logging

Use the structured logger — never use `console.*` directly:

```typescript
import { log } from '@/logger'
log.debug('...') // debug/info/warn/error/fatal/silent
```

`NiiVueOptions.logLevel` is typed as `LogLevel` (same union, re-exported from `src/index.ts`). When `log.level === 'debug'`, views render a `'WebGPU'`/`'WebGL2'` backend badge in the corner (hidden otherwise).

### Module naming

- **Public modules** (cross-directory): PascalCase with `NV` prefix — `NVModel.ts`, `NVMesh.ts`, `NVVolume.ts`
- **Internal modules** (folder-local): lowercase — `mesh.ts`, `font.ts`, `orient.ts`
- **Exception:** `NVTypes.ts` is lowercase of filename convention despite cross-directory use (pure type module)

### Import conventions

- **Cross-directory imports** use the `@/` path alias (maps to `src/`):
  ```typescript
  import { log } from '@/logger'
  import type { NVImage } from '@/NVTypes'
  ```
- **Same-directory imports** use relative paths: `import * as mesh from './mesh'`

## Coordinate systems

Two distinct fractional [0..1] spaces — do not conflate:

- **Scene fraction**: [0,1]³ within scene AABB. Used for `crosshairPos`. Conversion: `NVModel.scene2mm()`/`mm2scene()` — linear interp between `extentsMin`/`extentsMax`.
- **Volume texture fraction**: [0,1]³ within a single volume's 3D texture (voxel centers at `(i+0.5)/dim`). Per-image: `NVImage.frac2mm` mat4. Model caches background volume's matrices as `NVModel.tex2mm`/`mm2tex`.

All overlay volumes are resliced to match the background volume's grid, so `tex2mm`/`mm2tex` apply to all loaded overlays.

**MM space** is the common ground. Depth picker → mm → scene fraction for `crosshairPos`. `getSliceTexFrac()` converts scene fraction → texture fraction for the slice coordinate.

### 2D slice picking

Each `SliceTile` caches `mvpMatrix`, `planeNormal`, and `planePoint` during render. `screenSlicePick` uses these for fast ray-plane intersection. For mosaic tiles with `sliceMM`, uses `getSliceTexFracAtMM()` instead of crosshair. Depth picking (double-click on 3D tiles) reads back depth buffer and unprojects to mm-space.

## Format extensibility

All format readers use Vite's `import.meta.glob` for automatic discovery. To add a new reader:
1. Create a module in the appropriate `readers/` directory
2. Export `extensions` array and `read` function
3. Auto-registered at build time — no manual wiring needed

Shared utilities: `NVLoader.buildExtensionMap()` (extension→module maps), `NVGz.maybeDecompress()` (transparent gzip).

Same pattern for: mesh readers (`mesh/readers/`), volume readers (`volume/readers/`), tract readers (`mesh/tracts/readers/`), connectome readers (`mesh/connectome/readers/`), layer readers (`mesh/layers/readers/`), volume transforms (`volume/transforms/`).

**Detached-header formats:** AFNI (`.HEAD` + `.BRIK.gz`), NIfTI (`.hdr` + `.img`), NRRD (`.nhdr` + `.*`). The `urlImageData` property provides the image data URL alongside the header URL.

### V1 RGB vector volumes

Float32 RGB vector volumes (NIfTI `intent_code` 2003, `dim4=3`) are auto-converted to RGBA8 at load time by `convertFloat32RGBVector()`. RGB stores absolute magnitude; alpha encodes sign polarity in 3 LSBs (bit 0=x+, bit 1=y+, bit 2=z+).

**Explicit V1 conversion** (`loadImgV1(volumeIndex, isFlipX?, isFlipY?, isFlipZ?)`): For formats like AFNI that lack NIfTI intent codes. Delegates to `volume/TensorProcessing.ts`.

**V1 slice shader** (`volume.isV1SliceShader` config option): Interprets overlay RGBA as fiber direction data, renders colored lines with smoothstep falloff. Implemented in both `wgpu/slice.wgsl` and `gl/sliceShader.ts`.

### Volume modulation

`setModulationImage(targetId, modulatorId, modulateAlpha = 0)` scales a target
volume's brightness (RGB) or opacity (alpha) by another volume's windowed scalar
values. Works for **both** pre-baked RGB/RGBA volumes (V1 tensors) **and** plain
colormapped scalar overlays — but `modulateAlpha` means different things per type:

- **Scalar overlays:** `modulateAlpha === 0` modulates RGB; non-zero modulates
  ALPHA with exponent `max(1, |modulateAlpha|)` (matching the original NiiVue).
- **RGB/RGBA (V1) volumes:** **RGB only, always** — alpha is preserved for V1
  sign-polarity bits, so a non-zero `modulateAlpha` does NOT alpha-modulate them.

The two code paths are mutually exclusive by target datatype (each compute
function early-returns for the other's datatype, so only one of `_modulationData`
/ `_modulationWeight` is built per target). Both window by the modulator's own
`calMin/calMax`:

- **RGB/RGBA (V1) path:** `computeModulationData()` -> `_modulationData`
  (`Float32Array`, RAS order), applied CPU-side in `prepareRGBAData()`. Only RGB
  is scaled.
- **Scalar overlay path:** `computeModulationWeights()` -> `_modulationWeight`
  (`Float32Array`, **modulator native order**, already raised to the
  `modulateAlpha` exponent, cached by `_modulationWeightKey` — keyed on the
  modulator's buffer identity + offset + datatype + dims + scaling + frame +
  window + exponent, so a swapped/rescaled/re-windowed modulator invalidates the
  cached weight and its GPU texture). The scalar
  colormap GPU prepass (`gl/orientOverlay.ts` / `wgpu/orient.ts` + `orient.wgsl`)
  uploads it as an **R32F weight texture** and samples it through the modulator's
  overlay transform matrix (`buildModulationParams` -> `calculateOverlayTransformMatrix(baseVol, modVol)`)
  — the same mechanism used for the intensity volume, so the modulator may live
  on **any co-registered grid** (it does not need to match the target or
  background dims). Inside the prepass, `modulation == 1` does `rgb *= w`,
  `modulation == 2` does `a *= w`, applied before the overlay-opacity bake.

The prepass texture cache key includes the modulation state
(`modKey`/`_modulationWeightKey`), so toggling/repointing the modulator or
changing its window correctly re-uploads. The weight texture binds to WebGL2
texture unit 4 and WebGPU bind-group binding 6; a 1x1x1 placeholder is bound when
modulation is inactive. Modulation applies to **both overlays and the background
volume** — `updateVolume(...)` threads the full volume list so the background's
prepass (`overlay2Texture`/`volume2Texture`) can resolve and sample the
modulator. Alpha-modulating the background only *shows* as transparency when
`volumeIsAlphaClipDark` is on (the per-voxel background-alpha clip path); RGB
modulation of the background needs no flag.

Demo: `examples/vox.modulate.scalar.html` — grayscale MNI152 + a binary mask
(`mni152_mask.nii.gz`), with a `volume / mask / volume + mask / volume * mask
(modulate)` selector and a background-colour picker. The "modulate" mode
alpha-modulates the **background** by the mask (`volumeIsAlphaClipDark` on) so
anatomy outside the mask becomes transparent and the canvas colour shows through
(2D + 3D), WebGPU+WebGL2 parity. The MRSI mask can now use `setModulationImage`
instead of the bake workaround (see the MRSI invariant below).

**NVD persistence:** both `modulateAlpha` and `modulationImage` (the modulator
volume-id link) are serialized and restored — the link is reapplied in the
post-load pass (find-by-id at render time), so it survives even if the modulator
volume is restored later in the document. The `_modulationData`/`_modulationWeight`
arrays are derived (never serialized).

**Edge cases / invariants (keep these true):**
- **Label/atlas targets are NOT modulated** — their colormap prepass returns
  before the modulation block, so `buildModulationParams`/`computeModulationWeights`
  early-return for `colormapLabel` targets (no wasted setup).
- **NaN-safe weights** — both compute loops map a NaN/`<=0` window AND any NaN
  modulator voxel (finite window) to weight 0 (transparent), never NaN.
- **Cache key = modulator buffer identity** (WeakMap id) + offset + datatype +
  dims + scaling + frame + window + exponent. It does NOT detect **in-place**
  mutation of `mod.img` (a drawing/segmentation modulator edited without swapping
  the buffer) — re-call `setModulationImage` after such an edit. A repo-wide
  `NVImage` data-revision token is the deferred general fix.
- **Affine fast path** (`updateAffineOverlays`, 2-volume case) bails to a full
  update when `vols[0].modulationImage` is set — otherwise a modulated
  background's baked modulator matrix would go stale on an overlay affine change.
- **NVD volume order** is preserved by reconstructing volumes sequentially
  (`addVolume` pushes on async-prepare completion; a parallel restore would
  reorder background vs overlays).

## Three mesh species

Discriminated by `kind: MeshKind`. All share GPU pipeline (`positions`/`indices`/`colors`) but differ in source data:

| Species | `kind` | Source field | Dynamic? |
|---------|--------|-------------|----------|
| Triangulated mesh | `'mesh'` | `mz3` | No |
| Tract/streamline | `'tract'` | `trx` | Yes (radius, sides, decimation) |
| Connectome | `'connectome'` | `jcon` | Yes (node/edge scale, thresholds) |

Exactly one of `mz3`, `trx`, `jcon` is non-null per mesh. Source data is immutable; only derived GPU arrays change. VTK files use `probeVTKContent()` for content-based dispatch (LINES→tract, POLYGONS→mesh).

## Mesh layers (scalar overlays)

CPU-composited scalar overlays on meshes. `perVertexColors` (nullable `Uint32Array`, packed ABGR) preserves file-provided vertex colors for recompositing; null for uniform-color meshes. Layer readers in `mesh/layers/readers/` (CURV, SMP, STC) plus fallthrough to mesh/volume readers. Layers only apply to `kind === 'mesh'`; tract/connectome coloring happens during tessellation/extrusion.

## Mesh shaders

Fragment shaders in `gl/meshShader.ts` (GLSL) and `wgpu/mesh.wgsl` (WGSL): phong, flat, matte, toon, outline, rim, silhouette, crevice, vertexColor, crosscut. Selected per-mesh via `shaderType`. Vertex layout: interleaved `BYTES_PER_VERTEX` bytes (pos `float32x3` + normal `float32x3` + color `unorm8x4`), defined in `view/NVCrosshair.ts`.

**Crosscut shader** (`shaderType: 'crosscut'`): Renders crosshair-aligned ribbons using `fwidth()`-based screen-space line width. Unique render state: **no depth test, no face culling**. `crosscutMM` uniform computed by `view/NVCrosscut.ts`.

**Mesh clipping on 2D slices** (`mesh.thicknessOn2D`, default `Infinity`): Constrains near/far clip planes to show only mesh geometry within `±thicknessOn2D` mm of the slice plane. Uses `clipSpaceZeroToOne` parameter on `calculateMvpMatrix2D()`: `orthoZO` for WebGPU ([0,1] NDC), `ortho` for WebGL2 ([-1,1] NDC). `sliceTypeDim()` in `NVConstants.ts` maps AXIAL→2, CORONAL→1, SAGITTAL→0.

## Signal data class

A third, **non-spatial** data class alongside volumes and meshes, rendered as 2-D
line plots instead of slices. Source lives in `src/signal/`, with format readers
in `src/signal/readers/` auto-discovered via `import.meta.glob` (same pattern as
volume/mesh readers — export `extensions` + `read`). Two kinds, discriminated by
`kind: SignalKind`:

| Kind | Source | Stored as |
|------|--------|-----------|
| `physio` | BIDS time-series TSV | `columns: Float32Array[]`, `columnLabels`, `samplingFrequency`, `startTime` |
| `spectroscopy` | NIfTI-MRS complex FID | interleaved `fid`, `nPoints`, `nTransients`, `dwell`, `spectrometerFreq`, `nucleus` |

**Readers** (`readers/tsv.ts`, `readers/nii.ts`):

- `tsv` — BIDS physio, gz-aware (`NVGz.maybeDecompress`). Blank/`n/a`/`NaN` cells
  become NaN trace gaps (the line is left gapped — NOT interpolated — and the
  graph marks each missing sample with a short tick along the bottom axis in the
  series colour: the "missing-data rug", `drawMissingRug` in `view/NVGraph.ts`,
  decimation-safe at one tick per pixel column, and stacked into a per-series
  lane so coincident gaps in two series sit side-by-side, not overwriting). A
  stray all-non-numeric leading
  row is treated as column labels. Labels prefer the sidecar `Columns`, then an
  in-file header, then a generic fallback.
- `nii` — reuses `nifti-reader-js` header parsing but does **not** call
  `nii2volume` (which is GPU-volume specific and would discard complex data).
  Complex datatype -> spectroscopy FID; real non-spatial -> physio (dim4 is the
  time axis, dims5..7 are columns).

**Sidecar** (`sidecar.ts`): sibling `.json`, auto-fetched by URL (`fetchSidecar`,
404/sandbox tolerant) or paired on multi-file drag-drop at the controller layer.
MRS fields are `SpectrometerFrequency` / `ResonantNucleus`. `ImagingFrequency` is
deliberately **not** treated as an MRS marker (it appears in plain fMRI sidecars).

**NIfTI routing** (`detect.ts`, `niftiBufferIsSignal`): a NIfTI is a signal when it
is non-spatial (dim1-3 == 1 and dim4 > 1). MRS sidecar/header fields do NOT route
here — a spatial spectroscopic image (MRSI/CSI) carries them too but its dim1-3
encode space, which the 1-D signal reader cannot represent, so it stays on the
volume path (the reader throws if MRSI is forced via `asSignal`). Datatype/complex
is NOT a trigger — spatial MR is routinely complex. The `asSignal` load option
(`true`/`false`) overrides the sniff.

**MRS metadata** is resolved sidecar-first, then from the NIfTI-MRS header
extension (ecode 44 JSON, parsed by `mrsFromHeaderExtensions`); the ppm
spectrometer frequency falls back to `ImagingFrequency` (which is itself never an
MRS routing marker). `volumeTR()` decodes `xyzt_units` so ms/us temporal pixdims
are not 1000x/1e6x off.

**Processing** (`processing.ts`, pure/CPU): in-place radix-2 Cooley-Tukey FFT with
a direct DFT fallback for non-power-of-two lengths; optional transient averaging
before the transform; fftshift to centre zero frequency; projection to a real
component (`real`/`imag`/`magnitude`/`phase`). Spectroscopy x-axis is ppm
(MR convention, drawn high-to-low via `axis.reversed` rather than reversing the
data) or Hz. Y-range is windowed to the visible x-domain. Physio x-axis is
`startTime + i / samplingFrequency` (Time (s)), falling back to a sample-index
axis when the rate is unknown.

**Rendering** (`view/NVGraph.ts`): the GPU graph was extended with a "signal mode"
(multi-color Okabe-Ito series, legend, real/reversible/windowed x-axis) gated on a
non-empty `series` field; the legacy 4D-volume graph path is unchanged. When the
scene is signal-only (a signal but no volume/mesh) the plot fills the instance area
and BOTH renderers skip the entire spatial pass — no slices, crosshair, or
orientation labels (`NVViewGPU.ts` / `NVViewGL.ts` compute `signalOnly`).

**Graph wheel:** scrolling over the graph steps the 4D frame when a spatial
volume is present; for a signal-only graph it falls back to scrubbing the cursor
(`stepSignalCursor` -> `setSignalCursorFraction`). `physio.bold.html` also exposes
the live `hdr.toFormattedString()` via a Header button.

**Model/controller API:** `NVModel.signals[]`, `NVModel.signalCursorX`,
`collectSignalGraphData()` (merges every loaded signal's derived series onto a
shared axis). Controller (`NVControlBase.ts`): `loadSignals`, `addSignal`,
`removeSignal`, `removeAllSignals`, `setSignal` (updates display state /
attachment / annotations, driving the on-demand transform),
`setSignalCursorFraction`. Events: `signalLoaded`, `signalRemoved`,
`signalLocationChange`. Clicking the plot sets a cursor marker and emits the
values at that x for the status bar.

**Annotations** (`SignalAnnotation`, on `NVSignal.annotations`): text labels
anchored to a position in the signal's own axis data-units `{ text, x, y, color? }`.
They are merged into `GraphData.annotations` (only for signals sharing the common
axis) and drawn in `buildSignalGraphElements`: x is mapped through the visible
window (`mapSignalX`), so labels pan/zoom with the data and are hidden once their
x leaves the window. A `y` of `-Infinity`/`+Infinity` pins the label to the
bottom/top of the plot (a faint vertical guide marks its x); a finite `y` maps to
the value, clamped into the plot. Set via the load options
(`loadSignals`/`addSignal`) or `setSignal(i, { annotations })`; persisted in NVD.
`examples/svs.html` labels NAA/Cr/Cho at their ppm positions.

**Persistence** (`signal/persistence.ts`): NVD documents serialize signals at
document version 8 (`serializeSignal` / `reconstructSignal`, CBOR-friendly raw
bytes).

**Demos:** `examples/svs.html` (spectroscopy: average / component / ppm-range;
plus a "Show" scene selector — MRS only / MRI only / MRI + MRS / MRI + MRS + voxel
— that pairs the spectrum with the participant's T2w and a one-node connectome
"voxel" marker rendered with the outline shader at the MRS sampling location, and
a "View" menu offering single slices / render / multiplanar) and
`examples/physio.html` (cardiac / respiratory selector). Sample fixtures in
`packages/dev-images/images/signals/`, served at `/signals/...`.

(The 4D-volume-frame <-> physio-time alignment marker and association graph are
implemented — see "Volume+physio association" below.)

### Signal audit notes

Applied from the audit (all landed):

- Real-NIfTI physio reader applies `scl_slope` / `scl_inter` (raw values from
  `toTypedViewOrU8` would otherwise plot wrong magnitudes).
- Spectroscopy FID geometry is clamped to the bytes actually present before the
  transform (guards truncated/corrupt files from out-of-range reads).
- Signal types + event details are exported from `src/index.ts`.
- Signal-only-scene detection is centralized in `NVModel.isSignalOnlyScene()`
  (used by both renderers and `collectSignalGraphData`).
- Drag-drop sidecar pairing is case-insensitive. (Routing later changed: see the
  fourth-round note — `_dispatchImage` always sniffs header dims; MRS fields no
  longer short-circuit routing.)

Second audit round (all landed):

- `vite.config.examples.ts` rewrites `/signals/` (alongside `/volumes//meshes/`)
  for `VITE_BASE` GitHub Pages deploys.
- Non-power-of-two FIDs are zero-filled to the next power of two so the FFT
  always uses the radix-2 path (no O(n^2) DFT freeze on real-size data).
- Derived plots are memoized per signal by display state
  (`NVModel.derivePlotCached`, WeakMap); dense series render a per-pixel-column
  min/max envelope (`drawDecimatedSeries`) so the line buffer is bounded by plot
  width; the legend is capped (`LEGEND_MAX_ROWS`, overflow -> "+N more").
- `collectSignalGraphData` only merges signals whose axis (label + reversed)
  matches the first, so ppm and time-axis signals never share one axis.
- Signal types exported from the `webgpu`/`webgl2` subpath entries too.
- Dead fields removed: `SignalFromUrlOptions.kind`, `NVSignalDisplay.stacked`,
  `SignalSeries.visible`.
- Demos use `textContent` (not `innerHTML`) for the sidecar-derived status line.
- `FEATURE_PARITY.md` section 34 records the signal data class.

Volume+physio association (`NVModel.collectAssociatedTimeGraphData`): when a
physio signal sets `attachedToId` to a loaded 4D volume, the graph shows the
crosshair BOLD time-course (frame i at i*TR seconds, t=0 = first volume) plus
each attached physio trace at its native sampling rate (no resampling) on a
shared Time (s) axis. The window is clamped to the imaging period
`[0, (nFrames-1)*TR]` (physio logged before/after the scan is dropped); each
series is min-max normalized for display, but carries un-normalized values in
`GraphSeries.rawY` so the status-bar readout (`signalValuesAt`) reports the real
BOLD intensity / physio counts. A cursor marks the current frame's time and a
graph click scrubs the 4D volume to the nearest frame. The readout also refreshes
on crosshair move and frame change (`createOnLocationChange -> refreshSignalLocation`).
TR comes from `volumeTR(vol)` (`pixDims[4]`, seconds via `xyzt_units`). Crosshair
voxel sampling is shared via `NVModel.sampleVolumeTimeCourse` (guards `matRAS`).
Per-trace visibility: the BOLD/volume series is gated by
`ui.graph.showVolumeTimecourse` (controller `graphShowVolumeTimecourse`, default
true); a physio trace is hidden with `setSignal(i, { display: { selectedColumns:
[] } })`. The builder now needs only `>= 1` visible series (was BOLD + `>= 1`
physio), so BOLD and each physio toggle independently; hide the whole graph with
`isGraphVisible = false` when nothing is selected. Demo: `examples/physio.bold.html`
(a real task-fMRI run with per-trace fMRI/respiratory/cardiac checkboxes; opens
with the crosshair on an unclamped deep-WM voxel ~20 mm left of the origin since
the uint8-scaled sample saturates at the origin).

Signal graph pan/zoom: a dense signal graph (`> 20` samples) draws four bottom-row
buttons (`< - + >` = pan-left / zoom-out / zoom-in / pan-right) on the axis-title
row (`computeGraphControls` -> `GraphLayout.controls`, rendered + hit-tested from
that one source; `graphHitTest` returns `{ type: 'graphControl', id }`). They
drive `NVModel.graphZoom(factor)` / `graphPan(frac)` (controller `graphZoom` /
`graphPan`) which adjust `signalViewWindow` (`[min,max]` over the x-axis, null =
full). The window is applied in `applyGraphViewWindow` (called from
`collectGraphData` for signal-mode data): it derives the full domain from the
input axis each call, stamps it on `GraphData.fullXDomain`, and rewrites
`xAxis.min/max`, so the cursor mapping, layout, and render all honour the zoom;
zooming centres on the graph cursor when set. `graphZoom`/`graphPan`/
`panViewWindowTo` read the current full domain + axis orientation from a FRESH
`collectGraphData()` (`NVModel.currentGraphDomain()`) rather than any persisted
render-time field, so they work immediately after `loadSignals()` (before the
first RAF) and are genuine no-ops when no signal graph is shown. The window
persists across crosshair/frame changes and resets on
`loadSignals`/signal removal. Each button carries a `disabled` flag (no-op at the
current window: full view, an edge, or the zoom-in limit) — drawn dimmed toward
the panel background and skipped by `graphHitTest`. Buttons start one button-width
in from the plot's left edge so they clear the leftmost x-label ("0").
Sparse data lines (e.g. the volume time-course) are drawn with per-segment x-clip
(`clipSegmentX`) so a line reaches the plot edge even when the neighbouring sample
is off-window (no dropped leftmost/rightmost segment).

Reset to full view: `graphResetView()` (controller) clears `signalViewWindow`,
and a DOUBLE-CLICK on the signal graph does the same (the dblclick handler in
`control/interactions.ts` checks `graphHitTest` first and resets instead of
depth-picking — there is nothing to depth-pick on the 2-D plot). This is the
one-click way back from a deep zoom; zooming out past the full extent still
auto-resets too. A double-click on a spatial slice is unaffected (still depth-picks).

Marker vs window: explicit zoom/pan may leave the cursor marker off-window (zoom
only re-centres on the marker when it is already visible; the pan buttons can
scroll it out of view — both intentional). But when the marker moves ON ITS OWN
via the scroll wheel (stepping the 4D frame, or `stepSignalCursor` for a
signal-only graph), the window pans to keep it visible: `NVModel.panViewWindowTo(x)`
is called from `setSignalCursorValue` and from `ensureGraphCursorVisible()` (the
latter wired into the wheel/frame-step path in `control/interactions.ts`).
`stepSignalCursor` no longer clamps the marker to the window — it extrapolates
(`signalXValueAtFrac`, reversed-aware), clamps to the full extent, then the window
follows. ALL frame changes follow the marker via `setFrame4D -> ensureGraphCursorVisible`
(not just the wheel), so the windowed `signalValuesAt` readout stays accurate after
Back/Forward too. Demo: `examples/physio.bold.html`.

Signal-graph audit invariants (keep these true):
- **Pan is screen-space + reversed-aware.** `graphPan(screenFrac)` flips the data
  shift for a reversed (ppm) axis (orientation from the fresh
  `currentGraphDomain()`), and `computeGraphControls` swaps the disabled
  pan-left/right edges for reversed. The buttons move the view the same VISUAL
  direction on Time and ppm graphs.
- **Hidden BOLD pays nothing.** `collectAssociatedTimeGraphData` samples the volume
  time-course only inside `if (showVol)`; a hidden BOLD (or a volume without
  `matRAS`) does NOT block a physio-only graph, and the cache key omits the
  crosshair when BOLD is hidden.
- **Assoc cache is cursor-independent + invalidated on mutation.** The key omits
  `frame4D` (series don't depend on the frame; only `cursorX` does — re-stamped on
  cache hit), so frame stepping reuses the cached series. `_assocCache` is cleared
  by `invalidateGraphCache()` on signal/volume add/remove/load (ids are
  name-derived, so a same-URL reload must not reuse stale data).
- **Controls gated on a width budget, title yields.** Buttons render when the plot
  is wide enough to hold the button span plus the leftmost x-label and a gap
  (`plotWidth > fontSize*8.2 + labelWidth + fontSize*1.5`) — relaxed from the old
  flat `22*fontSize` so the typical side-strip association graph (e.g.
  `physio.bold.html`) still shows controls. The centered axis title is shifted
  right when needed to clear the buttons (`titleX = max(center, buttonsRight +
  0.5fs + halfLabel)`), so title and buttons never overlap. Rug lanes are capped
  to a bottom band.
- **Pan before emit on frame change.** `setFrame4D` calls `ensureGraphCursorVisible()`
  (which pans the window via `panViewWindowTo`) BEFORE `createOnLocationChange()`
  emits, so the windowed `signalValuesAt` readout samples the NEW window — not the
  pre-pan one. Reordering matters whenever a zoomed window must follow a
  Back/Forward step.
- **Zoom centers on the VISIBLE marker.** `graphZoom` centers on the fresh
  `currentGraphDomain().cursorX` (the live frame/association marker) rather than a
  stale `signalCursorX` left from an old graph click, so zooming in keeps the
  current frame in view.
- **Pan/zoom derive from a fresh collect, never render-time cache.** `graphZoom`/
  `graphPan`/`panViewWindowTo` call `currentGraphDomain()` (a fresh
  `collectGraphData()`, `_assocCache`-backed) for the full domain + orientation +
  cursor. There are NO persisted `_signalFullDomain`/`_signalAxisReversed` fields
  — that render-time-to-setter bridge was removed because it made the setters
  no-op before the first RAF and could act on a stale/hidden graph's domain.
  `invalidateGraphCache()` therefore only clears `_assocCache`.
- **`applyGraphViewWindow` is pure.** It returns a SHALLOW COPY with rewritten
  `xAxis.min/max` and derives the full domain from `data.xAxis` each call (stamped
  on the copy's `fullXDomain`) — it does NOT mutate the cached `GraphData` in
  place (which would compound on repeated collects).
- **Axis chosen from the first VISIBLE plot.** `collectSignalGraphData` picks the
  shared axis from the first resolved plot with `>= 1` series, not `resolved[0]`:
  a hidden first signal (`selectedColumns: []`) still resolves to an empty-series
  plot carrying its axis, and adopting it would suppress a later visible signal on
  a different axis. Returns null when no plot has a visible series.
- **Visibility changes refresh the readout.** `graphShowVolumeTimecourse` and
  `setSignal({ display })` call `refreshSignalLocation()` after redraw, so the
  footer doesn't keep reporting a just-hidden trace; when every trace is hidden the
  readout is cleared (empty `signalLocationChange`) rather than left stale.
- **Style setters clamp.** `graphLineWidth` to finite `[0,8]`, `graphLineAlpha` to
  `[0,1]` (no NaN/Infinity into the line buffer). All three new graph settings
  (`graphShowVolumeTimecourse`/`graphLineWidth`/`graphLineAlpha`) also have flat
  constructor options (`NiiVueOptions`), matching `graphNormalizeValues`.

Graph line style (`ui.graph`, controller `graphLineWidth` / `graphLineAlpha`):
`lineWidth` is a RELATIVE multiplier on the DPI-scaled base thickness (default 1;
`<1` thins dense traces so they stop overlapping; grid/axis lines unaffected).
`lineAlpha` (0..1, default 1) makes the multi-series DATA lines translucent so
overlapping traces are readable at intersections (legend/rug stay opaque). Both
applied in `view/NVGraph.ts`; the line renderer already alpha-blends (the cursor
draws at 0.5). Additive blending is NOT used (translucency was chosen as
background-independent; additive would need a graph-pass blend-mode change).

Third audit round (all landed):

- `refreshSignalLocation` early-returns when no signal is loaded (no wasteful
  per-crosshair-move `collectGraphData` rebuild for plain 4D volumes).
- `sampleVolumeTimeCourse` guards a missing `matRAS` (no throw on every move) and
  is shared by the association and legacy 4D-graph paths.
- Association readout now reports raw values via `rawY` (not normalized).
- TR convention centralized in `volumeTR` (`volume/utils`).

Fourth audit round (all landed):

- NIfTI routing is **non-spatial only** (no MRS-field short-circuit); spatial
  MRS/MRSI stays a volume and the reader throws if forced via `asSignal`.
- `volumeTR` decodes `xyzt_units` (s/ms/us) so ms/us TRs are not 1000x/1e6x off.
- MRS metadata falls back to `ImagingFrequency` and the NIfTI-MRS header
  extension; `fmri.json` fixture stripped of site/PII fields.

Fifth audit round (all landed):

- Physio-NIfTI `samplingFrequency` also decodes `xyzt_units` (`temporalUnitScale`).
- Header-extension parse requires ecode 44 and trims NUL padding
  (`parseMrsExtension`).
- TSV header heuristic no longer treats an all-missing-token first data row as
  labels (needs a genuine non-numeric, non-missing token).
- Association skips physio traces with no samples in the imaging window;
  `signalValuesAt` is constrained to the visible x-window.
- Graph-wheel steps the associated volume (matches graph-click), not `volumes[0]`.
- `collectAssociatedTimeGraphData` is memoized by crosshair/frame/signal state
  (`_assocCache`) so the refresh + render passes in one frame build once.

Sixth audit round (signal annotations feature; all landed):

- Annotation `y` is classified once into pinBottom (`-Infinity`) / pinTop
  (`+Infinity`) / finite; a malformed finite-but-`NaN` y is skipped (it has no
  plot position and must not be mistaken for an edge sentinel — previously it
  drew a spurious guide line and a `NaN`-positioned label). NaN/out-of-range x is
  rejected by the window comparison.
- Shared `mapSignalY` helper (clamped y projection) replaces three inlined copies
  (data-line, decimation, annotation finite branch); mirrors `mapSignalX`. The
  grid stays unclamped by design (drawn only when in range).
- Faint vertical-line alphas are named constants: `CURSOR_ALPHA` (0.5),
  `GUIDE_ALPHA` (0.35). The edge-pinned guide uses `gridThick`; the cursor uses
  `lineThick`.
- `SignalAnnotation` (NVTypes, domain) vs `GraphAnnotation` (NVGraph, renderer)
  is a deliberate mirror of the `SignalSeries`->`GraphSeries` split, keeping the
  graph view decoupled from signal-domain types. `collectSignalGraphData` copies
  annotations field-by-field and only for signals sharing the common axis.

Seventh audit round (svs.html MRI/MRS/voxel demo; all landed):

- **PII**: `svs_se_30.json` shipped real site/device identifiers (institution name +
  street address, device serial, station name, acquisition time, internal study
  labels). The demo fetches and serves this sidecar publicly (GitHub Pages), so the
  fields were stripped, keeping only technical/MRS keys (`SpectrometerFrequency`,
  `ResonantNucleus`, `DwellTime`, sequence/coil params). LESSON: any DICOM-derived
  sidecar added under `packages/dev-images/` must be PII-scrubbed before it ships
  in a demo (cf. the fourth-round `fmri.json` scrub).
- **New binary assets need Git LFS + staging**: `svs_T2w.nii.gz` was on disk but
  untracked; the `*.nii.gz` LFS filter only applies on `git add`. Untracked = the
  deployed demo 404s. `git add` it so the index holds an LFS pointer, not the blob.
- `applyScene` is serialized with a `sceneSeq` token and wrapped in try/catch:
  rapid "Show" changes (or a switch mid-load) cannot interleave and desync the
  volume list / `nodeShown` / `isGraphVisible`, and a failed fetch no longer leaks
  an unhandled rejection. The View menu is disabled in signal-only (MRS only) mode
  since `sliceType` has no effect when the spatial pass is skipped.
- The voxel marker is an inline one-node connectome built as a `File` (loadMeshes
  dispatches the reader by `.jcon` extension); a `Blob`/`File` is re-readable so it
  is reused across show/hide cycles.

Eighth audit round (external review + fixes; see `audit_response.md`):

- **Recurring PII**: re-exporting `svs_se_30.json` with dcm2niix re-introduces
  DICOM identifiers (department name, procedure/study description, acquisition
  time, image comments) every time; they were scrubbed again. The `.nii.gz` has
  NO NIfTI-MRS header extension (verified: `vox_offset` 352, no ecode 44), so the
  sidecar is REQUIRED and cannot be deleted. The reader only consumes
  `SpectrometerFrequency` / `ResonantNucleus` / `DwellTime` (+ `ImagingFrequency`
  fallback), and the parser unwraps the NIfTI-MRS array forms (`[297.1]`, `["1H"]`)
  via `firstNumber`/`firstString`. RESOLVED: `svs_se_30.json` is now a minimal
  hand-authored sidecar containing only `SpectrometerFrequency` / `ResonantNucleus`
  / `DwellTime` (+ a `_comment` warning against re-dumping), so there is no PII to
  re-acquire. Do NOT replace it with a raw dcm2niix dump. The ppm axis is unchanged
  (verified) and all 320 tests (which read the fixture) pass.
- **Scene race (real)**: the prior `sceneSeq` token was checked only *after* the
  async volume/mesh mutations, so a stale call could still mutate state. Replaced
  with a mutex — `applyScene` chains through a single promise (`sceneChain.then(...)`)
  so calls cannot interleave; last mode wins. Demo load failures now surface in the
  `#location` footer, not console-only.
- **Annotation copy at boundaries**: `createSignal`/`setSignal` now clone the
  annotations array + objects (`.map(a => ({ ...a }))`), matching `display`, so
  post-load caller mutation cannot silently change render state.
- **T2w data governance (RESOLVED)**: `svs_T2w.nii.gz` was defaced with mindgrab
  (maintainer confirmed), so the public demo asset is de-identified. Sidecar PII
  was separately scrubbed (now a minimal hand-authored file).

Ninth audit round (second external review; see `audit_response.md`):

- **Routing docs corrected**: README + `_dispatchImage` JSDoc claimed MRS sidecar
  fields route NIfTI to signals; the implementation (`detect.ts`) is dims-only
  (signal iff dim1-3==1 & dim4>1) and ignores MRS fields by design. Docs aligned.
- **Annotation color deep-copied**: `cloneAnnotation` (in `signal/NVSignal.ts`)
  copies the color tuple too; used by `createSignal` + `setSignal`. The `display`
  shallow-merge and the `signals` live getter are left as established API
  convention (mutate via `setSignal`). `persistence.ts` shallow copy is safe
  (CBOR-encoded immediately / reconstructed from fresh decoded data).
- **Demo scene switching coalesced**: `applyScene` records `pendingMode` and each
  queued task runs only if still latest, so rapid input skips intermediate
  load/remove churn. Initial `loadSignals` is now wrapped (footer error message).
- **No bare annotation guides**: annotations skip entirely when `fontSize <= 6`
  (guide was previously drawn even when the label was suppressed).
- Won't-fix (documented): full-`NVDocument` signal round-trip test is not runnable
  under the Bun harness (`import.meta.glob`); the signal path is covered by
  `persistence.test.ts` (serialize/reconstruct + real CBOR, incl. `-Infinity` y).

Deferred (low priority, documented): two-pass/streaming TSV parser;
annotations render only in the signal-only graph, not the volume+physio
association view (`collectAssociatedTimeGraphData`); annotation count/long-label
truncation/collision handling is unbounded by design (user-supplied, not
amplified); no committed Playwright e2e for the svs demo (manual headless smoke
each round, matching the repo's manual-rendering-verification convention);
ambiguous-NIfTI double read (dispatcher sniffs then loader re-reads);
`loadImage` keeps append semantics for signals by design; per-draw O(samples)
domain/range scans in the graph; incompatible signals are silently dropped from
a merged graph (warning/event is a future item); public setters to correct
`SamplingFrequency`/`StartTime`/`SpectrometerFrequency`/`DwellTime` after load
are not exposed (`setSignal` updates display/attachment only); rapid graph
scrubs queue async `setFrame4D` uploads without coalescing; annotations have no
add/clear convenience or per-annotation visibility (`setSignal({ annotations })`
is full-replace by design, matching the `setVolume`/`setSignal` options pattern).

### MRSI (spatial spectroscopic imaging)

MRSI/CSI is a **complex 4-D volume** (dim1-3 = space, dim4 = FID), so it stays
on the **volume path** (not the 1-D signal reader, which throws on spatial MRS).
`volume/mrsi.ts` (`isMrsiVolume`/`prepareMrsiVolume`, wired into `nii2volume`)
detects a complex spatial 4-D NIfTI and replaces its `img` with a derived scalar
**total-signal map** (integral of `|spectrum|` over the nucleus' `PPM_RANGE`,
`halveFirstPoint` on), while **retaining the raw complex FID + spectral metadata
on the NVImage** (`complexFID` / `mrsMeta`). The complex buffer is CPU-only —
the GPU only ever sees the scalar map, so texture handling is unaffected.

Complex decode + the NIfTI-MRS ecode-44 parse are shared between the SVS signal
reader and the MRSI volume path via `signal/mrs.ts` (`isComplexDatatype`,
`decodeComplexFID`, `mrsFromHeaderExtensions`).

The **crosshair-voxel spectrum** reuses the signal graph: `addMrsiSignal(volumeId)`
adds a spectroscopy `NVSignal` with `followsCrosshair = true` + `attachedToId`
pointing at the MRSI volume. In `collectSignalGraphData`, `plotFor` ->
`crosshairSpectroscopyPlot` extracts the crosshair voxel's FID
(`extractVoxelFid`, using the volume's `img2RASstart`/`step` native mapping) and
re-derives the spectrum **fresh every collect** (not memoized — one 1024-pt FFT
per frame is cheap and keeps the cursor live without the display-keyed plot
cache going stale). Moving the crosshair triggers `drawScene` -> render ->
`collectGraphData`, so the spectrum tracks the crosshair like the fsleyes MRS
plugin. The status-bar readout still requires a graph-cursor click (no
associated 4-D volume), but the plotted spectrum updates on every move.

FSL-MRS spectral transforms live in `signal/processing.ts`: `halveFirstPoint`,
`apodize` (exp line-broadening), `phaseCorrection` (0th deg / 1st ms), the
`GYRO_MAG_RATIO`/`PPM_SHIFT`/`PPM_RANGE` constants, and `integratePpmBandMap`
(the range->map engine, also the default-display-map engine). All new display
flags (`halveFirstPoint`/`apodizeHz`/`phase0`/`phase1Ms`) default off/0 so the
`svs.html` baseline is unchanged; parity-tested against fsleyes in
`processing.test.ts`. The FSL-MRS workflow + range->map tool + scene controller
are packaged as `@niivue/nv-ext-mrs` (demo `apps/demo-ext-mrs`, `mrsi.html`);
`context.mrs` (`MrsVolumeAccess`, first MRSI volume) / `context.mrsById(id)`
(multi-MRSI safe) expose the complex buffer read-only.
Fit-results overlays are deferred (no results dataset). Ported from
fsleyes-plugin-mrs (BSD-3) — provenance in that package's `PORTING.md`.

Audit-hardened invariants (keep these true):
- **Detection is metadata-gated.** `isMrsiVolume` requires complex + spatial +
  dim4>1 AND NIfTI-MRS ecode-44 fields (`hasMrsFields`), so a non-MRS complex
  4-D volume (e.g. complex fMRI) is NOT silently rewritten into a scalar map.
- **Truncation-safe.** `prepareMrsiVolume` clamps `nPoints*nTransients` to the
  bytes present and `integratePpmBandMap` guards reads with `?? 0` (no NaN map).
- **Not `isImaginary`.** The derived scalar overlay must NOT set
  `volume.isImaginary` (it's a real map; the complex data is in `complexFID`) —
  otherwise `control/locationTracking` appends a bogus imaginary readout.
- **No fake placeholder.** An unresolved `followsCrosshair` signal (volume
  removed / off-grid / NVD reload without `complexFID`) is dropped from the
  graph (`plotFor` returns null), never drawn as a flat zero-FID line.
- **NVD limitation:** `complexFID`/`mrsMeta` are NOT serialized to NVD (only the
  derived scalar `img`); a reloaded crosshair spectrum is unavailable until the
  MRSI volume is re-added. Persisting the ~18 MiB buffer is deferred by design.
- **Mask is modulated, not baked.** `nv-ext-mrs` `setMaskEnabled` calls
  `setModulationImage(mrsiId, maskId, 1)` (alpha) — the mask is loaded as a
  hidden volume (`opacity 0`, `calMin/calMax 0..1`) and consumed as the
  modulator; the core scalar-overlay modulation path (see Volume modulation
  above) makes out-of-mask voxels transparent in the GPU prepass. No more
  sentinel bake, buffer-swap, or `unmaskedMap`/`maskRAS` shadow copies.
- **Mask also applies to generated maps.** `setMaskEnabled` modulates the MRSI
  overlay AND every `makeMap` overlay (tracked in `mapIds`); a new `makeMap` while
  the mask is on inherits it. `sameGrid` is a dims heuristic and an **extension
  policy** (warn + skip on mismatch), NOT a core-modulation limit — core samples
  the modulator through the transform matrix and tolerates any co-registered grid.
- **`MrsScene` lifecycle.** `load()` is idempotent: it removes this scene's prior
  crosshair signal (via `removeSceneSignal`, which is scoped by
  `attachedToId === mrsiId && followsCrosshair` — NOT the first global
  `followsCrosshair` signal) and resets `mrsiId`/`maskId`/`maskEnabled`/`mapIds`
  before reloading. The `mrs` getter returns null (no global fallback) when
  `mrsiId` is null. `dispose()` removes the scene signal + detaches the snap
  listener. KNOWN GAP: the scene's volumes (MRSI grid, hidden mask, generated
  maps) are NOT removed on reload-without-anatomy or dispose — the controller
  exposes no single-volume removal to extensions (only `removeAllVolumes`); the
  demo always reloads with anatomy (`loadVolumes` -> `removeAllVolumes` clears
  them). Exposing per-volume removal to extensions is a tracked follow-up.

## Colormap conventions

**Negative colormaps:** Enabled by setting `colormapNegative` to a non-empty string. `calMinNeg`/`calMaxNeg` default to mirroring `calMin`/`calMax`.

**`colormapType`** (`COLORMAP_TYPE` enum in `NVConstants.ts`):
- `0` MIN_TO_MAX: Maps [calMin, calMax] across LUT. `isTransparentBelowCalMin` controls below-threshold.
- `1` ZERO_TO_MAX_TRANSPARENT: Maps [0, calMax], transparent below calMin.
- `2` ZERO_TO_MAX_TRANSLUCENT: Maps [0, calMax], faded alpha below calMin.

Volumes apply in GPU shader. Mesh layers apply during CPU compositing (`mesh/layers/index.ts`).

**Label colormaps:** Discrete indexed colors for atlas volumes. `NVCmaps.makeLabelLut()` → `NVImage.colormapLabel`. Orient shader uses nearest-neighbor LUT sampling. `calMin`/`calMax`/`colormapType` are ignored for label volumes. When a colormap registered via `addColormap(name, cmap)` includes a `labels?: string[]` field (e.g. the built-in `_draw` colormap), the drawing volume surfaces the human-readable label (e.g. `"11bladder"`) in the `locationChange` event's `string` field instead of a numeric fallback like `"draw:11"`.

## Drawing (voxel bitmap editing)

Voxel-level drawing/annotation on 2D slices, visible in both 2D and 3D views. Module: `src/drawing/`.

**Data model:** `model.drawingVolume` is an `NVImage | null` — a proper NIfTI volume with its own header and RAS transforms. Its `img` field (`Uint8Array`) holds label indices (0 = transparent) matching background volume's `dimsRAS`. Converted to RGBA via `drawingBitmapToRGBA()`, uploaded as 3D texture. Use `Drawing.getDrawingBitmap(vol)` to access the bitmap. `Drawing.createDrawingVolume(back)` creates an empty drawing from a background volume.

**Undo:** Circular buffer of RLE-compressed (PackBits) snapshots, controller-owned (not serialized). `addUndoBitmap()` saves *before* each stroke. `drawUndo()` loads then decrements (load-then-decrement order).

**Persistence:** `drawingVolume` lives in model, survives view reinitialization. NVD documents serialize bitmap via RLE (v6). Undo buffers not persisted.

**GPU pipeline:** Drawing texture has its own binding slot, separate from overlay. `refreshDrawing()` sets `_drawingDirty` flag, deferred to RAF. `_flushDrawing()` does bitmap→RGBA + GPU upload once per frame. `updateDrawingTexture()` reuses existing texture (no bind group recreation).

**`draw.isFillOverwriting`** (default `true`): Controls whether pen/fill overwrite existing non-zero voxels. When `false`, skip already-colored voxels (eraser always works).

**`draw.isEnabled` vs `closeDrawing()`**: `draw.isEnabled = false` disables pen but keeps drawing visible. `closeDrawing()` destroys drawingVolume and GPU textures.

## Crosshair navigation

**`moveCrosshairInVox(di, dj, dk)`**: Steps crosshair by discrete voxels in RAS-resampled ijk space. Snaps to voxel centers via mm→vox (rounded)→mm round-trip.

**Scroll wheel**: Steps one voxel in depth direction (AXIAL→k, CORONAL→j, SAGITTAL→i). Mesh-only: 1% of scene extent.

**Keyboard**: H/L/J/K step crosshair in RAS axes on 2D slices; rotate azimuth/elevation in render-only mode.

## Drag modes

Configurable drag interactions on 2D slices. `interaction.primaryDragMode` (default: `crosshair`) for left-button, `interaction.secondaryDragMode` (default: `contrast`) for right-button. 3D tile: left=rotate, right=clip plane. Module: `control/dragModes.ts`.

`DRAG_MODE` enum: `none`(0), `contrast`(1), `measurement`(2), `pan`(3), `slicer3D`(4), `callbackOnly`(5), `roiSelection`(6), `angle`(7), `crosshair`(8), `windowing`(9).

Public enum exports from the package root (alongside `DRAG_MODE`): `SLICE_TYPE` (axial/coronal/sagittal/multiplanar/render), `MULTIPLANAR_TYPE` (auto/column/grid/row), `SHOW_RENDER`, and `NiiDataType`.

**Overlay rendering:** Selection boxes use GlyphBatch panels (`_dragOverlay.rect`). Measurement/angle lines use line renderer (`_dragOverlay.lines`). Overlay state lives on `model._dragOverlay` (transient, not serialized).

**Drawing priority:** When `draw.isEnabled && drawingVolume`, drawing intercepts left-button before drag mode dispatch.

## Slice layout system

Pure-data layout engine in `view/NVSliceLayout.ts`. Computes `SliceTile[]` from `SliceLayoutConfig`. Both backends call `screenSlicesLayout()` once per frame.

Priority: mosaic string > render-only > single slice > hero layout > multiplanar.

**`SliceTile`** key fields: `leftTopWidthHeight`, `axCorSag`, `screen` (ortho mm bounds), `azimuth`/`elevation`, `sliceMM` (mosaic mm position), `renderOrientation`, `crossLines`, `showLabels`. Cached `mvpMatrix`/`planeNormal`/`planePoint` populated during render for picking.

### Mosaic string format

`layout.mosaicString` tokens: `A`/`C`/`S` (orientation), `R` (3D render), `X` (cross-lines), `L`/`L-` (labels), `;` (row break), `<number>` (mm position). Negative mm on render tiles adds 180 to azimuth. Example: `A -20 0 20 ; S R X 0 S R X -0`.

### Hero layout

`layout.heroFraction` (0–1) splits canvas: hero tile (left) + multiplanar A+C+S (right). `layout.heroSliceType` selects hero content.

### Mosaic tile rendering differences

- **`sliceMM`**: Uses `getSliceTexFracAtMM()` instead of crosshair-based `getSliceTexFrac()`.
- **Crosshairs/orient cube suppressed** on mosaic tiles.
- **Rotation-stable framing**: Mosaic render tiles pass `origin` to `calculateMvpMatrix2D`.

## Volume ray-march architecture

The 3D render shaders (`wgpu/render.wgsl`, `gl/renderShader.ts`) use a multi-pass ray-march:

1. **Background pass** (fast + fine): Gradient lighting via matcap. Handles clip planes.
2. **Optional passes** (overlay, PAQD, drawing): Each uses `rayMarchPass()` (fast skip + fine accumulation with premultiplied alpha), then `depthAwareMix()` for depth-correct compositing. When `gradientAmount > 0`, the drawing pass applies matcap lighting at first hit using a gradient sampled from the drawing volume (same uniform gate as the background pass).

Guards: Each optional pass checks `textureSize > 2` (placeholder is 2×2×2 all zeros).

### PAQD (probabilistic atlas with quantized distances)

GPU-side visualization: raw data (idx1, idx2, prob1, prob2 as rgba8unorm) uploaded with 256-entry label LUT texture. Shaders perform LUT lookup, probability-weighted blending, and alpha easing. **Split sampling**: label indices use nearest-neighbor; probabilities use linear interpolation.

## Critical rendering invariants

### Blending modes (DO NOT CHANGE without understanding consequences)

Volume ray-march shaders use **premultiplied alpha**. Framebuffer blend must match:
- **WebGPU** (`wgpu/render.ts`): `srcFactor: "one", dstFactor: "one-minus-src-alpha"`
- **WebGL2** (`gl/render.ts`): `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)` for volume draw, then restore `gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)`

If WebGL2 uses `SRC_ALPHA` instead of `ONE`, alpha is multiplied twice — recurring regression.

### Clip plane color

`scene.clipPlaneColor` alpha sign determines behavior in `render.wgsl`/`renderShader.ts`:
- **alpha >= 0**: Solid colored surface behind transparent regions
- **alpha < 0**: Tints accumulated color using `abs(alpha)` as mix factor

Both fast-pass and fine-pass must use `if (isClip)` — **not** `if (!cutaway && isClip)`.

## Extension context API

Stable plugin interface for extensions to interact with NiiVue without reaching into internals. Module: `src/extension/`. Created via `nv.createExtensionContext()`, which returns an `NVExtensionContext`. Multiple contexts can coexist — each tracks its own subscriptions.

**Lifecycle:** Call `context.dispose()` when done — removes all event listeners registered through that context and releases any shared buffers.

### Data access (live getters)

All properties are getters — always reflect current state, no staleness.

- **`context.backgroundVolume`** → `BackgroundVolumeAccess | null`: `img` (raw data in header order), `hdr`, `dims` (`{dimX, dimY, dimZ}` in RAS space), `voxelSizeMM`, `calMin`/`calMax`, `robustMin`/`robustMax`, `globalMin`/`globalMax`, `imgRAS` (Float32Array in RAS voxel order, cached, zero-copy when volume is already RAS-ordered).
- **`context.drawing`** → `DrawingAccess | null`: `bitmap` (Uint8Array, live reference), `dims`, `voxelSizeMM`, `update(bitmap)` (copy + refresh), `refresh()` (display-only refresh), `acquireSharedBuffer()` (swaps backing to SharedArrayBuffer for zero-copy worker communication; returns handle with `.view` and `.release()`).
- **`context.volumes`** → `readonly NVImage[]`: All loaded volumes.

### Events

`context.on(type, listener)` / `context.off(type, listener)` — subscribes to both standard `NVEventMap` events and extension-specific slice pointer events:

| Event | Detail | When |
|-------|--------|------|
| `slicePointerMove` | `SlicePointerEvent` | Pointer moves over a 2D slice (not dragging) |
| `slicePointerUp` | `SlicePointerEvent` | Pointer released over a 2D slice |
| `slicePointerLeave` | `undefined` | Pointer leaves the canvas |

**`SlicePointerEvent`** fields: `voxel` (RAS ijk, rounded), `mm` (world coords), `sliceType` (0=axial, 1=coronal, 2=sagittal), `canvasX`/`canvasY` (DPR-adjusted), `pointerEvent` (original DOM event). Hit-testing is done by NiiVue — extensions don't need manual `screenSlicePick` math.

Slice pointer events are emitted from `control/interactions.ts` via `computeSlicePointerEvent()`, which runs the hitTest → screenSlicePick → mm2vox pipeline and bounds-checks the result.

### Actions

- **Drawing:** `createEmptyDrawing()`, `closeDrawing()`, `drawUndo()`, `refreshDrawing()`
- **Volumes:** `addVolume(vol)`, `removeAllVolumes()`
- **Transforms:** `registerVolumeTransform(transform)`, `applyVolumeTransform(name, volume, options?)`

### Coordinate transforms

- `context.vox2mm([x,y,z])` → `[mx,my,mz]` — RAS voxel → world mm
- `context.mm2vox([mx,my,mz])` → `[x,y,z]` — world mm → RAS voxel

### `getImageDataRAS(volume)` utility

Exported from `volume/utils.ts` and from the package root. Returns `Float32Array | null` in RAS voxel order indexed as `data[rx + ry*dimX + rz*dimX*dimY]`. Zero-copy when native storage matches RAS (identity permutation); otherwise allocates a reordered copy. Values are raw (not scaled by scl_slope/scl_inter).

### Public exports

From package root (`src/index.ts`): `NVExtensionContext`, `computeSlicePointerEvent`, `getImageDataRAS`, and types `BackgroundVolumeAccess`, `DrawingAccess`, `DrawingDims`, `NVExtensionEventMap`, `SharedBufferHandle`, `SlicePointerEvent`.

## Web Workers

`NVWorker` (`workers/NVWorker.ts`) provides promise-based worker bridge with message-ID tracking, lazy creation, and transferable support.

**Build note:** Use `?worker&inline` for imports (blob URL, self-contained).

**Protocol:** Messages include `_wbId`. Reply with `{ _wbId, ...result }` or `{ _wbId, _wbError }`. Transfer output ArrayBuffers.

**Serialization:** Strip non-cloneable properties (class instances) via `JSON.parse(JSON.stringify())` before `postMessage`.

## Demo conventions

Demos import `import NiiVue from '../dist/niivuegpu.mjs'` — Vite dev plugin redirects to source. Simple demos inline in HTML; complex ones use separate `.js` files. Assets relative to `demos/` (e.g., `../meshes/brain.mz3` from `features/`).

## Dependencies

- `nifti-reader-js`: NIfTI parsing
- `gl-matrix`: Vector/matrix math
- `cbor-x`: CBOR encoding for NVD documents and ITK-Wasm
- `earcut`: Polygon triangulation (annotations)
- `clipper2-ts`: Polygon clipping (annotations)
