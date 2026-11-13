# Signals and MRS

Moved from `packages/niivue/AGENTS.md`; read it when working on physio, spectroscopy, MRSI or the signal graph. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Signal data class

A third, **non-spatial** data class alongside volumes and meshes, rendered as 2-D
line plots instead of slices. Source lives in `src/signal/`, with format readers
in `src/signal/readers/` listed in its `_registry.ts` (same pattern as
volume/mesh readers — export `extensions` + `read`). Two kinds, discriminated by
`kind: SignalKind`:

| Kind | Source | Stored as |
|------|--------|-----------|
| `physio` | BIDS time-series TSV | `columns: Float32Array[]`, `columnLabels`, `samplingFrequency`, `startTime` |
| `spectroscopy` | NIfTI-MRS complex FID | interleaved `fid`, `nPoints`, `nTransients`, `dwell`, `spectrometerFreq`, `nucleus` |

**Readers** (`readers/tsv.ts`, `readers/nii.ts`):

- `tsv` — BIDS physio, gz-aware (`NVGz.maybeDecompress`). Blank/`n/a`/`NaN` cells
  become NaN trace gaps (the line is left gapped — NOT interpolated — and the
  graph marks each missing sample with a short tick along the bottom axis in the
  series colour: the "missing-data rug", `drawMissingRug` in `view/NVGraph.ts`,
  decimation-safe at one tick per pixel column, and stacked into a per-series
  lane so coincident gaps in two series sit side-by-side, not overwriting). A
  stray all-non-numeric leading
  row is treated as column labels. Labels prefer the sidecar `Columns`, then an
  in-file header, then a generic fallback.
  - **Trigger rug (top):** the optional MEASURE-SPECIFIC trigger column,
    `<label>_trigger` (e.g. `cardiac_trigger` beside a `cardiac` recording, as
    bidsphysio writes), marks events of the recorded signal (heartbeats, breaths).
    The plain BIDS `trigger` column is the SCANNER VOLUME trigger (one pulse per
    TR — the acquisition grid, not a feature of the signal) and is intentionally
    NOT shown; using `<measure>_trigger` disambiguates the two, which otherwise
    share the value `1`. `derivePhysioSeries` resolves triggers PER PLOTTED
    SERIES: for each non-trigger series labelled `L` it finds the `L_trigger`
    column and attaches the x-positions of every cell that is BOTH numeric and
    non-zero (`n/a`/NaN and 0 are not) as `triggers: number[]` on THAT series — so
    a multi-measure file routes each measure's events to its own trace.
    `drawTriggerRug` draws them as a tick rug along the TOP of the plot — the
    mirror of the bottom missing-data rug (same per-pixel-column decimation,
    per-signal stacked lanes, series colour). **Default selection excludes trigger
    columns:** `selectedColumns: null` plots every NON-trigger column (label
    `trigger` or `*_trigger`), so a bare `loadSignals` doesn't draw the binary
    trigger channels as lines or let them dominate the y-range; an explicit
    `selectedColumns` is honoured verbatim (a caller can still plot a trigger
    column as a normal line).
- `nii` — reuses `nifti-reader-js` header parsing but does **not** call
  `nii2volume` (which is GPU-volume specific and would discard complex data).
  Complex datatype -> spectroscopy FID; real non-spatial -> physio (dim4 is the
  time axis, dims5..7 are columns).

**Sidecar** (`sidecar.ts`): sibling `.json`, auto-fetched by URL (`fetchSidecar`,
404/sandbox tolerant) or paired on multi-file drag-drop at the controller layer.
MRS fields are `SpectrometerFrequency` / `ResonantNucleus`. `ImagingFrequency` is
deliberately **not** treated as an MRS marker (it appears in plain fMRI sidecars).

**NIfTI routing** (`detect.ts`, `niftiBufferIsSignal`): a NIfTI is a signal when it
is non-spatial (dim1-3 == 1 and dim4 > 1). MRS sidecar/header fields do NOT route
here — a spatial spectroscopic image (MRSI/CSI) carries them too but its dim1-3
encode space, which the 1-D signal reader cannot represent, so it stays on the
volume path (the reader throws if MRSI is forced via `asSignal`). Datatype/complex
is NOT a trigger — spatial MR is routinely complex. The `asSignal` load option
(`true`/`false`) overrides the sniff.

