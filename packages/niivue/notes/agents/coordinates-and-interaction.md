# Coordinates, layout and interaction

Moved from `packages/niivue/AGENTS.md`; read it when working on picking, pan/zoom, crosshair moves, drag modes or slice layout. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Coordinate systems

Two distinct fractional [0..1] spaces — do not conflate:

- **Scene fraction**: [0,1]³ within scene AABB. Used for `crosshairPos`. Conversion: `NVModel.scene2mm()`/`mm2scene()` — linear interp between `extentsMin`/`extentsMax`.
- **Volume texture fraction**: [0,1]³ within a single volume's 3D texture (voxel centers at `(i+0.5)/dim`). Per-image: `NVImage.frac2mm` mat4. Model caches background volume's matrices as `NVModel.tex2mm`/`mm2tex`.

All overlay volumes are resliced to match the background volume's grid, so `tex2mm`/`mm2tex` apply to all loaded overlays.

**MM space** is the common ground. Depth picker → mm → scene fraction for `crosshairPos`. `getSliceTexFrac()` converts scene fraction → texture fraction for the slice coordinate.

### 2D slice picking

Each `SliceTile` caches `mvpMatrix`, `planeNormal`, and `planePoint` during render. `screenSlicePick` uses these for fast ray-plane intersection. For mosaic tiles with `sliceMM`, uses `getSliceTexFracAtMM()` instead of crosshair. Depth picking (double-click on 3D tiles) reads back depth buffer and unprojects to mm-space; when it misses (e.g. no volume) and a slide plane is set, the crosshair goes to the plane hit (`pickSlideWorld`).

### 2D pan/zoom (`pan2Dxyzmm`) — external dependency

`scene.pan2Dxyzmm` is `[panX_mm, panY_mm, panZ_mm, zoom]`. `calculateMvpMatrix2D` applies it so the **visible width = volumeWidthMM / zoom** centered at **volumeCentreMM − pan**. An external consumer — the DICOM-WSI / OpenSeadragon viewer (`apps/iiif-volumetric-demo`) — *inverts* this convention to drive deep-zoom navigation of whole slides. **Before changing the 2D pan/zoom math or the wheel-zoom anchoring, read the integration contract in `notes/dicom-wsi.md` §7** — those formulas are pinned to this behavior.

The built-in wheel zoom (`control/interactions.ts`, `isPanZoomMode` branch) anchors on `crosshairPos` by default. It holds that point still by calling `NVTransforms.zoomPan2DAbout`, which is the exact inverse of the window `calculateMvpMatrix2D` builds: `pan' = (zoom / newZoom) * (d + pan) - d` with `d = anchorMM - extentCentre`. Keep the two in step — a change to the ortho window's zoom or pan handling must be mirrored there, or the crosshair drifts again (issue #68). The anchor is resolved by `control/wheelZoomAnchor.ts` (`resolveWheelZoomAnchorMM`, unit-tested): `interaction.wheelZoomAnchor` is `'crosshair'` (default, unchanged) or `'pointer'` (issue #157), which anchors at `screenSlicePick` under the pointer and falls back to the crosshair when the pick misses.

**`pan2Dxyzmm` is a `vec4` (Float32Array) — never test a value read back out of it
for exact equality** (0.4 returns 0.40000000596). `stepZoom2D`
(`src/math/NVTransforms.ts`) detects a stalled zoom notch with
`Math.abs(next - zoom) < ZOOM_2D_SNAP / 2`, not `next === zoom`: the float32
round-trip made the equality unreachable, jamming the wheel zoom at 0.4 in both
directions. Pinned by `bothEndsOfTheRangeAreReachable` in `NVTransforms.test.ts`.

## Crosshair navigation

**`moveCrosshairInVox(di, dj, dk)`**: Steps crosshair by discrete voxels in RAS-resampled ijk space. Snaps to voxel centers via mm→vox (rounded)→mm round-trip.

