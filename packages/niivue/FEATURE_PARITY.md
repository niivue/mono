# Feature Parity: New NiiVue vs Old NiiVue

- **Old NiiVue package**: `~/github/niivue/niivue/packages/niivue`
- **New NiiVue package**: `~/github/niivue/mono/packages/niivue`
- **Old features reference**: `~/github/niivue/niivue/DOCUMENTED_PUBLIC_FEATURES.md`

Tracking which features from the old `niivue` package exist in the new rewrite.

- ✅ = Present (API may differ)
- ❌ = Missing
- ⚠️ = Partial

*Updated: 2026-06-18*

---

## 1. Core Initialization & Lifecycle

| Feature | Status | Notes |
|---------|--------|-------|
| Constructor with options | ✅ | `new NiiVueGPU(options)` |
| `attachTo(id)` / `attachToCanvas(canvas)` | ✅ | |
| WebGPU→WebGL2 init fallback + graphics-unavailable overlay | ✅ | `control/viewBoth.ts` retries WebGL2 when WebGPU `init()` throws (e.g. no GPU adapter); on all-backends-fail `control/canvasMessage.ts` overlays a DOM message with fixes (hardware accel / `#enable-unsafe-swiftshader`). Declined for a shared canvas |
| `cleanup()` | ✅ | Via `removeInteractionListeners` + resource cleanup |
| `setDefaults()` | ❌ | No explicit reset-to-defaults method |

## 2. Volume Loading

| Feature | Status | Notes |
|---------|--------|-------|
| `loadVolumes(list)` | ✅ | |
| `addVolume(volume)` | ✅ | |
| `loadImages()` (mixed volumes+meshes) | ✅ | `loadImage` / `addImage` |
| `loadFromUrl/File/ArrayBuffer` generic loaders | ✅ | Via `useLoader` plugin system |
| DICOM loading | ✅ | Provided by `@niivue/nv-ext-dcm2niix` extension (browser-side dcm2niix/WASM conversion) |
| `loadDeferred4DVolumes()` | ✅ | |
| Partial 4D load (`limitFrames4D` option) | ✅ | Reads only header + first N frames: a gzip NIfTI-1 via `DecompressionStream` (no fflate), or an uncompressed `.nii` `File` via `Blob.slice`; the only way to open a 4D volume larger than V8's ~2 GiB `ArrayBuffer` cap. Auto-caps to as-many-frames-as-fit on `RangeError`/`NotReadableError` even without the option |
| `getZarrVolume()` / Zarr format | ❌ | No Zarr reader |
| `NVImage` static loaders (`loadFromUrl/File/Base64`) | ❌ | NVImage is a type, not a class with static methods |

## 3. Mesh Loading

| Feature | Status | Notes |
|---------|--------|-------|
| `loadMeshes(list)` | ✅ | |
| `addMesh(mesh)` | ✅ | |
| `addMeshLayer()` / `removeMeshLayer()` | ✅ | |
| `NVMesh` static loaders | ❌ | NVMesh is a type; loading is done through the controller |

## 4. Connectome & Tractography

| Feature | Status | Notes |
|---------|--------|-------|
| Load connectome (via mesh loading) | ✅ | JCON format reader + `setConnectomeOptions` |
| `loadFreeSurferConnectome` | ❌ | No FreeSurfer connectome loader |
| Tractography: TCK, TRK, TRX, TT | ✅ | |
| Tractography: VTK lines | ✅ | |
| Tractography: TSF scalars | ✅ | |
| Tractography: AFNI .niml.tract | ❌ | |

## 5. Document Loading/Saving

