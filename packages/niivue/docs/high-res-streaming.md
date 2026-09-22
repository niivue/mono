# High-Resolution Volume Rendering: Client-Server Architecture

Rendering massive volumetric datasets (e.g., 20,000³ voxels, hundreds of gigabytes) requires a tightly integrated client-server architecture. Web browsers cannot load a 256 GB file into RAM, and standard GPUs have hard limits on 3D texture dimensions (typically 2048³) and strict VRAM budgets (e.g., 2–8 GB).

This document explains how NiiVue (the client) and the volumetric backend (the server) work together to bypass these limits, allowing seamless, interactive exploration of virtually unlimited-size volumes.

---

## 1. The Core Problem

A naïve volumetric renderer attempts to:
1. Download an entire file (e.g., NIfTI) into system memory.
2. Upload the entire voxel array into a single `GPUTexture` or `WebGLTexture`.
3. Draw a bounding box and ray-march through the texture.

**Failures at scale:**
* **Network/RAM limit:** Downloading a 50 GB file crashes the browser tab.
* **Texture limit:** GPUs reject 3D textures larger than `maxTextureDimension3D` (usually 2048³).
* **VRAM limit:** Even if split up, a 10 GB volume will crash a standard integrated GPU.

---

## 2. Client-Side: Tiled Volumes & LRU Streaming (NiiVue)

To solve the texture limit and VRAM constraints, NiiVue implements a **Tiled Volume Architecture**. 

### Chunking and Halos
Instead of uploading one massive texture, NiiVue logically partitions the volume into smaller 3D blocks called **chunks**.
* Each chunk carries a **3-voxel halo** of overlapping data from its neighbors. One voxel would be enough for seam-free trilinear interpolation alone; the wider halo is needed because the gradient pass (Sobel radius 1, then a radius-1 blur) reads ±2 voxels of the chunk's own data, and we want one extra voxel of margin so the trilinear sample at the seam stays valid.
* During rendering, NiiVue dynamically sorts the chunks back-to-front based on the camera's view direction and composites them together with premultiplied-alpha OVER blending.

### Visibility-Driven Working Sets
NiiVue calculates exactly which chunks are visible on the screen every frame:
* **3D Views:** The camera's frustum is checked against the spatial bounding box of each chunk.
* **2D Slices:** The slice plane checks which chunk boundaries it currently intersects.

Only the chunks actively contributing to the screen are placed into the **working set**.

### The `ChunkResidencyManager` (LRU Cache)
NiiVue maintains a strict GPU memory budget (e.g., 1.5 GiB). 
* When a new chunk enters the working set, it is queued for upload via an asynchronous "pump" to prevent main-thread stuttering.
* If uploading the chunk exceeds the GPU memory budget, NiiVue uses a **Least Recently Used (LRU)** eviction policy to destroy the textures of chunks that have been off-screen the longest.

---

## 3. Server-Side: LOD Pyramids & Spatial Queries

With NiiVue managing the GPU, the server must manage the network. Transferring full-resolution chunks for the entire volume is wasteful if the user is completely zoomed out.

### The Image Pyramid (Level of Detail)
During preprocessing, the server (e.g., using OME-Zarr or a IIIF Volumetric Server) generates an image pyramid—successively downsampled versions of the full volume. 
* **Level 0:** 100% resolution.
* **Level 1:** 50% resolution.
* **Level N:** 1% resolution.

### Bounding Box Queries
The backend API allows clients to request specifically targeted subsets of data. Instead of requesting a file, the client requests a spatial region at a specific resolution:
> `"Give me voxels X: 1000-2000, Y: 1000-2000, Z: 0-1000 at LOD Level 2"`

### 3D IIIF Manifests
To orchestrate this, the server publishes structural metadata (like the Draft IIIF Presentation API 4.0). This manifest informs NiiVue of the physical dimensions of the full dataset, the available LOD levels, and the grid structure.

---

## 4. The Complete Workflow

When a user explores a massive dataset, the client and server engage in a continuous, dynamic conversation:

1. **Zoomed Out (Overview):**
   * NiiVue detects that multiple voxels compress into a single screen pixel.
   * It calculates the ideal LOD (e.g., Level 3) and determines the visible chunks.
   * It requests these Level 3 chunks via an API callback (`VolumeChunkSource`).
   * The server rapidly responds with the tiny, downsampled payloads. NiiVue uploads them to the GPU.

2. **Zooming In (Drill Down):**
   * As the camera moves closer, the screen-space error rises. NiiVue realizes it needs higher resolution data (Level 0) for the chunks specifically intersecting the center of the screen.
   * The Level 0 chunks are requested from the server.
   * They take longer to download, and the plan swap that asked for them has already released the GPU textures of the Level 3 chunks it could not carry over. What fills the gap in the meantime is the **coarse floor** (see below), not the outgoing chunks: a whole-volume low-resolution texture the renderer draws wherever a brick has no texture yet.
   * Once the Level 0 chunks arrive, the `ChunkResidencyManager` admits them to the GPU cache and each one dissolves in over the floor across `chunkFadeMs` (120 ms by default; set it to 0 to make them pop in instantly).
   * Simultaneously, if the VRAM budget is exceeded, NiiVue evicts the high-resolution chunks that recently panned off the edges of the screen.

### The coarse floor

A brick with no resident texture draws **nothing**, so without a floor the scene background shows through — briefly for every region of the volume each time a refocus swaps the plan, which is what reads as a flash while zooming. `loadChunkedVolume` therefore builds a floor automatically from the coarsest pyramid level and installs it (`coarseFloor: false` opts out; it is skipped when that level is too large to upload as a single texture). An app that drives the chunked path itself can supply one with `setBaseCoarseFloor(image)` — a small in-memory `NVImage` covering the same mm box, with CPU voxels in `img` and no `chunkSource`.

The floor is what the cross-fade dissolves into, so with no floor installed there is no fade either: `fadeFraction` returns 1 immediately and chunks pop in at full strength.

### Per-level brightness compensation

**Which knob:** coarse bricks look too *dark* -> `volumeLodBrightnessCompensation`. Coarse bricks look too *transparent* -> `volumeLodOpacityCompensation` (next section). Both are exact no-ops on anything that is not a multi-LOD chunked volume; `nv.lodCompensation()` says whether either is doing anything, and what.

A coarse brick does not merely look softer than the fine data it stands in for: it looks **darker**. Downsampling averages voxels, which destroys the correlation between a sample's colour and its opacity, and front-to-back compositing weights each sample's colour by its opacity. The averaged brick therefore integrates to less light than the fine data over the same span, and the boundary between a level-0 brick and its level-3 neighbour reads as a brightness step, not just a sharpness one.

`volumeLodBrightnessCompensation` (default `0.08`, range `[0, 1]`, `0` disables) lifts each brick by an exponent derived from its own pyramid level:

```
e = 1 - coefficient * log2(k)
```

where `k` is the brick's linear downsample factor relative to the finest grid — the geometric mean of the three per-axis ratios, so an anisotropically decimated pyramid still yields one scalar (`chunkLodDownsample` in `src/volume/chunking.ts`). Because every pyramid level averages the same 2x2x2 neighbourhood, the correction is **one fixed step per level**: `log2(k)` is just the level index. The shaders multiply `e` into the same exponent that carries `scene.gamma` and raise only the classified RGB to it, so alpha, occlusion and thresholding are untouched. `k` is 1 for the finest level, for single-level plans, and for non-chunked volumes, which makes the whole feature an exact no-op outside multi-LOD plans whatever the coefficient is. The 3D render in `VOLUME_RENDER_MODE.SLICES` skips it too (`_lodGamma`): a plane takes one sample whatever the brick's level, so there is no sparser sampling to compensate, and applying it made a coarse floor brick's planes read brighter than the resident fine ones beside them. The 2D tiles still apply it.

#### Why per level and not per downsample factor

