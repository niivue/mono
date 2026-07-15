# Tiled volumes — Phase 3 design: chunk streaming + LRU residency

Design doc for Phase 3 of the tiled-volume work. Phases 0-2d (see
[`tiled-volumes.md`](./tiled-volumes.md) and
[`tiled-volumes-handoff.md`](./tiled-volumes-handoff.md)) made oversized
volumes renderable by splitting them into per-chunk 3D sub-textures. This
phase makes GPU chunk residency a *managed, streamed* resource so volumes
far larger than current caps render without failing.

Written by Claude for Gemini review, same process as the phase handoff log:
Claude writes the design, Gemini acknowledges or pushes back, then we
sub-phase the implementation.

---

## Where Phase 2 left off

`updateVolume` plans the chunks (`chunkVolume`) and immediately uploads
**every** chunk via `volume2TextureChunked` — scalar + gradient + (when
present) per-chunk overlay / PAQD / drawing textures. A `ChunkedTexEntry`
holds the full `VolumeChunkGPU[]`; all chunks stay GPU-resident for the
lifetime of the volume. The 3D draw loop sorts every chunk back-to-front
and draws all of them; the 2D slice loop draws the chunks the slice plane
crosses.

Two hard guardrails keep this honest:

- `CHUNKED_VOLUME_BYTE_CAP` — `updateVolume` throws if total GPU bytes
  (scalar + RGBA + gradient across all chunks) exceed the cap.
- `MAX_CHUNKS_PER_TILE` (32) — a volume that tiles into more chunks than
  this fails fast.

So Phase 2 renders oversized volumes correctly but only up to a
few-GB resident footprint. Beyond that it refuses to load.

## Goal

Render volumes whose **full chunk set exceeds GPU memory** by keeping only
the chunks the current views need resident, and evicting the rest under an
LRU policy bounded by a configurable GPU byte budget. The
`CHUNKED_VOLUME_BYTE_CAP` / `MAX_CHUNKS_PER_TILE` fail-fast becomes a
graceful-degradation path: a volume whose *working set* fits the budget
renders fine no matter how large the whole volume is.

## Non-goals (explicitly out of scope for Phase 3)

- **Server-side chunk sourcing.** Phase 3 keeps the Phase 2 assumption that
  the whole volume is in RAM as `NVImage.img`; chunk bytes are sliced from
  it with `extractChunkBytes`. The *GPU texture* is the streamed resource,
  not the voxel data. A later optional `VolumeChunkSource` callback (noted
  in `tiled-volumes.md`) would stream voxel data from a server — separate
  doc, separate phase.
- **LOD / mipmap pyramids.** Zoom-aware level selection is a natural
  follow-on but is not Phase 3.
- **Out-of-core RAM paging.** If `NVImage.img` itself does not fit in RAM,
  that is the `VolumeChunkSource` problem above.

## Architecture

### `ChunkResidencyManager`

One per chunked volume, per backend, mirrored in structure (parity rule).
It owns:

- **An LRU map** `chunkIndex -> VolumeChunkGPU` of currently-resident
  chunks (scalar + gradient; overlay / PAQD / drawing textures for the
  same index are evicted together — they share the `ChunkPlan`).
- **A GPU byte budget** (`maxChunkResidencyBytes`, configurable; see
  below). Sum of resident chunk bytes must stay under it.
- **An upload queue** of chunk indices requested but not yet resident.
- **A frame counter** for LRU recency stamps.

`ChunkedTexEntry.chunks` stops being a dense always-resident array and
becomes the manager's sparse resident set. `computeChunkCenters` and the
`ChunkPlan` stay as-is (cheap, CPU-only metadata for all chunks).

### Per-frame visibility (the working set)

Each frame, before drawing, compute the set of chunk indices the views
actually need — the *working set*:

- **3D ray-march tiles.** Frustum-cull each chunk's volume AABB against
  the tile MVP. A chunk whose AABB is fully outside the frustum is not in
  the working set. (Phase 2 draws all chunks; this adds the cull.)
