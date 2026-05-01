# Plan: Quick affine update path

## Goal

Make affine slider updates feel interactive in `packages/niivue/examples/vox.affine.html` as quickly as possible, while keeping overlay affine behavior correct in both WebGPU and WebGL2.

The immediate target is not a full renderer redesign. The target is a fast version of the current correct strategy: overlays are still rebaked into background space, but affine-only edits should reuse GPU resources and update only the transform/uniforms needed for the rebake.

## Recommended approach

Use a cached affine rebake path first.

For affine-only updates, move from the current expensive path:

```txt
set affine
recreate/re-upload scalar overlay texture
recreate LUT textures/sampler/bind group/output texture
run orient compute/render pass
wait for GPU completion
drawScene
```

to:

```txt
set affine
update/reuse orient matrix uniform
reuse scalar texture, LUT textures, sampler, bind group, and output texture
run orient compute/render pass
drawScene
```

This should be much faster and is much less complex than changing slice/render shaders to sample every overlay dynamically at draw time.

## Do not implement yet

Do not start with direct draw-time affine sampling via new matrix uniforms in the final slice/render shaders. That may eventually be the fastest architecture, but it requires broader changes to overlay blending, multiple overlays, label maps, negative colormaps, WebGPU/WebGL2 shader parity, 2D/3D rendering, and masking behavior.

Only revisit draw-time sampling if cached rebaking is still too slow after manual browser testing.

## Phase 1: Add an affine-only update route

1. Add an internal update path in `NVControlBase.ts`, for example:

```ts
private async updateVolumeAffineOnly(): Promise<void>
```

2. Change these methods to call the affine-only path instead of generic `updateGLVolume()`:
   - `setVolumeAffine`
   - `applyVolumeTransform`
   - `resetVolumeAffine`

3. Initially, the new method can fall back to `updateGLVolume()` until backend support exists. This keeps the control-flow change small and safe.

4. Extend the view interface with an optional fast path, for example:

```ts
updateAffineOverlays?: () => Promise<boolean>
```

Return `true` when the backend handled the affine-only update. Return `false` or leave undefined to fall back to `updateGLVolume()`.

Suggested controller logic:

```ts
private async updateVolumeAffineOnly(): Promise<void> {
  if (this._updating) {
    this._pendingUpdate = true
    return
  }
  this._updating = true
  try {
    if (!this.view) return
    const handled = await this.view.updateAffineOverlays?.()
    if (handled) {
      this.drawScene()
      return
    }
    await this.view.updateBindGroups()
    this.drawScene()
  } finally {
    this._updating = false
    if (this._pendingUpdate) {
      this._pendingUpdate = false
      await this.updateVolumeAffineOnly()
    }
  }
}
```

## Phase 2: WebGPU cached orient resources

Focus here first; this is the main current bottleneck.

### Current expensive path

`wgpu/orient.ts::volume2Texture(...)` currently does too much work per affine change:

- creates a scalar 3D source texture,
- uploads the whole volume data,
- creates a uniform buffer,
- creates an output RGBA storage texture,
- creates colormap and negative-colormap textures,
- creates a sampler,
- creates a bind group,
- dispatches compute,
- awaits `device.queue.onSubmittedWorkDone()`,
- destroys intermediates.

### Desired affine-only path

Create reusable WebGPU orient resources for each overlay volume.

Cache and reuse:

- scalar source 3D texture,
- colormap texture,
- negative colormap texture,
- label LUT texture,
- sampler,
- uniform buffer,
- output RGBA texture when background dimensions are unchanged,
- bind group where possible,
- pipeline/layout, which are already mostly cached.

On affine-only update:

1. Recalculate `NVTransforms.calculateOverlayTransformMatrix(baseVol, overlayVol)`.
2. Write the new matrix and existing orient parameters into the cached uniform buffer.
3. Dispatch the orient compute pass into the cached output texture.
4. Do not re-upload scalar volume data.
5. Do not recreate LUTs/samplers unless the relevant volume properties changed.
6. Do not call `await device.queue.onSubmittedWorkDone()` in this hot path.
7. Draw the scene.

### Suggested implementation shape

Refactor `wgpu/orient.ts` from one monolithic `volume2Texture(...)` helper into reusable pieces while keeping the old helper as a compatibility wrapper if useful.

Possible shape:

```ts
type OrientTextureCache = {
  sourceTexture: GPUTexture
  outputTexture: GPUTexture
  uniformBuffer: GPUBuffer
  colormapTexture: GPUTexture
  negativeColormapTexture: GPUTexture
  sampler: GPUSampler
  bindGroup: GPUBindGroup
  dimsIn: number[]
  dimsOut: number[]
  datatypeCode: number
  frame4D: number
  colormapKey: string
}
```

Add helpers like:

```ts
prepareOrientTextureCache(device, volume, target, existingCache)
updateOrientUniforms(device, cache, volume, matrix, opacity)
dispatchOrient(device, cache)
destroyOrientTextureCache(cache)
```

Use simple invalidation rules:

- Recreate source texture when dimensions, datatype, frame4D, or image buffer changes.
- Recreate LUT textures when colormap, negative colormap, or label colormap changes.
- Recreate output texture when background RAS dimensions change.
- Recreate bind group when any bound texture/buffer object changes.
- Otherwise only update the uniform buffer and dispatch.

## Phase 3: Wire WebGPU renderer fast path

1. Add overlay orient caches to the WebGPU volume renderer or `NVViewGPU`.
2. In the normal full update path, populate/update these caches as needed.
3. Implement `NVViewGPU.updateAffineOverlays()`:
   - return `false` if there is no valid background volume,
   - return `false` for unsupported/special cases at first,
   - otherwise update cached overlay orient uniforms and dispatch the rebake pass,
   - update/blend the final overlay texture,
   - return `true`.
4. For multiple overlays, keep the existing blend strategy but avoid recreating each individual overlay texture when only affine changed. If the current blend pass is simpler to leave as-is, optimize single-overlay first so the affine example page can be tested quickly.
5. Keep PAQD/special overlays conservative. If they are not part of the affine example, they can fall back to the full path initially.

## Phase 4: WebGL2 fast path

After WebGPU is manually testable, add the same controller fast path to WebGL2 if needed.

1. Implement `NVViewGL.updateAffineOverlays()`.
2. Reuse existing WebGL2 overlay framebuffer/render-to-texture behavior.
3. Ensure affine-only edits update only the matrix uniform and redraw/rebake overlay slices.
4. Avoid rebuilding mesh resources or unrelated textures.

If WebGL2 is already fast enough or the current WebGL2 path already avoids re-uploading unchanged data, this phase can be minimal.

## Phase 5: Manual validation

Use `packages/niivue/examples/vox.affine.html`.

Check:

- overlay moves correctly while dragging sliders,
- updates feel responsive in WebGPU,
- updates remain correct in WebGL2 fallback,
- single-overlay case works first,
- multiple overlays do not crash; they may fall back to the full path initially if needed.

## Implementation priority

1. Add `updateVolumeAffineOnly()` and optional view fast-path hook.
2. Implement WebGPU single-overlay cached orient rebake.
3. Remove `onSubmittedWorkDone()` from the affine hot path.
4. Manually test `vox.affine.html` in browser.
5. Extend to multiple overlays and WebGL2 if the single-overlay path works.
