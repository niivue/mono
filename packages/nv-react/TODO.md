# TODO — @niivue/nvreact

Planned features and improvements. Check items off as they are completed.

---

## 1. Tests

~~No test files exist yet.~~ Comprehensive coverage added using Bun's built-in
test runner (`bun:test`). CI workflow runs `bun test --coverage` on every push
and PR.

- [x] Controller unit tests (`NvSceneController` lifecycle, layout, volumes, events, broadcasting)
- [x] Hook tests (`useScene`, `useNiivue`, `useSceneEvent`, `useSceneContext`)
- [x] Component smoke tests (`NvScene`, `NvViewer`, `NvSceneProvider`)
- [x] Volume diffing logic in `NvViewer`

## 2. Colormaps and Intensity Controls

~~No React-level API for changing colormaps, adjusting window/level
(contrast/brightness), or per-volume opacity.~~

Controller methods (`setColormap`, `setCalMinMax`, `setOpacity`) identify
volumes by viewer index + volume index. `NvViewer` declarative diffing detects
changes to `colormap`, `cal_min`, `cal_max`, and `opacity` on already-loaded
volumes and applies them without reloading.

- [x] Support colormap, `cal_min`, `cal_max`, and `opacity` in `ImageFromUrlOptions` / volume props
- [x] Controller methods: `setColormap`, `setCalMinMax`, `setOpacity`
- [x] Events: `colormapChanged`, `intensityChanged`, `opacityChanged`

## 3. Mesh / Surface Support

The library is entirely volume-centric. Niivue supports meshes (`.obj`, `.vtk`,
FreeSurfer surfaces) but none of that is exposed.

- [ ] `meshes` prop on `NvViewer` with declarative diffing (like `volumes`)
- [ ] Controller methods: `loadMesh`, `removeMesh`
- [ ] Events: `meshAdded`, `meshRemoved`

## 4. Crosshair Position Control (Controlled Component Pattern)

`locationChange` fires when the user moves the crosshair, but there is no way
to set it programmatically.

- [ ] Controller method: `setCrosshairPosition(viewerIndex, { x, y, z })`
- [ ] `NvViewer` prop: `crosshairPosition`
- [ ] Hook: `useCrosshairPosition(scene, viewerIndex)` returning current coords

## 5. Screenshot / Export

No way to programmatically capture a viewer's canvas.

- [ ] Controller method: `screenshot(index)` returning a `Blob` or data URL
- [ ] `NvViewer` imperative handle or callback for screenshots

## 6. Annotations / Measurement Tools API

Niivue supports annotations (rulers, points, labels) but nothing is exposed at
the React level.

- [ ] Declarative `annotations` prop on `NvViewer`
- [ ] Controller methods: `addAnnotation`, `removeAnnotation`
- [ ] Events: `annotationAdded`, `annotationRemoved`

## 7. View State Serialization / Restore

No way to save and restore the entire scene state (layout, volumes, colormaps,
zoom, crosshair position).

- [ ] `scene.serialize()` returning a JSON-safe object
- [ ] `scene.restore(state)` to reconstruct a saved scene
- [ ] Enable bookmarking, sharing, and undo/redo workflows

## 8. Volume Header / Metadata Access

No React-friendly way to read volume header metadata (dimensions, voxel size,
orientation, data type).

- [ ] Hook: `useVolumeHeader(scene, viewerIndex, volumeIndex)`
- [ ] Expose structured metadata in the snapshot or via a dedicated method

## 9. Overlay / Drawing Support

Niivue supports overlay editing (painting voxels for segmentation masks) but
nothing is exposed.

- [ ] Props or controller methods to enable drawing mode
- [ ] Brush size, label value, and erase controls
- [ ] Callback to retrieve modified overlay data

## 10. Drag & Drop File Loading

No built-in support for dragging NIfTI/DICOM files onto a viewer.

- [ ] `NvDropZone` wrapper component or `enableDragDrop` prop on `NvViewer`
- [ ] Events: `fileDropped`, `fileLoaded`

## 11. DICOM Support / Directory Loading

No convenience for loading DICOM series from a directory or multi-file drop.

- [ ] Controller method for DICOM directory/series loading
- [ ] Integration with drag & drop (item 10)

## 12. Loading State UI

The snapshot tracks `isLoading` but there are no built-in loading indicators.

- [ ] `showLoadingIndicator` prop on `NvScene` and `NvViewer`
- [ ] Render prop or slot for custom loading UI

## 13. Keyboard Shortcuts

No built-in keyboard navigation (scroll slices, zoom, reset view).

- [ ] `keyboardShortcuts` prop or plugin system
- [ ] Default bindings (arrow keys for slices, +/- for zoom, R for reset)

## 14. Responsive / Auto-fit Layouts

The layout system is fixed grids with absolute positioning. No responsive
behavior.

- [ ] Breakpoint-aware layouts that collapse on small containers
- [ ] Auto-fit layout option based on container width
