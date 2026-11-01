# NiiVue API Style Guide

## Naming Conventions

### Boolean Properties
All boolean properties MUST use a verb prefix:
- `is` for state or visibility: `isColorbarVisible`, `isRadiological`, `isEnabled`
- `has` for possession (rare): `hasAttachment`

Never use bare adjectives or nouns for booleans:
- YES: `isLegendVisible`, `isFillOverwriting`, `isSnapToVoxelCenters`
- NO: `showLegend`, `drawFillOverwrites`, `forceMouseClickToVoxelCenters`

### Property Names
- camelCase for all properties: `calMin`, `calMax`, `crosshairPos`
- No snake_case, even for properties originating from external standards
- **Model groups** drop redundant prefixes (context is provided by the group):
  - `model.draw.penValue` not `model.draw.drawPenValue`
  - `model.mesh.xRay` not `model.mesh.meshXRay`
  - `model.volume.illumination` not `model.volume.volumeIllumination`
- **Controller flat API** uses the full prefixed name (no grouping context):
  - `nv1.drawPenValue` (maps to `model.draw.penValue`)
  - `nv1.meshXRay` (maps to `model.mesh.xRay`)
  - `nv1.volumeIllumination` (maps to `model.volume.illumination`)
- Boolean `is`/`has` comes AFTER the domain prefix:
  - `volumeIsAlphaClipDark`, `drawIsEnabled`, `drawIsFillOverwriting`
  - NOT `isVolumeAlphaClipDark`, `isDrawEnabled`
- The `graph` sub-object is flattened: `graphNormalizeValues`, `graphIsRangeCalMinMax`
- `tileMargin` (flat) maps to `layout.margin` (internal model)

### Method Names
- camelCase: `loadVolumes`, `setVolume`, `drawUndo`
- Use verbs: `load`, `set`, `get`, `create`, `close`, `save`, `remove`, `add`
- Prefer property setters over setter methods for single-value changes

## Model Organization

The model is organized into 8 config groups internally:

| Group | Purpose | Example Properties |
|-------|---------|-------------------|
| `scene` | Camera, crosshair position, clip planes, background | `azimuth`, `elevation`, `backgroundColor` |
| `layout` | Slice type, mosaic, multiplanar, hero, tiling | `sliceType`, `mosaicString`, `heroFraction` |
| `ui` | Visual chrome: colorbars, orient labels, fonts, measurements | `isColorbarVisible`, `crosshairWidth`, `fontScale`, `placeholderText` |
| `volume` | Global volume rendering settings | `illumination`, `isNearestInterpolation` |
| `mesh` | Global mesh rendering settings | `xRay`, `thicknessOn2D` |
| `draw` | Drawing/annotation settings | `isEnabled`, `penValue`, `opacity` |
| `interaction` | Drag modes, mouse behavior | `primaryDragMode`, `isSnapToVoxelCenters` |
| `annotation` | Vector annotation settings | `isEnabled`, `activeLabel`, `brushRadius`, `tool` |

Properties that don't belong in any group (computed geometry, data arrays, transient state) stay on the model root.

## Controller API (Flat)

The controller exposes a **flat API** -- no nested groups. Each property setter calls `drawScene()` directly (no reactive proxies).

### Property Access
```js
// Reading
const az = nv1.azimuth
const visible = nv1.isColorbarVisible

// Writing (triggers drawScene automatically)
nv1.azimuth = 110
nv1.isColorbarVisible = true
nv1.drawPenValue = 3
```

### Prefix Rules

| Domain | Prefix | Examples |
|--------|--------|---------|
| Scene, layout, UI, interaction | None | `nv1.azimuth`, `nv1.sliceType`, `nv1.isColorbarVisible`, `nv1.primaryDragMode` |
| Volume | `volume` | `nv1.volumeIllumination`, `nv1.volumeIsAlphaClipDark`, `nv1.volumeIsNearestInterpolation` |
| Mesh | `mesh` | `nv1.meshXRay`, `nv1.meshThicknessOn2D`, `nv1.meshCrosscutWidth` |
| Draw | `draw` | `nv1.drawPenValue`, `nv1.drawOpacity`, `nv1.drawIsEnabled` |
| Annotation | `annotation` | `nv1.annotationIsEnabled`, `nv1.annotationTool`, `nv1.annotationBrushRadius` |

### Complete Property List

**Scene** (no prefix -- delegate to `model.scene`):
`azimuth`, `elevation`, `crosshairPos`, `pan2Dxyzmm`, `scaleMultiplier`, `gamma`, `backgroundColor`, `clipPlaneColor`, `isClipPlaneCutaway`

