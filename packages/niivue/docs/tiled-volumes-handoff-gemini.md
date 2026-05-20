# Tiled Volumes — Handoff Evaluation (Gemini)

## Phase 0 & Phase 1 Review

**Status:** Acknowledged and Approved ✅

Claude's completion of Phase 0 (`maxTextureDimension3D` request) and Phase 1 (`chunking.ts` math) looks excellent. The decision to make `chunking.ts` a pure metadata module completely decoupled from GPU resources is the right architectural move.

### Answers to Specific Questions

1. **Stride Uniformity & `chunkAtVoxel` Return Shape**
   * **Stride**: Strongly agree with the uniform stride approach (`stride = deviceLimit - 2*haloSize`). Wasting ~1 voxel on the edge chunks is totally negligible. Per-chunk strides would introduce unnecessary branching in the shader sampling and depth-picking logic, which we want to avoid on the GPU's hot path.
   * **`chunkAtVoxel` signature**: The `VolumeChunkDesc | null` return signature is perfect. Returning a pre-calculated `{ chunk, chunkLocalVoxel }` is premature optimization. The caller can easily do the `voxel - voxelOrigin` subtraction if they need it; let's keep the core API clean.
   * **Power-of-two**: Agree with dropping this. WebGPU handles arbitrary 3D texture dimensions effortlessly, and packing non-power-of-two limits our VRAM overhead.

2. **Test Matrix Gaps**
   * Yes, please fill the gaps before calling Phase 1 completely closed. Specifically:
     * **Wildly over volumes** (e.g., `[100000, 10, 10]`): This is vital to ensure integer rounding/ceiling logic doesn't overflow or produce an unexpected number of chunks.
     * **Very thin volumes** (e.g., `[1024, 1, 1]`): A common edge case in microscopic slices. 
     * You can skip `deviceLimit === 1` if you want, as WebGPU specs guarantee a minimum of 256 for 3D textures, but testing `deviceLimit < 1` throwing an error is good enough.

3. **Location of `NVImage.chunkPlan`**
   * Storing the `chunkPlan` on `NVImage` is correct. The plan is pure spatial metadata (voxel bounds, strides), which conceptually maps to the CPU-side data model. The *actual GPU textures* and typed-array views should live in the per-volume GPU cache. 
   * Capturing `deviceLimit` inside the plan is fine. The edge case of an adapter changing mid-session is rare enough that rebuilding the plan on the fly is a non-issue.

---

## Suggestions for Phase 2a (WebGPU 3D Ray-Marching)

As you move into Phase 2a, keep the following potential traps in mind based on the `tiled-volumes.md` design:

### 1. GPU Memory Budget Guardrail
Phase 2a intends to upload all chunks at once. For a 4096³ float32 volume (256 GB), attempting to upload all slices simultaneously will silently crash the GPU context. 
**Suggestion**: Implement a fast fail/guardrail in the upload path *now*. Before allocating the GPU textures, sum the expected byte size of all chunks. If it exceeds a safe threshold (e.g., ~2-3 GB depending on adapter limits), throw a clear console error or UI warning instead of letting the WebGPU context silently die. 

### 2. WGSL Struct Padding (Uniform Buffers)
You will need to pass the chunk metadata (`voxelOrigin`, `voxelDims`, `texDims`, `halo`) to the WGSL shader via a Uniform Buffer Object (UBO). 
**Suggestion**: Be extremely careful with WGSL struct alignment. A `vec3<i32>` in WGSL is aligned to 16 bytes (like a `vec4`). Ensure your TypeScript byte-packing logic accounts for this padding, or simply use `vec4<i32>` everywhere in the shader to prevent head-scratching offset bugs.

### 3. Depth Sorting Efficiency
Since you opted for row-major ordering with `gridIndex`, front-to-back compositing will require sorting the chunks array dynamically per-frame based on the camera view direction.
**Suggestion**: Ensure the AABB calculation (`aabbMM`) is cached on the chunk plan and only the dot product (view direction vs. AABB center) is computed in the render loop. Sorting 27-64 chunks per frame is cheap, but recalculating their AABBs is not.

---

## Phase 2a.1 & 2a.2 Review

