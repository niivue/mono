# dandi-demo

Two views of ONE [DANDI Archive](https://dandiarchive.org) OME-Zarr store,
streamed straight from S3: a multi-LOD volume render on the left and an NVSlide
deep zoom of a single plane on the right.

```bash
bunx nx dev dandi-demo     # http://localhost:8090
bunx nx build dandi-demo
```

URL options:

- `?backend=webgpu` runs both panes on WebGPU (`webgl2` is the default).
- `?dataset=<key>` opens that Dandiset (`oct`, `oct-small`, `neun`, `hipct`,
  `spim`).
- `?local` reads `public/zarr/<zarrId>` instead of S3 (gitignored). Fetch the
  106 MB `oct-small` store with:

  ```bash
  aws s3 sync --no-sign-request \
    s3://dandiarchive/zarr/2aedcf87-6903-4080-9ccc-c17f1f13bc82 \
    apps/dandi-demo/public/zarr/2aedcf87-6903-4080-9ccc-c17f1f13bc82
  ```

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
- **Gestures per pane.** `Volume left/right drag` set NiiVue's primary and
  secondary drag modes; `Slide left/right drag` set those of the deep-zoom pane
  through core's `NVSlideController` (`SLIDE_DRAG_MODES`: `crosshairPan`,
  `crosshair`, `pan`, `windowing`, `contrast`, `measurement`, `none`; the wheel
  zooms). Slide windowing updates the volume live and the slide on release; a
  contrast box sets the window from `VolumeSliceSource.intensityRange`. Rulers
  are held in slide base pixels, so they stay on the tissue through pan and
  zoom; `slideOverlayContent` draws them and the contrast box in NiiVue's style.
- **Linked views.** With `link views` on, the slide pane's field of view is
  outlined on the volume (`nv.planeOutlines`, 2D and 3D). A click on the 3D
  render (`locationChange` `axCorSag` is `SLICE_TYPE.RENDER`) keeps the slide's
  plane and moves the crosshair onto it; the plane slider moves the volume
  crosshair too.

## Why this is an app, not a niivue example

It composes `@niivue/niivue` with `@niivue/uikit`, and uikit depends on niivue.
Living in `packages/niivue/examples` would make that a project-graph cycle;
apps may depend on any lib, so this is the correct home.
