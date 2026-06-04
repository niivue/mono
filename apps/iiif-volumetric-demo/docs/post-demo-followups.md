# Post-demo follow-ups — chunked volumetric WSI

Work on the chunked-streaming / WSI demo, branch `feat/dicom-wsi-omezarr`. The
three items from the original demo feedback have all shipped; we are now in a
**performance** phase on the chunked path (base + independent hi-res overlay).

## Shipped

1. **Higher-res overlay + chunking for overlays** — DONE, commit `ef1b77d`.
   An overlay carrying `NVImage.chunkOverlayOf` streams as its own
   independently-chunked volume (own `ChunkPlan` + `ChunkResidencyManager` +
   chunk source) and draws as translucent cubes over the base in the 3D render,
   sampled through its own finer grid. Both backends. Design + limitations:
   `packages/niivue/docs/high-res-streaming.md` §10. Demo: overlay page
   "stream hi-res" toggle; knobs `?level=N`, `?budgetGB=N`.
2. **Drawing on chunks + exploded chunks** — DONE (`3708476`, `26b48c7`,
   `2919265`, `9df7e38`, `793a061`, `089f1dd`, `b7064a1`).
3. **Clip plane in the chunk request strategy** — DONE (`2a327df`, `2794b17`).

---

# Performance phase (current)

Goal: make the chunked path fast and non-thrashing — fast streaming fill,
responsive interaction, and graceful behaviour when the working set is large
(e.g. L0 all-resident in the 3D render) or when base + overlay are both resident.

**Approach: measure first, then attack the biggest bottleneck.** Don't optimize
blind. Land changes on both backends (parity rule); keep the off path unchanged.

## Known symptoms (from the L0 experiment)
- Streaming fill is slow: the upload pump does **1 chunk/frame**
  (`CHUNK_UPLOADS_PER_FRAME` in both `wgpu/render.ts` and `gl/render.ts`), so N
  bricks take N RAFs; L0 = 60 bricks ≈ 60 frames before full resolution.
- **Thrash** when the working set exceeds budget: the 3D render tile needs every
  brick resident at once, so an over-budget set evicts bricks that are still
  needed and re-uploads them every frame.
- In 3D, base + overlay are **both** all-resident; with each manager using the
  full `maxChunkResidencyBytes` the VRAM need ~doubles.

## Step 0 — Instrument — DONE
`chunkStreamStats()` aggregates `{ resident, pending, inFlight, total }` brick
counts across all chunked volumes: `VolumeRenderer.chunkStreamStats` (both
backends) -> `NVViewGPU/GL.chunkStreamStats` -> `nv.chunkStreamStats()`
(NVControlBase). The demo overlay HUD shows "GPU bricks resident: N/total
(streaming: X in-flight, Y queued)" and polls each frame while streaming.

## Prioritized work (re-rank after Step 0)
- **P1 — Faster upload pump — DONE.** The pump now uploads round-robin across
  chunked volumes until a per-frame **wall-clock budget** (`CHUNK_UPLOAD_BUDGET_MS`
  = 8) or cap (`MAX_CHUNK_UPLOADS_PER_FRAME` = 24), instead of a fixed 1
  chunk/frame. Both backends. Self-tunes the fill rate to upload cost.
- **P1b — Parallel prefetch — DONE.** The `chunkSource` source-byte fetch was
  awaited serially inside `uploadChunk` inside the serialized pump, so on a cold
  load bricks fetched one at a time. The uploader now splits a cached
  `fetchBytes` out of `uploadChunk` and exposes `prefetchChunk` (bounded by
  `MAX_PREFETCHED_CHUNKS` = 16 outstanding buffers, no-op for in-memory). The
  residency manager fires a `prefetch` hook when a chunk is first queued, and
  the pump tops up the fetch window each call via `peekPendingUploads`, so the
  next bricks' fetches run in parallel ahead of the GPU upload. Both backends.
- **P2 — Coarse-first / progressive LOD.** Show a coarse whole-volume texture
  immediately and refine as fine bricks stream in, so interaction stays
  responsive and frames are never blank/partial. Larger change.
- **P3 — Residency budget split.** Split the configured `maxChunkResidencyBytes`
  between base and overlay managers (e.g. 60/40) so 3D doesn't over-commit VRAM.
- **P4 — No redundant GPU work.** Audit that camera-only changes (pan/zoom/
  rotate) never re-orient/re-gradient or rebuild bind groups for resident bricks.
- **P5 — 2D-slice independent overlay** (also unblocks streaming only *visible*
  overlay bricks, sidestepping the all-resident 3D limit). Separate feature.
- **P6 — Globally-merged base+overlay back-to-front order** (compositing
  correctness, not perf) — lowest priority.

## Verify
Demo overlay page, `?backend=webgl2|webgpu`, `?level=N`, `?budgetGB=N`. Dev
servers: IIIF data on :8080, vite on :8087. Before finishing: from
`packages/niivue` run `bun run lint:fix && bun run typecheck && bun test`, then
`bunx nx build niivue`.
