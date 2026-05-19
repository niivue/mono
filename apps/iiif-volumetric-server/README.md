# iiif-volumetric-server

Proof-of-concept IIIF server for NIfTI and other volumetric formats. Implements the IIIF Presentation 4.0 alpha (draft 3D) spec and IIIF Image API 3.0 for 2D slice tiles, plus volume bytestream endpoints (NIfTI/RAW/RLE) and an occupancy grid for sparse subvolume prefetch.

## Quick start

```bash
bun install
bun run apps/iiif-volumetric-server fetch-fixtures   # downloads OpenNeuro samples
bunx nx dev iiif-volumetric-server                   # starts the server on :3000
```

Open the demo viewer (separate app):

```bash
bunx nx dev iiif-volumetric-demo
```

## Layout

- `src/adapters/` — per-format readers (NIfTI, NRRD, OME-Zarr, DICOM).
- `src/iiif/` — IIIF Image API + Presentation API document builders.
- `src/routes/` — Express route modules.
- `src/util/` — encoders (PNG, RLE, NIfTI), occupancy/downsample helpers.
- `src/registry.ts` — volume discovery + cache.
- `src/server.ts` — Express app bootstrap.
- `scripts/fetch-fixtures.ts` — downloads OpenNeuro fixture data into `fixtures/`.

## Fixtures

Fixture NIfTI files are **not** committed. Run `bun scripts/fetch-fixtures.ts` to download a small sample from OpenNeuro public S3 datasets.