| Feature | Status | Notes |
|---------|--------|-------|
| `loadDocument()` / `loadDocumentFromUrl()` | ✅ | `loadDocument(source)` |
| `saveDocument()` | ✅ | |
| `saveScene()` | ❌ | |
| `saveHTML()` / `generateHTML()` | ✅ | `@niivue/nv-ext-save-html` extension package |
| `json()` — serialize state | ✅ | `serializeDocument()` returns a `Uint8Array` (CBOR by default) |
| JSON document (export + import) | ✅ (new) | `serializeDocument({ format: 'json' })` / `saveDocument('x.json')` writes a human-readable/portable JSON NVD (typed arrays base64-tagged); `loadDocument` sniffs JSON vs CBOR and reads either. Same document structure as the CBOR `.nvd`. `documentJson.ts`. |
| Import classic-NiiVue (legacy) JSON `.nvd` | ✅ via converter | Offline converter (`bun run convert:legacy <in> <out.nvd\|.json>`, `documentLegacy.ts`): maps the classic `opts`/`sceneData`/`imageOptionsArray`/`meshesString` to our format, LINKING volumes/meshes by their URL (embedded base64 blobs are not decoded — the URLs must be reachable). Not a runtime loader; a one-shot translation to a new-format document. |
| Sparse SETTINGS (omit defaults; fill on load) | ✅ (new) | v9: `serialize()` omits any setting equal to its default (all 8 config groups). On load a specified setting always wins; an omitted setting is filled per a **fill policy** — DEFAULT resets it to its built-in default (a document is a complete scene), `'current'` keeps the instance value. Save control: `nv.settingsSavePolicy` (`neverSave`/`alwaysSave`); load control: `nv.settingsFillPolicy` / `loadDocument(src, { fill })` (group or `'group.key'`). Crosshair persistence = `{ 'scene.crosshairPos': 'current' }`. `documentSettings.ts` (`sparsifyGroup`/`fillGroup`). A mono addition. |
| Sparse / dataless document (link volumes by URL) | ✅ VOLUMES / ❌ meshes | `serializeDocument({ linkData: true })` (or `saveDocument(name, { linkData: true })`) emits a document that references each volume by `url` instead of embedding its bytes; a volume with no linkable URL (drag-drop, `blob:`/`data:`) still embeds so it always round-trips. `SerializeOptions.linkData` in `NVDocument`. Verified: a linked mni152 doc is ~1 KB vs ~11 MB embedded. **Meshes still always embed** — the mesh URL-restore path doesn't yet reapply overlay layers / tract options (tracked follow-up). |
| Hydrate linked volumes on load | ✅ | `reconstructVolume`'s `else if (v.url)` branch fetches from the URL when embedded `data` is absent (pre-existing), so a linked document rehydrates on open — verified end-to-end with `linkData` saves. |

## 6. Volume Management

| Feature | Status | Notes |
|---------|--------|-------|
| Remove volume (by index) | ✅ | Via `model.removeVolume(index)` |
| `removeAllVolumes()` | ✅ | |
| `removeVolumeByUrl()` | ❌ | |
| `moveVolumeUp/Down/ToTop/ToBottom` | ✅ | Index-based API on controller |
| `setVolume()` — update volume properties | ✅ | `setVolume(idx, options)` |
| `setOpacity(volIdx, opacity)` | ✅ | Via `setVolume` |
| `cloneVolume()` | ❌ | |
| `getVolumeIndexByID` / `getOverlayIndexByID` | ❌ | |
| `volumes` property | ✅ | Via `model.volumes` |

## 7. Mesh Management

| Feature | Status | Notes |
|---------|--------|-------|
| `removeMesh(idx)` | ✅ | |
| `removeMeshByUrl()` | ❌ | |
| `setMesh()` — update properties | ✅ | |
| `setMeshLayerProperty()` | ✅ | |
| `meshThicknessOn2D` | ✅ | Property getter/setter |
| `getMeshIndexByID()` | ❌ | |
| `reverseFaces()` | ❌ | |
| `meshes` property | ✅ | Via `model.meshes` |

## 8. Colormaps

| Feature | Status | Notes |
|---------|--------|-------|
| List available colormaps | ✅ | Via `NVCmaps` |
| `setColormap` (via `setVolume`) | ✅ | |
| `setColormapNegative` / negative colormap option | ✅ | Via `colormapNegative` in volume, mesh layer, tract, and connectome options; API differs from old setter |
| `addColormap(name, cmap)` | ✅ | |
| `addColormapFromUrl()` | ✅ | |
| `setColormapLabel` / `setColormapLabelFromUrl` | ✅ | |
| `colormapInvert` | ❌ | |
| `setDrawColormap` | ✅ | `drawColormap` property |
| Custom colormap format `{R,G,B,A,I}` | ✅ | |

## 9. Display Options

| Feature | Status | Notes |
|---------|--------|-------|
| Crosshair: width, color, gap | ✅ | Properties |
| Background/font color | ✅ | Properties |
| Font scale | ✅ | `fontScale` property |
| Colorbar visibility | ✅ | `isColorbarVisible` |
| Ruler visibility | ✅ | `isRulerVisible` |
| Orient cube visibility | ✅ | `isOrientCubeVisible` |
| 3D crosshair visibility | ✅ | `is3DCrosshairVisible` |
| Radiological convention | ✅ | `isRadiological` |
| Nearest interpolation | ✅ | `volumeIsNearestInterpolation` |
| Multiplanar equal size | ✅ | `isEqualSize` |
| Mosaic string | ✅ | `mosaicString` property |
| Drag mode | ✅ | `primaryDragMode` / `secondaryDragMode` |
| Drawing enabled | ✅ | `drawIsEnabled` |
| Pen value/size/fill | ✅ | Properties |
| Selection box color | ✅ | Property |
| Show bounds border | ❌ | Not found |

## 10. View/Layout Control

