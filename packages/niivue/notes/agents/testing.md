# Testing

Moved from `packages/niivue/AGENTS.md`; read it when working on unit tests, e2e specs, reference images, coverage or the demo static checks. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Testing

Unit tests for non-rendering (server-side) logic run on the **Bun test runner**. Tests are co-located with source files as `*.test.ts`.

```bash
bun test                 # Run all tests with coverage
bun test src/drawing/    # Run tests in a specific directory
bun test --watch         # Watch mode
bunx nx test niivue      # From monorepo root, via Nx
```

Coverage is enabled by default via `bunfig.toml` (reporters: `text` + `lcov`, output at `coverage/`, gitignored). Test infrastructure (`scripts/bunTestPreload.ts`, `src/testing/**`) is excluded with `coveragePathIgnorePatterns`. Bun reports only line and function coverage, and only for files some test loads. Its text table's `All files` row is a mean of per-file percentages, not the aggregate.

```bash
bun test && bun run coverage:check   # aggregate totals, files no test loaded, floor check
```

`coverage:check` runs `.github/scripts/lcov-to-summary.ts` on `coverage/lcov.info`. It prints the exact aggregate for loaded files and an estimated total that counts every `src/**/*.ts` file no test loaded as 0%, with the list of those files. It exits 1 when loaded-file coverage drops below its `--min-lines` / `--min-functions` floors. CI runs it after the tests (the "Coverage summary (niivue)" step in `pr_gate.yml`), so a coverage drop fails the PR gate. When coverage rises, raise the floors in the `coverage:check` script in `package.json` to about one point below the new numbers. Do not use Bun's `coverageThreshold` for this: Bun checks it against each file separately, so any file below it fails the run.

### End-to-end tests (Playwright)

Browser-based e2e tests live in `e2e/*.spec.ts` and run in real headless Chromium
against the Vite dev server. Keep them for what needs a browser: rendering (pixels
from a real GPU context), real Workers, DOM image decoding and pointer input.

Everything else runs under Bun with a real controller and no canvas: the preload
(`scripts/bunTestPreload.ts`) maps the Vite `?raw` / `?worker` imports and stands
in for `requestAnimationFrame`, and `src/testing/headless.ts` gives `file://` URLs
into dev-images. Document round-trips, loading, state and events belong there
(see `src/loadDocument.*.test.ts`), not in `e2e/`. Bun's `fetch` of a missing
`file://` URL resolves `ok` and fails only on read, so a test that needs a real
404 (a probe, a failed load) or a served fixture uses `serveDevImages()`, an
HTTP server on a free port that also records the paths requested. Timing-driven
tests (`src/control/animateTo.test.ts`) step frames with `jest.useFakeTimers()`,
which fakes the rAF stand-in and `performance.now`; `setImmediate` stays real,
so awaiting it lets each frame's promise work land.

```bash
bun run test:e2e         # every spec (config: playwright.config.ts)
bun run test:e2e:metal   # same, minus any Metal-only exclusions (none at present); CI and local-metal.ts run this
bunx nx e2e niivue       # via Nx
```

Demo pages are not loaded here; a change to the demos or to anything they
load runs the demo static checks below. A
local run on macOS uses full Chromium on the real GPU by default (needs
`bunx playwright install chromium`): the suite takes about 8 s on an M3
Max, against more than a minute on SwiftShader. CI and other platforms stay on
SwiftShader unless `PLAYWRIGHT_CHROMIUM_CHANNEL=chromium` is set; on a Mac,
`PLAYWRIGHT_CHROMIUM_CHANNEL=` (empty) forces SwiftShader. A
`launchOptions` or other worker-option `test.use()` gives its specs their own
workers, each a second browser launch and NiiVue load; GPU specs use
`test.use(webgpuUse)` (`e2e/launchOptions.ts`), which is empty in hardware mode.

`playwright.config.ts` starts a no-`--open` dev server (`bun run e2e:serve`) and
reuses an already-running one locally (`reuseExistingServer` off in CI). The
port (5273) is fixed, so a dev server from ANOTHER checkout on that port is
silently reused and the tests run its code; check `lsof -iTCP:5273` first. A
machine without Playwright's pinned browser can set `PLAYWRIGHT_CHROMIUM_PATH`
to any installed `chrome-headless-shell`. `PLAYWRIGHT_CHROMIUM_CHANNEL=chromium` runs full
Chromium on the real GPU instead of SwiftShader (the macos-15 CI job does). These are
kept OUT of the hermetic unit `test` target and `pr_gate.yml` (they need a browser);
`niivue-e2e.yml` runs them instead.
Write assertions in Node/`expect`; drive the instance inside `page.evaluate`
(`await import('/src/index.ts')`, force `backend: 'webgl2'`, attach an off-screen
canvas). Artifacts (`test-results/`, `playwright-report/`) are gitignored.