This grew with `k - 1` until it was measured on a deep pyramid, and that form does not survive contact with one. It assumes a level-4 brick loses eight times what a level-1 brick loses; averaging does not work that way, and on the seven-level HiP-CT heart the correction ran away. At the old `0.022` default a level-4 brick asked for exponent `1 - 0.022 * 15 = 0.67` and a level-6 brick for `-0.386`, which the 0.25 clamp caught. Two visible symptoms followed:

* A LOD boundary read as a hard brightness step with the **coarse side too bright**, not too dark. Measured across the strongest brick-face seam on `hoa_heart` (WebGL2, gamma 1, trend removed): `+35.7%` at the shipped default, against `-34.0%` with the compensation off. The correction had overshot the null by roughly 6x and was itself the artifact.
* The **coarse floor** is built from the coarsest level, so it sat pinned at the 0.25 clamp. That floor is exactly what shows while a refocus streams fine bricks in, which is why zooming flashed pale before settling.

Under `1 - coefficient * log2(k)` neither happens: the deepest level of that pyramid asks for `1 - 0.08 * 6 = 0.52`, well clear of the clamp, and the seam response stays monotonic and gentle across the whole slider range (`-33.0%` at 0, `-28.7%` at 0.02, `-23.4%` at 0.04, `-10.1%` at 0.08). That is the practical gain: the coefficient is now **safe to turn up** on data that needs more, where before it saturated.

#### Picking the coefficient

The size of the deficit depends on how much intensity varies inside one fine voxel, so no coefficient is exact for all data, and the spread is real rather than a rounding error:

| data | character | coefficient that nulls its LOD seam |
|------|-----------|-------------------------------------|
| `hoa_heart` (HiP-CT) | sparse, thin, low contrast on a high pedestal | about `0.11` per level |
| `pawpawsaurus` (CT) | dense, opaque, near-saturated | about `0.05` per level |

`0.08` is the default because it splits them and because the dense case is nearly insensitive to the setting anyway: sweeping `pawpawsaurus` from 0 to 0.08 moves its mean brightness about 4% and changes its strongest edge step from `10.1%` to `9.3%`, while the same sweep on `hoa_heart` takes its seam from `-33%` to `-10%`. Spend the range where the artifact is visible. That is also why it stays a tunable render-time setting rather than a baked constant — the range demo (`examples/range.html`) exposes it as a slider next to `gamma` for A/B comparison.

### Per-level opacity compensation (off by default)

Brightness is only half of what averaging destroys. The other half is opacity, and it has its own correction — `volumeLodOpacityCompensation` (default `0`, range `[0, 1]`, `0` disables) — which is **off by default for a measured reason**, recorded here so it is not switched on by assumption.

The ray-march already corrects a coarse brick's sparser sampling: each sample's alpha is raised to the number of reference steps it stands for, `a' = 1 - (1-a)^k`. That is exact if the coarse voxel is homogeneous. It is not. The true transmittance through the `k` fine voxels the brick replaces is `prod(1-a_i)`, and because `log(1-a)` is concave that product is *smaller* than `(1-mean(a))^k`. A coarse brick is therefore systematically too see-through, by an amount set by the intensity variance inside the coarse voxel. The setting scales the exponent by `1 + coefficient * (k - 1)` to push it back (`lodOpacityScale` in `src/NVConstants.ts`, capped at 8x so a deep level cannot go fully opaque).

Simulating the march over a real OME-Zarr pyramid says that variance term is effectively zero wherever structure is dense enough to saturate the ray. Those regions already integrate the correct alpha, so inflating it only front-loads accumulation onto the nearer — and therefore dimmer — samples, which makes the accumulated **colour** worse. Across four probe regions, raising the coefficient from 0 to 0.5 cut mean alpha error from 6.7% to 5.1% while driving mean colour error from 15.3% to 25.7%. Sweeping colour gamma and opacity jointly finds a shallow optimum (`brightness 0.05`, `opacity 0.10`) worth about 0.2 points of colour and 1.4 points of alpha over gamma alone — not enough to justify changing the default.

