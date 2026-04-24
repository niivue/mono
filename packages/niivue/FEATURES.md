# NiiVue Public API Features

Reference for the `@niivue/niivue` public surface, aimed at planning a SwiftUI
host app (iOS / iPadOS / macOS) that embeds NiiVue inside a `WKWebView`. Each
feature is mapped to the JavaScript access pattern you'd invoke from the Swift
side via `evaluateJavaScript` or a `WKScriptMessageHandler` bridge.

- **Kind** — how the feature is exposed: **Prop** (sync getter/setter on the
  controller), **Method** (call a function), **Ctor** (constructor option),
  **Event** (async callback via `addEventListener`), **Type/Enum** (exported
  symbol).
- **Async** — `Yes` means the call returns a `Promise`. From Swift, you must
  await a response message rather than reading a synchronous return.
- **Bridge pattern** — suggested SwiftUI ↔ WebView interaction.

Source of truth: `packages/niivue/src/index.ts` (package exports),
`NVControlBase.ts` (controller), `NVTypes.ts` (types), `NVEvents.ts` (events),
`NVConstants.ts` (enums).

---

## 1. Lifecycle & Attachment

| Feature | Kind | Async | Signature / Notes | Bridge pattern |
|---|---|---|---|---|
| `new NiiVueGPU(options)` | Ctor | No | Flat `NiiVueOptions` — see §13 | Inject JS on page load |
| `attachTo(elementId)` | Method | Yes | Binds to a canvas by DOM id | Call once after WKWebView loads the HTML |
| `attachToCanvas(canvas, isAntiAlias?)` | Method | Yes | Binds to a `HTMLCanvasElement` | Alt. to `attachTo` |
| `destroy()` | Method | No | Releases GPU resources + listeners | Call before tearing down view |
| `resize()` | Method | No | Force canvas resize | Call on SwiftUI size-class change |
| `reinitializeView(options)` | Method | Yes | Recreate view (e.g. backend swap) | Rare; advanced |
| `backend` | Prop (get) | No | `'webgpu' \| 'webgl2' \| undefined` | Read for UI capability gating |
| `isAntiAlias` | Prop (get) | No | Read-only | — |
| `devicePixelRatio` / `forceDevicePixelRatio` | Prop | No | Override DPR | Tune for Retina/ProMotion |
| `isDragDropEnabled` | Prop | No | Allow file drag-drop | Usually disable in native shell |

## 2. Volume Loading & Management

| Feature | Kind | Async | Signature / Notes | Bridge pattern |
|---|---|---|---|---|
| `loadVolumes(list)` | Method | Yes | `[{ url, ... }]` — see `ImageFromUrlOptions` | Primary load path |
| `addVolume(volOrOptions)` | Method | Yes | Append a single volume | |
| `loadImage(opts)` / `addImage(opts)` | Method | Yes | Mixed volume-or-mesh variant | |
| `loadDeferred4DVolumes(id)` | Method | Yes | Pull remaining 4D frames on demand | |
| `removeAllVolumes()` | Method | Yes | | Wrap in Swift "Close all" |
| `moveVolumeUp / Down / ToTop / ToBottom(index)` | Method | Yes | Re-order layers | Drag-reorder UI |
| `setVolume(index, VolumeUpdate)` | Method | Yes | Per-layer props: `calMin`, `calMax`, `colormap`, `opacity`, `colormapNegative`, `colormapLabel`, `modulationImage`, … | Slider/picker bindings |
| `setModulationImage(targetId, modulatorId)` | Method | Yes | Modulate overlay brightness by another volume | |
| `loadImgV1(volumeIndex, flipX?, flipY?, flipZ?)` | Method | Yes | Convert to V1 RGB vector | |
| `recalculateCalMinMax(volumeIndex)` | Method | Yes | Reset window/level from data | "Auto window" button |
| `volumes` | Prop (get) | No | `readonly NVImage[]` | Observable list for SwiftUI |
| `useLoader(…)` | Method | No | Register custom format reader | Usually unused from native |

Supported built-in volume formats: NIfTI (`.nii`/`.nii.gz`), NRRD, MRtrix MIF,
AFNI HEAD/BRIK, MGH/MGZ, ITK MHD/MHA, ECAT7, DSI Studio FIB/SRC, BMP, V16, VMR,
NPY/NPZ. DICOM/Zarr/MINC/TIFF require external plugins.

## 3. Mesh, Tract & Connectome Loading