**Browser coverage** (opt-in, `e2e/coverage.ts`): which source the e2e suite
runs in the page, and a report merged with Bun's.

```bash
bun run test:e2e:coverage   # full suite with E2E_COVERAGE=1 -> coverage-e2e/lcov.info
bun test                    # unit coverage -> coverage/lcov.info
bun run coverage:merge      # -> coverage-merged/lcov.info + per-area summary (stdout)
```

Specs import `test` from `e2e/sharedPage.ts` (or `e2e/coverage.ts` for the
per-test `page`), which collects Chromium V8 coverage from the shared page,
the default `page` and pages a spec opens with `browser.newPage()`;
`monocart-coverage-reports` maps it to `src/**/*.ts` through Vite's source maps
(dev server or `E2E_BUNDLE=1` build). It adds to the suite's time, nothing when unset. Limits: page JavaScript
only. Web Worker code (`workers/*.worker.ts` and what only they run) is not
captured, nor is shader execution, nor a page opened with `context.newPage()`.
Bun counts every line of a multi-line statement and V8 only its first, so for
a file both suites load the merge compares the lines both count
(`.github/scripts/coverage-merge.ts`); the totals are not comparable with
`coverage:check`'s. Runs vary by under 0.1 pt; there is no threshold. CI's
macOS job (`niivue-e2e.yml`) collects it and posts the merged summary to the
job summary, so a PR whose Metal job local-metal skips gets no report.

