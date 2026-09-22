# Chunked Streaming TODOs

Open follow-ups for the multi-LOD chunked volume path
(`src/volume/chunking.ts`, `src/volume/NVChunkedVolume.ts`, the `gl/` and
`wgpu/` chunk renderers). Design context: `docs/high-res-streaming.md` and
`docs/tiled-volumes.md`. Anything that changes rendering must land in BOTH
backends in the same change.

Order of work (Chris, 2026-08-21): fix the VISUAL artifacts first, then the
performance items. The visual items are under "Carried over from the LOD
compensation work"; decode and budget plans wait behind them.

## Move chunk decode off the main thread

- [x] Decode OME-Zarr chunks in a worker instead of on the main thread.
      DONE (stage C). Full write-up: `docs/caching.md` 2.1 and 2.7.

      `fetchOmeZarrChunkedSource` opens the store on the calling thread for its
      metadata and puts every chunk read on a pool of workers.
      `src/workers/omeZarrChunk.worker.ts` opens its own view of the store
      through the same `openOmeZarrChunkedSource` the main thread uses (a
      zarrita array is not structured-cloneable) and runs fetch, decompress,
      dtype convert and the region assemble there, transferring the finished
      `Uint8Array` back. `src/volume/omeZarrChunkWorkerPool.ts` routes by
      hashing the region rather than picking the idlest worker, because each
      worker holds its own byte LRU and a revisited brick must return to the
      worker that already has its bytes. Pool size is half the reported cores,
      clamped to `[1, 4]`. `createSourceChunkLoader` is untouched, so the
      manager still sees one `VolumeChunkSource` contract with the same
      concurrency, retry and dedup wrapper.

      Measured on the same HiP-CT window that condemned the main-thread path:
      8604 ms of lost frame time over a 24 ms budget became NONE, with 1898 ms
      of streaming work accounted for off-thread, 100% of it. A 40 second OCT
      slice-scrub left 2 ms of main-thread streaming cost in total.

      Timing survives the move: each worker reports a cumulative snapshot, the
      pool diffs it and folds the delta into an off-thread total, so
      `mainThreadMs` reports only what still blocks the render loop and a new
      `offThreadMs` reports what was moved. The dandi-demo HUD shows the share
      as a `workers` row, so a silent fallback to the main thread reads as a
      number rather than merely as slowness.

      Two build invariants that are easy to undo by accident: the module that
      knows about the pool must stay OUTSIDE anything the worker imports (hence
      `fetchOmeZarrChunkedSource.ts` as its own file, with the worker importing
      only the pool-free `openOmeZarrChunkedSource`), and zarrita's lazily
      imported codecs need
      `worker.rollupOptions.output.inlineDynamicImports` in
      `vite.config.lib.ts` or the inlined worker code-splits into chunks it has
      nowhere to fetch.

      Not addressed here, by design: the GPU upload stays on the render thread
      (it cannot move, and it was 1.5 percent of the problem), and a pool moves
      the decode without avoiding it, so the 15x to 39x byte amplification in
      `docs/caching.md` 2.5 is stage D's target.

## Caching and prefetch

Full comparison against Neuroglancer, with the staged plan: **`docs/caching.md`**
(written for the 2026-08-26 discussion). The items it raises, shortest first:

- [x] Stale-drop and per-frame reprioritization in `ChunkResidencyManager`.
      DONE (`1a9d525d`). `_uploadQueue` was a plain FIFO that persisted across
      frames and was pruned only by `admit` and `remap`, so chunks requested for
      a viewport the user had already left still uploaded ahead of what was on
      screen. It is now a `Map` from chunk index to the frame the working set
      last asked for it: `requestUpload` re-stamps and reorders in O(1), the
      drain returns this frame's requests before older ones, and an entry
      unrequested for more than one frame is dropped rather than uploaded late
      (one frame of slack, because the pump is async). Same discipline `NVSlide`
      has always applied to tiles. `chunkStreamStats` reports a cumulative
      `staleDropped` on both backends so the win is measurable; the dandi-demo
      HUD shows it. The in-flight half folded into stage C as planned: the pool
      forwards an `AbortSignal` to the worker, which aborts the zarrita read on
      the wire rather than discarding the bytes on arrival.

