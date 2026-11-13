# GPU rebuilds and live updates

Moved from `packages/niivue/AGENTS.md`; read it when working on anything that triggers a GPU rebuild, `updateMeshPositions`, `updateVolumeData` or `isDirty`. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Scoped GPU rebuilds

Every controller change that needs new GPU resources goes through
`_updateGL(meshes, volumes?, colorbars?)` → `view.updateBindGroups(opts)`
(`UpdateBindGroupsOptions` in `view/volumeUpdateScope.ts`), which rebuilds only
what the change touched. Both backends share the planning code, so keep them
in step.

- **Meshes** (`view/meshGpuSync.ts`, `MeshRebuild`): `'all'` frees and
  re-uploads every mesh; `'changed'` reconciles `meshResources` with the model
  through `planMeshSync`: new meshes are uploaded, removed ones freed, and a
  kept mesh is re-uploaded only when its `uploadStamp` (the `positions`,
  `indices` and `colors` arrays plus `mesh._dataVersion` and
  `mesh._positionsVersion`, recorded at upload) no longer matches; `'none'` skips meshes. Kept meshes still pick up
  `shaderType` / `sliceShaderType`, which are draw-time state. Packing a mesh
  (normals + interleave, `packMeshVertices`) is the expensive part: ~0.2 s per
  4M vertices, which every setter used to pay for every mesh.
- **Mesh version tokens.** `mesh._dataVersion` is the in-place-edit token
  for `colors` and `indices` (`markMeshDataChanged` in `NVControlBase.ts`):
  `setMesh` bumps it for any option outside `MESH_DRAW_TIME_OPTIONS` (e.g.
  `color`, which is baked into `colors`), as do the mesh-layer setters and
  `setTractOptions` / `setConnectomeOptions`. In-place `positions` edits use
  `mesh._positionsVersion` only (bumped by `updateMeshPositions`), the token
  that position-derived caches such as cached normals key on; do not bump
  `_dataVersion` for them. Replacing an array is detected without either token.
- **Meshes must not share data arrays.** Resources and stamps are per mesh
  object, so two meshes sharing `positions` / `indices` / `colors` (e.g. a
  `{ ...mesh }` copy) go stale: recolouring one through `setMesh` writes the
  shared array but re-uploads only that mesh.
- **Who asks for what:** the public `updateGLVolume()` is the full rebuild
  (`'all'`), for callers who edited loaded data in place themselves. Volume
  and scene setters use `_updateGLChanged()` (every volume, colorbars, meshes
  `'changed'`, which is a no-op when no mesh changed). Mesh setters (`addMesh`,
  `removeMesh`, `setMesh`, layers, tract/connectome options) use
  `_updateGLMeshes()`: meshes `'changed'`, `volumes: []` (no volume pass) and
  colorbars (mesh layers and connectomes carry colorbars). `setMesh` with only
  `MESH_REDRAW_OPTIONS` (`opacity`, `visible`, `name`) just calls `drawScene()`.
  `setVolumeAffine`'s fallback rebuild uses meshes `'changed'`; view creation
  (`_rebuildViewResources`) and context restore use the full rebuild.
- **e2e:** the `mesh-edits` scene of `e2e/render-mesh.spec.ts` asserts, on both backends, which
  meshes each setter re-uploads (by `view._getMeshGpu(mesh)` identity) and that
  the redraw-only and recolour paths reach the screen.

## Live data updates (`updateMeshPositions`, `updateVolumeData`)

Fast paths for animating or live-editing data that is already loaded, without
a rebuild.

- **`updateMeshPositions(meshIndex, positions?)`** (sync): copies into the
  existing `mesh.positions` (same vertex count, `kind === 'mesh'` only), bumps
  `mesh._positionsVersion`, then `view.updateMeshVertices(mesh)` repacks the
  interleaved vertices (`packMeshVertices` in `mesh/vertexFormat.ts`; the version
  bump makes `meshNormals` recompute normals into its cached array) and writes
  them into the existing buffer (`bufferSubData` /
  `queue.writeBuffer`; WebGPU mesh vertex buffers carry `COPY_DST` for this).
  If the mesh has no GPU buffer yet, or the byte size no longer matches, it
  falls back to `_updateGLMeshes()`, which re-uploads it because its stamp's
  `_positionsVersion` no longer matches. Scene extents are deliberately not
  recomputed, so the camera does not chase a moving mesh. On success only the
  stamp's `positions` / `positionsVersion` are refreshed
  (`stampAfterVertexWrite`): the index buffer was not rewritten.