| Feature | Status | Notes |
|---------|--------|-------|
| `sliceType` (axial/coronal/sagittal/multiplanar/render) | ✅ | Property |
| `multiplanarType` (auto/column/grid/row) | ✅ | Property |
| `setCustomLayout` / `clearCustomLayout` / `getCustomLayout` | ✅ | `customLayout` property + `clearCustomLayout()` |
| `heroFraction` / `heroSliceType` | ✅ | Properties |
| Mosaic view | ✅ | `mosaicString` property |
| `setBounds()` | ✅ | |
| `clearBounds()` | ❌ | |
| Orientation text visible | ✅ | `isOrientationTextVisible` |
| Corner orientation text | ❌ | No `setCornerOrientationText` |
| Show all orientation markers | ❌ | |
| Tile margin/padding | ✅ | `tileMargin` |
| HiDPI/retina support | ✅ | Built-in |
| Multi-instance scenes (`opts.instances`, `setInstances`) | ✅ | Per-tile `volumeId` / `bounds` / `viewport`. Supported on both WebGL2 and WebGPU backends. |
| Shared-camera 3D space (`tile.space === 'global3d'`, `globalCamera`, `setGlobalCamera`) | ✅ | One camera spans every tile so adjacent volumes line up in world space. Supported on both backends; WebGPU uses a per-volume texture cache to keep multi-volume draws cheap. |

## 11. Navigation & Crosshair

| Feature | Status | Notes |
|---------|--------|-------|
| `moveCrosshairInVox(dx,dy,dz)` | ✅ | |
| `pan2Dxyzmm` | ✅ | Property |
| `crosshairPos` | ✅ | Property |
| `isPositionInMM` | ✅ | Property |

## 12. 3D Rendering

| Feature | Status | Notes |
|---------|--------|-------|
| Azimuth/elevation | ✅ | Properties |
| Volume illumination | ✅ | `volumeIllumination` |
| Gradient opacity | ❌ | No `setGradientOpacity` method |
| Custom gradient texture | ❌ | No `setCustomGradientTexture` / `getGradientTextureData` |
| MatCap texture | ✅ | `loadMatcap()` / `volumeMatcap` |
| Additive blend (MIP) | ❌ | No `setAdditiveBlend` |
| Gamma correction | ✅ | `gamma` property |
| Volume alpha shader | ✅ | `volumeAlphaShader` |

## 13. Clip Planes

| Feature | Status | Notes |
|---------|--------|-------|
| Clip plane color | ✅ | `clipPlaneColor` property |
| Clip plane cutaway | ✅ | `isClipPlaneCutaway` property |
| `setClipPlane` / `setClipPlanes` (up to 6) | ✅ | `setClipPlane`, `setClipPlanes`, `setClipPlaneDepthAziElev` |
| Keyboard/mouse clip plane interaction | ⚠️ | Clip planes are modelled and synchronized; full old interaction parity not verified |

## 14. Drawing & Segmentation

| Feature | Status | Notes |
|---------|--------|-------|
| Drawing enabled toggle | ✅ | `drawIsEnabled` |
| Pen value / size / fill | ✅ | Properties |
| Draw opacity | ✅ | `drawOpacity` |
| Create empty drawing | ✅ | Via `drawingVolume` setter |
| Load drawing | ✅ | `loadDrawing()` |
| Close/discard drawing | ✅ | `closeDrawing()` |
| Draw undo | ✅ | `drawUndoBitmaps` mechanism |
| Save drawing | ✅ | `saveDrawing()` |
| `drawGrowCut()` — GPU grow-cut segmentation | ❌ | |
| `drawOtsu()` — Otsu thresholding | ✅ | `@niivue/nv-ext-image-processing` exports `otsu`; API is a volume transform rather than legacy drawing method |
| `drawingBinaryDilationWithSeed()` | ❌ | |
| `findDrawingBoundarySlices()` | ✅ | `@niivue/nv-ext-drawing` package |
| `interpolateMaskSlices()` | ✅ | `@niivue/nv-ext-drawing` package |
| Click-to-segment (magic wand) | ✅ | Built into the core drawing (`drawIsClickToSegment` + `drawClickToSegmentTolerance`): a 2D-slice click or a 3D exploded-block right-click grows a region of intensity-similar voxels (`magicWand3D`). Grows the whole connected 3D structure by default; `drawClickToSegmentIs2D` confines a slice click to its plane (the block right-click is always 3D). Also available worker-side via `@niivue/nv-ext-drawing` (`magicWand`, `magicWandFromBitmap`, `MagicWandShared`) |
| Draw rim opacity | ✅ | `drawRimOpacity` |
| 2D slice drawing methods (pen point, drag stroke, filled polygon, eraser) | ✅ | Left-drag on any slice; `drawPenFilled` flood-fills a closed loop |
| 3D drawing on exploded blocks (render tile) | ✅ | New in the rewrite (old NiiVue drew on 2D slices only): right-button pen/eraser stroke, 3D flood fill, and magic-wand click-to-segment directly on exploded chunked blocks, on both backends. Demo `vox.draw.explode.html` |
| Export drawing slice as SVG | ✅ | `drawingToSVG(sliceType?, sliceIndex?)` traces the current slice's painted voxels into run-length `<rect>`s per label color (sized in voxels). Mirrors the slide vector layer's `toSVG` for volume drawings |
| Vector annotation drawing + SVG export | ✅ | The core annotation layer draws freehand vector polygons on slices (`annotationTool`, `annotationIsEnabled`); `annotationsToSVG(sliceType?, slicePosition?)` serializes them to `<path>`s in slice mm coordinates. Shapes can also be drawn **directly on the 3D exploded blocks** (right-drag on the render picks block points, fit to the best plane) and render explode-aware. The `vox.draw` / `vox.draw.explode` demos expose this as a "Vector (SVG)" pen mode |