**Scroll wheel**: Steps one voxel in depth direction (AXIAL→k, CORONAL→j, SAGITTAL→i). Mesh-only: 1% of scene extent. Over a legend with more rows than fit, the wheel scrolls the legend instead (see Legend visibility).

**Keyboard**: H/L/J/K step crosshair in RAS axes on 2D slices; rotate azimuth/elevation in render-only mode.

## Drag modes

Configurable drag interactions on 2D slices. `interaction.primaryDragMode` (default: `crosshair`) for left-button, `interaction.secondaryDragMode` (default: `contrast`) for right-button. 3D tile: left=rotate, right=clip plane. Module: `control/dragModes.ts`.

`DRAG_MODE` enum: `none`(0), `contrast`(1), `measurement`(2), `pan`(3), `slicer3D`(4), `callbackOnly`(5), `roiSelection`(6), `angle`(7), `crosshair`(8), `windowing`(9), `crosshairPan`(10).

`crosshairPan` is a single-button touch/trackpad mode: press and release without moving more than `crosshairPanThresholdCssPx` (4 CSS px, scaled to canvas pixels) places the crosshair at the release point like `crosshair`; moving further pans like `pan`, and the gesture then stays a pan. A `pointercancel` never places the crosshair.

Public enum exports from the package root (alongside `DRAG_MODE`): `SLICE_TYPE` (axial/coronal/sagittal/multiplanar/render/none — `none` skips the spatial pass so a signal graph fills the canvas, see "signal mode" in `signals.md`), `MULTIPLANAR_TYPE` (auto/column/grid/row), `SHOW_RENDER`, and `NiiDataType`.

**NVSlide panes** use `NVSlideController` (`src/slide/slideController.ts`) with the same primary/secondary modes (`pan`, `crosshair`, `crosshairPan`, `windowing`, `contrast`, `measurement`, `roiSelection`, `none`). There `roiSelection` is a zoom box, fit on release and capped at native resolution (one base pixel per device pixel); the middle button always pans, the wheel and a two-finger pinch zoom about the pointer, and a double-click zooms 2x (shift: out) while the primary mode is `pan`, within 4 px of the last press the controller took (a widget over the canvas takes its own). `middleDragMode`, `otherButtonDragMode` (buttons 3/4, default `none`), `isContextMenuBlocked`, `isPinchZoom` (default true), `wheelZoomRate` and `isWheelDeltaModeScaled` (line/page deltas to px, default true) let a host keep its own button and wheel behaviour (nv-ohif runs its tool on every button, no pinch, raw deltas); `cancelGesture()` ends a gesture without committing it. Without `onWindow` / `onContrast`, a windowing drag or contrast box sets `windowChannel`'s window itself (stored units; `windowDragStep` is the maths). `callbackOnly` reports the drag to `onDrag`.

**Slide viewer shell.** `createSlideView(canvas, opts)` (`src/slide/slideView.ts`) owns one standalone slide pane: renderer (WebGPU then WebGL2, or the reverse with `backend: 'webgl2'`), the rAF loop (plus a 100 ms timer, as rAF pauses in a hidden tab), resize (ResizeObserver) and pixel-ratio watch, fit on the first sized frame and again on resizes until the viewport moves, the controller and its overlay, composable `addOverlay` (UIKit) and `addRenderListener`, and one idempotent `destroy`. `controllerOverlay: false` leaves the rulers to the host. A WebGL2 start that gets no context after a WebGPU attempt retries once on a cloned canvas (`view.canvas`), and puts the original back if that fails too. It owns the slide (`setSlide` and `destroy` dispose the one they release) and its renderer, but not the canvas. It holds no format policy or app state. Backend factories are bound per entry (`slideViewWebGL2.ts`, `slideViewWebGPU.ts`, `slideViewBoth.ts`, as `control/view*.ts`), so `createSlideView` is the fourth sanctioned line where the two backend entries differ. `linkSlideViews` syncs viewports in mm when every slide states `pixelSpacingMM`, else as fractions of each slide, with echo suppression; `attachSlideLens` (also `slide/slideView.ts`) shows a second linked view through a pointer-following circle. UIKit's `attachSlidePlaneControl` (`uikit/src/slideView.ts`) adds z/t sliders over the plane contract (`planes`, async `setPlaneIndex`), hidden for a fixed source. `formatSlideSample` and `slideStatsSummary` are the readout and HUD text. UIKit adds `attachSlideMinimap`, `attachSlideHud` and `attachSlideChannelPanel`.

