# Feature Parity: New NiiVue vs Old NiiVue

- **Old NiiVue package**: `~/github/niivue/niivue/packages/niivue`
- **New NiiVue package**: `~/github/niivue/mono/packages/niivue`
- **Old features reference**: `~/github/niivue/niivue/DOCUMENTED_PUBLIC_FEATURES.md`

Tracking which features from the old `niivue` package exist in the new rewrite.

- ✅ = Present (API may differ)
- ❌ = Missing
- ⚠️ = Partial

*Updated: 2026-05-01*

---

## 1. Core Initialization & Lifecycle

| Feature | Status | Notes |
|---------|--------|-------|
| Constructor with options | ✅ | `new NiiVueGPU(options)` |
| `attachTo(id)` / `attachToCanvas(canvas)` | ✅ | |
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
| `json()` — serialize state | ✅ | `serializeDocument()` returns CBOR-encoded `Uint8Array` |

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
| Click-to-segment (magic wand) | ✅ | `@niivue/nv-ext-drawing` exports `magicWand`, `magicWandFromBitmap`, and `MagicWandShared` |
| Draw rim opacity | ✅ | `drawRimOpacity` |

## 15. Image Processing

| Feature | Status | Notes |
|---------|--------|-------|
| `removeHaze()` — dehaze/bias correction | ✅ | `@niivue/nv-ext-image-processing` exports `removeHaze` volume transform |
| `binarize()` | ⚠️ | Available through connected-label/threshold transform options, not standalone legacy method |
| `conform()` — 1mm isotropic | ✅ | Volume transform |
| `createConnectedLabelImage()` | ✅ | Volume transform |
| `setModulationImage()` | ✅ | |
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