## 15. Image Processing

| Feature | Status | Notes |
|---------|--------|-------|
| `removeHaze()` — dehaze/bias correction | ✅ | `@niivue/nv-ext-image-processing` exports `removeHaze` volume transform |
| `binarize()` | ⚠️ | Available through connected-label/threshold transform options, not standalone legacy method |
| `conform()` — 1mm isotropic | ✅ | Volume transform |
| `createConnectedLabelImage()` | ✅ | Volume transform |
| `setModulationImage()` | ✅ | Scalar overlays/background: RGB + alpha via GPU prepass (both backends), `examples/vox.modulate.scalar.html`. RGB/RGBA (V1) volumes: RGB only (alpha preserved for sign bits). `modulationImage` + `modulateAlpha` persisted to NVD. Backend parity verified manually (no Playwright). |
| `isAlphaClipDark` | ✅ | `volumeIsAlphaClipDark` |
| `setAtlasOutline()` | ❌ | |
| `overlayOutlineWidth` | ✅ | `volumeOutlineWidth` |

## 16. Statistical Thresholding

| Feature | Status | Notes |
|---------|--------|-------|
| `cal_min` / `cal_max` | ✅ | Via `setVolume` / `recalculateCalMinMax` |
| Negative thresholds (`cal_minNeg` / `cal_maxNeg`) | ✅ | Supported on volume and mesh layer options |
| `colormapType` threshold modes | ❌ | Not found on controller API |

## 17. Measurements

| Feature | Status | Notes |
|---------|--------|-------|
| Distance measurement | ✅ | `NVMeasurement` view component |
| `clearMeasurements()` | ✅ | |
| Angle measurements | ✅ | `DRAG_MODE.angle`; completed angles stored on model |
| `clearAngles()` | ⚠️ | `clearMeasurements()` clears both distances and angles; no separate `clearAngles()` method |
| `getDescriptives()` — ROI statistics | ❌ | |

## 18. Registration / Affine Transforms

| Feature | Status | Notes |
|---------|--------|-------|
| `getVolumeAffine` / `setVolumeAffine` | ✅ | Public controller methods; async setters update render state |
| `applyVolumeTransform` | ✅ | Applies translation/rotation/scale in world space |
| `resetVolumeAffine` | ✅ | Restores the affine captured at volume load |
| Affine utilities (`copyAffine`, `multiplyAffine`, etc.) | ✅ | Implemented in `NVTransforms`; public API is controller-first |

## 19. 4D Volumes (Timeseries)

| Feature | Status | Notes |
|---------|--------|-------|
| `setFrame4D(vol, frame)` | ✅ | |
| Graph display for 4D | ✅ | `isGraphVisible`, `graphNormalizeValues`, `graphIsRangeCalMinMax` |
| Large/partial 4D volumes (>2 GiB) | ✅ | `limitFrames4D` + auto-cap under V8's ~2 GiB ArrayBuffer limit; streaming gz / `Blob.slice` partial read; deferred-frame reload via `loadDeferred4DVolumes`. See §2 |

## 20. Synchronization

| Feature | Status | Notes |
|---------|--------|-------|
| `broadcastTo(instances)` | ✅ | |

## 21. Events

| Feature | Status | Notes |
|---------|--------|-------|
| EventTarget API (`addEventListener` / `removeEventListener`) | ✅ | Typed overloads |
| `volumeLoaded` / `meshLoaded` | ✅ | |
| `volumeRemoved` / `meshRemoved` | ✅ | |
| `volumeUpdated` / `meshUpdated` | ✅ | |
| `azimuthElevationChange` | ✅ | |
| `clipPlaneChange` | ✅ | |
| `sliceTypeChange` | ✅ | |
| `frameChange` | ✅ | |
| `drawingChanged` / `drawingEnabled` | ✅ | |
| `penValueChanged` | ✅ | |
| `pointerUp` | ✅ | |
| `canvasResize` | ✅ | |
| `propertyChange` | ⚠️ | New API uses typed `change` event with `{ property, value }` detail |
| `locationChange` / `intensityChange` | ⚠️ | `locationChange` exists; no separate `intensityChange` event found |
| `dragRelease` | ✅ | |
| `clickToSegment` event | ❌ | |
| `measurementCompleted` / `angleCompleted` | ✅ | |
| `documentLoaded` | ✅ | |
| `volumeOrderChanged` | ✅ | |
| `customMeshShaderAdded` / `meshShaderChanged` | ❌ | |
| Legacy callback properties | ❌ | Not supported |

