# iiif-volumetric-demo

Browser demo for the IIIF Volumetric Server, built on `@niivue/niivue`.

## Pages

- `index.html` — 3-pane IIIF Image API slices (axial / coronal / sagittal)
  plus a niivue 3D render driven by the Presentation 4.0 alpha manifest.
- `sheet.html` — 3×3 sheet of independent niivue instances on one
  zoomable canvas. Each cell loads a different IIIF volume from the
  server plus the same `.mz3` mesh (colored differently per cell).
  Drag to pan, wheel to zoom, +/−/fit buttons to step.
- `osd-volume-desktop.html` — OpenSeadragon-style deep-zoom 2D desktop
  of NIfTI tile previews fed from an IIIF VolumeDesktop manifest, with
  an embedded niivue 3D pane that loads the selected volume at the
  matching LOD.
- `omezarr.html` — multiscale streaming viewer with level selection,
  subvolume streaming, exploded block layout, and a WebGL2 / WebGPU
  backend toggle. Lists both OME-Zarr **and DICOM-WSI** volumes (the WSI
  streams as chunked RGB via niivue's RGB chunked-upload support). The
  default volume is `pawpawsaurus.ome.zarr` when present, otherwise the
  first streaming fixture returned by `/api`; open a specific one with
  `?id=...` (e.g. `?id=cptac-brca_dicom`).
- `wsi.html` — DICOM whole-slide-imaging deep-zoom viewer. Renders a
  slide as a depth-1 RGB volume (2D axial = the slide face) with smooth,
  OpenSeadragon-style zoom/pan: scroll to zoom (cursor-anchored), drag to
  pan, a log-scaled zoom slider, a minimap with a viewport box and
  click-to-jump, and double-click-to-dive. An auto-LOD layer swaps the
  underlying pyramid window as you cross zoom levels (coarse levels load
  whole; finer levels load only the visible window via the server's bbox
  subvolume read), scale-matched so only the detail sharpens. Needs a
  `dicom-wsi` fixture — run
  `bunx nx run iiif-volumetric-server:fetch-dicom-wsi` and restart the
  server. See `packages/niivue/docs/dicom-wsi.md`.

### Backend switching

Every niivue page reads a `?backend=webgl2|webgpu` URL query and
passes it to the `NiiVue` constructor (default: `webgl2`). The shared
nav ribbon exposes a `WebGL2 / WebGPU` toggle that reloads the page
with the new query; the WebGPU option is disabled when
`navigator.gpu` is absent. The choice is preserved across in-app
navigation.

## Running

The demo is a thin client; it needs the IIIF Volumetric Server running
on `http://127.0.0.1:8080` (default) with at least one volume fixture.
Run every command from the **repo root** unless noted.

Short version for the NIfTI demos:

```sh
bun install
git lfs install
git lfs pull
bunx nx build niivue
bunx nx run iiif-volumetric-server:fetch-fixtures
bunx nx dev iiif-volumetric-server
```

Then, in another terminal:

```sh
bunx nx dev iiif-volumetric-demo
```

Open `http://127.0.0.1:8087/index.html`.

`git lfs pull` is needed for pages that use `@niivue/dev-images`
assets, especially `sheet.html` and its mesh selector. Without it,
those files may be Git LFS pointer text instead of loadable volume or
mesh binaries.

### 1. Install dependencies (first time only)

```sh
bun install
```

### 2. Build `@niivue/niivue` (first time, and after any niivue change)

The demo imports `@niivue/niivue` (combined entry — both backends),
which resolves to a built file in `packages/niivue/dist/`. Vite does
**not** build workspace deps on the fly, so this must be done
explicitly:

```sh
bunx nx build niivue
```

> The built files are named `niivuegpu.js`, `niivuegpu.webgpu.js`,
> and `niivuegpu.webgl2.js` (the `niivuegpu` filename was kept from
> the upstream port). If Vite logs a missing-module error mentioning
> `niivuegpu.*.js`, this build step was skipped — it is not the
> legacy niivuegpu package.

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

For the OME-Zarr page, fetch the default OME-Zarr fixture too:

```sh
bunx nx run iiif-volumetric-server:fetch-omezarr
```

The default OME-Zarr fetcher downloads only one coarse FIB-SEM pyramid
level so a fresh checkout stays quick. To fetch a larger level:

```sh
cd apps/iiif-volumetric-server
bun scripts/fetch-omezarr.ts --level=s3 --max-mb=4000
```

### 4. Start the IIIF server (terminal 1)

```sh
bunx nx dev iiif-volumetric-server
```

Listens on `http://127.0.0.1:8080`. Override with `PORT` / `HOST` /
`PUBLIC_BASE_URL` env vars. If the fixtures directory is empty the
server logs a warning and serves no volumes. The server will also
log `niivuegpu dist not found` — that warning belongs to a legacy
`/vendor/niivuegpu/*` route that no current page uses (the demos
now pull niivue from `@niivue/niivue` directly) and is safe to
ignore.

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

The header on every page exposes the shared cross-page nav
(`volumes`, `sheet`, `osd desktop`, `omezarr`, `wsi`)
plus the `WebGL2 / WebGPU` backend toggle. `sheet.html` and
`osd-volume-desktop.html` both need the IIIF server running with at
least one fixture volume — `sheet.html` cycles available volumes
through 9 cells; `osd-volume-desktop.html` reads the VolumeDesktop
manifest at `/iiif/desktop/neuro/manifest`. `omezarr.html` needs at
least one OME-Zarr fixture; open
`http://127.0.0.1:8087/omezarr.html?id=fibsem-uint8.zarr` after the
default OME-Zarr fetch.

> **Hidden pages** (source kept in the repo, but not in the nav or the
> production build — open directly during development):
>
> - `volume-fly-space.html` — WASD-fly through a constellation of NIfTI
>   volumes via niivue's `space: 'global3d'` instances. A retired
>   proof-of-concept for planning the subvolume streaming strategy.
> - `stitch.html` — standalone WebGL2 diagnostic for texture-stitching
>   boundary artifacts (NxN GPU textures as adjacent quads under a shear
>   matrix). Raw WebGL2, no niivue, no IIIF dependency.

### 6. Stop

`Ctrl-C` in each terminal. Fixtures persist; re-running step 3 is only
needed to add or refresh data.

## Troubleshooting

- **Vite error: failed to resolve `@niivue/niivue` / missing
  `niivuegpu.*.js`** — step 2 was skipped. Run `bunx nx build niivue`.
- **Blank viewer / 404s on `/iiif/...`** — the server isn't running, or
  is on a different port than `IIIF_SERVER_URL` expects.
- **Server starts but no volumes listed** — fixtures dir is empty; run
  step 3.
- **OME-Zarr page says no OME-Zarr volumes** — run
  `bunx nx run iiif-volumetric-server:fetch-omezarr`, restart the
  server, then reload `omezarr.html`.
- **WebGPU toggle disabled** — the browser doesn't expose
  `navigator.gpu`. Safari needs the feature flag enabled; older
  Firefox builds don't support it. WebGL2 is the default and works
  everywhere.
- **Port 8087 or 8080 already in use** — stop the other process, or
  override `PORT` (server) / pass `--port` to Vite (demo).