**Reference images** (`e2e/render-*.spec.ts`, harness `e2e/renderHarness.ts`):
each scene draws tiny synthetic phantoms (the `Phantoms` built in the page by
the harness, no dev-images) on a fixed camera, by default a 160 px canvas,
under WebGL2 and WebGPU, and every capture must match
`e2e/__snapshots__/<spec>/<capture>-<backend>.png`. One set serves every
platform: the same PNG has to pass on Metal
(`PLAYWRIGHT_CHROMIUM_CHANNEL=chromium`) and SwiftShader (the default shell, as on
CI's Ubuntu job, which runs these specs too). The single tolerance is
`expect.toMatchSnapshot` in `playwright.config.ts`; do not loosen it for one
scene, make the scene deterministic instead (no antialiasing; text, thin lines
and cinematic only where they pass on both renderers; cinematic needs a fixed
`maxFrames`, which the harness waits for). Specs group scenes by feature
(`render-reference` the major render paths in `renderScenes.ts`, `render-mesh`,
`render-volume`, `render-colormaps`, `render-updates`, `render-cinematic`), so
they spread across workers.

A scene is `{ name, options?, size?, setup, sameAs?, steps? }`. `setup` and
each step's `run` are sent to the page as source, so they may use only their
`SceneContext` argument: `nv`, `lib` (enums, `chunkVolumeGrid`), `p`
(phantoms; add new ones in the harness), `view()` (the view internals a scene
may read, typed `SceneView`), `check(ok, message)` (fails the test), `settle()`
(waits until updates, chunk streams, brick fades and cinematic refinement have
drawn) and `canvas`. Nothing is awaited with a sleep. The harness captures a
settled frame with `nv.getCanvasImage()` after `setup` (`<scene>`) and after each step
(`<scene>--<step>`), so a **multi-step scene** shows behaviour: load, edit,
capture, edit again. `check` pins how a result was reached (a GPU entry kept,
a pass skipped, a warning logged), next to the change that should cause it.
`sameAs: '<scene>[--<step>]'` compares a capture with another capture's
reference in the same spec instead of its own: a restored setting, or a second
code path (chunked vs whole, deferred vs eager) that must draw the same
picture. State one step hands the next goes on `globalThis` (the shared page's
reset deletes it). Chunked scenes set brick size with `maxTextureDimension3D`:
the halo is 3 voxels, so stride = limit - 6; a limit below 7 fails the upload
(`updateVolume` logs a warning and nothing draws). Both backends stream bricks
under an 8 ms per-frame budget; WebGPU on SwiftShader fits about two bricks in
it (WebGL2 all 64 of a 16 limit), so brick count dominates scene time there.
Use the largest limit that still puts a seam on every axis (24 for the 32^3
phantom: 2x2x2 bricks).
To create or update references:

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chromium bunx playwright test e2e/render-volume.spec.ts --update-snapshots
bunx playwright test e2e/render-volume.spec.ts   # then confirm on SwiftShader
```

An update writes only the references that do not match, so when two captures
share one through `sameAs` and disagree, the second overwrites the first and
the next run fails: that is the equivalence failing, not a stale reference.
Look at every changed PNG before committing it: an update accepts whatever was drawn.

### Demo static checks

Fast, browser-free checks on `examples/`; `pr_gate.yml` runs all of them.

```bash
bun run typecheck           # also tsc -p examples/tsconfig.json: NiiVue API misuse in demo scripts
bun run check:demos         # literal /volumes/, /meshes/, /signals/ URLs missing from packages/dev-images;
                            # getElementById ids missing from the page that loads the script
bun run build:examples      # broken imports (empties dist/)
bunx nx lint niivue         # Biome; noUndeclaredVariables is on for examples/**/*.js
```

`examples/tsconfig.json` checks the JS with `strict` off. `examples/demo-dom.d.ts`
types DOM lookups as `any` and declares the debug handles pages put on
`window` (`nv1`, `__bench`, ...), so only NiiVue API misuse is reported.
`*.min.js` is listed explicitly: TS skips it in wildcards. Limits: misuse
through untyped helper params is not caught; asset URLs built at runtime
(`${...}`, bare file tables) are skipped; ids are checked only for literal
`getElementById` calls in a page's own `<script src>`; errors raised only at
runtime are not caught.

Demo conventions:

- Look up every element: `const x = document.getElementById('x')`. No implicit
  window named-access globals; tsc misses them once a file assigns
  `x.onclick = ...`, so Biome catches them.
- Page scripts live in `examples/<page>.js`, not inline `<script>`.
  `vox.worker.html` uses `vox.worker.page.js`, since `vox.worker.js` is the worker.

### What's tested

- **Drawing tools** (`src/drawing/`) — RLE codec, pen/line/flood-fill, undo stack
- **Annotations** (`src/annotation/`, `src/view/NVAnnotation.ts`) — undo/redo, point-in-polygon, slice projection, shape selection and control points, stats and screen shapes over split ROIs
- **GPU rebuild planning** (`src/view/volumeUpdateScope.ts`, `src/view/meshGpuSync.ts`) — which volumes and meshes a rebuild redoes
- **Math/transforms** (`src/math/`) — vox↔mm, spherical coordinates, slice plane equations, screen unprojection, mesh slab MVP
- **Volume utilities** (`src/volume/`) — intensity range, NIfTI header creation, voxel lookup, reorientation, modulation
- **Colormaps** (`src/cmap/`) — LUT generation, label colormap construction
- **Constants** (`src/NVConstants.ts`) — PAQD detection, slice type dimension mapping
- **Mesh I/O** (`src/mesh/`) — STL/OBJ writers, STL/OFF readers (roundtrip tests); vertex normals and their per-mesh cache
- **View utilities** (`src/view/`) — mm-to-canvas projection; legend columns, scrolling and hit tests

### What's NOT yet covered by unit tests

The following modules require a browser or GPU context and are not covered by the Bun unit test suite. Their output is covered by the Playwright e2e suite (`e2e/`, see above).

- `gl/`, `wgpu/` — GPU shader/rendering code
- `NVControl*.ts`, `NVLoader.ts` — DOM/canvas/fetch dependencies (the state paths of `NVControlBase.ts` are now partly reached through `src/testing/headless.ts`)
- `control/` — Mouse/keyboard interaction handlers
- `view/NVRenderer.ts`, `view/NVFont.ts` — Rendering pipeline
- `workers/` — Web Worker code (also outside browser coverage: see Browser coverage above)
- `codecs/NVGz.ts`, `codecs/NVZip.ts` — DecompressionStream (browser API)

### Writing new tests

- Co-locate tests next to source: `src/foo/bar.ts` → `src/foo/bar.test.ts`
- Import from `bun:test`: `import { describe, expect, test } from 'bun:test'`
- Use the `@/*` path alias for cross-directory imports (resolved via `bunfig.toml`)
- Follow AAA pattern (Arrange, Act, Assert) with one behavior per test
- Test the public contract, not private internals

Rendering changes are still verified manually via the interactive demos (`bun run dev` or `bun run demo`); add an `e2e/*.spec.ts` when the behavior can be asserted through the public API in a real instance (see End-to-end tests above).