- [x] Instrument fetch / decode / upload separately, before the worker work
      above. DONE (stage B). `src/volume/chunkTiming.ts` records five spans we
      own (`net`, `read`, `assemble`, `upload`, `gradient`), exposed as
      `nv.chunkTimingStats()` and shown in the dandi-demo HUD. Beside the phases
      it reports `mainThreadMs` (assemble + upload + gradient, the work that
      blocks the render loop) and `netBusyMs` (wall clock with a store read
      outstanding, as a union so concurrent reads are not counted twice). Slide
      tile uploads are timed too, in both `gl/slide.ts` and `wgpu/slide.ts`,
      because `NVSlide` reads planes through the same `fetchChunk`; divide each
      phase by its own `count`, never across phases.

      Decode is NOT reported. It runs inside zarrita and cannot be timed from
      outside, and `read - net - assemble` is not a bound in either direction
      because one `zarr.get` fans out to several concurrent store gets. The
      demo measures the effect instead, by accumulating rAF gaps over a 24 ms
      budget.

      Two findings beyond the decode result, both in `docs/caching.md` 2.5:
      we deliver 15x to 39x more store bytes than the bricks we build consume
      (a 2D plane still needs whole 3D chunks), and a repeat scrub over the same
      slice range appeared to get no reuse from the byte cache. The second one
      was wrong; the byte-cache item below records what the counters found.

- [x] Size the byte cache to the working set, or make its policy scan-resistant.
      Came out of stage B, and the answer is that neither is needed.
      `ByteLruCache` now counts hits, misses, admissions, oversize rejections
      and evictions, exposed as `source.byteCache.stats` and shown as a
      `byte cache` row in the dandi-demo HUD. Counting happens in `has`, the
      one gate `withByteCaching` consults before a read.

      Measured on live DANDI stores with a 512 MB budget: a full sweep of all
      561 OCT planes and back settled at 265 MiB resident with ZERO evictions,
      and the return leg was 168 lookups for 168 hits; a HiP-CT (1 TB) session
      settled at 328 MiB, also with zero evictions, at a 51% hit rate. Nothing
      was ever evicted or rejected in any pattern tried, because the
      store-level working set is bounded by what is on screen times the levels
      in play, not by the size of the dataset.

      The stage-B claim came from reading `net` bytes as bytes downloaded.
      `withChunkTiming` wraps the store OUTSIDE `withByteCaching`, so `net`
      counts reads the cache answered too: HiP-CT delivered 1154 MB through a
      cache holding 328 MiB precisely because half of those gets were hits. A
      delivered total above the budget is evidence of reuse, not of thrash.
      Details in `docs/caching.md` 2.6.

- [x] Directional prefetch for slice scrolling and zoom. `CHUNK_PREFETCH_WINDOW`
      is pipeline lookahead over chunks we have already decided we need, not
      prediction. `src/volume/chunkPrediction.ts` now tracks the working-set
      centroid in chunk-grid coordinates, smooths it, extrapolates three frames,
      and fetches the same footprint translated by the resulting whole-chunk
      step. One mechanism covers scrub and pan, it needs nothing from the camera
      plumbing, and both renderers call it the same way. Predicted chunks are
      fetched and never made resident, speculative reads are capped below the
      per-uploader prefetch limit, and only one flight of guesses is outstanding
      at a time, so speculation can never delay or evict a visible chunk.

      Two behaviours the obvious implementation gets wrong, both found in the
      browser rather than in tests: velocity must be held across the idle frames
      between discrete wheel steps (otherwise prediction only fires during a
      continuous drag), and an empty prediction must leave standing guesses
      alone (otherwise the first idle frame cancels the reads the scrub just
      started). Guesses are dropped on arrival without cancelling and cancelled
      only on a turn.

      Follow-up: the dandi demo cannot easily show this working, because
      `budgetPlan: 'focus'` sizes the plan to the byte budget and most datasets
      end up entirely resident, so the centroid never moves. A live
      `predicted > 0` reading needs a store whose plan exceeds the residency
      budget navigated at a fine level. Worth a dedicated demo preset before
      stage E is measured.

      Not yet predicted: crossing a level boundary during a zoom. The plan swap
      resets the predictor, which is correct but conservative.

- [x] Demote on eviction instead of destroying. An evicted brick used to cost a
      full fetch + decode + upload to bring back; `src/volume/decodedChunkCache.ts`
      holds its decoded source bytes so the return is a re-upload. With the byte
      cache already avoiding most of the network (see `caching.md` 2.6), the
      decode is what this saves.

      The plan said "holding only evicted chunks", which is not implementable:
      to have an evicted chunk's bytes you must still hold them when it is
      evicted, so the tier necessarily shadows the resident set. It is
      affordable because a resident chunk is 8 bytes per voxel on the GPU
      (RGBA8 color + RGBA8 gradient) against 1 to 4 on the CPU, so
      `decodedTierBudgetBytes` sizes the tier at that shadow plus a 50% tail,
      scaled by the source datatype and capped at 384 MiB. Eviction is plain
      LRU: the newest entries are the chunks still resident and the oldest are
      the chunks evicted longest ago, so dropping from the old end keeps exactly
      the frontier a reversal crosses back over.

      The tier belongs to the renderer's cache entry, not the uploader, so it
      also turns a colormap or window change from a full re-fetch into a
      re-upload (only the orient output depends on those), and it is re-keyed
      through a multi-LOD plan swap by the same content match the residency
      manager uses.

      Still to measure: the same demo-preset gap as stage D above. A store whose
      plan exceeds the residency budget is needed before the `decoded tier` HUD
      row reads anything but 0 hits.

