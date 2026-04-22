# AGENTS.md

Guidance for AI coding agents working in the NiiVueGPU repository.

## Project Overview

NiiVueGPU is a WebGPU-based neuroimaging visualization library (volumes + meshes) with a WebGL2 fallback. Written in TypeScript, MVC architecture with dual rendering backends.

## Build Commands

```bash
bun install          # Install dependencies
bun run dev          # Hot-reload dev server at localhost:8080
bun run build        # Development build to ./dist
bun run build:lib    # Build library to demos/dist/ (ES + UMD)
bun run demo         # Build library and serve demos/ with http-server
bun run deploy       # Production build to ./dist
bun run lint         # ESLint check
bun run lint:fix     # ESLint auto-fix
bun run typecheck    # TypeScript type checking (tsc --noEmit)
```

**Before committing**, always run: `bun run lint:fix && bun run typecheck`

## Testing

The package has a unit test suite for non-rendering (server-side) logic using the **Bun test runner**. Tests are co-located with source files as `*.test.ts`.

```bash
bun test                # Run all tests with coverage
bun test src/drawing/   # Run tests in a specific directory
bun test --watch        # Watch mode
bunx nx test niivue     # Run via Nx from monorepo root
```

Coverage is enabled by default in `bunfig.toml` (reporters: `text` + `lcov`). The `coverage/` directory is gitignored.

### What's tested

- **Drawing tools** (`src/drawing/`) — RLE codec, pen/line/flood-fill, undo stack
- **Annotations** (`src/annotation/`) — undo/redo, point-in-polygon, slice projection, shape selection & control points
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

Rendering tests (Playwright) are planned but not yet implemented. For now, verify rendering changes manually via the interactive demos (`bun run dev` or `bun run demo`).

`bun run dev` uses a Vite plugin (`vite.config.dev.js`) to redirect `import '../dist/niivuegpu.mjs'` to source for HMR. Same HTML/JS files work in dev and production.

Library packaging note: `bun run build` emits `dist/niivuegpu.js` (both backends), `dist/niivuegpu.webgpu.js` (WebGPU-only), and `dist/niivuegpu.webgl2.js` (WebGL2-only), with package exports `niivuegpu`, `niivuegpu/webgpu`, and `niivuegpu/webgl2`.

## Code Style

ESLint enforces these rules (see `eslint.config.js`):

- **No semicolons** — `semi: ["error", "never"]`
- **2-space indentation** — no tabs (`indent: ["error", 2, { SwitchCase: 1 }]`)
- **Strict equality** — always use `===` / `!==` (`eqeqeq: ["error", "always"]`)
- **Unused parameters** — prefix with `_` (e.g., `_event`) to suppress lint errors

## TypeScript

- **Strict mode** is enabled (strict null checks, no implicit any, etc.)
- **Target**: ESNext with bundler module resolution
- **WebGPU types**: `@webgpu/types` for GPU API type definitions
- Run `bun run typecheck` to validate — this runs `tsc --noEmit`

## Import Conventions

- **Cross-directory imports** use the `@/` path alias (maps to `src/`):
  ```typescript
  import { log } from '@/logger'
  import type { NVImage } from '@/NVTypes'
  ```
- **Same-directory imports** use relative paths: `import * as mesh from './mesh'`

## Module Naming

- **Public modules** (cross-directory): PascalCase with `NV` prefix — `NVModel.ts`, `NVMesh.ts`, `NVVolume.ts`
- **Internal modules** (folder-local): lowercase — `mesh.ts`, `font.ts`, `orient.ts`
- **Exception:** `NVTypes.ts` is lowercase despite cross-directory use (pure type module)

## Logging

Use the structured logger — never use `console.*` directly:

```typescript
import { log } from '@/logger'
log.debug('...') // debug/info/warn/error/fatal/silent
```

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

### Key Source Files

| File | Role |
|------|------|
| `NVControl.ts` | Controller — public API, property setters, delegates to `control/` |
| `NVModel.ts` | Data model — volumes, meshes, clip planes, scene state |
| `NVTypes.ts` | TypeScript interfaces (`NVImage`, `NVMesh`, `NVScene`, `NVConfig`, etc.) |
| `NVConstants.ts` | Runtime constants/enums (`SLICE_TYPE`, `COLORMAP_TYPE`, etc.) |
| `NVDocument.ts` | Document save/load (NVD format v4, CBOR-encoded) |
| `control/view.ts` | View lifecycle (attach, recreate, reinitialize) |
| `control/interactions.ts` | Event handling (mouse, keyboard, drag-drop, resize) |
| `wgpu/NVViewGPU.ts` | WebGPU renderer with compute pipelines |
| `gl/NVViewGL.ts` | WebGL2 fallback (substantially complete) |

Both backends have matching render layers: `mesh`, `font`, `line`, `colorbar`, `orient`, `crosshair`, `thumbnail` — each in `wgpu/` and `gl/` directories. All render entities extend `NVRenderer` (`src/view/NVRenderer.ts`):

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

Key conventions: `init()` stores the GPU context, `destroy()` is parameterless (uses stored context), `isReady` (public get, protected set) guards all draw calls. Stateless utilities (e.g. `buildLine()`) remain module-level exports.

## Coordinate Systems

Two distinct fractional [0..1] spaces — do not conflate:

- **Scene fraction**: [0,1]³ within scene AABB. Used for `crosshairPos`. Conversion: `NVModel.scene2mm()`/`mm2scene()` — linear interp between `extentsMin`/`extentsMax`.
- **Volume texture fraction**: [0,1]³ within a single volume's 3D texture (voxel centers at `(i+0.5)/dim`). Per-image: `NVImage.frac2mm` mat4. Model caches the background volume's matrices as `NVModel.tex2mm`/`mm2tex`.