**NVSlide request owners and planes.** Every tile load belongs to request owners (`slide.createRequestOwner(kind)`: `readout`, `view`, `plane3d`, `thumbnail`, `prefetch`, ranked 0, 1, 1, 2, 3); `owner.want(tiles, focus)` replaces its set each frame and `release()` drops it. A load is shared by its owners and cancelled (dequeued, or aborted in flight) when the last leaves; the queue serves (rank, distance to focus, age) with every 4th dequeue the oldest non-view load (`slide/slideLoadQueue.ts`). `requestTile` is gone. The 2D view, its coarse coverage (`prefetch`), thumbnails, the 3D plane (`SlidePlaneState.owner`, released by `releaseSlidePlane`) and `loadSampleAt` each own their loads; `_wanted` stays within tile capacity. LOD is one rule for 2D and 3D (`slideLod.pickLevel`, 1.1 hysteresis). Tile keys are `z<z>t<t>/L<i>/<x>/<y>`, produced only by `slide.tileKey`; `setPlaneIndex` is async, holds the old plane until the new plane's visible tiles are resident, then switches whole. Events: `tileerror`, `levelchange`, `idle`, `planechange`, `change`.

**NVSlide pixel readout.** `slide.sampleAt(x, y, {level?})` (base-level pixels, as `screenToSlide` returns) is synchronous and cache-only: it reads the finest resident tile (or level `index` `level`) through `_cache.peek`, never fetches, and leaves the LRU order and `cacheHits` alone, so hover can call it. `loadSampleAt(x, y, {level?, signal?})` fetches that level's covering tile (default 0) first through a one-shot `readout` request owner; `signal` stops the wait and cancels the load unless another owner wants it. Both return one `NVSlideSample` per channel: `stored` is the cached sample (before window, MONOCHROME1 inversion and ICC; bitmap-only RGB tiles are read back 1x1), `value` maps it through `NVSlideChannelInfo.storedToValue` when the source quantized it, and `exact` means level 0 and not quantized. `missing` is `outside`, `hole`, `uncached` or `hidden` (hidden channels are never fetched). Scalar tiles are read from `samples` only, so the readout survives dropping their RGBA bitmaps (#159). On a slide plane, `createOnLocationChange` passes `nv.slideSampleAt()` (the crosshair projected orthogonally onto the plane by `worldToSlidePixel`, so a crosshair off the plane's depth still reads the pixel under it) to `buildLocationMessage` as `NiiVueLocation.slide`; a scene with only a slide plane emits too. The plane's `change` listener re-emits only when those samples (level, stored, missing) differ from the last emitted ones, about once per level, never per tile. `NVSlideController.onHover(point | null)` fires on a gesture-less `pointermove`, at most once per frame (rAF, latest point; a high-rate mouse fires several moves per frame), and with null at once on `pointerleave`, cancelling a pending frame; the app calls `sampleAt`. nv-mcp reads it through `View.slideSampleAt` / `loadSlideSampleAt` (`where_am_i.slide`, `sample_slide`).