- [x] Persistent cross-session cache (Cache Storage). Every in-memory tier dies
      on reload, so `persistentByteCache.ts` holds RAW compressed store bytes
      below the byte LRU and above the fetch store: format-agnostic, keyed by
      the store key, and the smallest form a chunk has. Cache Storage bounds
      nothing, so our in-memory index is the budget -- each entry's byte length
      rides in its backing key, and one `keys()` listing rebuilds the index and
      the accounting without reading a body. Absences are deliberately NOT
      persisted (a missing chunk can become bytes tomorrow; bytes cannot
      change). Under the worker pool each worker owns a scope of one shared
      backing, which routing determinism makes a partition rather than a
      collision. Off by default -- it writes to the user's disk -- with the
      DANDI demo opting in at 512 MB and reporting the warm-start rate.

      Still open: an OPFS backing (the four-method `PersistentCacheBacking`
      interface exists for it), and persisting the decoded tier rather than the
      compressed one for stores whose codec is expensive.

- [x] Keep the previous resolution on screen while a finer level loads
      (NVSlide). `visibleTiles` now returns a `fallback` list of already-cached
      tiles from coarser levels covering the same viewport, coarsest first; both
      slide renderers paint it under the target level and skip the placeholder
      quad for any target tile still loading. Nothing is fetched for the fallback
      layer, and it is empty once every target tile is cached, so a settled view
      pays nothing. The volume path's equivalent is the coarse floor, which
      already exists. Not yet applied to the 3D slide-plane renderers, which
      drive visibility from world geometry via `requestTile`.

## Budget plans

- [ ] Give the planner named **budget plans** rather than one crosshair-focused
      policy with a byte budget.

  Full design and staging: **`docs/budget-plans.md`**. In short: today's single
  policy is right for interactive exploration, wrong for a static whole-volume
  figure (which wants the finest UNIFORM level that fits) and wrong for smooth
  rotation (which wants a frame-time budget, since bytes do not predict draw
  cost). Presets `'focus'` / `'uniform'` / `'interactive'`, staged so the first
  two are near-free and only `'interactive'` needs a new cost model.

  Sequenced AFTER the visual-artifact work below.

## Carried over from the LOD compensation work

- [x] Level-grid texture misregistration in `chunkUniformsFor`
      (`src/gl/render.ts`, `src/wgpu/render.ts`) and `chunkSampleTransform`
      (`src/volume/chunking.ts`). FIXED: `chunkOwnedTexBox` in `chunking.ts` is
      now the single source for the texture remap in all three call sites, and
      it maps the brick's OWNED common-grid box rather than the fetched box
      that `emitBrick` snaps out to whole level voxels. On the real hoa_heart
      pyramid this moved brick content by up to 3.4 / 6.3 / 8.7 common voxels at
      L2 / L3 / L4 and corrected a stretch of up to 5.9 / 12.4 / 23.7. A
      single-level plan is bit-identical to before. This was NOT the cause of
      the block seams (that was `lodGammaExponent`, fixed in `63e7df5d`).

- [ ] Residual LOD seams. At the refitted default (`0.08`) the measured step
      across a level boundary is about -10% on `hoa_heart`, down from +36%. No
      single coefficient nulls every dataset (sparse thin material wants ~0.11,
      dense structure ~0.05), so closing the rest is structural: either
      cross-LOD blending at brick faces (tracked as deferred in
      `FEATURE_PARITY.md`) or publishing a coverage-preserving pyramid. The
      max/mean blend prototype (0.85 max) landed every measured region within
      4% at every level and is the stronger lead.

## Two-panel block inspector demo

