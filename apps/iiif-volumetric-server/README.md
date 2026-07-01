# iiif-volumetric-server

Proof-of-concept IIIF server for NIfTI and other volumetric formats. Implements the IIIF Presentation 4.0 alpha (draft 3D) spec and IIIF Image API 3.0 for 2D slice tiles, plus volume bytestream endpoints (NIfTI/RAW/RLE) and an occupancy grid for sparse subvolume prefetch.

## Quick start

Run these commands from the repo root.

For the NIfTI-backed demos:

```bash
bun install
git lfs install
git lfs pull
bunx nx build niivue
bunx nx run iiif-volumetric-server:fetch-fixtures
bunx nx dev iiif-volumetric-server
```

In a second terminal:

```bash
bunx nx dev iiif-volumetric-demo
```

Then open `http://127.0.0.1:8087/index.html`. The server listens on
`http://127.0.0.1:8080`; the demo app proxies `/api`, `/iiif`, and
`/volumes` to that server.

For the OME-Zarr demo, fetch an OME-Zarr fixture before starting or
restart the server after fetching so the registry sees the new files:

```bash
bunx nx run iiif-volumetric-server:fetch-omezarr
bunx nx dev iiif-volumetric-server
```

Then visit `http://127.0.0.1:8087/omezarr.html`. The page prefers
`pawpawsaurus.ome.zarr` when that fixture exists; the tracked
`fetch-omezarr` script downloads `fibsem-uint8.zarr`, so a fresh
checkout falls back to that volume. You can also open it directly with
`http://127.0.0.1:8087/omezarr.html?id=fibsem-uint8.zarr`.

## Demo pages

The browser UI lives in [`../iiif-volumetric-demo`](../iiif-volumetric-demo).
Use the shared nav in the header, or open pages directly:

- `http://127.0.0.1:8087/index.html` — 2D IIIF slices plus a 3D volume render.
- `http://127.0.0.1:8087/sheet.html` — 3x3 sheet of independent volumes.
- `http://127.0.0.1:8087/osd-volume-desktop.html` — deep-zoom 2D desktop with a selected 3D volume.
- `http://127.0.0.1:8087/volume-fly-space.html` — fly through many volumes in one global scene.
- `http://127.0.0.1:8087/omezarr.html` — OME-Zarr pyramid and subvolume streaming demo.
- `http://127.0.0.1:8087/stitch.html` — standalone WebGL2 texture-stitching diagnostic.

Add `?backend=webgpu` or `?backend=webgl2` on NiiVue pages to pick the
renderer. WebGL2 is the default.

## Layout

- `src/adapters/` — per-format readers (NIfTI, NRRD, OME-Zarr, DICOM).
- `src/iiif/` — IIIF Image API + Presentation API document builders.
- `src/routes/` — Express route modules.
- `src/util/` — encoders (PNG, RLE, NIfTI), occupancy/downsample helpers.
- `src/registry.ts` — volume discovery + cache.
- `src/server.ts` — Express app bootstrap.
- `scripts/fetch-fixtures.ts` — downloads OpenNeuro fixture data into `fixtures/`.

## Fixtures

Fixture volumes are **not** committed.

The demo app also serves shared meshes and the `chris_t1.nii.gz`
headline volume from `@niivue/dev-images`, which is Git LFS-backed.
Run `git lfs install && git lfs pull` once after cloning so those files
are real binaries instead of pointer files.

- `bunx nx run iiif-volumetric-server:fetch-fixtures` downloads a small
  OpenNeuro NIfTI sample set into `fixtures/`.
- `bunx nx run iiif-volumetric-server:fetch-omezarr` downloads the
  default FIB-SEM OME-Zarr sample into `fixtures/omezarr/`.

To customise the NIfTI dataset or OME-Zarr level, run the scripts from
`apps/iiif-volumetric-server`:

```bash
bun scripts/fetch-fixtures.ts --dataset=ds002336 --max=10
bun scripts/fetch-omezarr.ts --level=s3 --max-mb=4000
```

Restart the server after adding fixtures; the volume registry is built
when the server starts.