## 22. Options Watching

| Feature | Status | Notes |
|---------|--------|-------|
| `watchOptsChanges()` / `unwatchOptsChanges()` | ❌ | Replaced by `propertyChange` event |

## 23. Shaders

| Feature | Status | Notes |
|---------|--------|-------|
| `createCustomMeshShader()` | ❌ | |
| `setCustomMeshShader()` / `setCustomMeshShaderFromUrl()` | ❌ | |
| `setMeshShader()` | ❌ | |
| `meshShaderNames()` | ❌ | |
| Built-in mesh shaders + per-mesh selection | ✅ | phong/flat/matte/toon/outline/rim/silhouette/crevice/vertexColor/crosscut, chosen per-mesh via `shaderType`; `sliceShaderType` (default `''` = inherit) selects a different shader for 2D slice tiles than the 3D render view |
| Built-in volume render shaders | ✅ | `volumeAlphaShader` |

## 24. Gestures / Input Configuration

| Feature | Status | Notes |
|---------|--------|-------|
| `primaryDragMode` / `secondaryDragMode` | ✅ | Properties |
| `setMouseEventConfig` / `getMouseEventConfig` | ❌ | |
| `setTouchEventConfig` / `getTouchEventConfig` | ❌ | |
| Selection box color | ✅ | Property |

## 25. Saving / Export

| Feature | Status | Notes |
|---------|--------|-------|
| `saveVolume()` | ✅ | |
| `saveDrawing()` | ✅ | |
| `saveMesh()` | ✅ | |
| `saveBitmap()` — screenshot | ✅ | |
| `saveDocument()` | ✅ | |
| `saveHTML()` / `generateHTML()` | ✅ | `@niivue/nv-ext-save-html` extension |
| `saveScene()` | ❌ | |
| Mesh writers: STL, MZ3, OBJ, IWM | ✅ | |

## 26. Fonts

| Feature | Status | Notes |
|---------|--------|-------|
| `setFont()` / `setFontFromUrl()` | ✅ | |
| `fontScale` | ✅ | |
| Built-in font (Ubuntu) | ✅ | |

## 27. Atlases

| Feature | Status | Notes |
|---------|--------|-------|
| Voxel-based atlas labels | ✅ | `setColormapLabel` |
| PAQD probabilistic atlas | ✅ | `volumePaqdUniforms` |
| Mesh-based atlases | ⚠️ | No annot/GIfTI layer readers found |
| `addLabel()` | ❌ | |

## 28. Plugin System

| Feature | Status | Notes |
|---------|--------|-------|
| `useLoader()` — custom format loader | ✅ | |
| External reader registration | ✅ | `registerExternalReader` on NVVolume |
| DICOM loader plugin | ✅ | `@niivue/nv-ext-dcm2niix` extension |
| Other loader plugins (itkwasm, minc, tiff, vox, cbor) | ❌ | Must be provided externally |

## 29. NVImage Public API

| Feature | Status | Notes |
|---------|--------|-------|
| Coordinate conversion (frac↔mm↔vox) | ❌ | NVImage is a plain type, not a class |
| `getValue()` / `getValues()` / `getVolumeData()` / `setVolumeData()` | ❌ | |
| `getImageMetadata()` / `hdr` / `dims` | ⚠️ | `hdr` exists on the type but no method API |
| `calMinMax()` / `calculateRAS()` | ✅ | Internal utilities in `volume/utils.ts` |
| `intensityRaw2Scaled()` / `intensityScaled2Raw()` | ❌ | |
| `clone()` / `zeroImage()` | ❌ | |
| Format readers | ✅ | All major formats except Zarr |

## 30. NVMesh Public API

| Feature | Status | Notes |
|---------|--------|-------|
| `setProperty()` / `setLayerProperty()` | ✅ | Via controller |
| `decimateFaces()` / `decimateHierarchicalMesh()` | ❌ | |
| `linesToCylinders()` | ❌ | |
| `createFiberDensityMap()` | ❌ | |
| `indexNearestXYZmm()` | ❌ | |
| `unloadMesh()` | ✅ | Via `removeMesh` |
| Connectome re-extrusion | ✅ | `setConnectomeOptions` / `reextrudeConnectome` |

## 31. Supported File Formats

### Volumes

