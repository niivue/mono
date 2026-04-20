# NiiVueGPU Events

NiiVueGPU uses the standard [`EventTarget`](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget) API. Every controller instance is an `EventTarget`, so you use `addEventListener` and `removeEventListener` just like a DOM element.

All events are fully typed via `NVEventMap`. TypeScript will infer the correct `CustomEvent<T>` detail type for each event name when using `addEventListener`/`removeEventListener`.

## Quick Start

```js
import NiiVue from 'niivuegpu'

const nv = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
await nv.attachToCanvas(document.getElementById('gl'))

// Listen for crosshair navigation
nv.addEventListener('locationChange', (e) => {
  console.log(e.detail.string) // human-readable location
  console.log(e.detail.mm)     // [x, y, z] in mm
  console.log(e.detail.values) // per-volume intensity values
})

// Listen for any property change
nv.addEventListener('change', (e) => {
  console.log(`${e.detail.property} = ${e.detail.value}`)
})

// Clean up
const handler = (e) => { /* ... */ }
nv.addEventListener('volumeLoaded', handler)
nv.removeEventListener('volumeLoaded', handler)
```

## TypeScript Usage

Event listeners are fully typed. The detail type is inferred from the event name:

```ts
import NiiVue from 'niivuegpu'

const nv = new NiiVue()

nv.addEventListener('locationChange', (evt) => {
  // evt is CustomEvent<NiiVueLocation> — fully typed
  const { mm, vox, values } = evt.detail
})

nv.addEventListener('documentLoaded', (evt) => {
  // evt is Event (no detail) — events with undefined payload use plain Event
})
```

## Event Reference

### User Interaction

#### `locationChange`
Fired when the crosshair position changes (user click, keyboard navigation, or programmatic).

| Field | Type | Description |
|-------|------|-------------|
| `mm` | `[number, number, number]` | Position in mm |
| `vox` | `[number, number, number]` | Rounded voxel indices |
| `frac` | `[number, number, number]` | Scene fraction [0..1] |
| `xy` | `[number, number]` | Mouse position on canvas |
| `axCorSag` | `number` | Slice orientation (0=sagittal, 1=coronal, 2=axial) |
| `values` | `NiiVueLocationValue[]` | Per-volume data (name, value, label) |
| `string` | `string` | Human-readable location with values |

```js
nv.addEventListener('locationChange', (e) => {
  document.getElementById('info').textContent = e.detail.string
})
```

#### `frameChange`
Fired when the current 4D frame changes on a volume.

| Field | Type | Description |
|-------|------|-------------|
| `volume` | `NVImage` | The volume whose frame changed |
| `frame` | `number` | New frame index (0-based) |

```js
nv.addEventListener('frameChange', (e) => {
  slider.value = e.detail.frame
})
```

#### `dragRelease`
Fired when any drag interaction completes on a 2D slice.

| Field | Type | Description |
|-------|------|-------------|
| `tileIdx` | `number` | Index of the tile where drag occurred |
| `axCorSag` | `number` | Slice orientation |
| `mmLength` | `number` | Drag distance in mm |
| `voxStart` | `[number, number, number]` | Start position (voxel, rounded) |
| `voxEnd` | `[number, number, number]` | End position (voxel, rounded) |
| `mmStart` | `[number, number, number]` | Start position in mm |
| `mmEnd` | `[number, number, number]` | End position in mm |

#### `measurementCompleted`
Fired when a distance measurement line is completed.

| Field | Type | Description |
|-------|------|-------------|
| `startMM` | `[number, number, number]` | Start point in mm |
| `endMM` | `[number, number, number]` | End point in mm |
| `distance` | `number` | Distance in mm |
| `sliceIndex` | `number` | Slice tile index |
| `sliceType` | `number` | Slice orientation |
| `slicePosition` | `number` | Slice position in mm |

#### `angleCompleted`
Fired when an angle measurement (two lines) is completed.

| Field | Type | Description |
|-------|------|-------------|
| `firstLine` | `{ startMM, endMM }` | First line endpoints in mm |
| `secondLine` | `{ startMM, endMM }` | Second line endpoints in mm |
| `angle` | `number` | Angle in degrees |
| `sliceIndex` | `number` | Slice tile index |
| `sliceType` | `number` | Slice orientation |
| `slicePosition` | `number` | Slice position in mm |

#### `pointerUp`
Fired on every pointer release over the canvas.

