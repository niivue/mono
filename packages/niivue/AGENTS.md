# AGENTS.md

Guidance for AI coding agents working in the NiiVue package (`@niivue/niivue`). The repo-wide rules are in the root `AGENTS.md`; this file adds what is specific to this package. Detail lives in `notes/agents/` (list at the end): read the file for the area you are changing before you change it.

## Project overview

NiiVue is a WebGPU-based neuroimaging visualization library (volumes + meshes) with a WebGL2 fallback. Written in TypeScript, MVC architecture with dual rendering backends.

## Build commands

Bun, at the version pinned in the repo-root `.bun-version` (every workflow reads it): `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat "$(git rev-parse --show-toplevel)/.bun-version")"`. An older Bun rewrites `bun.lock` to an older format, does not hoist `bun-types` (TS2688 in `typecheck`) and lacks `DecompressionStream` (gzipped-fixture tests fail).

```bash
bun run dev                          # Dev server at localhost:5273, serving examples/ from source
bun run build                        # Library build to ./dist, then the standalone build
bun run build:examples               # Examples site build
bun run lint:fix                     # Biome check --fix (src/)
bun run typecheck                    # tsc --noEmit (also type-checks examples/)
bun test                             # Unit tests with coverage
bunx nx dev niivue                   # Port 8080, also serving the SITE_APPS demo apps from source
```

**Before committing**, run the root AGENTS.md "Before finishing a task" sequence (codespell included); `bun run lint:fix && bun run typecheck` is the quick local pass.

`bun run build` emits `dist/niivue.js` (both backends), `dist/niivue.webgpu.js` and `dist/niivue.webgl2.js` (`@niivue/niivue`, `/webgpu`, `/webgl2`), then `build:standalone` writes a self-contained copy to `dist/standalone/` that `scripts/check-standalone.ts` keeps free of bare imports and `import.meta.url` assets.

## Architecture (MVC)

```
NiiVue (controller) - src/NVControl.ts
├── control/           - src/control/ (event handling, view lifecycle)
├── NVModel (data)     - src/NVModel.ts
└── NVViewGPU (WebGPU) - src/wgpu/NVViewGPU.ts
    or NVViewGL (WebGL2) - src/gl/NVViewGL.ts
```

**Data flow:** User interactions → NiiVue → model updates + `drawScene()` → `requestAnimationFrame` → view.render()

**Pixel readback:** `getCanvasImage()` and `saveBitmap()` run one controller frame (`_renderNow()`: drawing flush, sync, view hooks, render) and copy the rect the view drew (bounds under the canvas viewport) in the same task. A later `drawImage` of the canvas reads blank on WebGPU and on full-canvas WebGL2 (no `preserveDrawingBuffer`).

**Model-View separation:** Model is GPU-agnostic (only data). Views receive model read-only. Controller owns mutations. GPU resources are view-owned. This enables backend switching without data loss.

### Backend feature parity (hard rule)

Every controller-level feature must work identically on both `wgpu/NVViewGPU.ts` and `gl/NVViewGL.ts`. New features land on both backends in the same change — landing one side first is not acceptable. When porting an existing GL feature to WebGPU (or vice versa) the implementations should mirror each other in structure so that future cross-backend changes stay easy to diff.