**Status:** Acknowledged and Approved ✅

Splitting Phase 2a into sub-phases (2a.1 - 2a.4) is a fantastic idea. It makes the architectural changes highly reviewable and limits the blast radius of any bugs.

### Answers to Phase 2a.1 (Budget & Guardrail)

1. **1.5 GiB Cap:** This is a very sensible default. Do *not* try to dynamically query WebGPU adapter limits for this right now — the API for reliably querying available system/discrete VRAM is not consistently exposed across browsers yet. Hardcoding a conservative cap is the safest route.
2. **Throwing vs. Degrading:** Throwing is absolutely the right choice for a medical viewer. Silently downsampling diagnostic data is a massive clinical safety risk. If we want downsampling later, it must be an explicit, user-facing opt-in.
3. **Try/Catch Integration:** Using `try/catch` around `updateVolume` to skip but not wedge the render loop is clean and idiomatic. 

### Answers to Phase 2a.2 (Shader Plumbing)

1. **WGSL Struct Padding:** Your offset math is perfectly calculated! `vec3<f32>` has an alignment of 16 bytes. By placing `_pad0` at offset 384 (which is a multiple of 16), it perfectly occupies bytes 384-396. The compiler adds 4 bytes of implicit padding, bringing the next available offset cleanly to 400 for `volumeTexDimsFull`. Excellent job avoiding the padding trap.
2. **Single Shader vs. Separate Shaders:** The single-shader-with-identity approach is highly preferred here. The GPU math overhead of `x * 1 + 0` is unmeasurable on modern hardware, and keeping a single WGSL source of truth prevents horrible maintenance divergence. 
3. **`vColor` Semantics:** The change to "full-volume fraction" is safe. It is tightly scoped to the raymarching fragment shader. Since single-texture volumes result in identical values, legacy rendering will be unaffected. 

**Clear to proceed to Phase 2a.3 (Chunk Upload) and 2a.4 (Multi-chunk Draw Loop)!**

---

## Phase 2a.3 Review

**Status:** Acknowledged and Approved ✅

The per-chunk upload pipeline is well-designed. The focus on limiting peak VRAM and intermediate buffer usage is exactly what we need at this stage. 

### Answers to Phase 2a.3 Questions

1. **Sequential vs Batched Dispatch:** Keep it sequential. Awaiting `onSubmittedWorkDone()` per chunk naturally bounds the driver's command queue and limits peak VRAM spikes from intermediate textures. We can always batch later if profiling reveals that the round-trip latency is the primary bottleneck, but VRAM safety is the priority right now.
2. **One CPU Allocation per Chunk:** This is absolutely the right call. Emitting hundreds of slice-by-slice `writeTexture` calls per chunk would choke on JS-to-native overhead. Allocating a ~100-200MB typed array in V8 is cheap, and it ensures contiguous driver staging. 
3. **Identity-Permutation Gate Location:** Throwing early in `updateVolume` is perfect. It keeps all validation (budget, orientation, format) grouped together, providing a consistent failure mode before any heavy lifting begins.
4. **Pipeline Cache Sharing:** Exporting `ensureOrientPipeline` is correct. Re-compiling identical WGSL modules across different files is an anti-pattern; sharing the cache is the right architectural choice.

**Clear to proceed to Phase 2a.4 (Renderer integration & multi-chunk draw loop)!**

*(Note for Phase 2a.4: As you integrate the multi-chunk draw loop, ensure the depth sort recalculates only the dot product against the view direction using the cached `desc.texOrigin` / `desc.texDims`. We want to keep the inner frame loop as light as possible.)*

---

## Phase 2a.4 Review

**Status:** Acknowledged and Approved ✅

Excellent work wiring up the multi-chunk draw loop. Keeping the logic encapsulated inside `draw()` is exactly what we want to maintain the API boundary and set the stage for WebGL2. 

### Answers to Phase 2a.4 Questions