| Feature | Kind | Async | Signature / Notes |
|---|---|---|---|
| `loadMeshes(list)` | Method | Yes | `[{ url, ... }]` |
| `addMesh(meshOrOptions)` | Method | Yes | |
| `removeMesh(index)` | Method | Yes | |
| `removeAllMeshes()` | Method | Yes | |
| `setMesh(index, MeshUpdate)` | Method | Yes | Per-mesh props |
| `addMeshLayer(meshIndex, opts)` | Method | Yes | Scalar overlay |
| `removeMeshLayer(meshIndex, layerIndex)` | Method | Yes | |
| `setMeshLayerProperty(…)` | Method | Yes | |
| `setMeshLayerFrame4D(…)` | Method | Yes | |
| `setTractOptions(meshIndex, NVTractOptions)` | Method | Yes | Radius, sides, decimation, scalars |
| `getTractGroups(meshIndex)` | Method | No | `string[]` |
| `setConnectomeOptions(meshIndex, NVConnectomeOptions)` | Method | Yes | Node/edge scale, thresholds |
| `getMeshShader(meshIndex)` | Method | No | `'phong' \| 'flat' \| 'matte' \| 'toon' \| 'outline' \| 'rim' \| 'silhouette' \| 'crevice' \| 'vertexColor' \| 'crosscut'` |
| `meshes` | Prop (get) | No | `readonly NVMesh[]` |
| `meshShaders` | Prop (get) | No | Available shader names |
| `meshExtensions` / `meshWriteExtensions` | Prop (get) | No | Supported file formats |

Mesh formats: GIfTI, FreeSurfer, PLY, STL, OBJ, VTK, MZ3, OFF, GEO/BYU, DFS,
ICO/TRI, BrainNet NV, BrainVoyager SRF, X3D, ASC, WRL, IWM. Tracts: TCK, TRK,
TRX, TT, TSF (scalars), VTK lines.

## 4. Scene (Camera, Clipping, Background)

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `azimuth`, `elevation` | Prop | No | 3D camera angles |
| `crosshairPos` | Prop | No | `vec3` in scene fraction (or mm if `isPositionInMM`) |
| `pan2Dxyzmm` | Prop | No | 2D pan/zoom state |
| `scaleMultiplier` | Prop | No | Global zoom |
| `gamma` | Prop | No | |
| `backgroundColor` | Prop | No | `[r,g,b,a]` 0–1 |
| `clipPlaneColor` | Prop | No | Alpha sign controls cutaway vs tint |
| `isClipPlaneCutaway` | Prop | No | |
| `setClipPlane([depth,azi,elev])` | Method | No | Single active plane |
| `setClipPlanes([[…], …])` | Method | No | Up to 6 planes |
| `getClipPlaneDepthAziElev(i)` | Method | No | |
| `setClipPlaneDepthAziElev(i, d, a, e)` | Method | No | |
| `activeClipPlaneIndex`, `currentClipPlaneIndex` | Prop | No | |

## 5. Layout & View Mode

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `sliceType` | Prop | No | Use `SLICE_TYPE` enum: `AXIAL=0`, `CORONAL=1`, `SAGITTAL=2`, `MULTIPLANAR=3`, `RENDER=4` |
| `multiplanarType` | Prop | No | `AUTO/COLUMN/GRID/ROW` via `MULTIPLANAR_TYPE` |
| `showRender` | Prop | No | `SHOW_RENDER.NEVER/ALWAYS/AUTO` |
| `mosaicString` | Prop | No | DSL: e.g. `'A -20 0 20 ; S R X 0 S R X -0'` |
| `heroFraction` | Prop | No | 0–1, hero tile width |
| `heroSliceType` | Prop | No | |
| `isEqualSize` | Prop | No | |
| `isMosaicCentered` | Prop | No | |
| `tileMargin` | Prop | No | |
| `isRadiological` | Prop | No | Flip left/right |
| `customLayout` | Prop | No | `CustomLayoutTile[]` — explicit tile list |
| `clearCustomLayout()` | Method | No | |
| `setBounds([x1,y1,x2,y2])` | Method | No | Shared-canvas bounds |

## 6. UI Chrome

