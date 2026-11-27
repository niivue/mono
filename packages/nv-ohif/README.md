# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (3.13 and 3.14-beta). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

Documentation: https://niivue.github.io/mono/docs/packages/nv-ohif/

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
> `bun pm pack` + `pnpm add file:<dir>` so each resolves self-contained from the app tree.

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

## Enable the NiiVue modes

nv-ohif ships three OHIF modes, one subpath export each. In an OHIF app, add
`@niivue/nv-ohif` and `@niivue/niivue` to the root `package.json`
dependencies. Then merge the following into `platform/app/pluginConfig.json`,
with the extension placed after `@ohif/extension-cornerstone`:

```json
{
  "extensions": [{ "packageName": "@niivue/nv-ohif", "default": false }],
  "modes": [
    { "packageName": "@niivue/nv-ohif/modes/viewer" },
    { "packageName": "@niivue/nv-ohif/modes/tmtv" },
    { "packageName": "@niivue/nv-ohif/modes/dynamic" }
  ]
}
```

| Route | Mirrors | Hanging protocol (OHIF's own) |
|---|---|---|
| `/niivue-viewer` | longitudinal (tracked series, measurements), with segmentation editing (labelmap panel and toolbox) and SM slides; right panel starts closed | `default` |
| `/niivue-tmtv` | TMTV (petSUV, TMTV panel, ROI tools) | `@ohif/extension-tmtv.hangingProtocolModule.ptCT` |
| `/niivue-dynamic` | preclinical-4d (4 workflow steps, cine) | `default4D` |

- The modes import `@ohif/mode-basic`, `-tmtv`,
  `-preclinical-4d` (deep `src/` imports) and `@ohif/core` from the host, so
  those packages must be installed. OHIF's own pluginConfig already lists them.
- nv-ohif ships no hanging protocols. The modes use OHIF's protocols unchanged.
  The TMTV mode registers the `getPTVOIRange` attribute, as OHIF's TMTV mode does.
- The mode chunks do not import NiiVue. The extension loads when a mode is
  entered.
- `niivueMode({ id, routeName, displayName, layout, ...modeInstance })` (from
  `@niivue/nv-ohif/modes/viewer`) builds a custom NiiVue mode. `layout`
  overrides the route's layout props.
- Each mode needs its own route: OHIF registers one route per mode.
- **Migration (rc).** `@niivue/nv-ohif/modes/segmentation` and
  `/modes/microscopy` are gone; `/niivue-viewer` covers both.

## What it does today

- Registers a **React viewport** that owns a `<canvas>` + a NiiVue instance.
- Loads a display set whose URL is a NiiVue-readable volume (`.nii/.nii.gz`, `.nrrd`,
  `.mgz`, `.mha`, `.mif`, …) via `nv.loadVolumes(...)`, opening in its acquired plane unless the hanging protocol
  names a view.
- Loads a **DICOM** series by fetching it and converting to NIfTI with
  `@niivue/dcm2niix` (see [DICOM support](#dicom-support)).
- Renders **whole-slide (SM)** series with **NVSlide** (tiled deep-zoom) on its own
  canvas: **JPEG, JPEG 2000 and JPEG-LS** slides, TILED_FULL or TILED_SPARSE (colour or
  monochrome), are supported; slides with several optical paths or focal planes are
  declined with an explanatory note (see [Whole-slide imaging](#whole-slide-imaging)).
- Mirrors the viewport's tool group's active primary tool (`viewportOptions.toolGroupId`,
  default `'default'`) onto NiiVue's left-drag. Windows are per viewport, as in OHIF;
  the initial window comes from the hanging protocol's `displaySetOptions[0].options.voi`
  when set, else the series' DICOM WindowCenter/WindowWidth when every slice
  shares it (as cornerstone),
  else NiiVue's robust 2-98% range. Slices use cornerstone's radiological
  convention (patient right on screen left, sagittal nose left).
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
  overlay), an **Overlays** dropdown (`NiivueOverlayMenu`, see [Overlays](#overlays)),
  and a reset-view button — all with active/disabled state tracked per
  viewport.
- Draws cornerstone's **corner text**: study date + series description, W/L,
  and (2D acquisition-plane stack) instance number and image position;
  `viewportOptions.customViewportProps.hideOverlays` drops it (e.g. a 3D pane).
  OHIF's viewport prompts (`uiViewportDialogService`) are drawn on the pane.
- Feeds new measurements to OHIF's **measurement tracking** (longitudinal mode)
  as TrackedCornerstoneViewport does; inert without the tracking context.
- A 3D pane's display menu offers cornerstone's **Volume Rendering Options**
  (`setVolumeRenderingQulaity`, `shiftVolumeOpacityPoints`,
  `setVolumeLighting`): Quality is the sample rate, Shift moves the window and
  Shade toggles illumination. Ambient, Diffuse and Specular apply in 3D
  Cinematic only (`volumeCinematic` ambient / volumetricDiffuse / specular,
  kept per pane). Diffuse shades normal-free samples only, and Specular shows
  only where the colormap has a specular channel (`S`), which NiiVue's CT
  colormaps lack.
- A whole-slide pane shows a **minimap** with the visible region boxed.
- The pane root carries `data-viewportid` (as cornerstone) and `data-loaded`
  (set once the base volume or slide is shown, absent while loading or after a
  failure), for tooling and specs.
- Backs OHIF's full **Measurement** tool group (Length, ellipse / rectangle /
  circle / freehand / spline / livewire ROIs, Bidirectional, ArrowAnnotate) with
  NiiVue annotations, reflected into the Measurements panel with stats and
  editable labels (see [Measurement tools](#measurement-tools)).

## Toolbar buttons

The extension registers the commands (`niivueSetSliceType`, `niivueSetClipPlane`,
`niivueAddOverlay`, `niivueSetOverlayVisible`, `niivueMoveOverlay`,
`niivueRemoveOverlay`, `niivueSetWindowLevel`, `niivueSetWindowLevelPreset`,
`niivueAutoWindowLevel`, `niivueSetColormap`, `niivueToggleInterpolation`,
`niivueToggleCrosshair`), the toolbar evaluators, and a customization pack with the
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
  { primary: [/* ...your button ids, */ 'NiivueClip', 'NiivueWindowLevel',
              'NiivueColormap', 'NiivueInterpolation', 'NiivueOverlayMenu',
              'NiivueCapture', 'NiivueCrosshair'] },
],
```

Buttons removed in 1.0, for custom modes that listed them:

| Removed | Use instead |
| --- | --- |
| `NiivueViews` (and `NiivueAxial`, `NiivueCoronal`, `NiivueSagittal`, `NiivueMultiplanar`, `NiivueRender`) | each pane's orientation menu; `niivueSetSliceType` stays |
| `NiivueRuler` (`niivueSetMeasurementMode`) | OHIF's Length tool |
| `NiivueOverlay` (`niivueToggleOverlay`) | `NiivueOverlayMenu`; `niivueAddOverlay` with no series adds the next one or cancels a load |
| `NiivueReset` (`niivueResetView`) | OHIF's `resetViewport` |
| `NiivueColorbar` (`niivueToggleColorbar`) | the pane's display menu (Colorbar) |

It also answers OHIF's standard `resetViewport`, `setViewportOrientation`
(axial / sagittal / coronal / acquisition), `scaleUpViewport`, `scaleDownViewport`,
`fitViewportToWindow`, `setWindowLevelPreset`, `setViewportColormap`, `rotateViewportCW`, `rotateViewportCCW`,
`rotateViewportCWSet`, `flipViewportHorizontal`, `flipViewportVertical`,
`setViewportHorizontalFlip`, `setViewportVerticalFlip`, `invertViewport`
(invert the base grayscale) and `jumpToImage` (`imageIndex` in display-set
order, a multi-frame instance's frames counted) on a NiiVue viewport
(`viewportId` or `viewport.id`, else the active one; rotate and flip apply to
2D tiles, and reset clears them and the inversion) and hands any other viewport to the `CORNERSTONE` context, so
standard hotkeys work in mixed layouts. This relies on the extension registering
after cornerstone (newer command contexts win). The `NIIVUE` context is registered
app-wide, so these names route through nv-ohif in every mode (delegating to
`CORNERSTONE` when the viewport is not NiiVue), and a third-party extension that
registers the same names in a context newer than `CORNERSTONE` is bypassed. On a
whole-slide viewport the volume-only ones (orientation, W/L presets, colormap,
rotate/flip) are disabled.

### Overlays

A viewport holds one base series and any number of overlays drawn over it.
OHIF's data overlay menu works on a NiiVue pane: **+ Foreground** layers a
co-registered image series with the modality's overlay colormap (hsv by
default) at 90% opacity, as cornerstone's; **+ Segmentation** hangs a SEG or
RTSTRUCT.

| Command | Options | Effect |
|---|---|---|
| `niivueAddOverlay` | `displaySetInstanceUID?` | Load that series (else the study's next loadable one) as a warm, 0.5-opacity overlay. Refuses the base, a loaded overlay, and series NiiVue cannot load as a volume (SEG, RTSTRUCT, SR..., slides; RTDOSE is allowed). Does nothing until a newly hung base has loaded (the Overlay buttons are disabled meanwhile). Without a UID, a call while a load runs only cancels it; a UID it accepts replaces that load (one at a time). |
| `niivueSetOverlayVisible` | `displaySetInstanceUID`, `visible?` | Hide or show it, keeping it loaded and its opacity; toggles without `visible`. |
| `niivueMoveOverlay` | `displaySetInstanceUID`, `direction: 'up' \| 'down'` | Move it past the next overlay up (drawn over it) or down; the base stays the bottom layer. |
| `niivueRemoveOverlay` | `displaySetInstanceUID`, `viewportId?` | Unload it (from that pane, else the active one). |
| `setViewportColormap` | `viewportId?`, `displaySetInstanceUID?`, `colormap`, `opacity?` | OHIF's command: the base (no UID, or the base's) or an overlay; any other UID is a no-op. `colormap` is a NiiVue name (any case) or `Grayscale` / `hot_iron`, as a string or `{ name }`; an unknown name keeps the current one. `opacity` is clamped to 0..1; unlike Cornerstone, omitting it leaves it unchanged. |

The `NiivueOverlayMenu` button (uiType `niivue.overlayMenu`, a component the
toolbar module registers) is a dropdown over these commands: a list of the study's
series that can be added (disabled while one loads), then one row per overlay, top
layer first, with visibility, colormap (the colormap dropdown's names), opacity,
up/down and remove. It is disabled off NiiVue, on a whole-slide viewport and
until a base volume has loaded.

A base swap or unmount drops the overlays and cancels a load in flight.

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

**Editing.** nv-ohif turns on core's `annotationIsHandleGrab`: a press on any
shown measurement's control point drags it, whatever the active tool, with no
selecting click. Bidirectional follows cornerstone: a long-axis end turns the
long axis about the other end and carries the short axis; a short-axis end
slides the short axis along the long one. Angle and Cobb angle handles move
their points. Handles scale with device pixel ratio.

**Intensity stats** are sampled from the base volume in the series' modality unit
(HU for CT, SUV for PT, unitless otherwise); area is in mm2 and voxel-spacing
aware. Length and the bidirectional diameters are in-plane mm. A
`CalibrationLine` scales lengths and areas (see [Workflows](#workflows)).

**Rendering.** Shapes and their labels are drawn by NiiVue core, not OHIF's
cornerstone canvas.
A measured line renders as a graduated ruler (end caps, mm ticks, numbered majors,
length label) in the annotation's stroke color. Volume-pane
measurements draw yellow without fill, as slide annotations.

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
  stem), the lowest `EchoNumber`, the most voxels, the stem name, among the
  outputs mapped to the series' instances, else the oriented ones (a surview
  mixed with orientation-less pages opens on the surview). A note names the
  others.
- **Output stack.** Every other mapped output of the shown echo and part,
  multi-frame ones included, joins a cornerstone-style stack: on the
  acquisition plane the wheel steps through every image in instance order,
  switching outputs at an output's end (as does a StackScroll drag over
  single-slice outputs, one image per 4 px), and `jumpToImage` switches to the
  output holding the image.
- **Acquired plane.** A series OHIF marks not reconstructable (unequal slice
  spacing, orthogonal localizers), or a single slice, opens in its acquired
  plane rather than multiplanar.
- **Overlay planes (60xx).** While `ImageOverlayViewer` is Enabled and no SEG,
  RTSTRUCT or PT label holds the drawing, the first overlay plane shows as the
  pane's drawing, display only (the pen stays off). First plane only; a 4D
  plane follows the pane's frame (none past its last).
- **Fetching.** Each instance is retrieved whole (WADO-RS RetrieveInstance) when
  the server allows it; otherwise it is rebuilt from `/metadata` plus frames
  1..NumberOfFrames, so enhanced/multi-frame instances convert as one file.
  Inline Overlay Data is kept; a BulkDataURI overlay is dropped.
- **Partial conversions.** A nonzero dcm2niix exit that still produced images
  loads the choice with a note (dcm2niix's last error or warning line); no image
  is an error with dcm2niix's log tail.
- **SEG.** A SEG hung in a pane loads the series it references as the base and
  shows as a NiiVue drawing over it: dcm2niix turns it into a label volume
  colored by each segment's RGB, half-opaque fill under an opaque rim. Hung
  behind a primary series it does not reference, it is noted as not shown.
  Segment Bidirectional samples the active segment on world planes of the
  shown view (oblique grids included); `SegmentLabelTool` names the segment
  under the pointer.
- **RTSTRUCT.** Hung in a pane, it previews as a drawing over the CT it
  references: each ROI's closed planar contours filled onto the base grid, one
  label per ROI. Hydrated in the NiiVue Viewer it is an editable contour
  segmentation, one segment per ROI (`rtContours.ts`, as OHIF's segmentation
  mode); loading clears the pane's (and mirror panes') undo history, so undo
  cannot remove the loaded shapes. A pane that a non-empty contour
  segmentation mirrors into (hand-drawn ones too) loses its earlier annotation
  undo steps the same way. Other modes (TMTV), and a structure set with
  any contour more than 0.25 voxel off the base's slice planes, keep the drawing.
- **SR.** Not converted: a hydrated SR's measurement rows become NiiVue
  annotations (see [Workflows](#workflows)).
- **Not converted:** RTPLAN, RTRECORD, PLAN, PR, KO, REG, DOC, FID, ECG, HD
  and AU series (RTSTRUCT and SR are skipped as overlays too). RTDOSE is converted.
- **One series per viewport.** Only the first display set hung in a viewport
  loads; a note names the rest.
- A second Overlay press (or another `niivueAddOverlay`) while an overlay converts
  cancels it, as do a base swap and unmount.

### Imaging Data Commons

Point an OHIF DICOMweb data source at IDC's proxy (as IDC's own viewer,
`viewer.imaging.datacommons.cancer.gov/v3/app-config.js`) and open
`/niivue-viewer/<sourceName>?StudyInstanceUIDs=<uid>`. Slides tile over the
proxy. A volume or SEG series served by the proxy is fetched whole from IDC's
public S3 objects instead (located by IDC's v3 SQL index): the proxy refuses
whole-instance downloads and its metadata omits a large SEG's per-frame
positions. A display set that is only part of a series, or any S3 failure,
falls back to the proxy. The proxy reports no study modalities, so the
viewer mode accepts a study whose modalities are unknown.

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

The slide viewport is core's `createSlideView` (WebGL2): pan, the Zoom tool's
drag, the wheel, and OHIF's Length, Bidirectional, ArrowAnnotate, Probe,
RectangleROI, EllipticalROI, CircleROI, PlanarFreehandROI, SplineROI and
LivewireContour tools (core's slide overlay; a sub-millimetre length reads with
one decimal, "180.0 um"), reflected into the Measurements panel. A
Bidirectional is drawn as its long axis and gets a perpendicular short axis
(2/3 as long); its row shows length and width. An arrow asks for its text in
OHIF's dialog. The SR export writes a Bidirectional's two axes.
`mountWsiSlideView(canvas, slide, options)` returns a Promise of the view handle
(`setTool`, `resetView`, `zoom`, `fit`, `setWindow`, `saveBitmap`, `dispose`,
`canvas`).

**Migration (rc).** The WSI view's own UIKit ruler is gone, with
`createRulerSync`, `rulerSpecFor` and the `onMeasure` option of
`mountWsiSlideView` (nothing passed it). A NVSlide path for
2-D single-frame images is still a TODO (see `PLAN.md`).

## Workflows

Each follows the OHIF mode's own tools and panels (`modes/`: viewer, dynamic,
tmtv).

- **4D (dynamic PET).** A dynamic series converts to one 4D NIfTI; every pane
  shows the current frame from one shared buffer. OHIF's 4D panel (play,
  frame, fps) and Cine drive it; Cine on a 3D pane plays a slice clip.
  Computed volumes (sum / average / subtract over a frame range) and
  per-segment time-activity curves (`kinetics.ts`).
- **PET quantification (TMTV).** Body-weight SUV from the instance tags (no
  vendor quirks). One label per PT series on the PT grid, shown on every pane
  holding it (resampled on fusion panes); brush, threshold brush and ROI
  threshold tools; TMTV / TLG and per-segment stats, CSV export. The label
  replaces shown 60xx planes. A pane whose drawing is a SEG or RTSTRUCT, shown
  or still loading, keeps it (no label, no brush); once the last goes (closed,
  failed or cancelled mid-load), the label is dropped, the planes return and
  re-arming the brush brings the label back. A mode exit drops the labels.
- **MIP pane.** `VolumeRotateMouseWheel` and `MIPJumpToClickTool` (crosshair to
  the brightest voxel along the clicked ray).
- **Segmentation.** A SEG or RTSTRUCT drawing is entered in OHIF's
  segmentation panel and panel edits mirror back. `/niivue-viewer` carries
  OHIF's segmentation editing (labelmap and contour panels and toolboxes,
  segmentation tools in the default and mpr tool groups). OHIF's labelmap tools drive
  NiiVue's pen (threshold range and segment locks enforced); each edit is one
  OHIF undo step. A segment row's statistics card shows its voxel count and
  volume, refreshed after each edit. Export writes DICOM SEG or RTSTRUCT on the
  source series' own frames.
- **Contour segmentation** (`contourSeg.ts`, `contourOps.ts`,
  `contourSculpt.ts`). The contour panel's segmentation is NiiVue vector
  annotations, one group per segmentation (`seg:<id>`), labelled by segment.
  Freehand, spline (Catmull-Rom; linear and B-spline draw as it) and live wire
  draw the active segment in its colour; a stroke merges with its segment and
  overlaps the others, as cornerstone's (core `annotationIsCut`).
  Shift+freehand cuts a hole in its segment. Locked or hidden segments are not
  cut, grabbed or erased.
  Combine (merge, subtract, intersect), Duplicate, Smooth, Remove extra
  points, Fill holes, Remove small contours, Holes to segment and Sculptor
  (cursor drawn and sized as cornerstone's, Dynamic Cursor Size included) edit the
  shapes, each one undo step; locked segments are left as they are. The statistics
  card counts the voxels whose centres the shapes cover; Export writes a SEG
  of those voxels or an RTSTRUCT of the drawn rings (LPS, on each shape's
  voxel plane, so oblique slices round-trip). Every NiiVue pane showing the
  series holds the segmentation (one pane's copy is counted and exported; the
  others mirror its edits), so in MPR any pane draws into it; a layout change
  or series swap keeps it. Interpolate Contours (per tool, off by default)
  fills the slices between two drawn contours of a segment (outer rings only),
  as cornerstone's: in-betweens draw fainter and regenerate when a drawn one
  changes; editing one makes it drawn (undo restores it). Another
  segmentation active on the pane draws this one in its inactive style. Live
  wire uses cornerstone's LivewireScissors cost (core
  `annotationIsLivewireScissors`). A
  finished spline is an outline (Simplified Spline on, OHIF's default). Not
  done: Simplified Spline off.
- **SR.** NiiVue measurement rows are mirrored as cornerstone annotations, so
  OHIF's SR export includes them; a hydrated SR's rows show as NiiVue
  annotations (axis-aligned only). Slide rows save and load as OHIF's
  microscopy SR (`slideSR.ts`).
- **Undo.** NiiVue annotation and segmentation edits join OHIF's undo history,
  so OHIF's buttons and hotkeys undo both viewers in one order.
- **Reference lines and sync.** Other panes show where the active pane's
  slice cuts them. Camera and VOI sync groups share the crosshair; a VOI group
  carries the window, a camera group 2D pan and zoom.
- **Hanging options.** Per display set colormap, voi, voiInverted and
  blendMode (MIP), per viewport background.
- **Magnify.** `Magnify` (while the button is held) and `AdvancedMagnify`
  (placed glasses, as cornerstone's: a click places one; drag its rim to move
  it or a rim handle to resize it, or inside it on touch, where extra fingers
  stay the glass's and start no pinch zoom; Shift+right-click or a long touch
  picks its zoom; glasses stay while another tool is active and go
  when the button is toggled off). A glass shows on its own slice only.
- **Calibration.** `CalibrationLine` draws a line, asks its actual length in
  OHIF's dialog, then removes it. The scale applies to the whole display set
  (cornerstone calibrates one image) and to its rows, SR export, canvas labels
  and rulers, in `mm User` / `mm² User`; core keeps native mm. Contour
  segmentations stay native. A **Calibrated** marker's Reset returns to native
  mm. Unlike cornerstone, the line reads mm (calibrated, if set), not px,
  while drawn; the scale stays with the display set when a pane swaps away and
  back. Re-importing an
  SR restores the scale from its stored lengths, or areas in an ROI-only
  report (rows that disagree leave native mm). Importing an uncalibrated SR
  resets the scale to native. Cornerstone's own CalibrationLine stores lengths
  that need not match its geometry by the entered factor (x2 on a CT scout
  moved a Length 277.97 to 280.26 mm), so its SR marks a NiiVue pane
  Calibrated at the stored/geometry ratio (about 1.008 there).

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
SEG, RTSTRUCT, SR, 4D and TMTV landed too (see [Workflows](#workflows)).
Next: mesh/surface overlay, and **NVSlide for 2-D** single-frame series (see the
`## TODO — NVSlide for 2D` section in `PLAN.md`).
