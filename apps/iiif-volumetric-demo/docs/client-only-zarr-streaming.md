# Client-Only Zarr Chunk Streaming Demo

`range.html` is a proof-of-concept for loading chunked volume data directly
from the browser. It uses NiiVue's `chunkSource` hook as the bridge between
visible viewer chunks and backing storage fetches.

The page has two sources:

- `range shard`: a synthetic `uint8` volume packed into one chunk-major binary
  file and loaded with HTTP `Range` requests.
- `pawpawsaurus zarr`: the local Pawpawsaurus OME-Zarr fixture loaded directly
  from browser fetches with `zarrita`.

The useful URLs are:

```text
http://127.0.0.1:8087/range.html?source=synthetic
http://127.0.0.1:8087/range.html?source=omezarr&level=3
http://127.0.0.1:8087/range.html?source=omezarr&level=0
```

## Files

- `range.html`: the demo UI and HUD.
- `src/range.ts`: client chunk orchestration, fetch accounting, OME-Zarr
  metadata parsing, and `chunkSource` implementations.
- `scripts/generate-range-poc-fixture.ts`: generates the synthetic single-file
  shard fixture.
- `public/range-poc/synthetic-volume.{json,bin}`: generated fixture assets.
- `apps/iiif-volumetric-server/src/server.ts`: exposes OME-Zarr fixtures at
  `/zarr`.
- `vite.config.ts`: proxies `/zarr` to the IIIF volumetric server during local
  development.

## Server Role

The OME-Zarr path is still client-driven. The local server only exposes the
fixture directory as static files:

```text
/zarr/pawpawsaurus.ome.zarr/...
```

That route maps to:

```text
apps/iiif-volumetric-server/fixtures/omezarr/pawpawsaurus.ome.zarr
```

The server does not assemble subvolumes for this demo. The browser reads Zarr
metadata, fetches chunk objects, decodes them, and hands the resulting bytes to
NiiVue.

## Data Flow

On page load, `src/range.ts` creates a logical NiiVue volume with `img: null`
and a `chunkSource`.

For each visible NiiVue chunk:

1. NiiVue calls `chunkSource` with a chunk index, `texOrigin`, `texDims`, and
   `bytesPerVoxel`.
2. The source fetches the matching backing bytes.
3. The source returns a `Uint8Array` whose length exactly matches
   `texDims[0] * texDims[1] * texDims[2] * bytesPerVoxel`.
4. NiiVue uploads that chunk, tracks residency, and draws only the resident
   chunks needed by the current view.

The HUD shows requested chunks, completed chunks, wire bytes, decoded bytes,
cache use, failures, and the most recent backing requests.

## Synthetic Range Source

The synthetic fixture is deliberately simple. Its manifest declares:

- volume shape
- chunk grid
- chunk shape
- bytes per chunk
- path to the single binary shard

Every NiiVue chunk maps to a byte interval:

```text
start = chunkIndex * chunkBytes
end = start + chunkBytes - 1
```

The browser then fetches:

```http
Range: bytes=start-end
```

The HUD reports `206 range` when the server returns partial content. This is
the smallest demonstration of a Neuroglancer-like client-only range request
path.

## OME-Zarr Source

The Pawpawsaurus source uses `zarrita` in the browser:

```text
FetchStore("/zarr/pawpawsaurus.ome.zarr")
```

The root `zarr.json` provides OME-NGFF multiscale metadata. The selected level
opens an array such as:

```text
scale3/pawpawsaurus
scale0/pawpawsaurus
```

OME-Zarr stores this fixture in `Z, Y, X` order. NiiVue's logical volume shape
is `X, Y, Z`, so the demo reverses spatial metadata:

```text
zarr shape  [Z, Y, X] -> viewer shape  [X, Y, Z]
zarr chunks [Z, Y, X] -> viewer chunks [X, Y, Z]
zarr scale  [Z, Y, X] -> spacing       [X, Y, Z]
```