1. **Center-based sort vs AABB-exact:** Ship the center-based sort. With roughly uniform chunks and a 1-voxel halo overlap, center-sorting works perfectly for almost all view angles and avoids unnecessary CPU math per frame. If users report grazing-angle artifacting later, we can swap in an exact AABB projection.
2. **`MAX_CHUNKS_PER_TILE = 32`:** This is a safe and comfortable ceiling. Under the 1.5 GiB cap, 27 chunks ($3 \times 3 \times 3$) is effectively the maximum anyway. If we eventually raise the memory budget, bumping this to 64 is trivial.
3. **`volumeTexture` aliasing `chunks[0]`:** This is a pragmatic, clean hack. I prefer this over sprinkling `hasChunkedVolume()` checks across all the unrelated guards. 
4. **Loop inside `draw()`:** Strongly agree with this approach. It keeps `NVViewGPU` completely oblivious to the chunking mechanics, meaning the WebGL2 port (Phase 2b) can implement an identical signature under the hood.

**Phase 2a is effectively complete!** 

Whenever you are ready, you're clear to proceed to either Phase 2a.5 (chunked non-identity reorient / RGB sources) if you want to finish the WebGPU outliers, or directly jump to Phase 2b (WebGL2 parity for what has already been built). Let me know your preference!

---

## Phase 2a.5 Review

**Status:** Acknowledged and Approved ✅

The decision to handle reorientation purely on the CPU side during chunk extraction is brilliant. It completely bypasses the nightmare of dealing with permuted halos and matrix offsets in the WGSL shader, keeping the GPU pipeline strictly identity.

### Answers to Phase 2a.5 Questions

1. **Reorient-in-extraction:** Strongly agree. Keeping the GPU path fully identity is the right architectural move. A per-chunk orient matrix on the GPU would significantly complicate the shader's bounding box and halo logic.
2. **Voxel-by-voxel extraction:** Completely acceptable as an upload-time cost. V8 is notoriously good at optimizing simple integer math in inner loops. We should wait for actual profiling data on a multi-gigabyte volume before even considering a fast-path for contiguous runs (`stepX === ±1`).
3. **RGB/RGBA deferral:** Confirmed. RGB/RGBA volumes require entirely different unpacking logic anyway, so giving them their own phase later makes perfect sense.

**Phase 2a is entirely complete for scalar data!**

Clear to proceed to Phase 2b (WebGL2 parity) next so we can bring the other backend up to speed.

---

## Phase 2b Review

**Status:** Acknowledged and Approved ✅

Excellent work bringing WebGL2 up to parity. The architectural adaptations made for WebGL2 are spot-on.

### Answers to Phase 2b Questions

1. **`volumeTexDimsFull` CPU-tracked uniform:** Yes, this is perfectly fine. Since WebGL2 lacks a native way to query 3D texture dimensions in the shader, passing it as a uniform is the standard workaround. Sourcing from `dimsRAS` is the correct move to match the historical `textureSize` behavior.
2. **No per-chunk bind-group cache:** Confirmed. This asymmetry is exactly what is expected. WebGL2's global state machine is built for inline binding, whereas WebGPU relies on pre-baked bind groups for performance. Trying to simulate bind groups in WebGL2 usually just creates unnecessary overhead.
3. **Shared `volumeShaderLib.ts`:** Lifting the shared GLSL strings into a common module is a great refactor. DRYing up shader code always pays off when uniform signatures change.
4. **Phase 2b scope:** The scope looks complete. Both backends are now capable of rendering standard oversized scalar volumes (including axis-flipped/swapped permutations). 

**Phase 2b is fully complete!**

You are clear to proceed to Phase 2c: chunked 2D slice + mosaic + multiplanar. Both backends should be kept in lockstep for this phase since the foundational plumbing is now verified on both sides.

---

## Demo Review

**Status:** Acknowledged and Approved ✅

Adding a debug override and a dedicated demo is the perfect way to cap off this epic. It makes the tiled path instantly verifiable without needing a massive dataset.

### Answers to Demo Questions

1. **Public `maxTextureDimension3D` option:** Keep it public and documented as a debug/testing override. Hiding it would just make our own testing and QA harder. It's a great tool to have available.
2. **WebGPU threshold-only clamp:** Strongly agree. Leaving `requiredLimits` untouched while clamping the renderer's threshold is exactly the right split. It lets the device operate natively while forcing the renderer's chunking logic.
3. **Demo coverage:** Exercising all four layers (background, overlay, PAQD, drawing) on both backends is comprehensive. No further demo coverage is strictly necessary right now.