- **`updateVolumeData(volumeIndex, data?)`** (async): copies all frames or one
  frame (`nVox3D` values into the current `frame4D`) into the existing `img`,
  bumps `vol._dataVersion`, and runs `_updateGL('none', [vol])`, i.e.
  `updateBindGroups({ meshes: 'none', volumes: [vol], colorbars: false })`.
  That skips the meshes and the colorbars, and `view/volumeUpdateScope.ts`
  (shared by both backends) limits the volume work: an edited overlay re-runs only the overlay
  pass (not the background orient pass or its gradient); an edited background
  re-runs only the background, plus the overlays when `isBackgroundMasking` is
  on. Volumes modulated by an edited volume are included, transitively.
  Multi-instance mode (`instances`) still visits every volume (cache hits are
  cheap). The orient caches
  (`prepareOverlayTextureCache` / `prepareOrientTextureCache`) record
  `dataVersion`, and a mismatch re-uploads the source texture in place. They
  also survive a modulator edited in place: a new `mod.key` on the same grid
  only rewrites the weight texture (`syncModTexture` on WebGL2; WebGPU keeps
  the cache while `modTextureFits`); a modulator that appears, goes away or
  changes grid replaces the mod texture (WebGL2) or rebuilds the cache
  (WebGPU, whose bind group holds it). The per-volume `_texCache` single
  entries (multi-instance) are reused by url/name, so they store
  `wholeVolumeTextureKey` (`volume/orientChunked.ts`: `_dataVersion`,
  `chunkedDisplayKey` with the modulation, the label outline width, the RAS
  grid, the orient matrix and the modulator's matrix; `rgbaTextureKey` for
  RGB/RGBA), computed before the build's awaits, and rebuild on any mismatch:
  an edit, a window/frame/colormap change, a re-registered colormap name, a
  modulator change or a new affine. RGB/RGBA volumes have no orient pass; the
  renderers keep their texture in `volumeRgbaCache` / `overlayRgbaCache`
  (`prepareRGBATextureCache` in `gl/orientOverlay.ts` and `wgpu/orient.ts`),
  which rewrites it in place (`texSubImage3D` / `queue.writeTexture`) while
  the RGBA dims match, and skips the upload while `rgbaTextureKey`
  (`view/NVOrient.ts`: buffer identity, `_dataVersion`, `frame4D`, dims, RAS
  mapping, `_modulationData` identity) is unchanged. `prepareRGBAData` reads
  only the displayed `frame4D` of a 4D RGB/RGBA volume, so `setFrame4D` and
  the one-frame form of `updateVolumeData` show on color volumes too.
  `computeModulationData` keeps the same `_modulationData` array while
  `_modulationDataKey` (modulator identity, data version, grid, scaling,
  window, frame) matches, so a modulated RGBA volume is not re-uploaded on
  every update. Background masking goes through
  `VolumeRenderer.maskOverlayByBackground` on both backends: WebGL2 masks the
  overlay texture in place and clears the RGBA cache's key so the next pass
  rewrites it; WebGPU writes a new texture and destroys its input only when no
  cache owns it. Still allocating per update, by design: two or more resliced
  overlays (each is re-oriented into a temporary texture and the blend goes to
  a new one; caching every oriented overlay would cost one RGBA volume of GPU
  memory per overlay, and the blend has to be redone on any change anyway),
  multi-instance `_texCache` entries (rebuilt whole), the WebGPU masked
  overlay, and the gradient texture when lighting needs it.
  The window (calMin/calMax) is not recomputed. Volumes with a
  `chunkPlan` are rejected. An oversized volume gets one from
  `_ensureChunkedVolumeEntry` on its first render, so it is rejected from then
  on; a call before that first render is not refreshed. Neither method emits an
  event (`volumeUpdated`/`meshUpdated` are for display-option changes, and these
  run per frame). A coalesced `updateVolumeData` settles when its follow-up
  upload finishes (#447).
- **Frame sources (lazy time).** A volume with `frameSource` (set by
  `@niivue/nv-ext-tile`'s `lazyTime`) stays one frame (`nFrame4D` 1: every img
  reader indexes `frame4D * nVox3D`); its time axis lives on the source, and
  frame changes go through `_setSourceFrame` (see its JSDoc; `src/frameSource.test.ts`).
  `NVChunkedVolume` installs one too (`commit` swaps in a new per-frame chunk
  loader, so `volumeSourceKey` drops the old frame's bricks;
  `src/volume/NVChunkedVolume.frames.test.ts`). A source `descriptor` is saved
  in documents and reopened by `loadDocument`'s `resolveSource`
  (`src/documentSources.ts`, `src/loadDocument.sources.test.ts`); a newer
  `loadDocument`, `loadVolumes` or `loadImage` aborts a restore still pending.
  A switch is two-phase: every member's `load` stages first, then the group
  swaps in one synchronous `commit` between GPU passes, and the coarse floor is
  installed inside that update (`UpdateBindGroupsOptions.coarseFloor`) before
  the bricks rebuild. The source reader's `onChunk(bytes, req)` sees every
  decoded region; a streamed volume's readout (`NVImage.voxelValue`) is exact
  from its plan's decoded bricks and otherwise reads the coarse floor,
  flagged `approximate`.
- **`isDirty` reports an in-place edit to the ordinary path.** A caller that
  rewrote `img` in place sets `vol.isDirty = true`; `commitDirtyVolumes`
  (`volume/dataVersion.ts`) runs synchronously at the start of every GPU update
  (`_updateGL`, `updateVolumeAffineOnly`, `_rebuildViewResources`; also
  `setBaseCoarseFloor` for a separate floor level, while a loaded volume
  passed as the floor goes through a scoped `_updateGL`), bumps each flagged
  volume's `_dataVersion` and resets the flag. `_updateGL`, the affine full
  path and `_rebuildViewResources` recompute the modulation data and weights
  after that bump, before they rebuild textures. A view's `init()` already
  bakes from the cached arrays before `_rebuildViewResources` runs, but that
  rebuild replaces every texture, so a dirty modulator's old weights do not
  stay on screen. The flag is cleared at the bump, not after the upload, so
  an edit flagged during an in-flight upload gets its own version and the
  queued follow-up uploads it. A `chunkSource` volume's flag is cleared
  without a bump (warned once): its bricks come from the source, and a bump
  would only evict and re-stream them. A scoped `_updateGL` adds the dirty
  volumes to its scope; `updateVolumeAffineOnly` skips its overlay-only fast
  path when any volume was dirty. `isDirty` means
  only "voxel values changed": internal code must not set it for display,
  affine or GPU-lifetime changes, since every set costs a re-upload (and
  invalidates the CPU caches below). `loadImgV1` sets it because it assigns a
  new `img`: the GPU caches would notice the new buffer, but caches keyed only
  on `_dataVersion` (the graph cache) would not, so callers that assign a new
  `img` should set it too. A failed upload leaves the cache's recorded version
  behind, so the next update that rebuilds that volume retries it.
- **`_dataVersion` is the general in-place-edit token** for `NVImage`, bumped
  only through `markVolumeDataChanged` (`updateVolumeData`, `isDirty`). Any
  cache keyed on `img` buffer identity must also compare it (orient caches,
  `_texCache`, modulation weight key, extension `imgRAS`, legend centroids,
  graph cache). `chunkedDisplayKey` carries it, so an `isDirty` edit of an
  in-memory chunked volume rebuilds the uploader and re-streams every brick
  from `img` (the decoded tier only holds `chunkSource` bytes, which an
  in-place edit cannot reach). `coarseFloorKey` is the source (url/name and
  the `img` view: buffer identity, offset, length) plus
  `wholeVolumeTextureKey` with the floor's orient matrix, so it also covers
  the label outline width, the RAS grid and RGB/RGBA floors.
  `updateVolumeData` still rejects `chunkPlan` volumes: a full re-stream is
  not a per-frame fast path.
- **Colormap re-registration:** the orient caches, `chunkedDisplayKey`,
  `wholeVolumeTextureKey` and `coarseFloorKey` key colormaps by
  `NVCmaps.colormapKey(name)` (name plus how many times `addColormap`
  registered it), so re-registering a name rebuilds
  the cached LUT textures on the next update. Mesh layer, tract and
  connectome colors are baked into `m.colors` only when those change
  (`compositeLayers`, `retessellateTract`, `reextrudeConnectome`), so they
  keep the old colors until their next property change.
- **Coalescing:** `_updateGL(meshes, volumes?, colorbars?)` shares
  `_updating` / `_pendingUpdate` with `updateVolumeAffineOnly`; the queued
  follow-up takes the union of the callers' needs (`_pendingMeshes` via
  `mergeMeshRebuild`, `_pendingVolumes`, `_pendingColorbars`, and
  `_pendingAllVolumes`, which any unscoped caller, including an affine-only
  one, sets; without it the follow-up rebuilds only `_pendingVolumes`, which
  is empty when only mesh setters queued). `_pendingFull` makes an
  affine-only rerun yield to a queued full update.
  A caller queued behind the lock gets a promise from `_queueBehindUpdate`
  that `_runFollowUp` settles with the follow-up's outcome, so its failure
  reaches the queued callers, not the update that started it. The pass calls
  its `settle` callback in its own `finally`, before chaining the next
  follow-up, so no caller, queued or the one that took the lock, is held by
  follow-ups chained after its own pass (updates that coalesce into its queued
  follow-up before it starts do ride along). A new path that takes the lock
  must accept a `settle` callback and call it in its `finally` before chaining.
  A takeover wakes `_updateIdle` before its rebuild finishes, so
  `whenUpdatesSettle()` follows `_takenOverBy` from the pass it waited on to
  the rebuild that replaced it, and stops at a pass that ends normally. Setters
  that do not return their rebuild (e.g. `volumeIsBackgroundMasking`) are
  waited for with the public `whenUpdatesSettle()`, which joins the next
  follow-up when one is queued, else waits for the running pass, and does not
  report a failure. A view takeover (`_rebuildViewResources`) adopts callers
  only while a follow-up still holds the lock on the old view, and settles
  them with its own rebuild; `destroy()` resolves every queued or running
  caller, and later callers at once, and no follow-up runs after it.
