# Extensions and workers

Moved from `packages/niivue/AGENTS.md`; read it when working on the extension context API or Web Workers. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Extension context API

Stable plugin interface for extensions to interact with NiiVue without reaching into internals. Module: `src/extension/`. Created via `nv.createExtensionContext()`, which returns an `NVExtensionContext`. Multiple contexts can coexist — each tracks its own subscriptions.

**Lifecycle:** Call `context.dispose()` when done — removes all event listeners registered through that context and releases any shared buffers.

### Data access (live getters)

All properties are getters — always reflect current state, no staleness.

- **`context.backgroundVolume`** → `BackgroundVolumeAccess | null`: `img` (raw data in header order), `hdr`, `dims` (`{dimX, dimY, dimZ}` in RAS space), `voxelSizeMM`, `calMin`/`calMax`, `robustMin`/`robustMax`, `globalMin`/`globalMax`, `imgRAS` (Float32Array in RAS voxel order, cached, zero-copy when volume is already RAS-ordered).
- **`context.drawing`** → `DrawingAccess | null`: `bitmap` (Uint8Array, live reference), `dims`, `voxelSizeMM`, `update(bitmap)` (copy + refresh), `refresh()` (display-only refresh), `acquireSharedBuffer()` (swaps backing to SharedArrayBuffer for zero-copy worker communication; returns handle with `.view` and `.release()`).
- **`context.volumes`** → `readonly NVImage[]`: All loaded volumes.

### Events

`context.on(type, listener)` / `context.off(type, listener)` — subscribes to both standard `NVEventMap` events and extension-specific slice pointer events:

| Event | Detail | When |
|-------|--------|------|
| `slicePointerMove` | `SlicePointerEvent` | Pointer moves over a 2D slice (not dragging) |
| `slicePointerUp` | `SlicePointerEvent` | Pointer released over a 2D slice |
| `slicePointerLeave` | `undefined` | Pointer leaves the canvas |

**`SlicePointerEvent`** fields: `voxel` (RAS ijk, rounded), `mm` (world coords), `sliceType` (0=axial, 1=coronal, 2=sagittal), `canvasX`/`canvasY` (DPR-adjusted), `pointerEvent` (original DOM event). Hit-testing is done by NiiVue — extensions don't need manual `screenSlicePick` math.

Slice pointer events are emitted from `control/interactions.ts` via `computeSlicePointerEvent()`, which runs the hitTest → screenSlicePick → mm2vox pipeline and bounds-checks the result.

### Actions

- **Drawing:** `createEmptyDrawing()`, `closeDrawing()`, `drawUndo()`, `refreshDrawing()`; on `context.drawing`: `update(bitmap)`, `refresh()`, `pushUndo()`
- **Volumes:** `addVolume(vol)`, `removeAllVolumes()`
- **Transforms:** `registerVolumeTransform(transform)`, `applyVolumeTransform(name, volume, options?)`

### Coordinate transforms

- `context.vox2mm([x,y,z])` → `[mx,my,mz]` — RAS voxel → world mm
- `context.mm2vox([mx,my,mz])` → `[x,y,z]` — world mm → RAS voxel

### `getImageDataRAS(volume)` utility

Exported from `volume/utils.ts` and from the package root. Returns `Float32Array | null` in RAS voxel order indexed as `data[rx + ry*dimX + rz*dimX*dimY]`. Zero-copy when native storage matches RAS (identity permutation); otherwise allocates a reordered copy. Values are raw (not scaled by scl_slope/scl_inter).

### Public exports

From all three entry points (see **Entry points and public exports**):
`NVExtensionContext`, `getImageDataRAS`, and types `BackgroundVolumeAccess`,
`DrawingAccess`, `DrawingDims`, `MrsVolumeAccess`, `NVExtensionEventMap`,
`SharedBufferHandle`, `SlicePointerEvent`.

`computeSlicePointerEvent` is **not** exported from any entry point. It lives in
`extension/context.ts` and is called from `control/interactions.ts`; this section
used to list it as public, which it never was. Either re-export it from all three
entries or leave it internal, but the doc should not promise it.

## Web Workers

`NVWorker` (`workers/NVWorker.ts`) provides promise-based worker bridge with message-ID tracking, lazy creation, and transferable support.

**Build note:** Use `?worker&inline` for imports (blob URL, self-contained).

**Protocol:** Messages include `_wbId`. Reply with `{ _wbId, ...result }` or `{ _wbId, _wbError }`. Transfer output ArrayBuffers.

**Serialization:** Strip non-cloneable properties (class instances) via `JSON.parse(JSON.stringify())` before `postMessage`.