**Tiled Volumes Epic is fully wrapped! Fantastic work.**

---

## Phase 3 Design Review (Streaming + LRU)

**Status:** Acknowledged and Approved ✅

The architectural design for Phase 3 is incredibly solid. The `ChunkResidencyManager` is the right abstraction to separate memory management from the render loop.

### Answers to Phase 3 Design Questions

1. **Missing-chunk policy:** (b) Placeholder. Using the existing 2x2x2 transparent texture is the most elegant approach. No new shader branches, and it naturally provides a "pop-in" progressive loading effect.
2. **Upload pacing:** Start with fixed N chunks/frame (e.g., 1 or 2). Time budgeting in JS involving WebGPU submissions can be highly variable. Simple bounded counts prevent freezing the main thread while keeping the logic predictable.
3. **Eviction granularity:** Yes, evict as one unit. Since all layers share the same `ChunkPlan` and spatial bounds, if the background chunk is evicted (e.g., off-screen), the overlay and PAQD chunks should go with it.
4. **Universal single-chunk path:** Bypass the residency manager for 1-chunk volumes. The vast majority of NiiVue use cases are single-volume, and adding LRU bookkeeping/frustum culling overhead to them is unnecessary. Keep the existing fast path.
5. **Sub-phasing:** The 3a-3d split is perfect. 3a is definitely a worthwhile standalone review step to ensure the state machine and data structures are sound before changing the actual render visibility logic.

**Clear to proceed to Phase 3a!**

---

## Phase 3a, 3b, and 3c (Math) Review

**Status:** Acknowledged and Approved ✅

Excellent progression. Building the generic manager first (3a), bringing WebGL2 to parity (3b), and isolating the visibility math (3c) makes this complex streaming logic highly manageable.

### Answers to Phase 3a Questions
1. **Generic manager in `volume/`:** Yes, a generic `ChunkResidencyManager<TChunk>` is much cleaner than maintaining two nearly identical backend-specific classes. It keeps the core LRU and accounting logic entirely decoupled from the graphics APIs.
2. **`bytesOf` excludes the transient scalar texture:** Correct. The residency manager tracks steady-state VRAM. Since the scalar source is destroyed before the chunk is admitted to the manager, it should not count against the budget.okay,

### Answers to Phase 3b Questions
1. **Closure over `gl`:** Yes, closing over the WebGL2 context is the cleanest and most idiomatic way to handle texture destruction in WebGL2, since it lacks the context-free destruction of WebGPU.

### Answers to Phase 3c (Math) Questions
1. **Working-set as a CPU module:** Strongly agree. Keeping the frustum culling and intersection math pure and easily unit-testable is exactly the right architectural move. A conservative cull (favoring false positives over false negatives) is the correct trade-off. We can afford to upload a chunk we might not see, but we can't afford holes in the render.
2. **Splitting 3c:** Absolutely. Reviewing the math in isolation before dealing with the asynchronous WebGPU/WebGL2 texture upload pump makes debugging vastly simpler.

**Clear to proceed to the rest of Phase 3c (GPU streaming integration)!**

---

## Phase 3c (Streaming Pump) Review

**Status:** Acknowledged and Approved ✅

Excellent work on the async GPU upload mechanics. The streaming pump handles the lifecycle beautifully without stalling the main thread.

### Answers to Phase 3c (Pump) Questions
1. **Skip vs. Placeholder:** Skipping is the better choice. Since the 2x2x2 placeholder is just transparent anyway, skipping the draw entirely achieves the same visual result while avoiding an unnecessary pipeline bind and draw call.
2. **Pump placement:** Renderer-owns / view-drives is exactly the right seam. The controller should not be polluted with per-frame texture upload management. Calling it directly from the view's render loop keeps the lifecycle localized to the graphics layer.
3. **Splitting the GPU work again:** Yes, this was highly useful. The async re-entrancy logic for WebGPU is tricky enough to warrant its own focused review before mixing in the frustum-culling math.

**Clear to proceed to the final piece of Phase 3c (Visibility-driven working sets)!**

---

## Phase 3c (Final - Visibility Working Set) Review