**Layout** (no prefix -- delegate to `model.layout`):
`sliceType`, `mosaicString`, `showRender`, `multiplanarType`, `heroFraction`, `heroSliceType`, `isEqualSize`, `isMosaicCentered`, `tileMargin`, `isRadiological`, `isSingleViewFillCanvas`

**UI** (no prefix -- delegate to `model.ui`):
`isColorbarVisible`, `isOrientCubeVisible`, `isOrientationTextVisible`, `is3DCrosshairVisible`, `isGraphVisible`, `isRulerVisible`, `isCrossLinesVisible`, `isLegendVisible`, `isMeasureUnitsVisible`, `isThumbnailVisible`, `thumbnailUrl`, `placeholderText`, `crosshairColor`, `crosshairGap`, `crosshairWidth`, `fontColor`, `fontScale`, `fontMinSize`, `selectionBoxColor`, `measureLineColor`, `measureTextColor`, `rulerWidth`, `graphNormalizeValues`, `graphIsRangeCalMinMax`

**Volume** (prefix `volume` -- delegate to `model.volume`):
`volumeIllumination`, `volumeRenderMode`, `volumeCinematic`, `volumeOutlineWidth`, `volumeAlphaShader`, `volumeIsBackgroundMasking`, `volumeIsAlphaClipDark`, `volumeIsNearestInterpolation`, `volumeIsV1SliceShader`, `volumeOverlayAlphaBlend`, `volumeOverlayColorBlend`, `volumeMatcap`, `volumePaqdUniforms`

`volumeRenderMode` takes a `VOLUME_RENDER_MODE` and applies to the 3D render only:

| Value | Mode | What it draws |
|-------|------|---------------|
| `COMPOSITE` (0, default) | emission-absorption OVER | a solid, depth-ordered object |
| `MAXIMUM` (1) | maximum-intensity projection | the brightest sample per ray, through everything in front of it |
| `SLICES` (2) | orthogonal slices | the three crosshair planes, composited front to back |
| `CINEMATIC` (3) | progressive path tracing | anatomy with soft shadows and ambient occlusion, plus statistical overlays or a label volume |

`SLICES` does not ray-march: it takes at most three samples per ray, so it is
the cheapest 3D view. Overlays, PAQD and the drawing are sampled on the planes
the way the 2D tiles blend them; clip planes and all lighting are ignored.

`CINEMATIC` refines over `volumeCinematic.maxFrames` frames, redrawing itself
until done. Its transfer function is volume 0's colormap mapped across its
calMin..calMax; the optional colormap keys `E` (edge alpha), `S` (specular),
`gradient` `{lo, hi}`, `gMax`, `shininess` and `labelBlend` (see `ColorMap`)
make it 2D (intensity x gradient), and `addColormap` keeps them. The first drawn
label volume on volume 0's grid supplies per-label materials (`S`, `lo`/`hi`
surface ramp, `surface`, and `normalize` to calibrate uncalibrated intensities;
calibrated volumes use the colormap's own `min`/`max`), and its `hiddenLabels`
hide structures. Without visible label, PAQD or streamed overlays, standard overlays use the same
registration, colormaps, positive/negative thresholds, opacity and visibility
as the other render modes (`loadVolumes` / `setVolume`). They are unlit volumes,
mixed by depth; `clipPlaneOverlay` clips them with the anatomy when enabled;
`gamma` and `isOverlayOpacityCorrected` (per overlay voxel, so anisotropic
voxels match `COMPOSITE`) apply. They reuse the existing overlay texture and do
not cast anatomical shadows. A hidden background (`opacity: 0` or
`visible: false`) still shows the overlays. Not drawn: statistics mixed with a
visible label volume (the labels draw, one warning), PAQD and streamed overlays
(one warning) and channel stacks. Meshes and the crosshair composite by depth. A
chunked background draws `COMPOSITE` (one warning). Memory:
a duplicate r16float intensity texture, an rgba16float gradient and a half-res
extinction texture. Both backends; WebGL2 needs `EXT_color_buffer_float` (else
`COMPOSITE`, one warning). `volumeCinematic.isStochasticLighting` (default
false) traces shadow and AO from one sample per ray per frame: about 2.5x
faster per frame, noisier early frames, nearly the same converged image.
`nv.cinematicFrameMs` reads the mean GPU ms per
refinement frame (first 10 frames after a change; null without GPU timers).
Demo: `examples/cinematic.html`.

```js
nv.volumeRenderMode = VOLUME_RENDER_MODE.CINEMATIC
nv.volumeCinematic = { shadow: 0.8, ao: 0.6, labelMode: 'only' } // merged
```