| Field | Type | Description |
|-------|------|-------------|
| `x` | `number` | Pointer X offset on canvas |
| `y` | `number` | Pointer Y offset on canvas |
| `button` | `number` | Mouse button (0=left, 1=middle, 2=right) |

---

### Loading & Removal

#### `volumeLoaded`
Fired after a volume is successfully added (via `addVolume()` or `loadVolumes()`). Fires once per volume.

| Field | Type | Description |
|-------|------|-------------|
| `volume` | `NVImage` | The newly loaded volume |

#### `meshLoaded`
Fired after a mesh is successfully added (via `addMesh()` or `loadMeshes()`). Fires once per mesh.

| Field | Type | Description |
|-------|------|-------------|
| `mesh` | `NVMesh` | The newly loaded mesh |

#### `volumeRemoved`
Fired before a volume is removed. When removing all volumes, fires once per volume in reverse order.

| Field | Type | Description |
|-------|------|-------------|
| `volume` | `NVImage` | The volume being removed |
| `index` | `number` | Index in the volumes array |

#### `meshRemoved`
Fired before a mesh is removed.

| Field | Type | Description |
|-------|------|-------------|
| `mesh` | `NVMesh` | The mesh being removed |
| `index` | `number` | Index in the meshes array |

#### `documentLoaded`
Fired after `loadDocument()` completes. No detail payload — the loaded state is reflected in the model.

```js
nv.addEventListener('documentLoaded', () => {
  console.log(`Loaded ${nv.volumes.length} volumes`)
})
```

---

### View Lifecycle

#### `viewAttached`
Fired after `attachToCanvas()` or `attachTo()` completes successfully (GPU initialized, interaction handlers set up).

| Field | Type | Description |
|-------|------|-------------|
| `canvas` | `HTMLCanvasElement` | The attached canvas |
| `backend` | `'webgpu' \| 'webgl2'` | Active rendering backend |

```js
nv.addEventListener('viewAttached', (e) => {
  console.log(`Rendering with ${e.detail.backend}`)
})
```

#### `viewDestroyed`
Fired when `destroy()` is called, before teardown begins. No detail payload.

#### `canvasResize`
Fired when the canvas is resized (via ResizeObserver).

| Field | Type | Description |
|-------|------|-------------|
| `width` | `number` | New canvas clientWidth |
| `height` | `number` | New canvas clientHeight |

```js
nv.addEventListener('canvasResize', (e) => {
  overlay.style.width = `${e.detail.width}px`
})
```

---

### View Control

#### `azimuthElevationChange`
Fired when `azimuth` or `elevation` is set programmatically.

| Field | Type | Description |
|-------|------|-------------|
| `azimuth` | `number` | Current azimuth (degrees) |
| `elevation` | `number` | Current elevation (degrees) |

#### `clipPlaneChange`
Fired when a clip plane is modified via `setClipPlane()` or `setClipPlaneDepthAziElev()`.

| Field | Type | Description |
|-------|------|-------------|
| `clipPlane` | `number[]` | `[depth, azimuth, elevation]` |

#### `sliceTypeChange`
Fired when `sliceType` is set.

| Field | Type | Description |
|-------|------|-------------|
| `sliceType` | `number` | New slice type value |

---

### Data Updates

#### `volumeUpdated`
Fired after `setVolume()` applies property changes to a volume.

| Field | Type | Description |
|-------|------|-------------|
| `volumeIndex` | `number` | Index of the updated volume |
| `volume` | `NVImage` | The volume (after update) |
| `changes` | `VolumeUpdate` | The options that were applied |

```js
nv.addEventListener('volumeUpdated', (e) => {
  const { volumeIndex, changes } = e.detail
  if (changes.colormap) updateColormapUI(volumeIndex, changes.colormap)
})
```

#### `meshUpdated`
Fired after `setMesh()` applies property changes to a mesh.

| Field | Type | Description |
|-------|------|-------------|
| `meshIndex` | `number` | Index of the updated mesh |
| `mesh` | `NVMesh` | The mesh (after update) |
| `changes` | `MeshUpdate` | The options that were applied |

#### `colormapAdded`
Fired after `addColormap()` or `addColormapFromUrl()` registers a new user-defined colormap. The new LUT is then visible to volumes, mesh layers, colorbars, connectomes, and tracts.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Registered colormap name |

```js
nv.addEventListener('colormapAdded', (e) => {
  populateColormapDropdown(nv.colormaps)
  console.log(`registered ${e.detail.name}`)
})
```

---