Sparse thin material is the one place with a genuine alpha deficit (about -30% at level 3 on the probe used), and no global scale recovers much of it: at coefficient 0.5 it improves to -30.6%. That is expected, since the correction needs the per-voxel variance that mean-downsampling discarded. Fixing that case properly needs a pyramid built to preserve coverage (a max or conservative reduction) rather than a mean, which is a property of the published store, not of the renderer.

It is exposed because the trade is data-dependent: a volume that is mostly thin structure gains more from the alpha than it loses on the colour. Reach for `volumeLodBrightnessCompensation` first, and turn this up only if coarse bricks read as too *transparent* rather than too *dark*. The range demo exposes it as a second slider beside `LOD comp`.

This one is **ray-march only**. A 2D slice tile shows a single sample with no accumulation, so there is no aggregated alpha to correct; the slice renderers take the brightness exponent but not this one.

### Checking what the settings are doing

Both settings only reach bricks fetched from a *coarse* level of a *multi-LOD* plan, so on an ordinary volume they change nothing and nothing on screen says so. `nv.lodCompensation()` answers that directly:

```js
const report = nv.lodCompensation()
if (!report.isActive) {
  console.log(report.inactiveReason)  // e.g. 'volume 0 is not a chunked volume'
}
for (const l of report.levels) {
  // level index, linear downsample k, bricks drawn from this level, and the
  // exact numbers the shader gets: exponent on RGB, multiplier on the
  // step-size opacity exponent. Both are 1 where the setting is inert.
  console.log(l.level, l.downsample, l.brickCount, l.brightnessExponent, l.opacityScale)
}
```

`isActive` is true only when a coarse brick is actually drawn *and* a coefficient is non-zero; otherwise `inactiveReason` names the missing precondition. `floor` reports the whole-volume coarse floor separately, since it is not a member of the chunk plan (`level` -1). Setting a non-zero coefficient while no loaded volume is multi-LOD also emits a `log.warn` at the moment of the set. The range demo prints the report as a `LOD comp` row in its HUD.

Both coefficients share the range `[0, 1]`, so a value copied from one into the other is never silently clamped. Useful magnitudes differ: brightness is strong by 0.1 (its exponent is floored at 0.25), opacity is a linear scale on the step exponent and is capped at 8x.

---

## 5. The GPU Upload Pipeline

Sections 2–4 covered *which* bytes reach the GPU and *when*. This section covers *how* a chunk's raw NIfTI scalars become a sampled texel inside the ray-march shader. The same three-stage pipeline runs on both backends (WebGPU and WebGL2) and on both paths (single-texture and chunked); only the stage 1 and stage 2 outputs are sized differently when chunked.

| Stage | Input | Output | Where (WebGPU / WebGL2) |
| --- | --- | --- | --- |
| 1. Orient + colormap | Scalar 3D texture in source dtype | RGBA8 3D texture in RAS orientation | `wgpu/orient.ts:volume2Texture` / `gl/orientOverlay.ts` |
| 2. Gradient | RGBA8 colour texture (stage 1) | RGBA8 3D texture (gradient direction in RGB, magnitude in A) | `wgpu/wgpu.ts:volume2TextureGradientRGBA` / `gl/gradient.ts:volume2TextureGradientRGBA` |
| 3. Ray-march | RGBA8 colour + RGBA8 gradient + matcap + uniforms | Framebuffer | `wgpu/render.wgsl` / `gl/renderShader.ts` |

Stages 1 and 2 fire **once per chunk mutation** — a fresh upload, a frame change on a 4D volume, or a calMin/calMax/colormap edit. Stage 3 fires every frame. The actual `writeTexture` / `texImage3D` of the source bytes happens only inside stage 1.

### 5.1 Stage 1 — Orient + colormap (`volume2Texture`)

The orient pass uploads the raw scalar buffer into a 3D texture sized to the input header dims, then dispatches a compute shader (WebGPU) or a layered fragment pass (WebGL2) that reads the scalar, applies `calMin` / `calMax`, looks up the colormap LUT, and writes RGBA8 into a freshly-allocated output texture sized to the **RAS** dims. Source data in non-RAS orientation is permuted in-shader via the supplied 4×4 matrix; no separate CPU reorientation step.