All overlay volumes are resliced to match the background volume's grid, so `tex2mm`/`mm2tex` apply to all loaded overlays.

**MM space** is the common ground. Depth picker → mm → scene fraction for `crosshairPos`. `getSliceTexFrac()` converts scene fraction → texture fraction for the slice coordinate.

### 2D Slice Picking

Each `SliceTile` caches `mvpMatrix`, `planeNormal`, and `planePoint` during the render loop. `screenSlicePick` uses these cached values for fast ray-plane intersection without recomputing the MVP. A fallback recomputes from scratch on the first frame before cache is populated. For depth picking (double-click on 3D render tiles), `depthPick` reads back a depth buffer value and unprojects to mm-space.

## Format Extensibility

All format readers use Vite's `import.meta.glob` for automatic discovery. To add a new reader:
1. Create a module in the appropriate `readers/` directory
2. Export `extensions` array and `read` function
3. Auto-registered at build time — no manual wiring needed

Shared utilities: `NVLoader.buildExtensionMap()` (extension→module maps), `NVGz.maybeDecompress()` (transparent gzip).

Same pattern for: mesh readers (`mesh/readers/`), volume readers (`volume/readers/`), tract readers (`mesh/tracts/readers/`), connectome readers (`mesh/connectome/readers/`), layer readers (`mesh/layers/readers/`), volume transforms (`volume/transforms/`).

## Three Mesh Species

Discriminated by `kind: MeshKind`. All share GPU pipeline (`positions`/`indices`/`colors`) but differ in source data:

| Species | `kind` | Source field | Dynamic? |
|---------|--------|-------------|----------|
| Triangulated mesh | `'mesh'` | `mz3` | No |
| Tract/streamline | `'tract'` | `trx` | Yes (radius, sides, decimation) |
| Connectome | `'connectome'` | `jcon` | Yes (node/edge scale, thresholds) |

Exactly one of `mz3`, `trx`, `jcon` is non-null per mesh. Source data is immutable; only derived GPU arrays change. VTK files use `probeVTKContent()` for content-based dispatch (LINES→tract, POLYGONS→mesh).

## Mesh Layers (Scalar Overlays)

CPU-composited scalar overlays on meshes. `perVertexColors` (nullable `Uint32Array`, packed ABGR) preserves file-provided vertex colors for recompositing; null for uniform-color meshes. Layer readers in `mesh/layers/readers/` (CURV, SMP, STC) plus fallthrough to mesh/volume readers. Layers only apply to `kind === 'mesh'`; tract/connectome coloring happens during tessellation/extrusion.

## Colormap Conventions

**Negative colormaps:** Enabled by setting `colormapNegative` to a non-empty string. `cal_minNeg`/`cal_maxNeg` default to mirroring `cal_min`/`cal_max`. Absolute values used internally.

**`colormapType`** (`COLORMAP_TYPE` enum in `NVConstants.ts`):
- `0` MIN_TO_MAX: Maps [cal_min, cal_max] across LUT. `isTransparentBelowCalMin` (default `true`) controls below-threshold behavior.
- `1` ZERO_TO_MAX_TRANSPARENT: Maps [0, cal_max], transparent below cal_min.
- `2` ZERO_TO_MAX_TRANSLUCENT: Maps [0, cal_max], faded alpha below cal_min.

Volumes apply in GPU shader. Mesh layers apply during CPU compositing (`mesh/layers/index.ts`).

**Label colormaps:** Discrete indexed colors for atlas volumes. `NVCmaps.makeLabelLut()` → stored on `NVImage.colormapLabel`. Orient shader uses nearest-neighbor LUT sampling. `cal_min`/`cal_max`/`colormapType` are ignored for label volumes.

## Critical Rendering Invariants

### Blending Modes (DO NOT CHANGE without understanding consequences)

Volume ray-march shaders use **premultiplied alpha**. Framebuffer blend must match:
- **WebGPU** (`wgpu/render.ts`): `srcFactor: "one", dstFactor: "one-minus-src-alpha"`
- **WebGL2** (`gl/render.ts`): `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)` for volume draw, then restore `gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)`

If WebGL2 uses `SRC_ALPHA` instead of `ONE`, alpha is multiplied twice — recurring regression.

### Clip Plane Color

`clipPlaneColor` alpha sign determines behavior in `render.wgsl`/`renderShader.ts`:
- **alpha >= 0**: Solid colored surface behind transparent regions
- **alpha < 0**: Tints accumulated color using `abs(alpha)` as mix factor

Both fast-pass and fine-pass must use `if (isClip)` — **not** `if (!cutaway && isClip)`.

## Web Workers

`NVWorker` (`workers/NVWorker.ts`) provides promise-based worker bridge with message-ID tracking, lazy creation, and transferable support.

**Build note:** Use `?worker&inline` for imports (blob URL, self-contained).

**Protocol:** Messages include `_wbId`. Reply with `{ _wbId, ...result }` or `{ _wbId, _wbError }`. Transfer output ArrayBuffers.

**Serialization:** Strip non-cloneable properties (class instances) via `JSON.parse(JSON.stringify())` before `postMessage`.

## Demo Conventions

Demos import `import NiiVue from '../dist/niivuegpu.mjs'` — Vite dev plugin redirects to source. Simple demos inline in HTML; complex ones use separate `.js` files. Assets relative to `demos/` (e.g., `../meshes/brain.mz3` from `features/`).

## Dependencies

- `nifti-reader-js`: NIfTI parsing
- `gl-matrix`: Vector/matrix math
- `cbor-x`: CBOR encoding for NVD documents and ITK-Wasm