**MRS metadata** is resolved sidecar-first, then from the NIfTI-MRS header
extension (ecode 44 JSON, parsed by `mrsFromHeaderExtensions`); the ppm
spectrometer frequency falls back to `ImagingFrequency` (which is itself never an
MRS routing marker). `volumeTR()` decodes `xyzt_units` so ms/us temporal pixdims
are not 1000x/1e6x off.

**Processing** (`processing.ts`, pure/CPU): in-place radix-2 Cooley-Tukey FFT with
a direct DFT fallback for non-power-of-two lengths; optional transient averaging
before the transform; fftshift to centre zero frequency; projection to a real
component (`real`/`imag`/`magnitude`/`phase`). Spectroscopy x-axis is ppm
(MR convention, drawn high-to-low via `axis.reversed` rather than reversing the
data) or Hz. Y-range is windowed to the visible x-domain. Physio x-axis is
`startTime + i / samplingFrequency` (Time (s)), falling back to a sample-index
axis when the rate is unknown.

**Rendering** (`view/NVGraph.ts`): the GPU graph was extended with a "signal mode"
(multi-color Okabe-Ito series, legend, real/reversible/windowed x-axis) gated on a
non-empty `series` field; the legacy 4D-volume graph path is unchanged. When the
spatial view is hidden the plot fills the instance area and BOTH renderers skip the
entire spatial pass — no slices, crosshair, or orientation labels (`NVViewGPU.ts` /
`NVViewGL.ts` compute `spatialHidden = md.isSpatialViewHidden()`). The spatial view
is hidden when the scene is signal-only (a signal but no volume/mesh) OR the user
selects `SLICE_TYPE.NONE` — the latter hands the whole canvas to the graph while a
volume stays loaded (e.g. a 4D BOLD time-course wanting full screen real-estate).
`NVModel.isSpatialViewHidden()` is the single source of truth used by both
renderers AND the graph-data builders' `fullCanvas` flag, so the slice-skip and the
graph width never disagree. The association graph's `_assocCache` key includes
`isSpatialViewHidden()` so toggling `SLICE_TYPE.NONE` rebuilds the layout (side
strip <-> full canvas) rather than reusing the stale cached graph. Demo:
`physio.bold.html` exposes a "None (graph only)" slice-type option.

**Graph wheel:** scrolling over the graph steps the 4D frame when a spatial
volume is present; for a signal-only graph it falls back to scrubbing the cursor
(`stepSignalCursor` -> `setSignalCursorFraction`). `physio.bold.html` also exposes
the live `hdr.toFormattedString()` via a Header button.

**Model/controller API:** `NVModel.signals[]`, `NVModel.signalCursorX`,
`collectSignalGraphData()` (merges every loaded signal's derived series onto a
shared axis). Controller (`NVControlBase.ts`): `loadSignals`, `addSignal`,
`removeSignal`, `removeAllSignals`, `setSignal` (updates display state /
attachment / annotations, driving the on-demand transform),
`setSignalCursorFraction`. Events: `signalLoaded`, `signalRemoved`,
`signalLocationChange`. Clicking the plot sets a cursor marker and emits the
values at that x for the status bar.

**Annotations** (`SignalAnnotation`, on `NVSignal.annotations`): text labels
anchored to a position in the signal's own axis data-units `{ text, x, y, color? }`.
They are merged into `GraphData.annotations` (only for signals sharing the common
axis) and drawn in `buildSignalGraphElements`: x is mapped through the visible
window (`mapSignalX`), so labels pan/zoom with the data and are hidden once their
x leaves the window. A `y` of `-Infinity`/`+Infinity` pins the label to the
bottom/top of the plot (a faint vertical guide marks its x); a finite `y` maps to
the value, clamped into the plot. Set via the load options
(`loadSignals`/`addSignal`) or `setSignal(i, { annotations })`; persisted in NVD.
`examples/svs.html` labels NAA/Cr/Cho at their ppm positions.

**Persistence** (`signal/persistence.ts`): NVD documents serialize signals at
document version 8 (`serializeSignal` / `reconstructSignal`, CBOR-friendly raw
bytes).