Datatype handling (both backends produce the same `rgba8unorm` output regardless):

| NIfTI dtype | Code | GPU scalar format |
| --- | ---:| --- |
| UINT8 | 2 | `r8uint` |
| INT16 | 4 | `r16sint` |
| INT32 | 8 | `r32sint` |
| FLOAT32 | 16 | `r32float` |
| COMPLEX | 32 | `r32float` (real component) |
| UINT16 | 512 | `r16uint` |
| UINT32 | 768 | `r32uint` |
| RGB / RGBA | 128, 2304 | bypass — uploaded straight to `rgba8unorm` via `rgba2Texture` |

The scalar input texture is destroyed at end of pass; only the RGBA8 output survives. So steady-state GPU residency per chunk after stage 1 is **4 bytes per voxel** for colour.

### 5.2 Stage 2 — Gradient (Sobel + Blur)

The gradient texture is what gives the 3D render its phong-like matcap shading. It encodes a normalised gradient direction in `.rgb` (packed to `[0,1]`) and the magnitude in `.a`. Both backends produce an `rgba8unorm` texture of the same dims as the stage-1 colour texture.

| Backend | Implementation |
| --- | --- |
| WebGPU | Two compute pipelines (`sobel.wgsl`, `blur.wgsl`), `@workgroup_size(8,8,4)`, write via `texture_storage_3d<rgba8unorm, write>`; pipelines cached per device in `wgpu/wgpu.ts` |
| WebGL2 | Two fragment passes, rendering one Z-layer at a time into `gl.RGBA8` 3D textures via `FRAMEBUFFER` + `framebufferTextureLayer` |

Math is identical: Sobel stencil of radius 1, then a separable 3×3×3 box blur (radius 1). 8-bit precision is sufficient for matcap shading.

Steady-state residency per chunk after stage 2 is **another 4 bytes per voxel** — so 8 bytes per RAS voxel total, colour + gradient. For a 2×2×2 chunked grid with halo `[3,3,3]` the halo overhead adds roughly another 80% on top.

### 5.3 Stage 3 — Ray-march draw

The ray-march works in full-volume `[0,1]³` texture coordinates regardless of how many chunks exist. A single shader helper, `chunkTexCoord`, translates that into the **per-chunk** texture coordinate for the currently-bound chunk:

```wgsl
fn chunkTexCoord(p: vec3f) -> vec3f {
    return p * volumeFracToChunkFrac + chunkFracOffset;
}
```

The two uniforms come from `chunkSampleTransform(chunkDesc)` in `src/volume/chunking.ts`. When the volume isn't chunked, `identityChunkSampleTransform` returns the identity mapping and the helper is a no-op. The same `render.wgsl` / `renderShader.ts` therefore runs unchanged on both paths.

Per-frame draw flow on the chunked path:

| Step | What | Where |
| --- | --- | --- |
| 1. Frustum-cull | Pick visible chunks for the current view | `ChunkVisibility.chunksInFrustum` |
| 2. Sort | Back-to-front by `dot(rayDir, chunkCenter)` | `ChunkVisibility.chunksBackToFront` |
| 3. Stamp working set | Mark these chunks as needed-this-frame (LRU) | `ChunkResidencyManager.requestUpload` |
| 4. Stream misses | `uploadChunk(index)` for any not yet resident | `wgpu/orientChunked.ts` / `gl/orientChunked.ts` |
| 5. Evict under budget | LRU drop of chunks not touched this frame | `ChunkResidencyManager._evictToFit` |
| 6. Draw | One cube draw per chunk, OVER blended | `wgpu/render.ts:_drawChunked` / `gl/render.ts:_drawChunkedVolume` |

Both the 3D ray-march and the 2D slice shaders raise their classified RGB to one exponent per draw: the reciprocal of `scene.gamma` times the brick's per-level compensation (above). It is a draw-time uniform, deliberately not baked into the stage 1 colour texture — baking would force a re-upload of every resident chunk on each slider tick, add a second 8-bit quantization, and freeze the coefficient at upload time. The exponent reaches intensity-derived layers only; the drawing layer passes `1.0`, since its colours are categorical label swatches rather than brightness.