**Mesh** (prefix `mesh` -- delegate to `model.mesh`):
`meshXRay`, `meshThicknessOn2D`, `meshCrosscutWidth`

**Draw** (prefix `draw` -- delegate to `model.draw`):
`drawIsEnabled`, `drawPenValue`, `drawPenSize`, `drawIsFillOverwriting`, `drawOpacity`, `drawRimOpacity`, `drawColormap`

**Interaction** (no prefix -- delegate to `model.interaction`):
`primaryDragMode`, `secondaryDragMode`, `isSnapToVoxelCenters`, `isYoked3DTo2DZoom`, `isViewModeHotKeyEnabled`, `isLegendToggleEnabled`, `isDragDropEnabled`, `wheelZoomAnchor`, `isPanFollowingCrosshair`

**Annotation** (prefix `annotation` -- delegate to `model.annotation`):
`annotationIsEnabled`, `annotationActiveLabel`, `annotationActiveGroup`, `annotationBrushRadius`, `annotationIsErasing`, `annotationIsVisibleIn3D`, `annotationStyle`, `annotationTool`

### When to Use Methods vs Properties
Use **property setters** for:
- Single-value global config changes
- Any property that exists in a model group

Use **methods** for:
- Async operations (loading data): `loadVolumes()`, `loadMeshes()`
- Actions (not state): `drawUndo()`, `drawAddUndoBitmap()`, `createEmptyDrawing()`, `destroy()`, `annotationUndo()`, `annotationRedo()`
- Annotation management: `addAnnotation()`, `removeAnnotation()`, `clearAnnotations()`
- Multi-target operations (need to specify which item): `setVolume(idx, opts)`, `setFrame4D(id, frame)`
- Special formats: `setClipPlane([depth, azimuth, elevation])`
- String-to-number mapping: `setDragMode('contrast')`
- IO: `saveDocument()`, `loadDocument()`, `saveBitmap()`, `loadFiles(files, { add })` (what a canvas drop does: `.nvd` via `loadDocument`, `.json` sidecars paired by basename, else `addImage` / `loadImage`; per-file failures are logged)
- Remote assets: `setFont(font)` / `setFontFromUrl({ atlas, metrics })`, `addColormap(name, cmap)` / `addColormapFromUrl(url, name?)` / `hasColormap(name)` / `colormapNames(kind?)`, `loadMatcap(nameOrUrl)`. `addColormapFromUrl` derives `name` from the filename (stripping `.json.gz`/`.gz`/`.json`) if omitted, and dispatches `colormapAdded` after registration. A colormap with a `labels` array (even empty) is a label table; `setVolume(i, { colormap })` selects either kind, so atlases need no separate call.

### Batch Updates for Per-Item Config
Use the same option type for loading and updating:
```js
// Load with options
await nv1.loadVolumes([{
  url: '/volumes/mni152.nii.gz',
  calMin: 30, calMax: 80,
  isColorbarVisible: false
}])

// Update with same option keys
nv1.setVolume(0, {
  calMin: 40, calMax: 90,
  colormap: 'hot'
})
```

Same pattern for meshes, layers, tracts, connectomes.

### Editing Voxel Values
A volume's GPU textures are cached against its `img` array, so an in-place
edit (same array, new values) must be reported. Either call
`updateVolumeData(idx, data?)`, the fast path that re-uploads only that volume,
or set `isDirty` and let the next GPU update re-upload it:
```js
const vol = nv1.volumes[1]
vol.img.fill(0, 0, vol.nVox3D) // edit in place
vol.isDirty = true
await nv1.setVolume(1, { opacity: 0.8 }) // or updateGLVolume(), ...
```
Any call that runs a GPU update works; `setFrame4D` does only when the frame
changes. The update resets `isDirty` to false, and volumes without it keep
their textures. Set `isDirty` after assigning a new `img` array too, so caches
keyed only on the data version (such as the signal graph) refresh. Values are
raw (before `scl_slope`/`scl_inter`), and calMin/calMax are not recomputed.

