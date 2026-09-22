# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (v3.12). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

> **Status: proven in a real OHIF app.** Renders **NIfTI (volume-URL) display sets**
> and **DICOM series** (fetched + converted to NIfTI with `@niivue/dcm2niix`), with a
> toolbar surfacing NiiVue's views / clip plane / overlay / window-level. Verified
> mounting inside a full local OHIF Viewer (registered via `pluginConfig.json` + a
> mode). See `PLAN.md`.

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
`niivue`.

```js
// in a mode's viewport config
{
  namespace: '@niivue/nv-ohif.viewportModule.niivue',
  displaySetsToDisplay: ['<your NIfTI/volume display-set handler>'],
}
```

## What it does today

- Registers a **React 18 viewport** that owns a `<canvas>` + a NiiVue instance.
- Loads a display set whose URL is a NiiVue-readable volume (`.nii/.nii.gz`, `.nrrd`,
  `.mgz`, `.mha`, `.mif`, …) via `nv.loadVolumes(...)`, opening in multiplanar.
- Loads a **DICOM** series by fetching it and converting to NIfTI with
  `@niivue/dcm2niix` (see [DICOM support](#dicom-support) for the dependency caveat).
- Renders **whole-slide (SM)** series with **NVSlide** (tiled deep-zoom) on its own
  canvas: **JPEG, TILED_FULL** slides are supported; **JPEG 2000** and **TILED_SPARSE**
  are declined with an explanatory note (see [Whole-slide imaging](#whole-slide-imaging)).
- Mirrors OHIF's active primary tool (Window/Level, Pan) onto NiiVue's left-drag,
  and reflects a manual NiiVue window/level drag onto any sibling OHIF viewport
  showing the same series (`setViewportWindowLevel`).
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
button definitions. A mode pulls them in by reference and places them in its
primary bar:

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

PlanarFreehandROI panel reflection currently requires exactly one contour without
holes. Multi-part or holed freehand annotations remain visible in NiiVue but are
not reflected into OHIF, whose measurement schema exposes only one polyline.

**Gestures.** Drag tools press-drag-release on a 2D slice. The multi-click tools
(SplineROI, LivewireContour) click to place each vertex, double-click to close the
contour, and Escape to cancel an in-progress contour. Bidirectional takes two
drags: the long axis first, then the perpendicular short axis.

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

## DICOM support

DICOM series are rendered by fetching the instances and converting them to NIfTI
in-browser with `@niivue/dcm2niix` (a WASM build of dcm2niix). This is verified
working end-to-end in a real OHIF app for both uncompressed and JPEG-LS studies,
and it now works for `npm`-install consumers too.

> **History (resolved):** older `@niivue/dcm2niix` releases aborted every
> in-browser conversion. Emscripten's `exit()` *throws* inside a Web Worker (it
> returns the code under Node), and the worker did `const exitCode =
> mod.callMain(args)` and let that throw hit its catch, so it never read `/output`.
> The fix wraps `callMain` in try/catch and reads `err.status`. It is merged upstream
> (`rordenlab/dcm2niix`, commit `aae72ac`, both `js/src/worker.js` and
> `worker.jpeg.js`) and **published** in `@niivue/dcm2niix 1.3.20260724` (the
> calendar-versioned npm `latest`). This package pins `@niivue/dcm2niix` at
> `^1.3.20260724`, so `npm install @niivue/nv-ohif` pulls a dcm2niix that has the
> fix and DICOM conversion works out of the box. (Versions `1.2.0` and the
> `1.3.0-dev.0` prerelease predate the fix and are excluded by the pin.)

## Whole-slide imaging

A whole-slide (SM) series renders with **NVSlide** (tiled deep-zoom) on its own
WebGL2 canvas, overlaid on the NiiVue viewport. The manifest is built from the
DICOM tile pyramid (`buildWsiManifest`) and tiles are fetched on demand
(`DicomWsiTileSource`).

Support boundary:

- **Supported:** **JPEG**-encoded tiles with **TILED_FULL** frame organization.
- **Declined (with an in-viewport note, not a crash):**
  - **JPEG 2000** tiles (the viewer cannot decode them yet).
  - **TILED_SPARSE** frame organization (the tile grid assumes row-major
    TILED_FULL order, so a sparse slide would render scrambled).
  - A slide with no tiled (VOLUME) pyramid levels.

The slide viewport supports pan/zoom and the whole-slide ruler. A NVSlide path for
2-D single-frame images is still a TODO (see `PLAN.md`).

## Compatibility

- **OHIF**: `^3.12` (developed against 3.12.6; also exercised against OHIF
  `master`/3.13-beta in the dev rig).
- **React**: `^18.3.1` (OHIF is on React 18 — this does not use `@niivue/nvreact`,
  which targets React 19).
- **`@niivue/dcm2niix`**: required for DICOM only — see [DICOM support](#dicom-support).

## Roadmap

See `PLAN.md`. Landed: NIfTI + DICOM rendering, a toolbar for views / clip plane /
overlay / window-level (both directions) / colormap, the full **Measurement** tool
group (see [Measurement tools](#measurement-tools)), and **NVSlide whole-slide (SM)
rendering** for JPEG / TILED_FULL slides (see [Whole-slide imaging](#whole-slide-imaging)).
Next: segmentation overlays, mesh/surface overlay, JPEG 2000 / TILED_SPARSE slide
support, and **NVSlide for 2-D** single-frame series (see the
`## TODO — NVSlide for 2D` section in `PLAN.md`).