| Format | Status |
|--------|--------|
| NIfTI (.nii/.nii.gz) | ✅ |
| NRRD | ✅ |
| MRtrix MIF | ✅ |
| AFNI HEAD/BRIK | ✅ |
| MGH/MGZ | ✅ |
| ITK MHD/MHA | ✅ |
| ECAT7 | ✅ |
| DSI Studio FIB/SRC | ✅ |
| BMP | ✅ |
| V16 | ✅ |
| VMR | ✅ |
| NPY/NPZ | ✅ |
| Zarr | ❌ |
| DICOM (extension) | ✅ |
| MINC (plugin) | ❌ |
| TIFF (plugin) | ❌ |
| VOX (plugin) | ❌ |

### Meshes

| Format | Status |
|--------|--------|
| GIfTI | ✅ |
| FreeSurfer | ✅ |
| PLY, STL, OBJ, VTK | ✅ |
| MZ3, OFF, GEO/BYU | ✅ |
| BrainSuite DFS | ✅ |
| ICO/TRI | ✅ |
| BrainNet NV | ✅ |
| BrainVoyager SRF | ✅ |
| X3D | ✅ |
| ASC | ✅ |
| WRL (VRML) | ✅ |
| IWM | ✅ |

### Mesh Overlays/Layers

| Format | Status |
|--------|--------|
| FreeSurfer CURV | ✅ |
| SMP | ✅ |
| STC | ✅ |
| GIfTI overlay | ❌ |
| CIfTI-2 | ❌ |
| MZ3 overlay | ❌ |
| FreeSurfer ANNOT | ❌ |

### Tractography

| Format | Status |
|--------|--------|
| TCK, TRK, TRX, TT | ✅ |
| TSF (scalars) | ✅ |
| VTK lines | ✅ |
| AFNI .niml.tract | ❌ |

## 32. Exported Enums/Constants

| Feature | Status | Notes |
|---------|--------|-------|
| `DRAG_MODE` | ✅ | |
| `SLICE_TYPE` | ✅ | |
| `MULTIPLANAR_TYPE` | ✅ | |
| `SHOW_RENDER` | ✅ | |
| `NiiDataType` | ✅ | |
| `NiiIntentCode` | ❌ | In NVConstants (not exported from index) |

## 33. Miscellaneous

| Feature | Status | Notes |
|---------|--------|-------|
| `isRadiological` | ✅ | Property |
| `volumeIsNearestInterpolation` | ✅ | Property |
| Crosshair color/width | ✅ | Properties |
| `broadcastTo` sync | ✅ | |
| `volScaleMultiplier` | ✅ | `scaleMultiplier` property |
| `niftiArray2NVImage()` | ❌ | |
| `decimateHierarchicalMesh()` on Niivue | ❌ | |
| Thumbnail / placeholder | ✅ | `isThumbnailVisible`, `thumbnailUrl`, `placeholderText` |
| Legend visibility | ✅ | `isLegendVisible` |
| Annotation system (vector) | ✅ | New feature not in old package |

---

## 34. Signals (physio / spectroscopy)

New non-spatial data class (no equivalent in the old package), rendered as 2-D
line plots. Source in `src/signal/`; architecture documented in `AGENTS.md`.

| Feature | Status | Notes |
|---------|--------|-------|
| Signal data class (`NVModel.signals`) | ✅ | `physio` (BIDS TSV) and `spectroscopy` (NIfTI-MRS complex FID) |
| Readers (`tsv`, `nii`) | ✅ | Auto-discovered via `import.meta.glob`; gz-aware; NaN gaps; `scl_slope`/`scl_inter` applied for real NIfTI |
| BIDS/MRS sidecar | ✅ | Sibling `.json` fetched by URL or paired on drag-drop; `SpectrometerFrequency`/`ResonantNucleus` |
| NIfTI signal-vs-volume routing | ✅ | `detect.ts`: dims-only (non-spatial: dim1-3==1 & dim4>1); MRS fields do NOT route here; `asSignal` override |
| Processing (FFT/avg/ppm) | ✅ | Radix-2 FFT; non-pow2 zero-filled to next pow2; transient averaging; ppm/Hz axis; windowed y |
| Controller API | ✅ | `loadSignals`/`addSignal`/`removeSignal`/`removeAllSignals`/`setSignal`/`setSignalCursorFraction` |
| Events | ✅ | `signalLoaded`, `signalRemoved`, `signalLocationChange` |
| Graph rendering (`NVGraph` signal mode) | ✅ | Multi-color series, legend (capped), reversible/windowed x-axis, full-canvas when signal-only, dense-series decimation, derived-plot cache; on-graph pan/zoom buttons with wheel/frame follow (`graphZoom`/`graphPan`), relative line width/opacity (`graphLineWidth`/`graphLineAlpha`), and a missing-data rug for NaN gaps |
| Annotations (`SignalAnnotation`) | ✅ | Data-space text labels (`{text,x,y,color?}`) that pan/zoom with the window and hide when out of range; `y` of `±Infinity` pins to plot bottom/top; set via load options or `setSignal`, persisted in NVD. Render on the signal graph only (not the volume+physio association view) |
| Persistence (NVD) | ✅ | Document version 9 (`signal/persistence.ts`) |
| Demos | ✅ | `examples/svs.html`, `examples/physio.html`, `examples/physio.bold.html` |
| Volume + physio association | ✅ | `collectAssociatedTimeGraphData`: BOLD time-course + attached physio on a shared Time(s) axis at native rates, clamped to the imaging window, normalized, with a current-frame marker (`attachToId`); per-trace show/hide — BOLD via `graphShowVolumeTimecourse`, physio via `setSignal` `selectedColumns` |

