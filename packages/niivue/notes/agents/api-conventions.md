# API conventions

Moved from `packages/niivue/AGENTS.md`; read it when working on a public property, setter, method, event or load option. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## API conventions

See `notes/api.md` for full style guide and `docs/reference/migrating.md` for old→new property mapping.

### Naming rules

- **Booleans** use verb prefixes: `isColorbarVisible`, `isRadiological`, `isEnabled`
- **camelCase** throughout: `calMin`, `calMax`, `crosshairPos` (not `cal_min`)
- **Drop redundant prefixes** when context is provided by the group: `model.draw.penValue` not `model.draw.drawPenValue`

### Model organization — 8 config groups

The model is organized into 8 semantic config groups:

| Group | Purpose | Example properties |
|-------|---------|-------------------|
| `scene` | Camera, crosshair, clip planes, background | `azimuth`, `elevation`, `backgroundColor`, `scaleMultiplier` |
| `layout` | Slice type, mosaic, multiplanar, hero, tiling | `sliceType`, `mosaicString`, `heroFraction`, `isRadiological`, `isSingleViewFillCanvas` |
| `ui` | Visual chrome: colorbars, orient labels, fonts | `isColorbarVisible`, `crosshairWidth`, `fontScale`, `placeholderText` |
| `volume` | Global volume rendering settings | `illumination`, `isNearestInterpolation`, `outlineWidth` |
| `mesh` | Global mesh rendering settings | `xRay`, `thicknessOn2D` |
| `draw` | Drawing/annotation settings | `isEnabled`, `penValue`, `opacity` |
| `annotation` | Vector annotation settings | `isEnabled`, `activeLabel`, `activeGroup`, `brushRadius` |
| `interaction` | Drag modes, mouse behavior | `primaryDragMode`, `isSnapToVoxelCenters` |

Properties that don't belong in any group (computed geometry, data arrays, transient state) stay on the model root.

### Controller API — flat getters/setters

The controller exposes flat property getters/setters. Each setter automatically triggers `drawScene()`:

```js
nv1.azimuth = 110                 // triggers drawScene()
nv1.isColorbarVisible = true      // triggers drawScene()
nv1.drawPenValue = 3              // triggers drawScene()
nv1.volumeIllumination = 0.6      // triggers drawScene()
nv1.meshXRay = 0.1                // triggers drawScene()
```

**Prefix rules:** Scene/layout/UI/interaction properties have no prefix. Volume, mesh, draw, and annotation properties are prefixed (`volume`, `mesh`, `draw`, `annotation`). Boolean `is`/`has` comes after domain prefix: `volumeIsAlphaClipDark`, `drawIsEnabled`.

Multiple sets in the same synchronous block = one render (RAF batching).

### Constructor (flat options)

```js
const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  isColorbarVisible: true,
  volumeIllumination: 0.6,
  meshXRay: 0.1,
  drawPenSize: 5,
  primaryDragMode: DRAG_MODE.crosshair,
})
nv1.addEventListener('locationChange', (e) => {
  const location = e.detail  // NiiVueLocation
})
```

### Methods vs property setters

Use **property setters** for single-value global config (`nv1.azimuth = 110`).

Use **methods** for:
- Async operations: `loadVolumes()`, `loadMeshes()`
- Actions: `drawUndo()`, `createEmptyDrawing()`, `destroy()`
- Multi-target: `setVolume(idx, opts)`, `setFrame4D(id, frame)`
- Special formats: `setClipPlane([depth, azimuth, elevation])`
- IO: `saveDocument()`, `loadDocument()`

### Events (EventTarget API)

NiiVue extends `EventTarget`. Use `addEventListener`/`removeEventListener` for all notifications:

```js
nv1.addEventListener('locationChange', (e) => { ... })  // crosshair moved
nv1.addEventListener('volumeLoaded', (e) => { ... })    // volume finished loading
nv1.addEventListener('clipPlaneChange', (e) => { ... }) // clip plane adjusted
```

See `docs/reference/events.md` for the full event catalog and detail types.

**Emission order — every event fires after its mutation.** Add / update /
reorder / remove events all fire once the model has changed: `addVolume`→
`volumeLoaded` (the volume is in `nv.volumes`), `setVolume`→`volumeUpdated`,
`moveVolume*`→`volumeOrderChanged`, `removeVolume`→`volumeRemoved` (the volume
is no longer in `nv.volumes`), and the mesh, signal and measurement
equivalents. A removal event's `detail` carries the removed item and its former
index, so a listener reaches a departing item through `detail`, never the
collection. A listener that rebuilds a list by re-reading the collection can do
so synchronously inside any of these events and see the post-mutation state.
`loadDocument` follows the same rule for everything it replaces and restores
(`volumeRemoved`/`meshRemoved`/`signalRemoved`, then `change` per applied
setting, then `volumeLoaded`/`meshLoaded`/`signalLoaded`/`drawingChanged`, then
`documentLoaded` last). New methods should follow this.

### Per-item options (unified load + update)

```js
await nv1.loadVolumes([{ url: '...', calMin: 30, calMax: 80, isColorbarVisible: false }])
nv1.setVolume(0, { calMin: 40, colormap: 'hot' })
```

Same pattern for meshes, layers, tracts, connectomes.