**Demos:** `examples/svs.html` (spectroscopy: average / component / ppm-range;
plus a "Show" scene selector — MRS only / MRI only / MRI + MRS / MRI + MRS + voxel
— that pairs the spectrum with the participant's T2w and a one-node connectome
"voxel" marker rendered with the outline shader at the MRS sampling location, and
a "View" menu offering single slices / render / multiplanar) and
`examples/physio.html` (cardiac / respiratory selector). Sample fixtures in
`packages/dev-images/images/signals/`, served at `/signals/...`.

(The 4D-volume-frame <-> physio-time alignment marker and association graph are
implemented — see "Volume+physio association" below.)

### Signal graph behaviour

Volume+physio association (`NVModel.collectAssociatedTimeGraphData`): when a
physio signal sets `attachedToId` to a loaded 4D volume, the graph shows the
crosshair BOLD time-course (frame i at i*TR seconds, t=0 = first volume) plus
each attached physio trace at its native sampling rate (no resampling) on a
shared Time (s) axis. The window is clamped to the imaging period
`[0, (nFrames-1)*TR]` (physio logged before/after the scan is dropped); each
series is min-max normalized for display, but carries un-normalized values in
`GraphSeries.rawY` so the status-bar readout (`signalValuesAt`) reports the real
BOLD intensity / physio counts. A cursor marks the current frame's time and a
graph click scrubs the 4D volume to the nearest frame. The readout also refreshes
on crosshair move and frame change (`createOnLocationChange -> refreshSignalLocation`).
TR comes from `volumeTR(vol)` (`pixDims[4]`, seconds via `xyzt_units`). Crosshair
voxel sampling is shared via `NVModel.sampleVolumeTimeCourse` (guards `matRAS`).
Per-trace visibility: the BOLD/volume series is gated by
`ui.graph.showVolumeTimecourse` (controller `graphShowVolumeTimecourse`, default
true); a physio trace is hidden with `setSignal(i, { display: { selectedColumns:
[] } })`. The builder now needs only `>= 1` visible series (was BOLD + `>= 1`
physio), so BOLD and each physio toggle independently; hide the whole graph with
`isGraphVisible = false` when nothing is selected. Demo: `examples/physio.bold.html`
(a real task-fMRI run with per-trace fMRI/respiratory/cardiac checkboxes; opens
with the crosshair on an unclamped deep-WM voxel ~20 mm left of the origin since
the uint8-scaled sample saturates at the origin).

Signal graph pan/zoom: a dense signal graph (`> 20` samples) draws four bottom-row
buttons (`< - + >` = pan-left / zoom-out / zoom-in / pan-right) on the axis-title
row (`computeGraphControls` -> `GraphLayout.controls`, rendered + hit-tested from
that one source; `graphHitTest` returns `{ type: 'graphControl', id }`). They
drive `NVModel.graphZoom(factor)` / `graphPan(frac)` (controller `graphZoom` /
`graphPan`) which adjust `signalViewWindow` (`[min,max]` over the x-axis, null =
full). The window is applied in `applyGraphViewWindow` (called from
`collectGraphData` for signal-mode data): it derives the full domain from the
input axis each call, stamps it on `GraphData.fullXDomain`, and rewrites
`xAxis.min/max`, so the cursor mapping, layout, and render all honour the zoom;
zooming centres on the graph cursor when set. `graphZoom`/`graphPan`/
`panViewWindowTo` read the current full domain + axis orientation from a FRESH
`collectGraphData()` (`NVModel.currentGraphDomain()`) rather than any persisted
render-time field, so they work immediately after `loadSignals()` (before the
first RAF) and are genuine no-ops when no signal graph is shown. The window
persists across crosshair/frame changes and resets on
`loadSignals`/signal removal. Each button carries a `disabled` flag (no-op at the
current window: full view, an edge, or the zoom-in limit) — drawn dimmed toward
the panel background and skipped by `graphHitTest`. Buttons start one button-width
in from the plot's left edge so they clear the leftmost x-label ("0").
Sparse data lines (e.g. the volume time-course) are drawn with per-segment x-clip
(`clipSegmentX`) so a line reaches the plot edge even when the neighbouring sample
is off-window (no dropped leftmost/rightmost segment).