**NVSlide modules.** `NVSlide.ts` keeps the slide state and load queue; the rest is split under `src/slide/`: `slideSource.ts` (the `SlideTileSource` contract, optional `SlidePlaneCapable` for z/t planes, `ManifestRangeSource`, the `tileDecoders` registry incl. `raw-gray`), `slideChannels.ts` (`toValue`/`toStored` through `storedToValue`, default channels and windows, the single-channel `channelInfo` rules), `slideLod.ts` (level choice, tile span and capacity), `slideThumbnail.ts` (CPU composite of a level). Its tile cache is a core `ByteLru` (`src/byteLru.ts`) that closes bitmaps on eviction. `dispose()` aborts loads, disposes the source when it owns it (`ownsSource`, default true; a throwing constructor leaves it with the caller) and clears the cache last, even if the source's dispose throws, so `loadSampleAt` waiters settle. Renderers state their tile texture and raw pool bytes with `setRendererBudget`, through `SlideBudgetRegistration` (`slideFuse.ts`): `sync(slides)` per draw, `clear()` on destroy, and the views clear the plane renderer's when the slide plane is removed or replaced. `SlideRenderer.render(slides, screen)` and `SlideRendererGPU.render` are the only entry on both backends (the GL `draw(gl, ...)` is removed; `SlideRenderer` no longer extends NVRenderer). Both consume one backend-neutral frame plan (`slide/slideTiles.ts`): background, fallback coarsest first, then targets, with every upload and fuse before the first draw.

**Overlay rendering:** Selection boxes use GlyphBatch panels (`_dragOverlay.rect`). Measurement/angle lines use line renderer (`_dragOverlay.lines`). Overlay state lives on `model._dragOverlay` (transient, not serialized).

**Drawing priority:** When `draw.isEnabled && drawingVolume`, drawing intercepts left-button before drag mode dispatch.

## Slice layout system

Pure-data layout engine in `view/NVSliceLayout.ts`. Computes `SliceTile[]` from `SliceLayoutConfig`. Both backends call `screenSlicesLayout()` once per frame.

Priority: mosaic string > render-only > single slice > hero layout > multiplanar.

**Layout inset** (`layoutInset`, model `layout.inset`, [left, top, right,
bottom] CSS px, default zeros): tiles, colorbar, legend, graph and the header
label lay out inside the canvas minus the inset, so an in-canvas control panel
(the uikit controls demo's "Own panel") owns that strip. Both views compute
the rect once per frame with `NVSliceLayout.insetRect` (times `_dpr`; a bad
side counts as 0), pass its size where the canvas size went, and shift the
results: `fitSlicesFromModel(..., origin)` moves the tiles, `legendLayout.y` /
`.x` take the offset, `translateGraphLayout` moves the graph, and the colorbar
renderers' `setContentRect` sets `ColorbarLayout.originX/Y` (they keep the full
size for NDC). In `instances` mode a tile without `bounds` takes the inset
rect too; an instance's own `bounds` are left alone (the caller placed it). Overlay renderers still get the whole view, and picking needs
nothing (it reads tile rects). Not `bounds`: a bounded view clips its overlay
and drops pointer events outside, and on WebGPU renders to an offscreen copy.

The scale ruler (`view/NVRuler.ts`) takes px-per-mm from `mmPerPixel2D` so it
tracks the 2D zoom (`pan2Dxyzmm` is threaded in by both renderers), and reads
`screen.fovMM` as tile-local `[u, v, depth]`. Pinned by `view/NVRuler.test.ts`.
With no 2D tile and a `setSlidePlane` slide, both views pass the render scale
(`mmPerPixelRender`, orthographic so rotation-independent) and the ruler draws
on the render tile. Standalone NVSlide panes get the same bar from
`slideOverlayContent(slide, screen, source, { isRulerVisible: true })`:
bottom-left, `slideScaleBar` picks the length from `pixelSpacingMM[0]` and
`viewport.scale` (labels "um" below 1 mm, the font has no µ), none without
spacing; `scaleBarLines` is shared with `NVRuler`, so no shader change.
`rulerUnits` (`'auto' | 'nm' | 'um' | 'mm' | 'cm'`, default `'auto'`) fixes the
bar's unit for both; mosaic render tiles get the bar from their own screen
bounds, and `global3d` tiles get none (their camera is perspective, owner
decision).

