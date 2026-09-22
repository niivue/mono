# dandi-demo

Two views of ONE [DANDI Archive](https://dandiarchive.org) OME-Zarr store,
streamed straight from S3: a multi-LOD volume render on the left and an NVSlide
deep zoom of a single plane on the right.

```bash
bunx nx dev dandi-demo     # http://localhost:8090
bunx nx build dandi-demo
```

Add `?backend=webgpu` to the URL to run both panes on WebGPU (`?backend=webgl2`
is the default).

## What it shows

- **One source, two consumers.** `fetchOmeZarrChunkedSource` opens the pyramid
  once; that single `ChunkedVolumeSource` feeds both `nv.loadChunkedVolume` and
  `NVSlide.fromSource(new VolumeSliceSource(source, ...))`, so the two panes
  share one zarrita byte cache. A brick the volume view pulled is free for the
  slide view, and the other way round.
- **Nothing is downloaded whole.** A 1.0 TB HiP-CT store opens as fast as a
  100 MB one. The HUDs report what that costs in practice: resident bricks,
  visible and pending tiles, decoded voxels, and cache hits. Deep-zooming the
  larger stores puts tiles visibly in flight.
- **Views.** The volumetric pane opens on the 3D render, which is where a
  streamed brick set is legible as a whole; the `View` dropdown switches it to
  multiplanar or to a single axial, coronal, or sagittal slice.
- **The UIKit ruler.** Tick `measure`, then click two points on the deep-zoom
  pane. Endpoints are held in slide base pixels, so a measurement stays pinned
  to the tissue through pan, zoom and a level swap.

## Why this is an app, not a niivue example

It composes `@niivue/niivue` with `@niivue/uikit`, and uikit depends on niivue.
Living in `packages/niivue/examples` would make that a project-graph cycle;
apps may depend on any lib, so this is the correct home.