| Feature | Kind | Notes |
|---|---|---|
| `isColorbarVisible`, `isOrientCubeVisible`, `isOrientationTextVisible` | Prop | Toggles |
| `is3DCrosshairVisible`, `isCrossLinesVisible` | Prop | |
| `isGraphVisible` (4D), `isRulerVisible`, `isLegendVisible` | Prop | |
| `isPositionInMM` | Prop | Crosshair coord space |
| `isMeasureUnitsVisible` | Prop | |
| `isThumbnailVisible`, `thumbnailUrl`, `placeholderText` | Prop | Load-time preview |
| `crosshairColor`, `crosshairGap`, `crosshairWidth` | Prop | |
| `fontColor`, `fontScale`, `fontMinSize` | Prop | |
| `selectionBoxColor`, `measureLineColor`, `measureTextColor` | Prop | |
| `rulerWidth` | Prop | |
| `graphNormalizeValues`, `graphIsRangeCalMinMax` | Prop | 4D graph styling |

## 7. Volume Rendering (global)

| Feature | Kind | Notes |
|---|---|---|
| `volumeIllumination` | Prop | 0–1; matcap lighting for 3D render |
| `volumeOutlineWidth` | Prop | Overlay outline thickness |
| `volumeAlphaShader` | Prop | Selects ray-march variant |
| `volumeIsBackgroundMasking` | Prop | |
| `volumeIsAlphaClipDark` | Prop | |
| `volumeIsNearestInterpolation` | Prop | Nearest vs linear |
| `volumeIsV1SliceShader` | Prop | Treat overlay as fiber direction |
| `volumeMatcap` | Prop | Matcap name |
| `volumePaqdUniforms` | Prop | PAQD atlas tuning |
| `loadMatcap(nameOrUrl)` | Method (async) | Register matcap at runtime |

## 8. Mesh Rendering (global)

| Feature | Kind | Notes |
|---|---|---|
| `meshXRay` | Prop | 0–1 opacity in 3D |
| `meshThicknessOn2D` | Prop | Clip to ±N mm of slice plane |

## 9. Drawing / Segmentation

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `drawIsEnabled` | Prop | No | Pen on/off |
| `drawPenValue` | Prop | No | Label index |
| `drawPenSize` | Prop | No | |
| `drawIsFillOverwriting` | Prop | No | |
| `drawOpacity`, `drawRimOpacity` | Prop | No | |
| `drawColormap` | Prop | No | |
| `drawingVolume` | Prop (get/set) | No | `NVImage \| null` |
| `drawingColormaps` | Prop (get) | No | Available palettes |
| `createEmptyDrawing()` | Method | No | |
| `closeDrawing()` | Method | No | Destroys drawingVolume |
| `drawUndo()` | Method | No | Circular undo buffer |
| `refreshDrawing()` | Method | No | Force GPU upload |
| `saveDrawing(filename?)` | Method | Yes | Returns `Uint8Array` or triggers download |
| `loadDrawing(…)` | Method | Yes | |
| `drawPenAutoClose`, `drawPenFilled` | Prop | No | |
| `maxDrawUndoBitmaps` | Prop | No | Default 8 |

## 10. Vector Annotations

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `annotationIsEnabled` | Prop | No | |
| `annotationActiveLabel`, `annotationActiveGroup` | Prop | No | |
| `annotationBrushRadius` | Prop | No | |
| `annotationIsErasing` | Prop | No | |
| `annotationIsVisibleIn3D` | Prop | No | |
| `annotationStyle` | Prop | No | `AnnotationStyle` |
| `annotationTool` | Prop | No | `AnnotationTool` union |
| `annotations` | Prop (get) | No | `readonly VectorAnnotation[]` |
| `selectedAnnotation`, `selectAnnotation(id)` | Prop / Method | No | |
| `addAnnotation(a)`, `removeAnnotation(id)`, `clearAnnotations()` | Method | No | |
| `annotationUndo()`, `annotationRedo()` | Method | No | |
| `getAnnotationsJSON()` / `loadAnnotationsJSON(json)` | Method | No | Round-trip through Swift |

## 11. Measurements

| Feature | Kind | Notes |
|---|---|---|
| `clearMeasurements()` | Method | |
| `measurementCompleted` / `angleCompleted` events | Event | See §15 |
| `measureLineColor`, `measureTextColor`, `isMeasureUnitsVisible` | Prop | Styling |
| Drag modes `measurement` (2) and `angle` (7) | Enum | Set via `primaryDragMode`/`secondaryDragMode` |

## 12. Interaction