- **2D slice tiles.** The chunks a slice plane intersects — already a
  small set the slice loop computes; lift it to feed the working set.
- The working set is the union across every tile in the layout.

### Upload (request -> resident)

Chunks in the working set but not resident are enqueued. Each frame the
manager uploads a **bounded** number (or time budget — open question 2)
via `device.queue.writeTexture` (WebGPU) / `texSubImage3D` (WebGL2), so a
large working set fills in over a few frames instead of hitching one.
When an upload completes the manager calls `drawScene()` so the newly
resident chunk appears.

### Missing-chunk draw policy

A chunk in the working set but not yet uploaded must not crash the draw
loop. Candidate policies (open question 1):

- (a) **Skip + request** — draw nothing for that chunk this frame, enqueue
  it, redraw when it lands. Briefly shows a hole that fills within ~1-2
  frames. Simplest; recommended default.
- (b) **Placeholder** — bind a 2x2x2 transparent texture (the existing
  placeholder) so the chunk is simply transparent until resident. Same
  visual as (a) but no per-chunk skip branch.
- (c) **Coarse stand-in** — needs an LOD pyramid; out of scope.

Recommendation: (b) — reuse the placeholder texture already bound for
absent layers. It needs no new skip path and degrades to "transparent
until loaded," which reads as natural progressive loading.

### Eviction

When a requested upload would push resident bytes over budget, evict the
least-recently-used chunk **not in the current working set** until there
is room. If the working set itself exceeds the budget, the manager
thrashes (evict + re-upload same frame) but still renders — degraded, not
broken. A `log.warn` flags sustained thrash.

### Budget

Replace the `CHUNKED_VOLUME_BYTE_CAP` hard throw with a configurable
`maxChunkResidencyBytes` (new `NiiVueOptions` field, defaulting to roughly
today's cap). `updateVolume` no longer throws on large volumes; it just
plans the chunks and lets the manager stream them. `MAX_CHUNKS_PER_TILE`
is removed — frustum culling, not a fixed count, now bounds per-tile draws.

## Backend parity

The manager, LRU policy, working-set computation, upload pacing, and
eviction order are identical across backends. Only GPU resource
creation/upload/destroy differ. The visibility math (frustum cull, slice
intersection) is shared CPU code — a candidate for `volume/` so both
backends call one implementation.

## Sub-phasing

Phase 3 is large; split it for review the way Phase 2a was:

- **3a** — `ChunkResidencyManager` skeleton + LRU map + budget accounting,
  WebGPU. Behavior unchanged: it still makes every chunk resident at load.
  This decouples upload from `updateVolume` without changing what renders.
- **3b** — WebGL2 parity for 3a.
- **3c** — visibility-driven upload, both backends: frustum cull + slice
  intersection -> working set; bounded per-frame uploads; missing-chunk
  policy; `drawScene()` on upload completion.
- **3d** — eviction under budget pressure; `maxChunkResidencyBytes`
  option; remove `MAX_CHUNKS_PER_TILE`, convert the byte cap to the
  configurable budget. Demo: extend `vox.tiled` with a budget slider so
  thrash/streaming is visible.

## Acknowledgment requested

1. **Missing-chunk policy** — agree with (b), bind the existing
   transparent placeholder for not-yet-resident chunks, over an explicit
   per-chunk skip path?
2. **Upload pacing** — fixed N chunks/frame, or a per-frame time budget
   (upload until ~X ms spent)? Fixed N is simpler and predictable; a time
   budget adapts to chunk size but needs a clock per frame.
3. **Eviction granularity** — evict scalar + gradient + overlay + PAQD +
   drawing for a chunk index as one unit (they share the plan), correct?
4. **Universal single-chunk path** — should 1-chunk volumes (the common
   case) bypass the residency manager entirely to keep their hot path
   free of LRU bookkeeping, or go through it for uniformity?
5. **Sub-phasing** — is the 3a-3d split right, and is 3a (LRU plumbing
   with no behavior change) a worthwhile standalone review step?