Frame-order contract: `beginFrame()` must run **before** the working-set request, so working-set chunks carry the current frame stamp and a same-frame `admit` cannot evict the chunks the renderer is about to draw.

---

## 6. Per-Backend Differences

Both backends are written to mirror each other line-for-line (feature parity is a hard rule — see `AGENTS.md`). The genuine asymmetries are only those imposed by the APIs themselves:

| Concern | WebGPU | WebGL2 |
| --- | --- | --- |
| Source bytes upload | `device.queue.writeTexture` | `gl.texImage3D` |
| Orient stage | Compute pipeline writing `texture_storage_3d<rgba8unorm, write>` | Fragment pipeline rendering one Z-layer at a time into `FRAMEBUFFER` |
| Gradient stage | Two compute pipelines (sobel + blur), device-cached in `wgpu/wgpu.ts` | Two fragment passes, layered FBO targets, in `gl/gradient.ts` |
| Volume blend func | `srcFactor: "one", dstFactor: "one-minus-src-alpha"` | `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`, restored to default after the draw |
| Chunked depth state | Separate `pipelineChunked` with `depthCompare: 'always'` | `gl.depthFunc(gl.ALWAYS)` wrapping the chunk loop, restored to `LESS` after |
| Pacing in benchmarks | `device.queue.onSubmittedWorkDone()` per frame | None — `EXT_disjoint_timer_query_webgl2` provides GPU time post-hoc |

If you find a real asymmetry that isn't on the list above, it is almost certainly a bug.

---

## 7. Chunked-Path Correctness Notes

Two non-obvious settings differ between the single-texture and chunked draw paths. Both are correctness fixes — not optimisations — that landed on this branch (commit `8be40df`):

| Setting | Single-texture | Chunked | Why |
| --- | --- | --- | --- |
| Depth test | `LESS` with depth writes | `ALWAYS` | The N chunk cube draws share one depth buffer; depth-testing transparent OVER-composited layers against each other rejects a chunk that lies behind an already-drawn chunk and loses its contribution. The rejection locus is a fixed curved pattern in volume space, which is why the artifact reads as a static, no-shimmer concentric-ring darkening. |
| Output alpha | `colAcc / earlyTermination` | Snap to `(rgb/a, 1)` on full coverage, otherwise leave `colAcc` as-is | Scaling every fragment by `1/earlyTermination` inflated each chunk's alpha. Multi-chunk OVER then over-occluded the chunks behind, with the error compounding per chunk crossing — the second source of the same concentric-ring artifact. |

---

## 8. Invariants the Renderer Assumes

These hold across both backends and both paths. Breaking any of them produces a class of visible bug that's easy to misdiagnose as a shader problem.

| Invariant | Where enforced | Symptom when violated |
| --- | --- | --- |
| Ray-march writes premultiplied alpha; blend func matches | `render.wgsl`, `renderShader.ts`, + the WebGL2 `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` | Alpha multiplied twice — recurring WebGL2 regression |
| Per-chunk halo ≥ 3 | `chunkVolume(..., [3,3,3])` call sites in `wgpu/render.ts` and `gl/render.ts` | Gradient seams at chunk boundaries |
| Chunks drawn back-to-front | `ChunkVisibility.chunksBackToFront` | OVER compositing produces a wrong image |
| Chunked draws skip depth self-testing | `pipelineChunked` (WebGPU) / `gl.depthFunc(ALWAYS)` (WebGL2) | Concentric-ring darkening |
| Output alpha not scaled by `1/earlyTermination` on chunked path | Final block of `render.wgsl` and `renderShader.ts` | Per-chunk alpha inflation; chunks behind appear dimmer |
| `beginFrame()` called before working-set request | Caller of `ChunkResidencyManager` | Same-frame eviction can drop the chunk you're about to draw |
| Orient + gradient produce bit-identical results inside a chunk's data region vs the whole-volume version | Tests in `src/volume/orientChunked.test.ts` | Subtle per-chunk shading differences |