- Do not add WebGL2-only or WebGPU-only `opts.*`, methods, or `setX()` calls.
- Do not gate a feature behind `opts.backend === '...'` with a warn-and-noop. If a backend genuinely cannot support a feature (rare), document it in `FEATURE_PARITY.md` with the reason.
- When the controller threads a new piece of per-tile state, both view tile loops must consume it (see `tile.space === 'global3d'` for the reference shape: per-volume texture cache + per-tile MVP + skip layers that don't apply).
- Demos that exercise a feature should be backend-agnostic — typically a `?backend=webgl2|webgpu` URL switch — so manual verification is symmetric.

Where each part lives, the backend init fallback and the key source files: `notes/agents/architecture.md`.

## Entry points and public exports

The package ships three hand-maintained entry points:

| Subpath | File | Distribution |
|---------|------|--------------|
| `@niivue/niivue` | `src/index.ts` | universal (carries both backends) |
| `@niivue/niivue/webgl2` | `src/index.webgl2.ts` | WebGL2 only |
| `@niivue/niivue/webgpu` | `src/index.webgpu.ts` | WebGPU only |

(The other `package.json` subpaths, `./viewport`, `./scene`, `./assets/fonts`
and `./assets/matcaps`, point straight at a module and have no hand-written
index. `./scene` imports NiiVue from `@/index`, which `vite.config.lib.ts`
externalizes to `./niivue.js`; `src/entryPoints.test.ts` checks nothing else
imports `@/index` and no entry imports `src/scene`.)

The library build prepends `/// <reference types="@webgpu/types" preserve="true" />` to the
`types` file of every `package.json` export (`vite.config.lib.ts`), so a new
export needs no reference of its own; do not write one in source, as dts drops it.

**A new public export goes in all three files.** Adding it to `src/index.ts`
alone is the standing mistake, and nothing in the toolchain catches it: the
typecheck passes, the build passes, `dist/index.d.ts` has the symbol, and the
docs describe it. It surfaces only downstream, when someone writes
`import { Thing } from '@niivue/niivue/webgl2'` against a package that plainly
documents `Thing` and gets a build error. Reviewers should read a diff that
touches `src/index.ts` and no other entry point as a defect until shown otherwise.

How to check it, the sanctioned differences between the three entries, rebasing an export and removing one: `notes/agents/entry-points.md`.

## API conventions

Booleans take an `is`/`has` prefix after any domain prefix (`isColorbarVisible`, `volumeIsAlphaClipDark`); names are camelCase (`calMin`, not `cal_min`). The controller exposes flat property setters for single-value config (`nv.azimuth = 110`), each scheduling one redraw per synchronous block; methods are for async work, actions, multi-target updates and IO; per-item options are the same object for load and update (`loadVolumes([{ url, calMin }])`, `setVolume(0, { calMin })`). Every event fires after its mutation. Full rules, the 8 config groups and the event list: `notes/agents/api-conventions.md`, `notes/api.md` and `docs/reference/events.md`.

## Code style

The root `AGENTS.md` has the Biome rules. In this package:

- Log through `import { log } from '@/logger'` (`log.debug` … `log.fatal`), never `console.*`. `NiiVueOptions.logLevel` takes the same `LogLevel`; at `debug`, views draw a WebGPU/WebGL2 backend badge.
- Cross-directory imports use the `@/` alias (`import type { NVImage } from '@/NVTypes'`); same-directory imports are relative.
- Cross-directory modules are PascalCase with an `NV` prefix (`NVModel.ts`); folder-local ones are lowercase (`mesh.ts`). `NVTypes.ts`, a pure type module, is the exception.
- `@webgpu/types` is a peer dependency (and a dev one here), so published declarations dedupe with the consumer's copy.
- Example pages live in `examples/`, import `../src/index.ts`, and keep their script in `examples/<page>.js`; the conventions and static checks are in `notes/agents/testing.md` ("Demo static checks").

## Critical rendering invariants

### Blending modes (invariant)

Volume ray-march shaders use **premultiplied alpha**. Framebuffer blend must match:
- **WebGPU** (`wgpu/render.ts`): `srcFactor: "one", dstFactor: "one-minus-src-alpha"`
- **WebGL2** (`gl/render.ts`): `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)` for volume draw, then restore `gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)`

If WebGL2 uses `SRC_ALPHA` instead of `ONE`, alpha is multiplied twice — recurring regression.

### Clip plane color

`scene.clipPlaneColor` alpha sign determines behavior in `render.wgsl`/`renderShader.ts`:
- **alpha >= 0**: Solid colored surface behind transparent regions
- **alpha < 0**: Tints accumulated color using `abs(alpha)` as mix factor

Both fast-pass and fine-pass must use `if (isClip)` — **not** `if (!cutaway && isClip)`.

## Topic notes

Read the matching file in `notes/agents/` before changing that area:

- `build.md`: every build and dev script, both dev servers, packaging and the standalone build
- `testing.md`: unit tests, e2e specs, reference images, coverage, demo static checks
- `architecture.md`: MVC parts, backend init fallback, key source files
- `entry-points.md`: the three entry points and how to keep them in step
- `api-conventions.md`: naming, config groups, setters vs methods, events, per-item options
- `coordinates-and-interaction.md`: coordinate spaces, picking, pan/zoom, crosshair, drag modes, slice layout
- `formats-and-volumes.md`: readers and writers, partial 4D loading, RGB vectors, modulation, overlay blending
- `meshes.md`: mesh species, mesh layers, mesh shaders (crosscut, crosscut2), mesh slab
- `gpu-updates.md`: scoped GPU rebuilds, `updateMeshPositions`, `updateVolumeData`, `isDirty`, frame sources
- `signals.md`: the signal data class, physio and spectroscopy, MRSI
- `colormaps-and-drawing.md`: colormap windows, label tables, legends, hidden labels, voxel drawing
- `rendering.md`: the volume ray-march and render variants
- `cinematic.md`: cinematic (path-traced) rendering
- `extensions-and-workers.md`: the extension context API and Web Workers

## Dependencies

- `nifti-reader-js`: NIfTI parsing
- `gl-matrix`: Vector/matrix math
- `cbor-x`: CBOR encoding for NVD documents and ITK-Wasm (`.iwi.cbor`, `.iwm.cbor`). A reader of untrusted CBOR calls `assertCborFitsInput` (`documentBounds.ts`) before `decode`: it rejects heads that declare more items than the input holds ("Invalid CBOR: ..."). Decoded fields are untrusted too: the IWM reader rejects non-array `points`/`cells`, since a map with a huge `length` would size a typed array
- `earcut`: Polygon triangulation (annotations)
- `clipper2-ts`: Polygon clipping (annotations)
