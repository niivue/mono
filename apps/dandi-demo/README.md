# dandi-demo

Two views of ONE [DANDI Archive](https://dandiarchive.org) OME-Zarr store,
streamed straight from S3: a multi-LOD volume render on the left and an NVSlide
deep zoom of a single plane on the right.

```bash
bunx nx dev dandi-demo     # http://localhost:8090
bunx nx build dandi-demo
```

Options:

- `?backend=webgl2` runs both panes on WebGL2 (WebGPU is the default). The
  backend is resolved (WebGPU adapter probe) before the streaming budget is
  chosen, so a fallback to WebGL2 gets WebGL2's budget; the HUD names the
  running backend.
- `?aa=on|off` sets anti-aliasing for both panes (default on, but off in
  Safari and other WebKit browsers, whose WebGPU misrenders with it).
- On a HiDPI display a Retina toggle draws the slide pane at native device
  pixels (off: one canvas pixel per CSS pixel).
- On the dev server the menu also offers two synthetic stores
  (`?dataset=synthetic` and `synthetic-oct`) generated per chunk by the dev
  server (`@niivue/dev-images`, `src/syntheticZarr.ts`): the geometry
  of the two OCT stores (301^3 and 1716 x 1470 x 561 float32, 64^3 chunks) with
  gyroid octaves that add detail at each finer level. The 4.5 GB one is the
  dev default; no network and no bytes in the repository. The published demo
  omits them and opens on the OCT.
- The `Slide` menu beside Backend switches the deep-zoom tiles between linear
  and nearest sampling (`isNearestInterpolation` on the slide renderers).
- `HUD: on|off` (or the `I` key) hides the overlay panels; the choice is kept
  per page in `localStorage`.
- `?dataset=<key>` opens that Dandiset: `oct-small` (default, the 106 MB human
  brain OCT), `oct`, `neun`, `hipct` or `spim`.
- `?local` reads `public/zarr/<zarrId>` instead of S3 (gitignored). Fetch
  `oct-small` with:

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
  through core's `NVSlideController` (`crosshairPan`, `crosshair`, `pan`,
  `windowing`, `contrast`, `measurement`, zoom box (`roiSelection`), `none`;
  the middle button pans and the wheel zooms). Slide
  windowing updates the window text live and both panes on release; a contrast box
  sets the window from `VolumeSliceSource.intensityRange`. Rulers are held in
  slide base pixels, so they stay on the tissue through pan and zoom;
  `slideOverlayContent` draws them and the contrast box in NiiVue's style.
- **Streaming strategy.** `Plan` picks the budget plan (`focus` refines
  around the crosshair, `uniform` holds the finest level that fits the whole
  volume, `interactive` uses fewer bricks) and `Swap` what a re-plan does with
  the bricks it replaces (`keep until covered`, the default, draws them until
  their replacements arrive, 3D render only; `replace` frees them). The HUD's
  `retiring` row shows what the first costs in memory.
- **Linked views.** With `link views` on, the slide pane's field of view is
  outlined on the volume (`nv.planeOutlines`, 2D and 3D). A click on the 3D
  render (`locationChange` `axCorSag` is `SLICE_TYPE.RENDER`) keeps the slide's
  plane and moves the crosshair onto it; the plane slider moves the volume
  crosshair too.

## Why this is an app, not a niivue example

It composes `@niivue/niivue` with `@niivue/uikit`, and uikit depends on niivue.
Living in `packages/niivue/examples` would make that a project-graph cycle;
apps may depend on any lib, so this is the correct home.
