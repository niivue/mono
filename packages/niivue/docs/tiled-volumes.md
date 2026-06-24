# Tiled (chunked) volume rendering

Design doc for supporting volumes whose longest dimension exceeds the GPU's
`maxTextureDimension3D`.

## Problem

Both WebGPU and WebGL2 cap 3D textures at `maxTextureDimension3D`
(usually 2048; some adapters expose 4096–16384, which we now request
explicitly). Volumes that exceed the device limit in any spatial dim
cannot be uploaded as a single 3D texture — the renderer silently
produces a black frame.

For multi-gigabyte microscopy / WSI / CT data sets the limit is reached
routinely. We need to render volumes larger than the texture cap by
splitting them into chunks and compositing across multiple draw calls.

## Approach

Chunk a large `NVImage` into N axis-aligned sub-volumes, each ≤
`maxTextureDimension3D` per dim, with a 1-voxel halo. Treat **every**
volume as a chunked volume (chunk count == 1 in the common case) so the
renderer's hot path stays uniform.

Each chunk owns:

- Its own 3D texture (and gradient texture, if lit).
- A chunk-local AABB in volume voxel space.
- A chunk-local frac↔mm transform.
- A neighbour-aware halo flag (which faces are interior — those faces
  use halo voxels and so should not contribute past the chunk's own
  data extent).

The 3D ray-marcher and the 2D slice shader are rewritten to issue one
draw call per chunk, clipped to the chunk's volume footprint and
sampling that chunk's texture only.

## Data model

```
NVImage
  ├── img            (typed array, full volume — unchanged)
  ├── hdr            (NIFTI header — unchanged)
  ├── chunks?: VolumeChunk[]      // new, optional. Absent ⇒ legacy single-tex path
  └── chunkShape?: [number,number,number]  // chosen tile size in voxels

VolumeChunk
  ├── voxelOrigin:  [x,y,z]        // chunk's (0,0,0) in volume voxel coords
  ├── voxelDims:    [w,h,d]        // chunk size in voxels (≤ device limit)
  ├── haloSize:     [hx,hy,hz]     // 0 on outer faces, otherwise typically 1
  ├── texture:      GPUTexture | WebGLTexture
  ├── gradientTexture?: GPUTexture | WebGLTexture
  └── aabbMM:       { min:vec3, max:vec3 }  // for view-direction sort
```

A new module `volume/chunking.ts` computes `chunks` + `chunkShape` given
the volume's dims and the device's `maxTextureDimension3D`. Chunks tile
the volume with overlap = halo on interior faces; outer faces have no
halo (the chunk's outer face *is* the volume's outer face).