- [x] A demo with two side-by-side panels for looking INSIDE one LOD brick.

  Left panel: `hoa_heart` at a coarse level (L3 or L4) with the explode factor
  above 1, so the brick lattice is visible and individually pickable. The user
  clicks a brick.

  Right panel: that same brick re-rendered on its own, but built from the L0
  chunks that tile it, loaded as a separate `NVImage`. So the left panel shows
  where the brick sits in the whole heart at the level the streamer actually
  chose, and the right shows the finest data underneath it.

  What it is for: this is the direct visual test for exactly the class of bug
  `chunkOwnedTexBox` just fixed. A registration or reconstruction error inside a
  single brick is nearly invisible in the full render and obvious when the
  coarse brick and its L0 constituents sit side by side. It also gives the
  pyramid-coverage work (the max/mean blend) a way to compare a coarse brick
  against its own fine data directly rather than through a whole-volume
  difference.

  Notes for whoever builds it: brick picking needs a ray test against the
  exploded brick boxes (the plan already has every box in common-grid coords);
  the right panel needs the set of L0 chunks covering one brick's common box,
  which is a `chunkVolumeGrid` over that sub-box against level 0; both panels
  must work on both backends.

  Built, in two halves. `examples/vox.block.pick.html` does the picking half
  against a CPU-resident NIfTI: `pickExplodedBlock` ray-tests the exploded brick
  boxes and `extractChunkBlock` copies the picked brick out as a standalone
  volume that keeps the parent's anatomy.

  `examples/vox.block.pick.zarr.html` does the multi-LOD half against
  `hoa_heart` streamed from the public store, which is the part that tests
  `chunkOwnedTexBox`. A streamed volume holds its voxels in GPU brick textures,
  so `extractSubVolume` returns null for one and the right panel cannot be built
  by copying out of `img`. It instead opens a SECOND streamed volume over the
  same store, cropped to the picked brick's common-grid box, and lets that
  volume's own octree pull the crop down toward level 0 near its crosshair. Two
  details are worth carrying into any similar work:

  - A brick is already one texture's worth of data AT ITS OWN LEVEL, so
    re-fetching it at that level buys nothing. The detail comes from the crop
    source's finest levels, which is why the right panel is a fresh
    `loadChunkedVolume` over a cropped `ChunkedVolumeSource` rather than a
    re-request of the picked brick.
  - Picking needed a core change. `pickExplodedDraw` sampled the parent's CPU
    `img` to find the first voxel above threshold along the ray; a streamed
    volume has no `img`, so every pick landed on the brick's box face. It now
    falls back to `vol.pickSampler` (mm-space, backed by the coarse floor) when
    `img` is absent. That lives in `control/`, so both backends get it.

## OME-Zarr world origin never reaches the volume affine

- [ ] Thread the OME-NGFF `translation` through to the streamed volume's affine.

  OME-NGFF's equivalent of a NIfTI sform/qform is the per-dataset
  `coordinateTransformations` list, which carries a `scale` and a `translation`.
  `src/volume/omeZarr.ts` already parses BOTH, but only the scale survives the
  trip to a volume:

  - `omeZarrChannelFile` / `channelVolumeFile` (`src/volume/omeZarrLoader.ts`)
    build an explicitly origin-centred volume.
  - `ChunkedVolumeLevel` (`src/volume/ChunkedVolumeSource.ts`) carries
    `level` / `shape` / `spacing` and has no origin field.
  - `createStreamingNVImage` (`src/volume/streamingVolume.ts`) builds
    `affine = diag(spacing)`, pinning the origin at voxel `[0,0,0]`.

  So an OME-Zarr volume's mm coordinates are relative to its own corner, not to
  the world origin the store declares. Anything that reasons in anatomical mm is
  affected: the crosshair readout, cross-store alignment, and in particular
  `extractSubVolume` (`src/volume/ChunkExtract.ts`), which inherits the parent's
  `matRAS` verbatim. For a NIfTI parent that means the extracted block reports
  true anatomical mm; for an OME-Zarr parent it means the block faithfully
  reproduces an affine that was already missing its world origin. See
  `examples/vox.block.pick.html`, which demonstrates the NIfTI case.

  Measured on `hoa_heart` (2026-08, all 7 levels): every dataset's
  `translation` is exactly half its own `scale` -- e.g. L5 has scale
  `[224.416, 224.416, 224.416]` um and translation `[112.208, 112.208,
  112.208]`. That is the OME-NGFF voxel-CENTRE convention, not a world origin:
  every level is corner-aligned at world 0, so what NiiVue drops for this store
  is a uniform half-voxel shift with NO inter-level misregistration. The gap
  still matters for any store that declares a real world origin (or per-level
  translations that are not a pure centre offset), and it is worth fixing for
  the half-voxel alone, but it is not the cause of any brick-alignment artifact
  seen so far. `examples/vox.block.pick.zarr.html` prints each level's `scale`,
  `translation`, and their ratio so the convention is visible in the demo.

  Shape of the fix: add an optional per-level `originMM` (or a full affine) to
  `ChunkedVolumeLevel`, populate it from the parsed `translation` in the
  OME-Zarr loader path, and have `createStreamingNVImage` write it into the
  affine's translation column instead of leaving it at zero. Levels declare
  their own translation in NGFF, so the coarse levels must not be assumed to
  share level 0's origin. Unit-testable end to end (no GPU needed): parse a
  fixture `.zattrs`, build the streaming NVImage, assert `matRAS[3,7,11]`.