---

## 35. MRSI (MR spectroscopic imaging)

Spatial spectroscopic imaging (MRSI/CSI): a complex 4-D NIfTI where dim1-3 are
space and dim4 is the FID. Core enablers live in `src/volume/mrsi.ts`,
`src/signal/processing.ts`, and `src/signal/mrs.ts`; the FSL-MRS workflow
(navigation, manipulation, range-to-map) is provided by the core `MrsScene` controller (`src/mrs/MrsScene.ts`) with a demo
at `examples/mrsi.html`. Ports algorithms from fsleyes-plugin-mrs (BSD-3) — see
`PORTING.md`.

| Feature | Status | Notes |
|---------|--------|-------|
| Complex MRSI volume load | ✅ | `isMrsiVolume`/`prepareMrsiVolume` in `volume/mrsi.ts`: complex spatial 4-D NIfTI **with NIfTI-MRS ecode-44 metadata** retains raw FID + spectral metadata (`NVImage.complexFID`/`mrsMeta`) and shows a derived total-signal map (GPU never sees the complex buffer). The MRS-metadata gate prevents non-MRS complex 4-D volumes from being rewritten. Geometry is clamped to the bytes present (truncation-safe). The derived scalar overlay does NOT set `isImaginary` (the readout treats it as a plain scalar) |
| Shared complex/ecode-44 decode | ✅ | `signal/mrs.ts` (`isComplexDatatype`/`decodeComplexFID`/`mrsFromHeaderExtensions`) used by both signal (SVS) and volume (MRSI) paths |
| Crosshair-voxel spectrum | ✅ | `addMrsiSignal(volumeId)` + `NVSignal.followsCrosshair`: the graph extracts the crosshair voxel's FID (`extractVoxelFid`) and re-derives the spectrum on every crosshair move. When the FID can't be resolved (volume removed / off-grid / NVD reload without the buffer) the signal is dropped from the graph rather than drawing a fake flat placeholder |
| NVD persistence of MRSI | ⚠ partial | `followsCrosshair` signals serialize, but the volume's `complexFID` is NOT written to NVD (only the derived scalar `img`). On reload the crosshair spectrum is unavailable (graph drops it, no fake line) until the MRSI volume is re-added. Persisting the 18 MiB complex buffer is deferred by design |
| Sampled-voxel marker | ✅ | `MrsScene.enableVoxelSnap`: crosshair snaps to the MRSI voxel-grid centre (`context.mrs.voxelCenterMm`) within the slab, marking the coarse cell being read; free over the surrounding anatomy |
| FSL-MRS spectral transforms | ✅ | `halveFirstPoint`, `apodize` (exp line-broadening), `phaseCorrection` (0/1-order); off by default so the `svs.html` baseline is unchanged; parity-tested vs fsleyes |
| Nucleus constants | ✅ | `GYRO_MAG_RATIO`, `PPM_SHIFT`, `PPM_RANGE` ported verbatim |
| ppm-band metabolite map | ✅ | `integratePpmBandMap` + `makeMetaboliteMap` / `MrsScene.makeMap` (core): integrate `|spectrum|`/`real` over a ppm band across all voxels -> `SpecSum_{lo}_{hi}` overlay |
| Extension context exposure | ✅ | `context.mrs` (`MrsVolumeAccess`): read-only complex buffer + metadata + `makeScalarOverlay` |
| Demo (`mrsi.html`) | ✅ | T1 + MRSI grid + mask, crosshair->spectrum, component/apodize/phase/ppm controls, make-map |
| Fit-results overlay | ⛔ Deferred | fit/baseline/residual spectra + concentration/QC maps (`tools.py`); blocked on a `fsl_mrsi` results directory |
| Interactive Ctrl/Shift-drag phasing | ⛔ Deferred | demo uses sliders |

---

## 36. Tiled volumes + multi-resolution (LOD)

Render volumes larger than the GPU's `maxTextureDimension3D` by tiling them into
chunks, and render multi-GB pyramids (OME-Zarr) with per-brick level-of-detail
focused on a point. Chunk math is shared (`volume/chunking.ts`,
`volume/ChunkVisibility.ts`, `volume/ChunkResidency.ts`); GPU resources are
per-backend. Design: `docs/tiled-volumes.md`. Demo: `apps/iiif-volumetric-demo`
(`omezarr.html`).