Chunk shape is chosen to be the largest power-of-two ≤ `(limit – 2)` so
that a 1-voxel halo on each interior face still leaves room. Example:
device limit 2048 → chunk shape 2046 per interior axis, edge chunks
take the remainder. (We may revisit the power-of-two constraint —
some hardware prefers it for caching, others don't care.)

## Renderer changes

Both backends, parity required.

### 3D ray-march (`wgpu/render.*`, `gl/renderShader.*`)

Per frame, per volume:

1. Compute view direction in volume space.
2. Sort `vol.chunks` front-to-back along view direction (the existing
   render compositing is front-to-back with premultiplied alpha — the
   first chunk a ray enters contributes before subsequent ones).
3. For each chunk: issue one draw call with the chunk-local AABB as
   the ray-march bounding box, the chunk's texture bound, and the
   chunk-local tex transform. Existing per-pass blend
   (`ONE / ONE_MINUS_SRC_ALPHA`) accumulates correctly across chunks
   without further changes.
4. Repeat for overlay / PAQD / drawing passes — each gets the same
   chunked treatment (per-pass chunk metadata can live alongside the
   background volume's chunks because all overlays are resliced to the
   background grid).

Boundary behaviour: trilinear sampling at a chunk edge needs the
neighbour's adjacent voxel. The 1-voxel halo carries it, so seams
disappear without per-shader special-casing. The shader still clips
sampling to `[haloStart, chunkDim - haloEnd]` so the halo isn't
double-counted across chunks.

### 2D slice (`wgpu/slice.*`, `gl/sliceShader.*`)

A slice plane intersects ≤ 4 chunks (planar slab through axis-aligned
chunks). For each tile:

1. Pick the chunks the slice plane crosses.
2. For each chunk, compute its on-screen footprint (clip-space rect)
   from the chunk's volume AABB.
3. Draw the slice quad once per chunk, scissored to its footprint, with
   the chunk's texture bound and the chunk-local tex coord transform.

Mosaic / multiplanar reuses the same per-chunk loop per tile.

### Gradient texture

Gradients are computed via central differences (or Sobel) on the
volume texture. To keep gradients smooth across chunk boundaries the
gradient texture is chunked with the same halo, computed from the
voxel data + halo so that the central-difference stencil at the chunk
edge reads valid neighbour data. The drawing-volume gradient (when
illuminated) inherits the same scheme.

### Depth pick / screen pick / drawing

`screenSlicePick` and the depth-pick readback both unproject screen
coords to mm-space. mm-space is the common ground, so the picker
itself doesn't change — only the chunk lookup at the end (`mm → tex
frac` becomes `mm → chunk + chunk-local tex frac`). Drawing-volume
writes go through the same lookup.

## API surface

Public API is unchanged at first. Internally:

- `NVImage.chunks` is optional. Absence ⇒ legacy single-tex path
  (which we may keep for a release or two as a fallback).
- A new internal hook `volume/chunking.chunkVolume(img, limit)`
  produces the chunk descriptors and pre-allocates the per-chunk
  typed-array views (zero-copy slicing of the source `img`).
- The view's per-volume GPU cache stores a `VolumeChunkGPU[]` keyed
  the same way as today (URL or name).

A later, optional, addition: a `VolumeChunkSource` callback so apps
can stream chunks on demand from a server (the iiif-volumetric-server
already supports bbox subvolume queries, so the demo can plug
straight in).

## Backend parity

WebGPU and WebGL2 must mirror each other in chunk structure, sort
order, halo handling, and per-chunk uniform layout. The chunking math
lives in shared module `volume/chunking.ts`; only the GPU resource
creation and per-draw setup differ. See `AGENTS.md` ("Backend feature
parity") for the hard rule.

## Memory budget

A single 4096³ float32 volume is 256 GB — well beyond GPU RAM. The
chunking strategy assumes the volume already fits in RAM (it's an
`NVImage`); GPU memory pressure comes from how many chunks are
resident at once. Future work:

- Stream chunks lazily based on view dir + zoom (only upload chunks
  the ray-march would hit at the current LOD).
- LRU eviction of chunks not touched in N frames.

These are not in scope for the first cut. The first cut uploads all
chunks for the active volume, which is fine up to a few-GB GPU
resident size.

## Multi-resolution (per-brick LOD)

`chunkVolumeMultiLOD` (in `volume/chunking.ts`) extends the uniform tiling above
into a Neuroglancer-style **per-brick level-of-detail** plan: a region near a
focus point renders at the finest pyramid level, and bricks coarsen with distance.
One `ChunkPlan` holds bricks of mixed pyramid levels; they still tile the volume
exactly once, so there is no inter-level alpha compositing problem.

### Coordinate-frame split

Each `VolumeChunkDesc` in a multi-LOD plan carries `sourceLevel` and stores **two**
coordinate frames (see the `sourceLevel` doc comment on `VolumeChunkDesc`):

- **Common (finest, level-0) grid** — `voxelOrigin` / `voxelDims`. Drives **world
  placement**: `voxelOrigin/voxelDims ÷ plan.volumeDims` give the brick's sub-cube
  of the `[0,1]` world cube. All geometry, visibility, `matRAS`, and seam alignment
  use this frame, so it is identical for every brick regardless of level.
- **The brick's own level grid** — `texOrigin` / `texDims` / `haloLow` / `haloHigh`.
  Drives the **fetch bbox**, the uploaded texture size, and the in-texture halo
  remap (`dataOriginTexFrac` / `dataSizeTexFrac = (texDims − halos)/texDims`).

`plan.levelDims[ℓ]` holds each level's full-volume dims (`levelDims[0] === volumeDims`).

### Balanced octree + budget

Refinement is **scale-relative**: a cell subdivides while its nearest distance to
the focus (beyond `radius`) is below `detail × cellSize`. Because the threshold
scales with the cell, the level changes by ~1 per cell step. An explicit **2:1
balance** post-pass then splits any brick that has a face-neighbour more than one
level finer, guaranteeing face-adjacent bricks differ by at most one level (smooth
LOD transitions, no fine-next-to-very-coarse walls). The budget pass first shrinks
`detail` (coarsens while staying balanced), then raises a global level `floor`, and
finally respects `maxBricks` so a plan never exceeds the renderer's
`MAX_CHUNKS_PER_TILE` cap. Budget is estimated as `Σ texDims·8` (rgba + gradient).

### Per-brick ray step + opacity correction

The one shader change vs. the single-level path is a per-brick `rayStepTexVox`
uniform = the brick's source-level dims, used **only** for the ray-march step
density (`render.wgsl` / `renderShader.ts`); `volumeTexDimsFull` stays the common
grid everywhere else (vertex placement, depth, gradient). A coarse brick takes
fewer samples, so a **step-size opacity correction** `1 − pow(1 − a, stepRatio)`
(with `stepRatio = fineLenVox / lenVox`) scales per-sample alpha up to the finest
density, keeping brightness resolution-independent. Both backends.

### Mixed-size draw order

Chunk cubes draw with `depthFunc ALWAYS`, so correct premultiplied-alpha
compositing depends entirely on `chunksBackToFront`. A single far-corner scalar key
is correct only for equal-size boxes under axis-aligned views; mixed-size LOD bricks
at oblique angles need the **separating-axis comparator**: two non-overlapping AABBs
that can occlude one another are separated along some axis, and the near-side box
along the most view-aligned separating axis is in front. (It reproduces the old
order for equal-size grids.)

### Residency must match the plan budget

The plan budget (how many bricks the octree makes) and the `ChunkResidencyManager`
budget (what stays GPU-resident) both measure `texDims·8` and **must agree** —
otherwise the manager evicts bricks the plan included and blocks stop rendering.
A consumer sets `maxChunkResidencyBytes` to the same value it passes as the plan's
`budgetBytes`.

### Focus indicators

`NVModel._focusBox` (`nv.focusBox`) outlines a world-space AABB on 3D render tiles
via `buildFocusBoxLines`; `NVModel._lodBoxes` (`nv.lodBoxes`) draws a set of them,
e.g. one per brick coloured by level for debugging. Both backends loop-draw them.

### Known limitation

Same-level brick boundaries are seamless (halo). Adjacent **different-level**
boundaries still show a one-level brightness/blockiness step (and matcap lighting
can catch the coarse blocky surfaces as highlights) — inherent to multi-resolution
compositing of a non-dyadic pyramid. The real fix is cross-LOD blending (sample the
brick's level and the next coarser, fade across a boundary band); deferred.

## Open design questions

1. **Universal chunked path vs. opt-in.** Treating every volume as a
   single-chunk volume keeps one render path but adds a tiny
   per-volume overhead for small volumes. Worth the simplicity, but
   we should measure on the bench suite before deciding.
2. **Power-of-two chunk shape.** Some hardware prefers it for cache
   lines; on others it just wastes a few MB. Default to power-of-two
   minus halo, revisit if perf reports show otherwise.
3. **Halo size > 1?** Trilinear needs 1; future filtering (cubic,
   gradient with wider stencil) might want 2. Make `haloSize` per-axis
   configurable from the start.
4. **Chunk source ownership.** Some workflows (DICOM, OME-Zarr) have
   natural chunk boundaries on the server. Worth letting the caller
   provide pre-chunked data instead of always slicing client-side.

## Phasing

1. ✅ Phase 0 — request the adapter's `maxTextureDimension3D` so the
   single-texture path covers volumes up to whatever the GPU supports.
2. Phase 1 — `chunking.ts` + `NVImage.chunks` data structure + unit
   tests for chunk math (no rendering changes).
3. Phase 2a — chunked 3D ray-march, single backend (WebGPU first since
   it's where most fixtures land), behind a feature flag.
4. Phase 2b — port to WebGL2 (parity).
5. Phase 2c — chunked 2D slice + mosaic + multiplanar (both backends
   in lockstep).
6. Phase 2d — chunked gradient + drawing + overlays + PAQD.
7. Phase 3 — chunk streaming + LRU residency (separate doc when we
   get there).