When NiiVue asks for a viewer chunk at `[x0, y0, z0]` with dimensions
`[sx, sy, sz]`, the demo asks `zarrita` for:

```text
[slice(z0, z0 + sz), slice(y0, y0 + sy), slice(x0, x0 + sx)]
```

No transpose is needed for the returned bytes. Zarr C-order stores X as the
fastest varying spatial dimension, which matches the byte layout NiiVue expects
once the axes are relabeled from `Z, Y, X` to `X, Y, Z`.

## Viewer Chunks Versus Zarr Chunks

For small/coarse levels, the demo uses the native Zarr chunk grid as the viewer
chunk grid. Pawpawsaurus L3 is:

```text
viewer chunks: 2 x 2 x 4 @ 60 x 81 x 34
zarr chunks:   2 x 2 x 4 @ 60 x 81 x 34
```

Pawpawsaurus L0 is too large to use the native Zarr grid directly:

```text
zarr chunks: 8 x 8 x 8 = 512 chunks
```

NiiVue currently caps one chunked volume plan at 256 chunks. To load L0, the
demo follows the same idea as `omezarr.html`: it decouples the viewer brick
grid from the storage chunk grid. L0 uses larger viewer bricks:

```text
viewer chunks: 4 x 3 x 5 = 60 chunks
zarr chunks:   8 x 8 x 8 = 512 chunks
```

Each viewer brick is filled by `zarrita`, which fetches and decodes whatever
native Zarr chunks intersect that brick.

## Byte Cache

Large viewer bricks can overlap the same native Zarr chunk, especially where
halo voxels are present. The demo wraps the `FetchStore` with
`zarrita.withByteCaching` and a bounded LRU cache:

```text
cache budget: 512 MB
```

The cache reduces repeated HTTP object reads while keeping the POC bounded.
The HUD shows cache hits and current cache bytes.

## Windowing

The Pawpawsaurus source uses the same display window as the existing
`omezarr.html` demo:

```text
30269,56893
```

This is the punchy window that `omezarr.html` derives after its first coarse
paint, rather than the wider OMERO metadata window.

## HTTP Behavior

The two source modes exercise different HTTP access patterns:

- Synthetic source: one binary shard, byte intervals, `206 Partial Content`.
- Pawpawsaurus OME-Zarr: object-per-chunk files, ordinary `200 OK` chunk object
  reads.

The OME-Zarr mode is still useful for proving client-only chunk streaming. It
does not use Range for Pawpawsaurus because this fixture is not stored as a
sharded Zarr array. If the backing store used Zarr sharding, kerchunk
references, or another shard index, the same browser-side store path could use
`getRange` and HTTP `Range` requests for inner chunks.

## Current Limits

- Only `uint8` and `uint16` are enabled in this POC.
- The Pawpawsaurus path is hard-coded to `pawpawsaurus.ome.zarr`.
- L0 works, but full-resolution multiplanar views are heavy. The browser may
  fetch many native Zarr chunks because each plane spans a large volume extent.
- This demo does not yet implement a WSI-style moving viewport/window. That is
  the likely next step for making full-resolution L0 interaction cheaper.
- The OME-Zarr source currently relies on local static serving through `/zarr`.
  A production deployment would need CORS, auth, and cache headers appropriate
  for the backing object store.

## Verification

Useful checks while developing this page:

```sh
bunx nx run iiif-volumetric-demo:format
bunx nx run iiif-volumetric-demo:lint
bunx nx run iiif-volumetric-demo:typecheck
bunx nx run iiif-volumetric-demo:build
bun run check-boundaries
```

Runtime smoke checks:

- `source=synthetic` should show `206 range` in the HUD.
- `source=omezarr&level=3` should show Pawpawsaurus with `2 x 2 x 4` viewer
  chunks and zero failures.
- `source=omezarr&level=0` should show Pawpawsaurus with `4 x 3 x 5` viewer
  chunks, `8 x 8 x 8` Zarr chunks, and zero failures.