| Feature | Kind | Notes |
|---|---|---|
| `primaryDragMode`, `secondaryDragMode` | Prop | `DRAG_MODE` enum: `none(0)`, `contrast(1)`, `measurement(2)`, `pan(3)`, `slicer3D(4)`, `callbackOnly(5)`, `roiSelection(6)`, `angle(7)`, `crosshair(8)`, `windowing(9)` |
| `setDragMode(modeOrString)` | Method | Convenience |
| `isSnapToVoxelCenters` | Prop | |
| `isYoked3DTo2DZoom` | Prop | |
| `moveCrosshairInVox(di, dj, dk)` | Method | Keyboard/button navigation |
| `getCrosshairPos()` / `setCrosshairPos([x,y,z])` | Method | |
| `vox2frac([i,j,k])` | Method | |
| `createOnLocationChange(axCorSag?)` | Method | Emit location event |

**Note for touch devices:** There is currently no public
`setTouchEventConfig` / `setMouseEventConfig`. Default drag modes apply to both
pointer and touch. For iOS/iPadOS you'll likely want `primaryDragMode =
DRAG_MODE.crosshair` plus long-press or two-finger gestures wired in SwiftUI
and forwarded through `moveCrosshairInVox` / `pan2Dxyzmm` / `azimuth` / etc.

## 13. Constructor Options (`NiiVueOptions`)

All flat keys; mirrors the prop list above. Grouping (from source):

- **Infrastructure** (set once): `backend`, `isAntiAlias`, `devicePixelRatio`,
  `bounds`, `showBoundsBorder`, `boundsBorderColor`, `boundsBorderThickness`,
  `font`, `matcaps`, `isDragDropEnabled`, `logLevel`, `thumbnail`.
- **Scene**: `azimuth`, `elevation`, `crosshairPos`, `pan2Dxyzmm`,
  `scaleMultiplier`, `gamma`, `backgroundColor`, `clipPlaneColor`,
  `isClipPlaneCutaway`.
- **Layout**: `sliceType`, `mosaicString`, `showRender`, `multiplanarType`,
  `heroFraction`, `heroSliceType`, `isEqualSize`, `isMosaicCentered`,
  `tileMargin`, `isRadiological`, `customLayout`.
- **UI**: all §6 props.
- **Volume**: all §7 props.
- **Mesh**: all §8 props.
- **Draw**: all §9 props (except methods).
- **Interaction**: all §12 props (except methods).
- **Annotation**: all §10 props (except methods).

## 14. Fonts, Colormaps, Matcaps

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `setFont(NVFontData)` | Method | Yes | In-memory atlas |
| `setFontFromUrl({ atlas, metrics })` | Method | Yes | Remote atlas + JSON metrics |
| `colormaps` | Prop (get) | No | Registered names (`string[]`) |
| `hasColormap(name)` | Method | No | |
| `addColormap(name, ColorMap)` | Method | No | `{ R, G, B, A?, I?, labels? }` |
| `addColormapFromUrl(url, name?)` | Method | Yes | |
| `setColormapLabel(volIdx, lut)` | Method | Yes | |
| `setColormapLabelFromUrl(volIdx, url)` | Method | Yes | |
| `loadMatcap(nameOrUrl)` | Method | Yes | |

## 15. Events (`addEventListener` / `removeEventListener`)

All events are standard `CustomEvent`s on the controller. Detail payload types
are exported from the package.

| Event | Detail type | When |
|---|---|---|
| `locationChange` | `NiiVueLocation` | Crosshair moved (voxel + mm + intensities) |
| `frameChange` | `{volume, frame}` | 4D frame changed |
| `dragRelease` | `DragReleaseInfo` | End of measurement/pan drag |
| `pointerUp` | `{x, y, button}` | |
| `measurementCompleted` | `CompletedMeasurement` | |
| `angleCompleted` | `CompletedAngle` | |
| `volumeLoaded` / `meshLoaded` | `{volume}` / `{mesh}` | |
| `volumeRemoved` / `meshRemoved` | `{volume, index}` / `{mesh, index}` | |
| `volumeUpdated` / `meshUpdated` | `{index, …, changes}` | After `setVolume` / `setMesh` |
| `volumeOrderChanged` | `{volumes}` | After reorder |
| `documentLoaded` | `undefined` | |
| `viewAttached` / `viewDestroyed` | attach detail / none | |
| `canvasResize` | `{width, height}` | |
| `azimuthElevationChange` | `{azimuth, elevation}` | |
| `clipPlaneChange` | `{clipPlane}` | |
| `sliceTypeChange` | `{sliceType}` | |
| `penValueChanged` | `{penValue}` | |
| `drawingChanged` | `{action}` | stroke/create/close/undo |
| `drawingEnabled` | `{isEnabled}` | |
| `annotationAdded` / `annotationRemoved` / `annotationChanged` | — | |
| `colormapAdded` | `{name}` | |
| `change` | `{property, value}` | Generic property-change firehose |

**Bridge pattern:** inside the WebView, attach a listener for each event you
care about, then `window.webkit.messageHandlers.<name>.postMessage(detail)` to
deliver it to a `WKScriptMessageHandler` in Swift. Use `change` as a catch-all
to stay in sync with controller-initiated prop changes (e.g. user rotates with
a drag and `azimuth` updates — Swift state needs to follow).

## 16. Saving & Export

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `saveVolume(index, SaveVolumeOptions)` | Method | Yes | NIfTI download or bytes |
| `saveMesh(index, opts)` | Method | Yes | Formats: STL, MZ3, OBJ, IWM |
| `saveBitmap(opts)` | Method | Yes | Screenshot |
| `saveDrawing(filename?)` | Method | Yes | NIfTI label volume |
| `serializeDocument()` | Method | No | Returns CBOR `Uint8Array` |
| `saveDocument(filename?)` | Method | No | Triggers browser download (.nvd) |
| `loadDocument(urlOrFile)` | Method | Yes | Reverse of save |
| `volumeWriteExtensions`, `volumeExtensions` | Prop (get) | No | |

For a native shell, prefer `serializeDocument()` + `saveBitmap()` returning the
`Uint8Array`, then hand bytes back to Swift via `postMessage` (ArrayBuffer
serializes as base64 or can be transferred). Avoid the built-in `saveDocument`
auto-download path on iOS.

## 17. Multi-instance / Sync

| Feature | Kind | Notes |
|---|---|---|
| `broadcastTo(targets?, SyncOpts?)` | Method | Sync two controllers sharing a canvas or running in split view |
| `bounds` (ctor) + `setBounds([x1,y1,x2,y2])` | Method | Normalized [0..1] sub-canvas region |

## 18. Extension Context (stable plugin API)

| Feature | Kind | Notes |
|---|---|---|
| `createExtensionContext()` | Method | Returns `NVExtensionContext` |
| `context.backgroundVolume` | Prop (getter) | `{img, hdr, dims, voxelSizeMM, calMin, calMax, robustMin/Max, globalMin/Max, imgRAS}` |
| `context.drawing` | Prop (getter) | `{bitmap, dims, voxelSizeMM, update, refresh, acquireSharedBuffer}` |
| `context.volumes` | Prop (getter) | `readonly NVImage[]` |
| `context.on(type, listener)` / `.off(…)` | Method | Supports all `NVEventMap` + slice pointer events |
| `slicePointerMove` / `slicePointerUp` / `slicePointerLeave` | Event | `SlicePointerEvent` with `voxel`, `mm`, `sliceType`, `canvasX/Y`, `pointerEvent` |
| `context.vox2mm` / `context.mm2vox` | Method | Coordinate conversions |
| `context.createEmptyDrawing()` / `closeDrawing()` / `drawUndo()` / `refreshDrawing()` | Method | |
| `context.addVolume(vol)` / `removeAllVolumes()` | Method | |
| `context.registerVolumeTransform(t)` / `applyVolumeTransform(name, vol, opts?)` | Method | |
| `context.dispose()` | Method | Releases listeners |

Exported helpers: `computeSlicePointerEvent`, `getImageDataRAS(volume)` (RAS
voxel-order `Float32Array`, zero-copy when possible).

## 19. Volume Transforms

| Feature | Kind | Notes |
|---|---|---|
| `volumeTransforms` | Prop (get) | Registered transform names |
| `volumeTransform` | Prop (get) | Name→function map |
| `getVolumeTransformInfo(name)` | Method | `TransformInfo \| undefined` |
| `registerVolumeTransform(VolumeTransform)` | Method | |
| `applyVolumeTransform(name, vol, opts?)` | Method (via extension context) | |

Built-in transforms include `conform` (1mm isotropic) and
`createConnectedLabelImage`. Additional segmentation / interpolation transforms
ship in `@niivue/nv-ext-drawing` and `@niivue/nv-ext-image-processing`.

## 20. 4D Volumes

| Feature | Kind | Async | Notes |
|---|---|---|---|
| `getFrame4D(id)` | Method | No | Current frame index |
| `setFrame4D(id, frame)` | Method | Yes | |
| `loadDeferred4DVolumes(id)` | Method | Yes | Pull remaining frames |
| `isGraphVisible`, `graphNormalizeValues`, `graphIsRangeCalMinMax` | Prop | — | 4D graph overlay |
| `frameChange` event | Event | — | |

## 21. Exported Enums & Types

From the package root (`@niivue/niivue`):

- **Enums/constants:** `DRAG_MODE`, `SLICE_TYPE`, `SHOW_RENDER`, `NiiDataType`.
- **Default export:** `NiiVueGPU` (also named export).
- **Core types:** `NiiVueOptions`, `NiiVueLocation`, `NiiVueLocationValue`,
  `NVImage`, `NVMesh`, `NVMeshLayer`, `NVTractOptions`, `NVConnectomeOptions`,
  `NVFontData`, `ColorMap`, `CustomLayoutTile`, `BackendType`, `NIFTI1`,
  `NIFTI2`, `TypedVoxelArray`, `SyncOpts`, `SaveVolumeOptions`, `ViewHitTest`,
  `DragReleaseInfo`, `ImageFromUrlOptions`, `MeshFromUrlOptions`,
  `MeshLayerFromUrlOptions`, `VolumeUpdate`, `MeshUpdate`.
- **Events:** `NVEventMap`, `NVEventListener`, `NVEventTarget`, and every
  `*Detail` type.
- **Extension API:** `NVExtensionContext`, `BackgroundVolumeAccess`,
  `DrawingAccess`, `DrawingDims`, `NVExtensionEventMap`, `SharedBufferHandle`,
  `SlicePointerEvent`.
- **Volume transforms:** `OptionField`, `ResultDefaults`, `TransformInfo`,
  `TransformOptions`, `VolumeTransform`.
- **Utilities:** `getImageDataRAS`, `NVWorker`, `computeSlicePointerEvent`.
- **Writer options:** `WriteOptions`.
- **Logger:** `LogLevel`.

Package subpath entries also ship bundled asset barrels:
`@niivue/niivue/assets/fonts`, `@niivue/niivue/assets/matcaps`, plus explicit
`/webgpu` and `/webgl2` entry points if you want to pin a backend.

---

## SwiftUI ↔ WebView Bridging Notes

1. **Synchronous property writes** (§4–§10, §12) are fire-and-forget — send a
   tiny `evaluateJavaScript("nv.azimuth = \(value)", …)` from Swift. The
   setter internally triggers `drawScene()` on RAF, so batching multiple sets
   in one JS call coalesces into a single render.
2. **Async methods** (load/save/transform) — use a request-id pattern: Swift
   sends `{ id, method, args }`, JS awaits then posts `{ id, result }` back
   via `WKScriptMessageHandler`.
3. **Controller-initiated state** (user dragged crosshair, rotated 3D, etc.):
   subscribe to `locationChange`, `azimuthElevationChange`, `sliceTypeChange`,
   `frameChange`, `drawingChanged`, `volumeUpdated`, `volumeOrderChanged`,
   and (optionally) the generic `change` event. Forward the detail to Swift
   and update `@Published` state there.
4. **Large binary payloads** (loaded volume bytes, screenshots, serialized
   documents): prefer passing file URLs / `blob:` URLs where possible; when
   sending raw `Uint8Array` across the bridge, base64-encode for
   `postMessage` or use a `fetch`-to-Swift scheme handler
   (`WKURLSchemeHandler`) for larger-than-a-few-MB transfers.
5. **File loading from Swift storage:** register a `WKURLSchemeHandler` (e.g.
   `niivue://volume/<id>`) and pass those URLs to `loadVolumes`. This works
   on iOS where `file://` paths inside the app container are otherwise
   awkward for the WebView.
6. **Gesture ergonomics on iPadOS/iOS:** the WebView already receives
   touch events, but consider mapping Apple Pencil pressure/tilt to
   `drawPenSize` from SwiftUI rather than relying on the DOM's
   `PointerEvent.pressure` inside the WebView. Force-touch and Apple Pencil
   hover events are more reliably handled natively.
7. **Backend selection:** on Apple platforms WebGPU availability varies
   (Safari 17+ macOS, progressive on iOS). Pass `backend: 'webgl2'` in
   `NiiVueOptions` if you need deterministic behavior; otherwise omit and
   let NiiVue auto-select.