---

## 9. Cost Summary

| Path | GPU bytes per voxel (steady state) | Per-frame draws | Per-mutation passes |
| --- | ---:| ---:| --- |
| Single-texture | 8 (RGBA8 colour + RGBA8 gradient) | 1 | 1 × (orient + gradient) |
| Chunked, 2×2×2, halo `[3,3,3]` | ~13–14 (≈80% halo overhead × 8) | 8 (one per chunk) | 8 × (orient + gradient) per full re-upload; only the affected chunk on stream-in |

For real-GPU frame times on the single-texture path, see the headed table in `docs/perf.md`. The chunked path doesn't yet have a dedicated benchmark scenario — see the open follow-up at the bottom of `docs/tiled-volumes-handoff.md`.

---

## 10. Independent hi-res overlay (`chunkOverlayOf`)

By default an overlay over a chunked base is **resliced onto the base grid**
(`_updateOverlayChunks` -> `orient.overlay2TextureChunked`), so the overlay can
never out-resolve the base. An overlay volume carrying `chunkOverlayOf` (the
base's cache-key) is instead streamed as a **second, independently-chunked
volume**: its own `ChunkPlan`, its own `ChunkResidencyManager` working set, its
own streaming chunk source. It is drawn as its own translucent chunk cubes over
the base, sampled through its own (finer) grid.

How it rides the existing machinery:

- It is a second `_texCache` entry, so `beginChunkFrame()` / `pumpChunkUploads()`
  (which already iterate every chunked entry) stream it for free.
- `_activeOverlayChunked` is the active pointer; `requestOverlayChunksInFrustum`
  / `requestOverlayVisibleChunksInView` drive its working set (culled against the
  overlay's own plan + `matRAS`, the shared scene MVP).
- `drawOverlayChunked` (both backends) draws its cubes after the base in the same
  pass; `overlayLayerMode=1` (a shader uniform, formerly the unused `numPaqd`)
  makes the fragment skip the base clip-surface / AO / matcap treatment and
  composite as a flat translucent layer. WebGPU uses a dedicated
  `OVERLAY_CHUNK_PARAMS_BASE` region of the params buffer so its cube uniforms
  never collide with base cube uniforms within a frame.

Scope / limitations (current):

| Limitation | Detail |
| --- | --- |
| 3D render only | The overlay composites in the 3D render tile; it is **not** drawn on 2D multiplanar slices yet. Load a base-grid-resliced overlay for 2D. |
| Co-registered, axis-aligned | Assumes the overlay shares the base's orientation/extent (e.g. a finer pyramid level). Arbitrary base->overlay affine is a follow-up (compose via `calculateOverlayTransformMatrix`). |
| Compositing order | Base and overlay cube sets are each sorted back-to-front but drawn as two sets (overlay always over base) — the same per-cube approximation already used between neighbouring base chunks. |
| Residency budget | Each `ChunkResidencyManager` uses the full configured `maxChunkResidencyBytes`. With a base + overlay both resident the total can approach 2x; size the streamed levels so base + overlay fit (the demo streams the overlay at one finer level than a deliberately-coarser base). A single split budget is a follow-up. |
| Layer mix | `chunkExplode` is per-entry, so exploding the base does not explode the overlay. |
| Render mode | In `SLICES` the overlay contributes its own plane hits over the base's, sampled with the layer alpha the orient pass baked in (`sampleSlice(pos, isLayer)`) rather than the background `opacity` this draw passes as 1. The planes themselves come from the base's crosshair, so it leans on the co-registration above. |

Demo: `apps/iiif-volumetric-demo` overlay page, "stream hi-res" toggle (3D
render). The overlay streams a finer pyramid level than the base and z-scores
each brick client-side.

---

## 11. Open follow-ups

Tracked in `docs/streaming-todos.md`: moving chunk decode off the main thread,
the level-grid texture misregistration, and the residual LOD seams. Named
**budget plans** (planning policies beyond the crosshair-focused default) have
their own design doc, `docs/budget-plans.md`.
