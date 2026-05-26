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
   * Because they take longer to download, NiiVue continues rendering the blurry Level 3 chunks as a placeholder.
   * Once the Level 0 chunks arrive, the `ChunkResidencyManager` admits them to the GPU cache, instantly "popping" the view into sharp focus.
   * Simultaneously, if the VRAM budget is exceeded, NiiVue evicts the high-resolution chunks that recently panned off the edges of the screen.

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
