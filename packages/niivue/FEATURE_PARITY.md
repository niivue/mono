# Feature Parity: New NiiVue vs Old NiiVue

- **Old NiiVue package**: `~/github/niivue/niivue/packages/niivue`
- **New NiiVue package**: `~/github/niivue/mono/packages/niivue`
- **Old features reference**: `~/github/niivue/niivue/DOCUMENTED_PUBLIC_FEATURES.md`

Tracking which features from the old `niivue` package exist in the new rewrite.

- ✅ = Present (API may differ)
- ❌ = Missing
- ⚠️ = Partial

*Generated: 2026-04-17*

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
| `loadDicoms()` | ❌ | No DICOM loader built-in (plugin system exists via `useLoader`) |
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
| `setColormapNegative` | ❌ | No negative colormap API found |
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
| `setClipPlane` / `setClipPlanes` (up to 6) | ❌ | No explicit clip plane setting methods found |
| Keyboard/mouse clip plane interaction | ❌ | Not verified |

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
| `drawOtsu()` — Otsu thresholding | ❌ | |
| `drawingBinaryDilationWithSeed()` | ❌ | |
| `findDrawingBoundarySlices()` | ✅ | `@niivue/nv-ext-drawing` package |
| `interpolateMaskSlices()` | ✅ | `@niivue/nv-ext-drawing` package |
| Click-to-segment (magic wand) | ❌ | |
| Draw rim opacity | ✅ | `drawRimOpacity` |

## 15. Image Processing

| Feature | Status | Notes |
|---------|--------|-------|
| `removeHaze()` — dehaze/bias correction | ❌ | |
| `binarize()` | ⚠️ | Available as option in connectedLabel transform, not standalone |
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
| Negative thresholds (`cal_minNeg` / `cal_maxNeg`) | ❌ | No negative colormap/threshold support found |
| `colormapType` threshold modes | ❌ | Not found on controller API |

## 17. Measurements

| Feature | Status | Notes |
|---------|--------|-------|
| Distance measurement | ✅ | `NVMeasurement` view component |
| `clearMeasurements()` | ✅ | |
| Angle measurements | ❌ | No angle measurement found |
| `clearAngles()` | ❌ | |
| `getDescriptives()` — ROI statistics | ❌ | |

## 18. Registration / Affine Transforms

| Feature | Status | Notes |
|---------|--------|-------|
| `getVolumeAffine` / `setVolumeAffine` | ❌ | No public affine get/set on controller |
| `applyVolumeTransform` | ❌ | Transform system is for processing, not affine manipulation |
| `resetVolumeAffine` | ❌ | |
| Affine utilities (`copyAffine`, `multiplyAffine`, etc.) | ⚠️ | `NVTransforms` module exists but not publicly exported |

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
| `propertyChange` | ✅ | |
| `locationChange` / `intensityChange` | ❌ | Not in event map |
| `dragRelease` | ❌ | |
| `clickToSegment` event | ❌ | |
| `measurementCompleted` / `angleCompleted` | ❌ | |
| `documentLoaded` | ❌ | |
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
| DICOM loader plugin | ❌ | No built-in DICOM plugin |
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
| DICOM (plugin) | ❌ |
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

1. **Drawing segmentation tools**: `drawOtsu`, `drawingBinaryDilationWithSeed`, `interpolateMaskSlices`, `findDrawingBoundarySlices`, click-to-segment, flood fill
### High Priority (Core Functionality)
3. **Negative colormaps/thresholds**: `cal_minNeg`, `cal_maxNeg`, `setColormapNegative`, `colormapType`
4. **Affine manipulation**: `getVolumeAffine`, `setVolumeAffine`, `applyVolumeTransform`, `resetVolumeAffine`
5. **Mesh overlay formats**: GIfTI, CIfTI-2, MZ3, FreeSurfer ANNOT layer readers
6. **Image processing**: `removeHaze`, standalone `binarize`
7. **ROI statistics**: `getDescriptives`

### Medium Priority
9. **3D rendering**: `setGradientOpacity`, `setAdditiveBlend` (MIP), custom gradient textures
10. **Clip plane methods**: `setClipPlane(s)` explicit API
11. **Volume/mesh lookup by ID/URL**: `getVolumeIndexByID`, `getMeshIndexByID`, `removeVolumeByUrl`, `removeMeshByUrl`
12. **Angle measurements**
13. **~~HTML/scene export~~**: ~~`saveHTML`, `generateHTML`~~ (done — `@niivue/nv-ext-save-html`), `saveScene`
14. **Zarr volume format**
15. **DICOM loading** (plugin)
16. **FreeSurfer connectome** loader
17. **NVImage class methods**: coordinate conversion, getValue, clone, etc. (architectural difference — NVImage is a type not a class)

### Lower Priority
18. **Mouse/touch event config**: `setMouseEventConfig`, `setTouchEventConfig`
19. **`cloneVolume`**
20. **`setAtlasOutline`**
21. **`colormapInvert`**
22. **Mesh utilities**: `decimateFaces`, `linesToCylinders`, `createFiberDensityMap`, `reverseFaces`
23. **Missing events**: `locationChange`, `intensityChange`, `dragRelease`, `measurementCompleted`, `angleCompleted`, `documentLoaded`, `volumeOrderChanged`
24. **Enum exports**: `NiiIntentCode`
25. **AFNI .niml.tract** tractography format
26. **Legacy callback properties**
27. **`watchOptsChanges`** (replaced by `propertyChange` event)

### Deferred (Not Planning to Implement Soon)
- **`drawGrowCut`** — GPU grow-cut segmentation
- **Custom mesh shaders**: entire shader system (`createCustomMeshShader`, `setMeshShader`, `meshShaderNames`)