**`SliceTile`** key fields: `leftTopWidthHeight`, `axCorSag`, `screen` (ortho mm bounds), `azimuth`/`elevation`, `sliceMM` (mosaic mm position), `renderOrientation`, `crossLines`, `showLabels`. Cached `mvpMatrix`/`planeNormal`/`planePoint` populated during render for picking.

### Single-slice canvas fill (`isSingleViewFillCanvas`, default **true**)

A lone AXIAL/CORONAL/SAGITTAL tile takes the whole canvas instead of being
letterboxed to the slice's aspect ratio; the stored mm window
(`screen.mnMM`/`mxMM`/`fovMM`, in-plane indices 0 and 1) is widened about its own
centre by the same ratio. Scale (mm-per-pixel) and centre are unchanged — the slice
lands on identical pixels — only the clipping rect grows, so a zoom spends the old
letterbox margins on image instead of cropping them away. Excluded: multiplanar,
render, mosaic, hero, custom layouts.

- **The widened span is stored PRE-zoom**, and the fill branch is taken only for a
  positive finite fit scale. A window sized from the live zoom reintroduces the
  crosshair drift of issue #68 (`zoomPan2DAbout` assumes a fixed window that zoom
  narrows); a zero/infinite scale puts NaN mm bounds in the projection. A filled
  slice also leaves `fitSlicesAndGraph` no letterbox slack to give the 4D graph.
  All pinned in `view/NVSliceLayout.test.ts`.
- **`fovMM` stays the DATA's span; only `mnMM`/`mxMM` widen.** They are equal on
  every other tile. Chrome that must size against the image rather than the empty
  margin reads `fovMM` (the scale ruler does, or its bar outgrows a small volume);
  anything projecting the window reads `mnMM`/`mxMM`.
- **No edge-voxel smear into the new margins.** Both backends draw a unit quad in
  TEXTURE space (`gl/sliceShader.ts`, `wgpu/slice.wgsl`), so its corners are the
  volume's mm extents and sampler wrap mode is unreachable.
- **The whole canvas is a live tile.** `hitTest`/`screenSlicePick` clamp to the
  TILE, which used to equal the volume extents, so picks in the former letterbox
  margin land outside the volume. `setCrosshairPos` clamps frac to [0,1] and
  `buildDragReleaseInfo` clamps voxels to `dimsRAS` (its mm fields stay unclamped —
  they describe the real gesture), but a PEN stroke straying into blank margin
  paints the boundary voxel rather than missing, because `drawPoint` clamps.
- **Old documents reopen filled.** `documentSettings.fillGroup` writes
  `LAYOUT_DEFAULTS` for any key a document omits, and `loadDocument` resets an
  explicit `false` unless called with `{ fill: 'current' }`. Standard for every
  layout default; noted because this one is visible.
- **Plumbing follows the `isRadiological` pattern**; NVDocument serializes the
  layout group generically. Model-to-config mapping lives ONCE in
  `NVSliceLayout.fitSlicesFromModel`, which both renderers call — a flag threaded
  into one backend is a parity break.

### Mosaic string format

`layout.mosaicString` tokens: `A`/`C`/`S` (orientation), `R` (3D render), `X` (cross-lines), `L`/`L-` (labels), `;` (row break), `<number>` (mm position). Negative mm on render tiles adds 180 to azimuth. Example: `A -20 0 20 ; S R X 0 S R X -0`.

### Hero layout

`layout.heroFraction` (0–1) splits canvas: hero tile (left) + multiplanar A+C+S (right). `layout.heroSliceType` selects hero content.

### Mosaic tile rendering differences

- **`sliceMM`**: Uses `getSliceTexFracAtMM()` instead of crosshair-based `getSliceTexFrac()`.
- **Crosshairs/orient cube suppressed** on mosaic tiles.
- **Rotation-stable framing**: Mosaic render tiles pass `origin` to `calculateMvpMatrix2D`.
