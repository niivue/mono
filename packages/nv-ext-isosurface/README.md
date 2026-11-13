# @niivue/nv-ext-isosurface

One isosurface `NVMesh` per channel of a [NiiVue](https://github.com/niivue) chunked (streamed) volume.

Documentation: https://niivue.github.io/mono/docs/packages/nv-ext-isosurface/

## Installation

```bash
bun add @niivue/nv-ext-isosurface
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import { channelIsosurfaces } from '@niivue/nv-ext-isosurface'

const ac = new AbortController()
const [nuclei, cells] = await channelIsosurfaces(
  [
    { source: dapi, threshold: 800, color: [0, 0, 1, 1], name: 'DAPI' },
    { source: labels, labels: [1, 2, 7], level: 2, name: 'cells' },
  ],
  { signal: ac.signal, onProgress: (done, total) => console.log(done, total) },
)
nv.addMesh(nuclei)
nv.addMesh(cells)
```

## API

`channelIsosurfaces(channels, options?): Promise<NVMesh[]>`, one mesh per channel, in order.

Channel (`IsosurfaceChannel`):

- `source`: `ChunkedVolumeSource`.
- `level`: pyramid level index. Default: finest level with voxel count <= `maxVoxels`.
- `threshold`: surface where the stored value >= threshold.
- `labels`: one surface per ID (`value === id`), merged into the channel's mesh. Set exactly one of `threshold`/`labels`.
- `frame`: time point, passed to `fetchChunk`.
- `color` (RGBA 0..1, default white), `name` (default `channel <i>`).

The mesh name ends with ` (level <L>)`, the level used.

Options (`IsosurfaceOptions`): `maxVoxels` (default 256^3), `maxVertices` per mesh (positive integer, default 4e6), `brickEdge` (integer >= 2, default 64), `signal`, `onProgress(done, total)` in bricks over all channels.

## Units

- Vertices are in the streamed volume's world space (`createStreamingNVImage`: affine `diag(level 0 spacing)`, voxel `i` centred at `i * spacing`), so each mesh overlays its rendered volume exactly, streamed or a whole level from `loadOmeZarrVolumes` (same placement).
- That space is in the source's own units, never converted: mm for mm sources, micrometres for a micron `xyztUnits` source. NiiVue renders the volume the same way and uses the unit only for labels and the ruler. For mm from a micron source, scale positions by 1e-3 (the mesh then no longer overlays the volume).
- A coarser level covers the same box: its voxel size is level 0 extent / level shape per axis.
- `threshold` is in stored (raw) units: `ChunkedVolumeSource` carries no `scl_slope`/`scl_inter`. Calibrate as `(value - inter) / slope` first.

## Bounds

- Rejected before any fetch: a level over `maxVoxels` (or none within it), a bad `maxVertices`, `brickEdge` or `color` (`RangeError`); an unknown datatype, or not exactly one of `threshold`/`labels` (`TypeError`).
- The level is fetched in bricks of `brickEdge^3` cells plus a 1-voxel overlap; each brick's bytes are dropped after meshing.
- Output grows in doubling typed buffers; passing `maxVertices` rejects with `RangeError` as soon as it happens.
- Bricks weld through saved brick faces: each brick restores a 1-cell halo of vertex indices from its lower x, y and z neighbours. Welding memory per channel: `labels * (nbx * nby + nbx + 1) * (brickEdge + 1)^2` Int32 (`nb` = bricks per axis), plus one `(brickEdge + 1)^3` field and index brick. The result is identical to a single-brick run, closed, with no seams.

## Cancellation

`signal` is passed to `fetchChunk` and checked before and after each brick fetch. CPU work yields to the host (a `MessageChannel` macrotask) once about 8 ms have passed since the last yield, then checks `signal` again. An abort rejects with the signal's reason (`AbortError` by default) and no further bricks are fetched.

## Algorithm and limits

- Naive surface nets: one vertex per cell at the mean of its edge crossings (linearly interpolated for thresholds, midpoints for label masks), one quad per crossing edge.
- Surfaces are closed at the volume edge, capped at the outermost voxel centres.
- NaN and +-Infinity voxels (float data) count as outside.
- Surface nets can join surfaces that touch only at a voxel corner or edge (non-manifold there); fine for smooth objects.
- Datatypes: NIfTI u8, i8, u16, i16, u32, i32, f32, f64 (no RGB).
- Runs on the calling thread, yielding about every 8 ms; use a coarser level or a worker for large levels.

## Development

```bash
bunx nx build nv-ext-isosurface     # Build
bunx nx typecheck nv-ext-isosurface # Type-check
bunx nx test nv-ext-isosurface      # Test
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
