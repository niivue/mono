# WIP

## Context for next agent

Current branch: `feat/affine-manipulation`.

Implemented so far:

- New NiiVue controller affine API in `packages/niivue/src/NVControlBase.ts`:
  - `getVolumeAffine(volumeIndex)`
  - `setVolumeAffine(volumeIndex, affine)`
  - `applyVolumeTransform(volumeIndex, transform)`
  - `resetVolumeAffine(volumeIndex)`
- Affine helpers/types:
  - `AffineMatrix` and `AffineTransform` in `packages/niivue/src/NVTypes.ts`
  - affine utility functions in `packages/niivue/src/math/NVTransforms.ts`
  - tests in `packages/niivue/src/math/NVTransforms.test.ts`
- Original affines are stored when volumes are created in `packages/niivue/src/volume/NVVolume.ts`.
- Affine types are exported from `packages/niivue/src/index.ts`, `index.webgl2.ts`, and `index.webgpu.ts`.
- ipyniivue API was regenerated, so `packages/ipyniivue/api.generated.json` and `packages/ipyniivue/src/ipyniivue/_generated.py` include generated affine methods.
- Feature parity was updated in `packages/niivue/FEATURE_PARITY.md`.
- Added the NiiVue example page `packages/niivue/examples/vox.affine.html` and linked it from `packages/niivue/examples/index.html`.
- The mistakenly-added ipyniivue notebook example was removed.

Important behavior note:

- A prior attempted optimization changed affine setters to call `drawScene()` instead of `updateGLVolume()`.
- That made slider interaction fast but incorrect: overlays did not move, because overlay affine changes are currently baked into background-space overlay textures during `updateBindGroups()` / `updateGLVolume()`.
- This was reverted. Affine setters currently call `updateGLVolume()` so behavior is correct, but affine slider updates are slower than desired.

Validation already run after the latest changes:

- `bunx nx run niivue:lint --skip-nx-cache`
- `bunx nx run niivue:typecheck --skip-nx-cache`
- `bunx nx run niivue:test --skip-nx-cache`

Before finishing the overall task, rerun the full required repo sequence from `AGENTS.md`:

```bash
bunx nx affected -t format
bunx nx affected -t lint
bunx nx affected -t typecheck
bunx nx affected -t test
bunx nx affected -t build
bun run check-boundaries
```

## Affine manipulation performance notes

Old NiiVue is faster during affine slider updates because its affine update path is a GPU render-to-texture pass, while the new package's current WebGPU path does heavier compute work and resource allocation per affine change.

Old NiiVue behavior:

- `setVolumeAffine`, `applyVolumeTransform`, and `resetVolumeAffine` call `updateGLVolume()`.
- `updateGLVolume()` calls `refreshLayers(...)` for each volume.
- For overlays, `refreshLayers(...)`:
  - computes `calculateOverlayTransformMatrix(...)`
  - uploads/uses a temporary source 3D texture
  - renders each output slice into the overlay texture with WebGL framebuffer draws
  - passes the affine-derived matrix as a shader uniform via `gl.uniformMatrix4fv(orientShader.uniforms.mtx, false, mtx)`
  - loops over `backDims[3]` slices with `gl.drawArrays(...)`

So old NiiVue also rebakes the overlay into background space, but does it as a fairly optimized WebGL render pass: one shader, framebuffer layer rendering, uniforms, and draw calls.

New package behavior:

- `setVolumeAffine` calls `updateGLVolume()`.
- `updateGLVolume()` calls `view.updateBindGroups()`.
- In the WebGPU backend, overlay preparation goes through `wgpu/orient.ts::volume2Texture(...)`.
- Per update, that function currently:
  - creates a scalar 3D GPU texture
  - uploads the whole source volume data with `device.queue.writeTexture(...)`
  - creates a uniform buffer
  - creates an output RGBA storage texture
  - creates colormap / negative-colormap GPU textures
  - creates a sampler
  - creates a bind group
  - dispatches compute over the output volume
  - awaits `device.queue.onSubmittedWorkDone()`
  - destroys intermediates

Likely performance issues in the new path:

1. The overlay scalar volume is re-uploaded on every affine change.
2. Colormap textures and samplers are recreated on every affine change.
3. Intermediate GPU resources and bind groups are recreated every time.
4. `await device.queue.onSubmittedWorkDone()` forces CPU/GPU synchronization per update.
5. The overlay is still rebaked into a background-space RGBA texture instead of sampled dynamically using an affine matrix at draw time.

Conclusion: old NiiVue is not necessarily using a fundamentally different visual strategy, because it also rebakes overlays. Its implementation is much leaner for repeated affine changes. The new WebGPU path is architecturally cleaner but currently treats affine edits like a full overlay texture rebuild from scratch, including re-uploading unchanged data.