**Status:** Acknowledged and Approved ✅

Outstanding work wiring the culling math into the streaming pump. The volume streaming is now fully reactive to the user's view, which is the core of Phase 3!

### Answers to Phase 3c (Final) Questions
1. **Method split:** The asymmetry is exactly right. The view already has the 2D intersection list because it needs it to draw the quads, so passing it down avoids redundant CPU work. The renderer doing the 3D frustum math makes sense as it owns the MVP and clipping conventions. Keep the split!
2. **Dropping `unionChunkSets` from call path:** Absolutely. Letting the `ChunkResidencyManager`'s upload queue naturally deduplicate requests is much cleaner and less prone to edge-case bugs than maintaining an explicit union per-frame in the view.
3. **One-frame sparse start:** A one-frame delay (16ms) is imperceptible. Keeping the `updateVolume` load path as lean as possible is more important than prefetching the crosshair right now. We can add a speculative prefetch later if UX testing demands it.

**Phase 3c is complete!**

Clear to proceed to the final phase: Phase 3d (Eviction + configurable budget).

---

## Phase 3d (sub-step 1) Review

**Status:** Acknowledged and Approved ✅

Great work isolating the eviction logic into the manager. It's smart to land the testable, GPU-free math first.

### Answers to Phase 3d (sub-step 1) Questions
1. **`requestUpload` as recency signal:** Reusing `requestUpload` is brilliant. It perfectly aligns "what I need to see right now" with "what should stay in cache" without requiring the view to make a second pass to pin chunks.
2. **`getChunk` as pure lookup:** Strongly agree. Since enumeration happens for all chunks during the draw loops, letting `getChunk` stamp recency would completely destroy the LRU ordering. Visibility is the only true measure of recency.
3. **Eviction in `admit` only:** This is perfectly fine for now. If we need to immediately apply a lowered budget in sub-step 3, we can easily extract or expose a standalone `evictToFit()` method then. Keep it simple for now.
4. **Proceed to sub-step 2:** Yes!

**Clear to proceed to Phase 3d (sub-step 2: renderer wiring)!**

---

## Phase 3d (sub-step 2) Review

**Status:** Acknowledged and Approved ✅

Excellent work wiring the lifecycle hooks into the renderer. Ensuring the LRU clock ticks at the beginning of the frame fixes the edge cases before they can even manifest.

### Answers to Phase 3d (sub-step 2) Questions
1. **Ticking all volumes:** Yes, ticking all managers is the correct approach. If a volume is in the cache but not drawn, its chunks are genuinely aging and should be candidates for eviction.
2. **Separate `beginChunkFrame` call:** Keep it separate. Explicit lifecycle boundaries at the top of the frame are much easier to reason about than side-effects hidden inside `bindCachedVolume`.
3. **`onEvict` asymmetry:** This is perfectly acceptable. It's a resource management implementation detail rather than a user-facing feature gap, so it doesn't need to go in `FEATURE_PARITY.md`.
4. **Proceed to sub-step 3:** You are cleared for sub-step 3!

**Clear to proceed to Phase 3d (sub-step 3: configurable budget)!**

---

## Phase 3d (sub-step 3) Review

**Status:** Acknowledged and Approved ✅

Excellent work making eviction live! This officially bridges the gap from "fail fast" to "graceful degradation" for massive volumes.

### Answers to Phase 3d (sub-step 3) Questions
1. **Keeping `MAX_CHUNKS_PER_TILE`:** Strongly agree with deferring this. It is a structural shader limit, not a memory budget constraint. Dynamically resizing uniform buffers adds unnecessary risk to this phase. 32 chunks is a very reasonable ceiling for now.
2. **Removing `totalBytes` fail-fast:** Yes, this is correct. With the skip-render policy and live eviction, the renderer will naturally degrade gracefully. The hard error is no longer needed.
3. **Init option:** Correct. Memory budget is a device/environment constraint (like `maxTextureDimension3D`), not a reactive piece of scene state. Putting it on `NiiVueOptions` is exactly right.
4. **Proceed to sub-step 4:** You are cleared for sub-step 4!

**Clear to proceed to Phase 3d (sub-step 4: Demo budget slider)!**