Reset to full view: `graphResetView()` (controller) clears `signalViewWindow`,
and a DOUBLE-CLICK on the zoom-out (`-`) button does the same. The reset is
restricted to that one button: the dblclick handler in `control/interactions.ts`
resets only when `graphHitTest` returns the `zoomOut` control, so a double-click
on `+`/`<`/`>` keeps its single-click action (zoom in / pan) instead of being
overridden by a reset, and a plot double-click just scrubs. Any graph hit still
consumes the dblclick so it does not fall through to depth-pick (nothing to pick
on the 2-D plot). This is the one-click way back from a deep zoom; zooming out
past the full extent still auto-resets too. A double-click on a spatial slice is
unaffected (still depth-picks), except that while a spline/livewire contour is
in progress a double-click on a 2D slice tile closes the contour instead, and
one on the 3D render tile is ignored (#114). The graph check runs first, so a
graph double-click keeps its action mid-contour.

Marker vs window: explicit zoom/pan may leave the cursor marker off-window (zoom
only re-centres on the marker when it is already visible; the pan buttons can
scroll it out of view — both intentional). But when the marker moves ON ITS OWN
via the scroll wheel (stepping the 4D frame, or `stepSignalCursor` for a
signal-only graph), the window pans to keep it visible: `NVModel.panViewWindowTo(x)`
is called from `setSignalCursorValue` and from `ensureGraphCursorVisible()` (the
latter wired into the wheel/frame-step path in `control/interactions.ts`).
`stepSignalCursor` no longer clamps the marker to the window — it extrapolates
(`signalXValueAtFrac`, reversed-aware), clamps to the full extent, then the window
follows. ALL frame changes follow the marker via `setFrame4D -> ensureGraphCursorVisible`
(not just the wheel), so the windowed `signalValuesAt` readout stays accurate after
Back/Forward too. Demo: `examples/physio.bold.html`.

Signal-graph audit invariants (keep these true):
- **Pan is screen-space + reversed-aware.** `graphPan(screenFrac)` flips the data
  shift for a reversed (ppm) axis (orientation from the fresh
  `currentGraphDomain()`), and `computeGraphControls` swaps the disabled
  pan-left/right edges for reversed. The buttons move the view the same VISUAL
  direction on Time and ppm graphs.
- **Hidden BOLD pays nothing.** `collectAssociatedTimeGraphData` samples the volume
  time-course only inside `if (showVol)`; a hidden BOLD (or a volume without
  `matRAS`) does NOT block a physio-only graph, and the cache key omits the
  crosshair when BOLD is hidden.
- **Assoc cache is cursor-independent + invalidated on mutation.** The key omits
  `frame4D` (series don't depend on the frame; only `cursorX` does — re-stamped on
  cache hit), so frame stepping reuses the cached series. `_assocCache` is cleared
  by `invalidateGraphCache()` on signal/volume add/remove/load (ids are
  name-derived, so a same-URL reload must not reuse stale data).
- **Controls gated on a width budget, title yields.** Buttons render when the plot
  is wide enough to hold the button span plus the leftmost x-label and a gap
  (`plotWidth > fontSize*8.2 + labelWidth + fontSize*1.5`) — relaxed from the old
  flat `22*fontSize` so the typical side-strip association graph (e.g.
  `physio.bold.html`) still shows controls. The centered axis title is shifted
  right when needed to clear the buttons (`titleX = max(center, buttonsRight +
  0.5fs + halfLabel)`), so title and buttons never overlap. Rug lanes are capped
  to a bottom band.
- **Pan before emit on frame change.** `setFrame4D` calls `ensureGraphCursorVisible()`
  (which pans the window via `panViewWindowTo`) BEFORE `createOnLocationChange()`
  emits, so the windowed `signalValuesAt` readout samples the NEW window — not the
  pre-pan one. Reordering matters whenever a zoomed window must follow a
  Back/Forward step.
- **Zoom centers on the VISIBLE marker.** `graphZoom` centers on the fresh
  `currentGraphDomain().cursorX` (the live frame/association marker) rather than a
  stale `signalCursorX` left from an old graph click, so zooming in keeps the
  current frame in view.
- **Pan/zoom derive from a fresh collect, never render-time cache.** `graphZoom`/
  `graphPan`/`panViewWindowTo` call `currentGraphDomain()` (a fresh
  `collectGraphData()`, `_assocCache`-backed) for the full domain + orientation +
  cursor. There are NO persisted `_signalFullDomain`/`_signalAxisReversed` fields
  — that render-time-to-setter bridge was removed because it made the setters
  no-op before the first RAF and could act on a stale/hidden graph's domain.
  `invalidateGraphCache()` therefore only clears `_assocCache`.
- **`applyGraphViewWindow` is pure.** It returns a SHALLOW COPY with rewritten
  `xAxis.min/max` and derives the full domain from `data.xAxis` each call (stamped
  on the copy's `fullXDomain`) — it does NOT mutate the cached `GraphData` in
  place (which would compound on repeated collects).
- **Axis chosen from the first VISIBLE plot.** `collectSignalGraphData` picks the
  shared axis from the first resolved plot with `>= 1` series, not `resolved[0]`:
  a hidden first signal (`selectedColumns: []`) still resolves to an empty-series
  plot carrying its axis, and adopting it would suppress a later visible signal on
  a different axis. Returns null when no plot has a visible series.
- **Visibility changes refresh the readout.** `graphShowVolumeTimecourse` and
  `setSignal({ display })` call `refreshSignalLocation()` after redraw, so the
  footer doesn't keep reporting a just-hidden trace; when every trace is hidden the
  readout is cleared (empty `signalLocationChange`) rather than left stale.
- **Explicit x-range wins over a stale zoom window (default).** The transient
  `signalViewWindow` (pan/zoom) is a sub-range of the current x-domain. When
  `setSignal({ display })` MOVES that domain — an explicit `ppmRange`, a ppm<->Hz
  switch (`useHz`), or a ppm reference shift (`ppmRef`) — the controller resets
  `signalViewWindow = null` so the explicit range is shown in full and zoom/pan
  restart from it (otherwise the leftover window clamps against the new domain and
  the range control, e.g. svs.html's ppm sliders, looks dead). The check is
  by-value (`sameRange`), so re-applying the same display (nudging an unrelated
  slider like apodization/phase) keeps the current zoom; physio per-trace toggles
  never touch these fields, so they preserve it too. This reset is gated on
  `graphAutoResetView` (default true; flat constructor option + setter).
- **Reactive range (two-way sync) for hosts that want it.** A host UI (range
  sliders) can mirror the in-graph pan/zoom: the `graphRangeChange` event fires on
  every visible-range change (zoom/pan/reset/wheel-follow/auto-reset) with
  `{ min, max, full, axisLabel, isWindowed }`; `getGraphRange()` is its synchronous
  read. The host sets the window from a range control via `setGraphRange([lo,hi] |
  null)` (clamped to the full extent; null = full). The intended reactive recipe
  (illustrated by the `Reactive` checkbox in `examples/svs.html` and
  `examples/mrsi.html`): turn OFF `graphAutoResetView`, drive the window with
  `setGraphRange` instead of `ppmRange`, and update the slider positions from
  `graphRangeChange` (setting an `<input>` `.value` does not fire `input`, so no
  feedback loop). `MrsScene.setPpmWindow` flows through `setSignal`, so the MRSI demo gets the default reset for free and adds the reactive toggle on top.
- **Style setters clamp.** `graphLineWidth` to finite `[0,8]`, `graphLineAlpha` to
  `[0,1]` (no NaN/Infinity into the line buffer). All three new graph settings
  (`graphShowVolumeTimecourse`/`graphLineWidth`/`graphLineAlpha`) also have flat
  constructor options (`NiiVueOptions`), matching `graphNormalizeValues`.

Graph line style (`ui.graph`, controller `graphLineWidth` / `graphLineAlpha`):
`lineWidth` is a RELATIVE multiplier on the DPI-scaled base thickness (default 1;
`<1` thins dense traces so they stop overlapping; grid/axis lines unaffected).
`lineAlpha` (0..1, default 1) makes the multi-series DATA lines translucent so
overlapping traces are readable at intersections (legend/rug stay opaque). Both
applied in `view/NVGraph.ts`; the line renderer already alpha-blends (the cursor
draws at 0.5). Additive blending is NOT used (translucency was chosen as
background-independent; additive would need a graph-pass blend-mode change).

Signal contracts (keep these true):

- NIfTI routing to signals is dims-only (`signal/detect.ts`: dim1-3 == 1 and
  dim4 > 1); MRS sidecar or header fields do not route, and a spatial MRS file
  stays a volume (the reader throws if forced with `asSignal`).
- `volumeTR` and the physio-NIfTI sampling rate read the time unit from
  `xyzt_units`.
- `svs_se_30.json` is a hand-written minimal sidecar (`SpectrometerFrequency`,
  `ResonantNucleus`, `DwellTime`). Do not replace it with a raw dcm2niix dump:
  that brings back DICOM identifiers. Scrub any DICOM-derived sidecar added
  under `packages/dev-images/` before a demo ships it.
- `createSignal` and `setSignal` clone the annotations they receive
  (`cloneAnnotation`), color tuple included.
- `examples/svs.html` runs `applyScene` calls one at a time through a promise
  chain, and only the latest queued mode runs.
### MRSI (spatial spectroscopic imaging)

MRSI/CSI is a **complex 4-D volume** (dim1-3 = space, dim4 = FID), so it stays
on the **volume path** (not the 1-D signal reader, which throws on spatial MRS).
`volume/mrsi.ts` (`isMrsiVolume`/`prepareMrsiVolume`, wired into `nii2volume`)
detects a complex spatial 4-D NIfTI and replaces its `img` with a derived scalar
**total-signal map** (integral of `|spectrum|` over the nucleus' `PPM_RANGE`,
`halveFirstPoint` on), while **retaining the raw complex FID + spectral metadata
on the NVImage** (`complexFID` / `mrsMeta`). The complex buffer is CPU-only —
the GPU only ever sees the scalar map, so texture handling is unaffected.

Complex decode + the NIfTI-MRS ecode-44 parse are shared between the SVS signal
reader and the MRSI volume path via `signal/mrs.ts` (`isComplexDatatype`,
`decodeComplexFID`, `mrsFromHeaderExtensions`).

The **crosshair-voxel spectrum** reuses the signal graph: `addMrsiSignal(volumeId)`
adds a spectroscopy `NVSignal` with `followsCrosshair = true` + `attachedToId`
pointing at the MRSI volume. In `collectSignalGraphData`, `plotFor` ->
`crosshairSpectroscopyPlot` extracts the crosshair voxel's FID
(`extractVoxelFid`, using the volume's `img2RASstart`/`step` native mapping) and
re-derives the spectrum **fresh every collect** (not memoized — one 1024-pt FFT
per frame is cheap and keeps the cursor live without the display-keyed plot
cache going stale). Moving the crosshair triggers `drawScene` -> render ->
`collectGraphData`, so the spectrum tracks the crosshair like the fsleyes MRS
plugin. `refreshSignalLocation()` re-emits `signalLocationChange` on every
crosshair/frame change (not just a graph-cursor click), so a host can show the
ppm/spectrum readout live; `examples/mrsi.html` combines it with `locationChange`
to display world-space mm location + voxel/map values alongside the ppm/spectrum.

FSL-MRS spectral transforms live in `signal/processing.ts`: `halveFirstPoint`,
`apodize` (exp line-broadening), `phaseCorrection` (0th deg / 1st ms), the
`GYRO_MAG_RATIO`/`PPM_SHIFT`/`PPM_RANGE` constants, and `integratePpmBandMap`
(the range->map engine, also the default-display-map engine). All new display
flags (`halveFirstPoint`/`apodizeHz`/`phase0`/`phase1Ms`) default off/0 so the
`svs.html` baseline is unchanged; parity-tested against fsleyes in
`processing.test.ts`. The FSL-MRS workflow + range->map tool + scene controller
are provided by the core `MrsScene` controller (demo `examples/mrsi.html`);
`context.mrs` (`MrsVolumeAccess`, first MRSI volume) / `context.mrsById(id)`
(multi-MRSI safe) expose the complex buffer read-only.
Fit-results overlays are deferred (no results dataset). Ported from
fsleyes-plugin-mrs (BSD-3) — provenance in `PORTING.md`.

Audit-hardened invariants (keep these true):
- **Detection is metadata-gated.** `isMrsiVolume` requires complex + spatial +
  dim4>1 AND NIfTI-MRS ecode-44 fields (`hasMrsFields`), so a non-MRS complex
  4-D volume (e.g. complex fMRI) is NOT silently rewritten into a scalar map.
- **Truncation-safe.** `prepareMrsiVolume` clamps `nPoints*nTransients` to the
  bytes present and `integratePpmBandMap` guards reads with `?? 0` (no NaN map).
- **Crosshair spectrum vs map transients.** `extractVoxelFid` transposes the native
  point-major MRSI buffer to SVS transient-major (`2*(t*nPoints+p)`) and emits all
  transients; `crosshairSpectroscopyPlot` passes the real `nTransients` so
  `deriveSeries` averages identically to `integratePpmBandMap` — keep these two
  reductions in sync or the spectrum and a generated map disagree for `nTransients>1`.
- **Not `isImaginary`.** The derived scalar overlay must NOT set
  `volume.isImaginary` (it's a real map; the complex data is in `complexFID`) —
  otherwise `control/locationTracking` appends a bogus imaginary readout.
- **No fake placeholder.** An unresolved `followsCrosshair` signal (volume
  removed / off-grid / NVD reload without `complexFID`) is dropped from the
  graph (`plotFor` returns null), never drawn as a flat zero-FID line.
- **NVD limitation:** `complexFID`/`mrsMeta` are NOT serialized to NVD (only the
  derived scalar `img`); a reloaded crosshair spectrum is unavailable until the
  MRSI volume is re-added. Persisting the ~18 MiB buffer is deferred by design.
- **Mask is modulated, not baked.** `MrsScene.setMaskEnabled` calls
  `setModulationImage(mrsiId, maskId, 1)` (alpha) — the mask is loaded as a
  hidden volume (`opacity 0`, `calMin/calMax 0..1`) and consumed as the
  modulator; the core scalar-overlay modulation path (see Volume modulation
  above) makes out-of-mask voxels transparent in the GPU prepass. No more
  sentinel bake, buffer-swap, or `unmaskedMap`/`maskRAS` shadow copies.
- **Mask also applies to generated maps.** `setMaskEnabled` modulates the MRSI
  overlay AND every `makeMap` overlay (tracked in `mapIds`); a new `makeMap` while
  the mask is on inherits it. `sameGrid` is a dims heuristic and an **extension
  policy** (warn + skip on mismatch), NOT a core-modulation limit — core samples
  the modulator through the transform matrix and tolerates any co-registered grid.
- **`MrsScene` lifecycle.** `load()` is idempotent: it removes this scene's prior
  crosshair signal (via `removeSceneSignal`, which is scoped by
  `attachedToId === mrsiId && followsCrosshair` — NOT the first global
  `followsCrosshair` signal) and resets `mrsiId`/`maskId`/`maskEnabled`/`mapIds`
  before reloading. The `mrs` getter returns null (no global fallback) when
  `mrsiId` is null. `dispose()` removes the scene signal + detaches the snap
  listener. KNOWN GAP: the scene's volumes (MRSI grid, hidden mask, generated
  maps) are NOT removed on reload-without-anatomy or dispose — the controller
  exposes no single-volume removal to extensions (only `removeAllVolumes`); the
  demo always reloads with anatomy (`loadVolumes` -> `removeAllVolumes` clears
  them). Exposing per-volume removal to extensions is a tracked follow-up.

Deferred MRSI follow-ups: (1) `MrsScene.load()` is non-transactional — a throw after a
volume is added orphans it (same root cause as the per-volume-removal gap above);
(2) `setMaskEnabled`/`makeMap` fan `setModulationImage` over `[mrsiId, ...mapIds]`
with `Promise.all`, so a mid-fan rejection can leave some overlays modulated while
`maskEnabled` rolls back (fix: sequential apply with inverse-rollback);
(3) `integratePpmBandMap` runs a synchronous per-voxel FFT — fine for the demo
grid, but move map generation to a Web Worker before MRSI scales to clinical CSI
sizes. Provenance/licensing is settled: `package.json` ships
`LICENSE.fsleyes-plugin-mrs` + `PORTING.md`, and the root `LICENSE` acknowledges
the BSD-3 upstream. The MRS API is exported from all three entry subpaths
(`index.ts`, `index.webgpu.ts`, `index.webgl2.ts`).