| Feature | Status | Notes |
|---------|--------|-------|
| Chunked single-level volume | ✅ | `chunkVolume`/`chunkVolumeGrid`: tile to fit the device limit, 1-voxel halo for seam-free trilinear. 3D ray-march + 2D slice, both backends |
| Chunk streaming + LRU residency | ✅ | `ChunkResidencyManager` (index-keyed, byte-budgeted, frustum/slice working set); per-frame upload pump; coarse-floor cross-fade so the view never blanks |
| Per-brick multi-LOD plan | ✅ | `chunkVolumeMultiLOD`: heterogeneous `ChunkPlan` with per-brick `sourceLevel`; common-grid (placement) vs level-grid (texture) coordinate split |
| 2:1 balanced octree | ✅ | Scale-relative refinement (`detail`) + explicit balance post-pass: face-adjacent bricks differ by ≤1 level. Budget pass shrinks `detail`, then raises a floor, then respects `maxBricks` (< `MAX_CHUNKS_PER_TILE`) |
| Per-brick ray step + opacity correction | ✅ | `rayStepTexVox` uniform + `1 − pow(1−a, stepRatio)`; coarse bricks step at their own density without rendering dimmer. Both backends (`render.wgsl` / `renderShader.ts`) |
| Mixed-size back-to-front order | ✅ | `chunksBackToFront` BSP clean-plane recursive sort — exact compositing order for mixed brick sizes at any angle (`depthFunc ALWAYS` relies on it); a pairwise comparator left rare mis-ordered opaque bricks as stray bright blocks |
| In-place plan swap (refocus) | ✅ | `swapChunkedVolumePlan` + residency `remap`: unchanged bricks keep their GPU textures; only changed bricks re-fetch |
| Focus box / per-brick LOD boxes | ✅ | `nv.focusBox` (single AABB) and `nv.lodBoxes` (set, e.g. coloured per level) drawn on 3D render tiles, both backends |
| Cross-LOD blending (geomorph) | ⛔ Deferred | Different-level boundaries show a one-level brightness/blockiness step; smooth fade between a brick's level and the next coarser is the real fix (needs a 2nd texture bound per brick, both shaders) |

---

## Summary of Key Missing Features

### High Priority (Core Functionality)
1. **Mesh overlay formats**: GIfTI, CIfTI-2, MZ3, FreeSurfer ANNOT layer readers
2. **ROI statistics**: old `getDescriptives()` over drawing/label regions (new vector annotations have stats, but this is not equivalent)
3. **Statistical threshold modes**: old `colormapType` threshold behavior is not clearly exposed, despite negative colormaps/thresholds being present

### Medium Priority
4. **3D rendering**: `setGradientOpacity`, `setAdditiveBlend` (MIP), custom gradient textures
5. **Volume/mesh lookup by ID/URL**: `getVolumeIndexByID`, `getMeshIndexByID`, `removeVolumeByUrl`, `removeMeshByUrl`
6. **`saveScene()`**: HTML export is covered by `@niivue/nv-ext-save-html`, but old scene export remains missing
7. **Zarr volume format**
8. **FreeSurfer connectome** loader
9. **NVImage class methods**: coordinate conversion, getValue, clone, etc. (architectural difference — NVImage is a type not a class)

### Lower Priority
11. **Mouse/touch event config**: `setMouseEventConfig`, `setTouchEventConfig`
12. **`cloneVolume`**
13. **`setAtlasOutline`**
14. **`colormapInvert`**
15. **Mesh utilities**: `decimateFaces`, `linesToCylinders`, `createFiberDensityMap`, `reverseFaces`
16. **Missing/changed events**: no separate `intensityChange`; shader events not present; legacy callback properties not supported
17. **Enum exports**: `NiiIntentCode`
18. **AFNI .niml.tract** tractography format
19. **`watchOptsChanges`** (replaced by `change` / property-change style event)
20. **Standalone `binarize()` and separate `clearAngles()` APIs** (functionality partly available through different APIs)

### Covered by New Extensions / Different APIs
- **DICOM loading**: `@niivue/nv-ext-dcm2niix`
- **Drawing helpers**: `findDrawingBoundarySlices`, `interpolateMaskSlices`, magic wand segmentation in `@niivue/nv-ext-drawing`
- **Image processing**: `otsu`, `removeHaze`, `conform`, `connectedLabel` in `@niivue/nv-ext-image-processing`
- **HTML export**: `generateHTML`, `saveHTML` in `@niivue/nv-ext-save-html`
- **Negative colormaps/thresholds and clip plane setters**: present in the new core API, but setter names differ from the old package

### Deferred (Not Planning to Implement Soon)
- **`drawGrowCut`** — GPU grow-cut segmentation
- **Custom mesh shaders**: entire shader system (`createCustomMeshShader`, `setMeshShader`, `meshShaderNames`)
