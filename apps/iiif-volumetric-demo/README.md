# iiif-volumetric-demo

Browser demo for the IIIF Volumetric Server, built on `@niivue/niivue`.

## Pages

- `index.html` — 3-pane IIIF Image API slices (axial / coronal / sagittal)
  plus a niivue 3D render driven by the Presentation 4.0 alpha manifest.
- `sheet.html` — 3×3 sheet of independent niivue instances on one
  zoomable canvas. Each cell loads a different IIIF volume from the
  server plus the same `.mz3` mesh (colored differently per cell).
  Drag to pan, wheel to zoom, +/−/fit buttons to step.
- `stitch.html` — standalone WebGL2 diagnostic for texture-stitching
  boundary artifacts. A single test pattern is split into NxN GPU
  textures rendered as adjacent quads under a global shear matrix.
  Toggle filter / wrap / overlap padding / pattern / tile count and
  compare against the single-texture reference. No niivue, no IIIF
  dependency.

Additional POC pages from the standalone repo (`osd-volume-desktop.html`,
`volume-fly-space.html`) are deferred — they depend on niivuegpu APIs
(`setInstances`, `setViewport`, `NVCanvasViewportController`,
`setGlobalCamera`) that are not yet ported into `@niivue/niivue`.

## Running

The demo is a thin client; it needs the IIIF Volumetric Server running
on `http://127.0.0.1:8080` (default) with at least one volume fixture.
Run every command from the **repo root** unless noted.

### 1. Install dependencies (first time only)

```sh
bun install
```

### 2. Build `@niivue/niivue` (first time, and after any niivue change)

The demo imports `@niivue/niivue/webgl2`, which resolves to a built
file in `packages/niivue/dist/`. Vite does **not** build workspace
deps on the fly, so this must be done explicitly:

```sh
bunx nx build niivue
```

> The built file is named `niivuegpu.webgl2.js` (the filename was
> kept from the upstream `niivuegpu` port). If Vite logs a missing
> module error mentioning `niivuegpu.*.js`, this build step was
> skipped — it is not the legacy niivuegpu package.

### 3. Download fixture volumes (first time, or to add more)

This pulls a small set of T1w NIfTI files from OpenNeuro into
`apps/iiif-volumetric-server/fixtures/`. The default is 20 subjects from
dataset `ds000228`; already-present files are skipped.

```sh
bunx nx run iiif-volumetric-server:fetch-fixtures
```

To customise the dataset or count:

```sh
cd apps/iiif-volumetric-server
bun scripts/fetch-fixtures.ts --dataset=ds002336 --max=10
```

### 4. Start the IIIF server (terminal 1)

```sh
bunx nx dev iiif-volumetric-server
```

Listens on `http://127.0.0.1:8080`. Override with `PORT` / `HOST` /
`PUBLIC_BASE_URL` env vars. If the fixtures directory is empty the
server logs a warning and serves no volumes. The server will also
log `niivuegpu dist not found` — that warning belongs to the legacy
`/vendor/niivuegpu/*` route used by the deferred pages and is safe
to ignore when running `index.html`.

### 5. Start the demo (terminal 2)

```sh
bunx nx dev iiif-volumetric-demo
```

Vite serves on `http://127.0.0.1:8087` and opens `index.html`. It
proxies `/api`, `/iiif`, `/volumes`, `/vendor`, and `/dev` to the IIIF
server. Point the proxy elsewhere with `IIIF_SERVER_URL`:

```sh
IIIF_SERVER_URL=http://127.0.0.1:9090 bunx nx dev iiif-volumetric-demo
```

The header on every page exposes the shared cross-page nav (`volumes`,
`sheet`, `stitch`, plus dimmed `osd-volume` and `volume-fly` links to
the deferred POCs). `sheet.html` needs the IIIF server running with at
least one fixture volume — it cycles the available volumes through 9
cells. **The two deferred POC pages** (see top of this README) will
fail with missing-symbol errors from the old `niivuegpu` API; use the
home link in their topbar to navigate back.

### 6. Stop

`Ctrl-C` in each terminal. Fixtures persist; re-running step 3 is only
needed to add or refresh data.

## Troubleshooting

- **Vite error: failed to resolve `@niivue/niivue/webgl2` / missing
  `niivuegpu.webgl2.js`** — step 2 was skipped. Run
  `bunx nx build niivue`.
- **Blank viewer / 404s on `/iiif/...`** — the server isn't running, or
  is on a different port than `IIIF_SERVER_URL` expects.
- **Server starts but no volumes listed** — fixtures dir is empty; run
  step 3.
- **Header links open a broken page** — `osd-volume-desktop.html` and
  `volume-fly-space.html` are deferred (the nav dims them). Use the
  home link in their topbar to return.
- **Port 8087 or 8080 already in use** — stop the other process, or
  override `PORT` (server) / pass `--port` to Vite (demo).