`updateVolumeData` writes into the volume's existing texture when the volume
is the background or the only overlay, for scalar and RGB/RGBA data, and a
volume it modulates only has its modulation weights rewritten. It still
allocates new textures with two or more overlays (they are re-oriented and
blended into a new texture), in multi-instance mode (`instances`, the edited
volume's texture is rebuilt), for WebGPU background masking, and for the
gradient texture when lighting is on.

Volumes drawn in chunks (those with a `chunkPlan`, including volumes NiiVue
chunked because they exceed the GPU texture limit) are not supported by
`updateVolumeData`, which logs a warning and returns. Setting `isDirty` on one
whose `img` is in memory works, but the next GPU update re-streams every
chunk, so it is not suited to per-frame updates. A volume streamed from a
`chunkSource` (`loadChunkedVolume`) keeps no full `img`; its bricks come from
the source, so `isDirty` is ignored for it (cleared with a one-time warning,
nothing is re-streamed). A coarse floor level passed to `setBaseCoarseFloor`
is meant to be a separate volume, not a loaded one: after editing its `img`
in place, set its `isDirty` and pass it to `setBaseCoarseFloor` again. (A
loaded volume passed as the floor is updated like any other dirty volume.)

For a 4D RGB/RGBA volume the displayed frame is `frame4D`, as for scalar
volumes, so the one-frame form of `updateVolumeData` writes the frame on
screen.

Re-registering a colormap name with `addColormap` replaces its colors in
volumes that use it on their next GPU update (e.g. `updateGLVolume()`). Mesh
layers, tracts and connectomes bake their colors when they are built, so they
pick up the new colors on their next change (`setMeshLayerProperty`,
`setTractOptions`, `setConnectomeOptions`, ...).

### Constructor (Flat Options)
```js
const nv1 = new NiiVue({
  // Infrastructure (top-level)
  backend: 'webgpu',
  isAntiAlias: false, // default; true enables 4x MSAA (slow on Safari WebGPU, #318)

  // All config properties are flat (same names as controller getters/setters)
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  isColorbarVisible: true,
  volumeIllumination: 0.6,
  meshXRay: 0.1,
  drawPenSize: 5,
  primaryDragMode: DRAG_MODE.crosshair,

})

// Register event listeners after construction
nv1.addEventListener('locationChange', (e) => {
  console.log(e.detail.string)
})
```

### Removed Controller Methods

Legacy setter methods have been replaced by flat property setters:

| Old method | New flat property |
|-----------|-------------------|
| `setVolumeRenderIllumination(v)` | `nv1.volumeIllumination = v` |
| `setSliceType(v)` | `nv1.sliceType = v` |
| `setCrosshairColor(v)` | `nv1.crosshairColor = v` |
| `setRenderAzimuthElevation(a, e)` | `nv1.azimuth = a; nv1.elevation = e` |
| `setScale(v)` | `nv1.scaleMultiplier = v` |
| `setRadiologicalConvention(v)` | `nv1.isRadiological = v` |

Note: `setDragMode(v)` still exists as a method (for string-to-number mapping).

## Per-Item Option Types

### Volume Options
Used by `loadVolumes()`, `addVolume()`, and `setVolume()`:
- Display: `calMin`, `calMax`, `calMinNeg`, `calMaxNeg`, `colormap`, `colormapNegative`, `colormapType`
- Behavior: `isTransparentBelowCalMin`, `opacity`, `visible` (hide without changing `opacity`), `modulateAlpha`, `isNearestInterpolation` (2D sampling; unset = nearest for label data, linear otherwise)
- UI: `isColorbarVisible`, `isLegendVisible` (default true; `nv.isLegendVisible` gates the combined legend)
- Labels: `atlasOutline`, `hiddenLabels` (label values drawn transparent; `nv.isLegendToggleEnabled` lets a legend colour-box click toggle them; hidden labels show as an outlined legend box)
- 4D: `frame4D`, `limitFrames4D`

### Mesh Options
Used by `loadMeshes()`, `addMesh()`, and `setMesh()`:
- Display: `opacity`, `visible` (hide without changing `opacity`), `color`, `shaderType`
- UI: `isColorbarVisible`, `isLegendVisible` (default true; `nv.isLegendVisible` gates the combined legend)

### Layer Options
Used by `addMeshLayer()` and `setMeshLayerProperty()`:
- Display: `calMin`, `calMax`, `calMinNeg`, `calMaxNeg`, `colormap`, `colormapNegative`, `colormapType`
- Behavior: `isTransparentBelowCalMin`, `isAdditiveBlend`, `isColormapInverted`, `opacity`
- UI: `isColorbarVisible`, `outlineWidth`

### Tract Options
Used by `setTractOptions()`:
- Geometry: `fiberRadius`, `fiberSides`, `decimation`, `minLength`
- Color: `colorBy`, `colormap`, `colormapNegative`, `calMin`, `calMax`, `fixedColor`, `groupColors`

### Connectome Options
Used by `setConnectomeOptions()`:
- Nodes: `nodeColormap`, `nodeColormapNegative`, `nodeMinColor`, `nodeMaxColor`, `nodeScale`
- Edges: `edgeColormap`, `edgeColormapNegative`, `edgeMin`, `edgeMax`, `edgeScale`