### Drawing

#### `drawingChanged`
Fired on drawing lifecycle events and user strokes.

| Field | Type | Description |
|-------|------|-------------|
| `action` | `'stroke' \| 'create' \| 'close' \| 'undo'` | What happened |

- `'create'` — `createEmptyDrawing()` was called
- `'stroke'` — user completed a pen stroke (pointerup)
- `'undo'` — `drawUndo()` restored a previous state
- `'close'` — `closeDrawing()` destroyed the drawing

#### `drawingEnabled`
Fired when `drawIsEnabled` is set.

| Field | Type | Description |
|-------|------|-------------|
| `isEnabled` | `boolean` | Whether drawing mode is now active |

#### `penValueChanged`
Fired when `drawPenValue` is set.

| Field | Type | Description |
|-------|------|-------------|
| `penValue` | `number` | New pen label index |

---

### Annotations

#### `annotationAdded`
Fired when a new vector annotation is added.

| Field | Type | Description |
|-------|------|-------------|
| `annotation` | `VectorAnnotation` | The newly added annotation |

#### `annotationRemoved`
Fired when a vector annotation is removed.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | ID of the removed annotation |

#### `annotationChanged`
Fired on annotation editing events (draw, erase, move, resize, undo, redo, clear).

| Field | Type | Description |
|-------|------|-------------|
| `action` | `'draw' \| 'erase' \| 'move' \| 'resize' \| 'undo' \| 'redo' \| 'clear'` | What happened |

---

### Generic Property Change

#### `change`
Fired by every property setter on the controller. Use this for unified state tracking without subscribing to individual events.

| Field | Type | Description |
|-------|------|-------------|
| `property` | `string` | Property name (matches the setter name, e.g. `'azimuth'`, `'isColorbarVisible'`) |
| `value` | `unknown` | New value |

```js
// Log all property changes
nv.addEventListener('change', (e) => {
  console.log(`${e.detail.property} changed to`, e.detail.value)
})

// React to specific properties
nv.addEventListener('change', (e) => {
  if (e.detail.property === 'backgroundColor') {
    document.body.style.background = `rgba(${e.detail.value})`
  }
})
```

Properties that emit `change` include all controller setters: `azimuth`, `elevation`, `crosshairPos`, `sliceType`, `backgroundColor`, `isColorbarVisible`, `volumeIllumination`, `meshXRay`, `drawPenValue`, `primaryDragMode`, and all others. Some setters also emit a more specific event (e.g. `azimuthElevationChange`, `sliceTypeChange`).

---

## Migrating from Callbacks

The old callback-based API (`onLocationChange`, `onFrameChange`, `onDragRelease`) has been replaced by events. Migration is straightforward:

```js
// Before (callbacks in constructor)
const nv = new NiiVue({
  onLocationChange: (data) => { /* ... */ },
  onFrameChange: (volume, frame) => { /* ... */ },
  onDragRelease: (info) => { /* ... */ },
})

// After (addEventListener)
const nv = new NiiVue({})
nv.addEventListener('locationChange', (e) => { /* e.detail === data */ })
nv.addEventListener('frameChange', (e) => {
  const { volume, frame } = e.detail
})
nv.addEventListener('dragRelease', (e) => { /* e.detail === info */ })
```

Key differences:
- Event data is in `e.detail` (standard `CustomEvent` pattern)
- Listeners can be added/removed at any time, not just at construction
- Multiple listeners per event are supported
- Events with no payload (e.g. `documentLoaded`, `viewDestroyed`) use plain `Event` instead of `CustomEvent`

## Exported Types

All event detail types are exported from the package for use in TypeScript:

```ts
import type {
  NVEventMap,
  NVEventTarget,
  FrameChangeDetail,
  VolumeLoadedDetail,
  MeshLoadedDetail,
  VolumeRemovedDetail,
  MeshRemovedDetail,
  AzimuthElevationChangeDetail,
  ClipPlaneChangeDetail,
  SliceTypeChangeDetail,
  PenValueChangedDetail,
  DrawingChangedDetail,
  DrawingEnabledDetail,
  PropertyChangeDetail,
  PointerUpDetail,
  VolumeUpdatedDetail,
  MeshUpdatedDetail,
  ViewAttachedDetail,
  CanvasResizeDetail,
  AnnotationAddedDetail,
  AnnotationRemovedDetail,
  AnnotationChangedDetail,
  ColormapAddedDetail,
} from 'niivuegpu'
```
