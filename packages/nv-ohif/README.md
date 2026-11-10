# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (3.13 and 3.14-beta). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

> **Status: proven in a real OHIF app.** Renders **NIfTI (volume-URL) display sets**
> and **DICOM series** (fetched + converted to NIfTI with `@niivue/dcm2niix`), with a
> toolbar surfacing NiiVue's views / clip plane / overlay / window-level. Verified
> mounting inside a full local OHIF Viewer (registered via `pluginConfig.json` + a
> mode). OHIF production builds need the production JSX runtime, so `build:lib`
> sets `NODE_ENV=production`. The build goes to `lib/`, not `dist/`: OHIF's build
> copies every extension's `dist/` folder into the site root. See `PLAN.md`.

> **Consuming the local build (dev):** install **packed tarballs**, do not symlink.
> Symlinking the monorepo package into an OHIF app makes its bundler follow the link
> and bundle a duplicate of shared deps (breaks OHIF's floating-ui). Use
> `npm pack` + `pnpm add file:<dir>` so each resolves self-contained from the app tree.

## Try the proof demo

`bun run dev` starts a small OHIF-shaped harness (`demo/`) that drives the real
extension — it pulls the viewport via `getViewportModule()` and renders it with a mock
OHIF display set pointing at a public NIfTI, so you can see NiiVue rendering a volume
without a full OHIF app.

## Install

```bash
bun add @niivue/nv-ohif
# peers your OHIF app already provides: @ohif/core, @ohif/extension-default,
# react@^18.3.1, react-dom@^18.3.1, and @niivue/niivue
```

## Register the extension

Add it to your OHIF app's `pluginConfig.json` (or `addExtension`) and reference the
viewport from a mode. The extension id is `@niivue/nv-ohif`; the viewport name is
`niivue`. List it after the cornerstone extension (see **Jumping to a row** below).

```js
// in a mode's viewport config
{
  namespace: '@niivue/nv-ohif.viewportModule.niivue',
  displaySetsToDisplay: ['<your NIfTI/volume display-set handler>'],
}
```

## What it does today

- Registers a **React viewport** that owns a `<canvas>` + a NiiVue instance.
- Loads a display set whose URL is a NiiVue-readable volume (`.nii/.nii.gz`, `.nrrd`,
  `.mgz`, `.mha`, `.mif`, …) via `nv.loadVolumes(...)`, opening in multiplanar.
- Loads a **DICOM** series by fetching it and converting to NIfTI with
  `@niivue/dcm2niix` (see [DICOM support](#dicom-support)).
- Renders **whole-slide (SM)** series with **NVSlide** (tiled deep-zoom) on its own
  canvas: **JPEG, JPEG 2000 and JPEG-LS** slides, TILED_FULL or TILED_SPARSE (colour or
  monochrome), are supported; slides with several optical paths or focal planes are
  declined with an explanatory note (see [Whole-slide imaging](#whole-slide-imaging)).
- Mirrors the viewport's tool group's active primary tool (`viewportOptions.toolGroupId`,
  default `'default'`) onto NiiVue's left-drag. Windows are per viewport, as in OHIF;
  the initial window comes from the hanging protocol's `displaySetOptions[0].options.voi`
  when set, else NiiVue's robust 2-98% range.
- Ships **toolbar buttons + commands**: a views dropdown (axial / coronal /
  sagittal / multiplanar / 3D render), a **clip-plane** dropdown (off / anterior /
  posterior / left / right / superior / inferior), a **window/level** dropdown
  (auto robust window + OHIF's modality presets, applied as NiiVue calMin/calMax),
  a **colormap** dropdown (gray / hot / bone / cool / warm / viridis / plasma /
  inferno / turbo / jet, applied to the base volume), a **colorbar** toggle (the
  colormap legend), a **smoothing** toggle (nearest-neighbor vs linear
  interpolation), a **crosshair** toggle (`NiivueCrosshair`, show/hide the
  crosshair — use in place of cornerstone's Crosshairs button, which no-ops on a
  NiiVue viewport), a **capture** button (`NiivueCapture`, save the viewport as
  PNG — use in place of cornerstone's Capture, which errors on a NiiVue
  viewport), an **overlay** toggle (load the study's next series as a colormapped
  overlay), and a reset-view button — all with active/disabled state tracked per
  viewport.
- Backs OHIF's full **Measurement** tool group (Length, ellipse / rectangle /
  circle / freehand / spline / livewire ROIs, Bidirectional, ArrowAnnotate) with
  NiiVue annotations, reflected into the Measurements panel with stats and
  editable labels (see [Measurement tools](#measurement-tools)).

## Toolbar buttons

The extension registers the commands (`niivueSetSliceType`, `niivueResetView`,
`niivueSetClipPlane`, `niivueToggleOverlay`, `niivueSetWindowLevel`,
`niivueSetWindowLevelPreset`, `niivueAutoWindowLevel`, `niivueSetColormap`,
`niivueToggleColorbar`, `niivueToggleInterpolation`, `niivueToggleCrosshair`), the toolbar evaluators, and a customization pack with the
button definitions. `niivue*` commands act only when the active viewport is NiiVue.

A mode pulls them in by reference and places them in its primary bar:

```js
// in a mode
toolbarButtons: [
  { $reference: 'cornerstone.toolbarButtons' },
  { $reference: 'niivue.toolbarButtons' },
],
toolbarSections: [
  { $reference: 'cornerstone.toolbarSections' },
  { $reference: 'niivue.toolbarSections' },
  // restate your primary bar with the NiiVue buttons added (sections
  // shallow-merge per key, later wins). Use NiivueCapture / NiivueCrosshair
  // in place of cornerstone's 'Capture' / 'Crosshairs' on NiiVue viewports:
  // ToolbarService.register is first-registration-wins, so a same-id override
  // of a cornerstone button is silently dropped.
  { primary: [/* ...your button ids, */ 'NiivueViews', 'NiivueClip',
              'NiivueWindowLevel', 'NiivueColormap', 'NiivueColorbar', 'NiivueInterpolation',
              'NiivueRuler', 'NiivueOverlay', 'NiivueReset', 'NiivueCapture',
              'NiivueCrosshair'] },
],
```

It also answers OHIF's standard `resetViewport`, `setViewportOrientation`
(axial / sagittal / coronal / acquisition), `scaleUpViewport`, `scaleDownViewport`,
`fitViewportToWindow`, `setWindowLevelPreset`, `rotateViewportCW`, `rotateViewportCCW`,
`rotateViewportCWSet`, `flipViewportHorizontal`, `flipViewportVertical`,
`setViewportHorizontalFlip` and `setViewportVerticalFlip` on a NiiVue viewport
(`viewportId`, else the active one; rotate and flip apply to 2D tiles, and reset
clears them) and hands any other viewport to the `CORNERSTONE` context, so
standard hotkeys work in mixed layouts. This relies on the extension registering
after cornerstone (newer command contexts win). The `NIIVUE` context is registered
app-wide, so these names route through nv-ohif in every mode (delegating to
`CORNERSTONE` when the viewport is not NiiVue), and a third-party extension that
registers the same names in a context newer than `CORNERSTONE` is bypassed.

`withNiivueSupport(button)` adds the `evaluate.niivue.unsupported` evaluator to a
button: on a NiiVue viewport it disables buttons whose commands or tools are not in
`NIIVUE_STANDARD_COMMANDS` / `NIIVUE_SUPPORTED_TOOLS` (or `niivue*`), and OHIF hides
them when the button sets `hideWhenDisabled`; other viewports are left to the
button's own evaluators.

## Measurement tools

Every tool in OHIF's **Measurement** group is backed by NiiVue's vector
annotation system (one unified path, no separate ruler subsystem). Pick a tool in
the toolbar and it draws on the NiiVue viewport; a completed shape appears as a
row in OHIF's **Measurements** panel with its stats.

| OHIF tool | NiiVue annotation | Gesture | Reported |
|-----------|-------------------|---------|----------|
| Length (Ruler button) | `measureLine` | drag | length (mm), drawn as a graduated ruler |
| EllipticalROI | `measureEllipse` | drag | area (mm2) + min/mean/max/SD intensity |
| RectangleROI | `measureRect` | drag | area (mm2) + intensity |
| CircleROI | `measureCircle` | drag | area (mm2) + intensity |
| PlanarFreehandROI | `freehand` | drag | contour only (no stats) |
| SplineROI | `measureSpline` | multi-click | area (mm2) + intensity |
| LivewireContour | `measureLivewire` | multi-click | area (mm2) + intensity |
| Bidirectional | `measureBidirectional` | two drags | long + short diameter (mm) |
| ArrowAnnotate | `arrow` | drag | label only |

PlanarFreehandROI, SplineROI and LivewireContour panel reflection requires exactly
one contour without holes. Multi-part (eraser-split) or holed contours remain
visible and measured in NiiVue but are not reflected into OHIF, whose measurement
schema exposes only one polyline.

**Gestures.** Drag tools press-drag-release on a 2D slice. The multi-click tools
(SplineROI, LivewireContour) click to place each vertex, double-click on a 2D slice
to close the contour (a double-click on the 3D render is ignored), and
Escape to cancel an in-progress contour. Bidirectional takes two drags on the
same slice: the long axis first, then the perpendicular short axis. A second drag
on a different slice starts the measurement over. Loading a document drops any
half-drawn contour or bidirectional axis.

**Intensity stats** are sampled from the base volume in the series' modality unit
(HU for CT, SUV for PT, unitless otherwise); area is in mm2 and voxel-spacing
aware. Length and the bidirectional diameters are in-plane mm.

**Rendering.** Shapes and their labels are drawn by the `@niivue/uikit` overlay
(the same widget set the whole-slide ruler uses), not OHIF's cornerstone canvas.
A measured line renders as a graduated ruler (end caps, mm ticks, numbered majors,
rotated length label) in the annotation's stroke color.

**Free-text labels.** Edit a measurement row's label in OHIF's panel and the text
is pushed onto the shape on the viewport; the label and the annotation stay in
sync both directions.

**Panel reflection needs a backing DICOM series.** A row is added only when the
viewport is backed by a loaded DICOM series with instances (so the row carries a
resolvable `referenceSeriesUID`). A NIfTI-URL display set still draws the shape on
the canvas, but it is not reflected into the panel.

**DICOM identity.** Points are LPS mm. When a shape lies on one acquired frame plane of
a converted series, its row also carries that frame's `SOPInstanceUID`,
`frameNumber` and `referencedImageId` (matched from each frame's position against
the converted volume's affine, keeping the shown echo and magnitude/phase part).
A shape off that plane (across slices, or reformatted), on a slice two frames
share or none claims (e.g. enhanced multi-echo/4D, oblique frames), or on a volume
without a sform omits them.

**Jumping to a row.** List `@niivue/nv-ohif` after the cornerstone extension, so
its `jumpToMeasurementViewport` (which hands non-NiiVue rows to cornerstone) takes
precedence and a NiiVue row is not re-hung into another viewport.

## DICOM support

DICOM series are rendered by fetching the instances and converting them to NIfTI
in-browser with `@niivue/dcm2niix` (a WASM build of dcm2niix). This is verified
working end-to-end in a real OHIF app for both uncompressed and JPEG-LS studies,
and it works for `npm`-install consumers too. The package requires
`@niivue/dcm2niix` `^1.4.20261105-rc.3`, which reports dcm2niix's log when a conversion
fails and ships its own TypeScript declarations. Conversion uses its `convert()`
after the instances download; its worker is terminated on success, failure or
abort. Releases before `1.3.20260724` aborted every in-browser conversion (an
Emscripten `exit()` throw inside the Web Worker) and are excluded.

- **Output choice.** When a series converts to several NIfTI images, the viewport
  shows one: ORIGINAL/PRIMARY (sidecar `ImageType`) first, then magnitude over
  phase/real/imaginary (sidecar `ImageType`, else the `_ph`/`_real`/`_imaginary`
  stem), the lowest `EchoNumber`, the most voxels, the stem name. A note names
  the others.
- **Fetching.** Each instance is retrieved whole (WADO-RS RetrieveInstance) when
  the server allows it; otherwise it is rebuilt from `/metadata` plus frames
  1..NumberOfFrames, so enhanced/multi-frame instances convert as one file.
- **Partial conversions.** A nonzero dcm2niix exit that still produced images
  loads the choice with a note (dcm2niix's last error or warning line); no image
  is an error with dcm2niix's log tail.
- **Not converted:** SEG, RTSTRUCT, RTPLAN, RTRECORD, PLAN, SR, PR, KO, REG,
  DOC, FID, ECG, HD and AU series (also skipped as overlays). RTDOSE is converted.
- **One series per viewport.** Only the first display set hung in a viewport
  loads; a note names the rest.
- A second Overlay press while an overlay converts cancels it, as do a base
  swap and unmount.

## Whole-slide imaging

A whole-slide (SM) series renders with **NVSlide** (tiled deep-zoom) on its own
WebGL2 canvas, overlaid on the NiiVue viewport. `@niivue/nv-ext-tile/dicom` indexes the
series metadata (`indexDicomWsiMetadata`) and fetches each tile on demand by WADO-RS
`/frames/{n}` (`DicomWebWsiSource`), sending OHIF's authorization header and keeping
any query (an access token) on the series URL.

Support boundary:

- **Supported:** **JPEG**, **JPEG 2000** and **JPEG-LS** tiles, **TILED_FULL** or
  **TILED_SPARSE** (frames placed by their per-frame positions), one optical path and
  one focal plane, 8-16-bit unsigned samples.
  - JPEG 2000 and JPEG-LS frames are requested untranscoded (`transfer-syntax=*`) and
    decoded by `@niivue/dcm2niix`'s WASM worker pool, registered by
    `@niivue/nv-ext-tile/dicom`'s `registerDcm2niixDecoders` (loaded on the first such
    tile). A pool whose workers die is replaced, and the tile retried once.
  - A decoder the host app registered with `NVSlide.registerTileDecoder('image/jp2' |
    'image/jls', ...)` is kept; so is an ICC transform the host registered first
    (otherwise dcm2niix's is registered too).
  - A server that transcodes the frame anyway is refused rather than mis-decoded.
  - Monochrome slides keep their samples; OHIF's window/level (`niivueSetWindowLevel`)
    sets the slide's display window, which defaults to the full BitsStored range.
    MONOCHROME1 is inverted after windowing. Colour above 8 bits is scaled to 8 by BitsStored.
  - Colour slides are colour-managed: the optical path's ICC profile (inline, or fetched
    from its bulk-data URL through the data source's `retrieve.bulkDataURI` when on the series origin,
    else directly) is applied through the registered ICC transform
    (`registerDcm2niixDecoders` registers dcm2niix's), unless its ColorSpace is SRGB.
- **Tile-cache limit:** when the requested level's visible tiles exceed NVSlide's tile cache,
  the viewer draws the finest coarser level that fits and shows a brief note (zoom in for full
  resolution).
- **Declined (with an in-viewport note, not a crash):**
  - Several **optical paths** or **focal planes**, or levels whose metadata cannot prove
    one of each (NumberOfOpticalPaths, TotalPixelMatrixFocalPlanes, NumberOfFrames):
    their frames would land in the wrong tile positions.
  - Other transfer syntaxes (JPEG Lossless, RLE, HTJ2K): the note names the syntax.
    Uncompressed levels are not indexed, so the note says the slide has no tiled levels
    and why.
  - A slide with no tiled (VOLUME) pyramid levels.

The slide viewport supports pan/zoom and the whole-slide ruler. A NVSlide path for
2-D single-frame images is still a TODO (see `PLAN.md`).

## Compatibility

- **OHIF**: tested on 3.13.14 and 3.14.0-beta.70 (developed against 3.12.6).
- **React**: `^18.3.1 || ^19`, supplied by the host (OHIF 3.13.14 ships React
  18.3.1, 3.14.0-beta.70 ships 19.2.7). This does not use `@niivue/nvreact`.
- **dcmjs**: `^0.49.0 || ^0.52.0` (OHIF 3.13+ pins 0.52.0).
- **`@niivue/dcm2niix`**: required for DICOM only — see [DICOM support](#dicom-support).
- **`@niivue/nv-ext-tile`**: a dependency; nv-ohif imports only `/dicom`, so GeoTIFF is installed but never loaded.

## Roadmap

See `PLAN.md`. Landed: NIfTI + DICOM rendering, a toolbar for views / clip plane /
overlay / window-level / colormap, the full **Measurement** tool
group (see [Measurement tools](#measurement-tools)), and **NVSlide whole-slide (SM)
rendering** for JPEG, JPEG 2000 and JPEG-LS slides (see [Whole-slide imaging](#whole-slide-imaging)).
Next: segmentation overlays, mesh/surface overlay, and **NVSlide for 2-D** single-frame series (see the
`## TODO — NVSlide for 2D` section in `PLAN.md`).
