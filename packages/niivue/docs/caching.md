# Caching and Prefetch

What NiiVue caches today when it streams a remote pyramid, where Neuroglancer
is ahead of us, and the order we should close the gap. Written for the
2026-08-26 discussion following Stephan Bollmann's DANDI demo, where Daniel
Haehn raised caching and Chris Rorden pointed at Neuroglancer's predictive
caching.

**If you want the reference rather than the history, read
`caching-architecture.md`:** what each tier holds today, how the scheduling
around them works, a comparison table against Neuroglancer, and the designs we
tried and rejected. This doc is the record of how we got there.

Companion docs: `caching-architecture.md` (how caching works today),
`high-res-streaming.md` (how the chunked path works),
`budget-plans.md` (how a plan chooses which bricks to want),
`parity-neuroglancer-napari.md` (the wider feature comparison),
`streaming-todos.md` (the open work list this doc feeds).

**Status:** Every stage has landed (A through G, 2026-08-25), and the branch
is pushed. Sections 2.2 through 2.9 and the stage table below describe what
changed. Four of those sections are measurements rather than designs: 2.5 is
the answer to the question this doc was written to ask and it moved two items
up the list, 2.6 retires stage G (the byte cache was already sized correctly,
and the finding that said otherwise misread 2.5's numbers), 2.7 shows the
main-thread stall gone, and 2.9 puts a number on the warm start.

## 1. What we cache today

Two independent stacks, because a streamed volume and a deep-zoom slide are
different resources. Both are byte-budgeted LRUs; neither is persistent.

### Volume path (`loadChunkedVolume`)

| Tier | Holds | Where | Default budget |
|---|---|---|---|
| Store bytes | RAW compressed store responses, keyed by store path | `ByteLruCache` behind zarrita's `withByteCaching` (`volume/omeZarrChunkedSource.ts`) | 256 MB (`OME_ZARR_CHUNK_CACHE_BYTES`); dandi-demo raises it to 512 MB |
| GPU bricks | Uploaded 3D brick textures | `ChunkResidencyManager` (`volume/ChunkResidency.ts`) | 1.5 GB (`DEFAULT_CHUNK_RESIDENCY_BYTES`) |
| Coarse floor | The coarsest pyramid level as ONE whole-volume texture | `gl/render.ts`, `wgpu/render.ts` | always resident |

The residency LRU stamps recency from the per-frame working set
(`requestUpload`), never evicts a chunk touched in the current frame, and
cross-fades a newly admitted brick in over the coarse floor across
`chunkFadeMs` (120 ms). The pump uploads under an 8 ms per-frame budget capped
at 24 chunks, and peeks 16 chunks ahead (`CHUNK_PREFETCH_WINDOW`) to start
their source fetches in parallel with the serial upload.

Note the coarse floor is already the volume-side answer to "do not clear the
low resolution until the high resolution is ready". Nothing ever renders a
hole; the worst case is coarse data.

### Slide path (`NVSlide`)

| Tier | Holds | Where | Default budget |
|---|---|---|---|
| Decoded tiles | `ImageBitmap` per tile, accounted in decoded RGBA bytes | `NVSlideTileCache` (`slide/NVSlide.ts`) | 96 MB; dandi-demo raises it to 192 MB |
| GPU tiles | One 2D texture per tile key | `TileTextureCache` (`slide/tileTextureCache.ts`) | 128 MB per renderer |

The slide path already has the queue discipline the volume path lacks: the
load queue drains LIFO (`pop`, not `shift`) and every dequeued tile is checked
against the `_wanted` set first, so a tile queued for a viewport the user has
already left is DROPPED rather than fetched. Under a fast pan that is the
difference between fetching what is on screen and fetching where the user was
half a second ago.

As of `b245524e` it also keeps the previous resolution on screen: a zoom that
selects a finer level draws the already-cached coarser tiles underneath while
the fine tiles arrive, instead of flat placeholder quads.

## 2. Where Neuroglancer is ahead

Neuroglancer's chunk manager is the reference implementation here. Four
differences matter, roughly in descending order of what a user would feel.

### 2.1 Fetch and decode run on a worker (DONE, stage C)

Neuroglancer does fetch, decompress, and dtype conversion on a chunk worker; the
main thread does little more than GPU upload. We used to do all of it on the main
thread, and it was the single largest cost in the streaming path.

Stage B measured it rather than assuming it, in case most of the stall turned out
to be `texSubImage3D` rather than decode. It is not. Section 2.5 has the numbers:
on a 20 second streaming window the render loop lost 8.6 seconds over a 24 ms
budget, and 125 ms of that was texture upload. Everything else ran between the
store read and our assemble loop, which is the zarrita decode.

Stage C moved it. `fetchOmeZarrChunkedSource` now opens the store on the calling
thread for its metadata and then puts every chunk read on a small pool of
workers:

- `src/workers/omeZarrChunk.worker.ts` opens its OWN view of the store (a zarrita
  array is not structured-cloneable) through the same `openOmeZarrChunkedSource`
  the main thread uses, so the worker is not a reimplementation of the read path.
  It runs store `get`, decompress, dtype convert, and our transpose / zero-pad
  assemble, then transfers the finished `Uint8Array` back.
- `src/volume/omeZarrChunkWorkerPool.ts` routes a request by hashing its region
  (level, texture origin, texture dims) rather than picking the idlest worker.
  Each worker keeps its own byte LRU, so a revisited brick has to come back to
  the worker that already holds its bytes. Sizing is half the reported cores,
  clamped to `[1, 4]`; these reads are network-bound, several are already
  outstanding per worker, and each extra worker costs another store open and
  another slice of the byte budget.
- Timing survives the move. Each worker reports a CUMULATIVE
  `ChunkTimingSnapshot`; the pool diffs it against what it last merged and folds
  the delta into a module-level off-thread total, so `mainThreadMs` now reports
  only what still blocks the render loop and a new `offThreadMs` reports what was
  moved. `netBusyMs` is a union per recorder, so the merged figure is an upper
  bound with a pool running and exact with one worker or none.
- `createSourceChunkLoader` still presents the residency manager with one
  `VolumeChunkSource` contract and the same concurrency, retry and dedup wrapper,
  and it now carries the in-flight cancellation stage A left open. A chunk the
  working set stops asking for is dropped from the queue, and that drop reaches
  the uploader, the loader, the pool, the worker and finally zarrita's own
  `signal`, so the read is abandoned on the wire instead of discarded on
  arrival. Because several chunk indices can share one region, the loader counts
  waiters and only aborts when the last one withdraws.

A worker failure is not automatically fatal: the caller still holds a main-thread
source. Only failures a re-run would repeat come back marked final
(`OmeZarrChunkError` for a missing store or an undecodable region, `AbortError`
for a cancelled read), and those are rethrown rather than paid for twice. A pool
that has been disposed reports as an abort too: a read that outlives the volume
it belongs to must not be "recovered" by fetching the same bytes on the main
thread for a view that is gone.

Two build details are load-bearing and easy to undo by accident. The module that
knows about the pool must stay OUTSIDE anything the worker imports, which is why
`fetchOmeZarrChunkedSource` lives in its own file and the worker imports only the
pool-free `openOmeZarrChunkedSource`. And zarrita loads its blosc / lz4 / zstd
codecs through dynamic imports, which would split the worker bundle into chunks
that an inlined worker has nowhere to fetch from, so `vite.config.lib.ts` sets
`worker.rollupOptions.output.inlineDynamicImports`. The pool itself is imported
on demand, so the megabyte-scale inlined worker is only downloaded by a caller
who actually streams chunks.

Section 2.7 has the result.

### 2.2 Priority tiers and a queue that is rebuilt every frame

Neuroglancer assigns each chunk a priority tier (visible vs prefetch) plus a
numeric priority, recomputes them as the view changes, and keeps sorted queues
per tier with separate capacity limits for download, system memory, and GPU
memory.

This was our largest gap and it is now closed (Stage A). `_uploadQueue` used
to be a plain FIFO array: `orderByViewCenter` sorted the working set nicely
WITHIN one frame, but the queue persisted ACROSS frames and was pruned only by
`admit` (one index) and `remap` (clears it). Nothing dropped a queued chunk
that was no longer wanted, so a rotate or a pan filled the queue with chunks
for viewports we had left and they uploaded ahead of what was on screen.

It is now a `Map` from chunk index to the frame the working set last asked for
that chunk. Each `requestUpload` re-stamps the entry and moves it to this
frame's request position (delete-then-set reorders a `Map` in O(1), so a
re-request costs nothing), the drain returns this frame's requests before any
older ones, and an entry unrequested for longer than one frame is dropped
instead of uploaded late. The slack is one frame rather than zero because the
pump is async and a frame boundary can land between `beginFrame` and the draw
that re-requests; a 60 fps pan outruns one frame anyway.

Two things fall out of it for free. A drag already pauses the pump while draws
keep stamping requests, so at pointerup the queue holds the final viewport's
working set instead of the whole drag path. And `chunkStreamStats` now reports
a cumulative `staleDropped`, which is a direct readout of upload work the old
queue would have spent on viewports the user had already left: 84 retired
requests over one slice scrub of DANDI 000722. The dandi-demo HUD shows it on
a queue row.

We still do not have Neuroglancer's explicit priority TIERS (visible vs
prefetch, with separate download / system-memory / GPU-memory capacities).
What we have is a single queue that is correctly ordered by the current view,
which is most of what tiers buy at our scale.

Related: a chunk fetch that is already in flight cannot be cancelled either.
`parity-neuroglancer-napari.md` records stale-request cancellation as partial,
present for desktop thumbnails and absent on the volume chunk path. Dropping a
queued request is most of the win, since the queue is where the backlog builds,
but an `AbortController` on the in-flight fetches is the other half.

The shape of the fix was NVSlide's `_wanted` discipline ported down into
`ChunkResidencyManager`: pure CPU bookkeeping, unit-tested with no GPU, and it
landed in both backends at once because the manager is shared.

### 2.3 Eviction demotes; ours destroyed (DONE, stage E)

In Neuroglancer a chunk evicted from GPU memory falls back to system memory
rather than disappearing, so bringing it back is a re-upload. For us, eviction
called `destroy` and the brick was gone: showing it again cost fetch, decode,
AND upload. The only thing that survived was its compressed bytes in the store
LRU, and only if they had not been evicted there too.

Stage E adds the tier (`src/volume/decodedChunkCache.ts`). It holds the DECODED
source bytes for a chunk, exactly what the uploader's `fetchBytes` returns, so a
hit costs a texture upload and nothing else. Given 2.6, where the byte cache
already avoids most of the network, the decode is the part this actually saves,
and 2.5 measured the decode as the expensive part.

Designing it corrected the plan this doc originally carried. "Hold only chunks
evicted from GPU, not every chunk ever decoded" is not implementable: to have an
evicted chunk's bytes you must still be holding them at the moment of eviction,
which means holding them throughout its GPU residency. A tier that drops a
chunk's bytes on upload has nothing left to demote later. So the tier shadows
the resident set by construction, and the honest question is not how to avoid
the shadow but what it costs.

It costs less than the framing suggested, because a chunk is much narrower on
the CPU than on the GPU. A resident chunk carries an RGBA8 color texture plus an
RGBA8 gradient, 8 bytes per voxel; its source is 1 to 4. Shadowing the whole
resident set is therefore an eighth to a half of the GPU budget in JS heap, so
`decodedTierBudgetBytes` sizes the tier at that shadow plus a 50% tail, capped
at 384 MiB. The size tracks the datatype rather than being a flat fraction of
the GPU budget, since a uint8 volume shadows for an eighth of what a float32
volume costs. The tail is the part that pays: it is what a scrub finds when it
turns around.

Eviction is plain LRU, which is what that structure wants. The newest entries
are the chunks still on the GPU, whose copies cost nothing to lose, and the
oldest are the chunks evicted longest ago, which a reversal reaches last. So
dropping from the old end keeps precisely the frontier the view is about to
cross back over, and the reversal depth the tier buys is its slot count minus
the GPU's.

One win fell out of where the tier lives. It is owned by the renderer's cache
entry rather than the uploader, because it holds SOURCE bytes and only the
orient output depends on the colormap and window. A colormap or window change
rebuilds the uploader and re-streams every chunk; that re-stream is now uploads
rather than fetches. A multi-LOD plan swap re-keys the tier with the same
`matchChunksByContent` map the residency manager uses, so a refocus back to a
level finds its bricks.

The HUD gains a `decoded tier` row next to `byte cache`, and
`chunkStreamStats().decoded` carries the counters.

### 2.4 Prefetch is predictive, ours is pipeline lookahead (DONE, stage D)

`CHUNK_PREFETCH_WINDOW` is not prediction. It looks 16 entries into a queue we
have already decided we need, purely so the fetch pipe stays full ahead of the
serial upload. Neuroglancer extrapolates the navigation state and requests
chunks for where the view is GOING, at a priority tier that can never evict or
delay a visible chunk.

Stage D adds that. It measures travel in the one space both backends already
share, the chunk grid. Each frame the view hands its working set (the chunks it
just asked to have resident) to a `ChunkTravelPredictor`
(`src/volume/chunkPrediction.ts`). The centroid of that set moves when the view
moves: a slice scrub marches it along the slice axis, a pan slides it across the
plane. The predictor smooths that motion, extrapolates three frames forward, and
returns the same footprint translated by the resulting whole-chunk step, which
is the next slabs along a scrub or the tiles about to arrive at the leading edge
of a pan. One mechanism therefore covers both of the interactions listed below
without a general framework, and it needs nothing from the camera plumbing,
which is why it lands identically on `gl/render.ts` and `wgpu/render.ts`.

- Slice scrolling: the centroid marches along one axis, so the predicted step is
  the next slabs in the direction of travel.
- Pan and 2D zoom: the centroid slides across the plane, so the predicted step is
  the leading edge. Crossing a level boundary is not yet predicted; the plan swap
  resets the predictor, which is correct but conservative.

Camera-orbit prediction is still not built, and still should not be first.

Three properties keep speculation subordinate to what the view can actually see:

- Predicted chunks are FETCHED, never made resident. They never enter the
  residency queue, never stamp the eviction clock, and can never delay a visible
  chunk. That is our version of Neuroglancer's priority tier.
- Speculative reads are capped below the per-uploader prefetch limit
  (`MAX_PREFETCHED_CHUNKS - PREFETCH_SLOTS_RESERVED`), so real reads always have
  slots.
- At most one flight of guesses is outstanding (`CHUNK_PREDICT_WINDOW`, 4). New
  reads start only as the view consumes standing ones, so a drag cannot cancel
  and restart speculation on every frame.

Two behaviours are worth recording because the obvious implementation gets them
wrong, and browser testing rather than unit testing is what exposed both.

Travel is measured per MOVE, not per frame. Interaction is bursty: a wheel step
lands in one frame and the next comes thirty frames later. Decaying the velocity
on the idle frames means prediction only ever fires during a continuous drag,
which is the one case that needs it least, so a still frame holds the velocity
instead.

An empty prediction leaves standing guesses alone. Releasing them on the first
idle frame cancels exactly the reads a discrete scrub had just started for its
next step. Guesses are dropped when the view arrives at them (without
cancelling, since by then the read belongs to the pump), and cancelled only when
nothing standing lies on the new heading, which is the definition of a turn.

Observability: `chunkStreamStats()` gained a cumulative `predicted` count,
surfaced as a `prefetch` row in the dandi demo HUD. The payoff shows up in the
source's byte-cache hit rate rather than in residency, since a predicted chunk
is a byte-cache entry until the view asks for it.

Honest limitation on verification: in the dandi demo the working set rarely
travels by a whole chunk. `budgetPlan: 'focus'` sizes the plan to the byte
budget, so most of its datasets end up entirely resident and the centroid never
moves, and on a coarse level a single wheel step is a small fraction of a chunk.
The prediction is unit-tested (16 cases in `chunkPrediction.test.ts`, covering
scrub, reversal, burst-with-idle-frames, pan, jump, cap and reset), but a live
`predicted > 0` reading needs a store whose plan exceeds the residency budget
being navigated at a fine level. That is a demo gap, not a feature gap, and it
is the first thing to fix when stage E is measured.

### 2.5 Measured: where the time actually goes

Stage B added a per-phase recorder (`src/volume/chunkTiming.ts`, exposed as
`nv.chunkTimingStats()`) that times five spans we own: `net` (one store `get`),
`read` (one whole `fetchChunk`), `assemble` (our transpose and zero-pad loop),
`upload` (building a texture, either a volume brick or an `NVSlide` tile), and
`gradient`. Two figures sit beside them, both exact rather than inferred:
`mainThreadMs` is `assemble + upload + gradient`, the streaming work that
actually blocks the render loop, and `netBusyMs` is wall clock with at least one
store read outstanding, counted as a union so overlapping reads do not
multiply-count the same seconds.

Decode is deliberately NOT reported. It happens inside zarrita, between the
store read and our assemble loop, and we cannot time it from outside. An earlier
draft reported `read - net - assemble` as a decode estimate; that is invalid,
because one `zarr.get` fans out to every store chunk covering the region, so
several `net` spans overlap inside a single `read` and the subtraction is not a
bound in either direction. It read as zero or negative in practice. The
replacement is to measure the effect instead: the demo accumulates rAF gaps over
a 24 ms budget, which catches main-thread time no matter which library spends
it.

All figures below are WebGL2 in Chrome against the live DANDI stores.

**HiP-CT (000026, roughly 1 TB, over S3), 20 second window, streaming only, no
interaction:**

| Figure | Value |
|---|---|
| Frames drawn | 1267 |
| Main-thread time lost over a 24 ms budget | 8604 ms |
| Worst single frame gap | 1052 ms |
| Instrumented main-thread work (`mainThreadMs`) | 125 ms |
| Brick reads / mean read | 187 / 822 ms |
| Store gets / mean get | 1955 / 189 ms |
| Store bytes delivered | 3340 MB |
| Network busy (union) | 10083 ms of 20006 ms |

The idle baseline over 400 frames with nothing streaming is 0 ms over budget, so
the 8.6 seconds is the streaming path and not a noisy machine.

Three things follow.

**Decode dominates the main thread, and upload is a rounding error.** Of 8.6
seconds of lost frame time, 125 ms is instrumented, and every instrumented
millisecond is texture upload. The remainder is un-instrumented main-thread work
inside the read path. This is the number Stage C has to beat, and the part a
decode worker cannot move (upload plus gradient) is 1.5 percent of it.

**We fetch and decode far more than we use.** On the smaller OCT store a 20
second window delivered 493 MB of store bytes to produce 33.9 MB of brick
voxels, and a slice scrub delivered 948 MB to produce 24.6 MB. That is 15x to
39x amplification, and it is structural rather than a bug: a 2D plane through a
3D-chunked store still requires whole 3D chunks, so the useful fraction is
bounded by one over the chunk depth. It also explains the decode cost directly,
since decode scales with bytes delivered rather than bytes displayed. Read
"delivered" strictly: `withChunkTiming` wraps the store outside the byte cache,
so these totals count reads the cache answered as well as reads that went to the
network. They are the right figure for decode cost, which is paid either way,
and an overstatement of network traffic. Stage G below measures the split.

**The byte cache looked like it was thrashing, and it is not.** An earlier
reading of these numbers concluded that a scan evicts the byte cache before it
can be reused, because one pass delivered roughly twice the 512 MB budget. That
inference was wrong, and the error is the one flagged above: `net` counts every
read the store serves, hits included, so a delivered total larger than the
budget is evidence of reuse rather than of eviction. Section 2.6 has the direct
measurement.

For contrast, the small OCT store over the same 20 seconds lost 316 ms with a
worst gap of 128 ms, against 493 MB delivered. Main-thread cost tracks bytes
delivered, not bricks drawn.

### 2.6 Measured: the byte cache is sized correctly

Stage G set out to size the byte cache to the working set, or failing that to
give it a scan-resistant policy. Before changing either, it needed to answer a
question the previous numbers could not: is the cache missing because the budget
is too small to hold the working set, or because this access pattern never
revisits a chunk? Both look identical from outside, both read as a low hit rate,
and they want opposite fixes.

Evictions tell them apart, so `ByteLruCache` now counts them, along with hits,
misses, admissions and oversize rejections. The counters are exposed as
`source.byteCache.stats` and the demo prints them as a `byte cache` HUD row.
Counting happens in `has`, which is the single gate `withByteCaching` consults
before every read; `get` runs only after a hit, so a lookup cannot be counted
twice.

WebGL2 in Chrome, live DANDI stores, 512 MB budget:

| | OCT, 4.5 GB | HiP-CT, 1 TB |
|---|---|---|
| Store gets | 733 | 737 |
| Bytes delivered | 415 MB | 1154 MB |
| Hits / misses | 183 / 550 | 376 / 361 |
| Hit rate | 25% | 51% |
| Resident at end | 265 MiB of 512 | 328 MiB of 512 |
| Evicted | 0 entries, 0 bytes | 0 entries, 0 bytes |
| Rejected as oversize | 0 | 0 |

The OCT session was a full sweep of all 561 axial planes and back again; the
HiP-CT session was a load plus a sweep across half of its 10656 planes. Neither
evicted a single entry.

Three conclusions.

**The budget is not the binding constraint.** Nothing was ever evicted, on
either store, in any pattern tried. The store-level working set is bounded by
what is on screen times the number of resolution levels in play, not by the size
of the dataset, which is why a 1 TB volume settles at 328 MiB just as a 4.5 GB
one settles at 265 MiB. There is no scan to be resistant to, and raising
`OME_ZARR_CHUNK_CACHE_BYTES` would buy nothing.

**Reuse is real when it is asked for.** The return leg of the OCT sweep, back
across planes the forward leg had already visited, was 168 lookups and 168 hits:
zero misses, zero new bytes, the whole pass served from memory. That is the
behaviour the earlier reading concluded was absent.

**The headline hit rate understates the cache** because it averages a cold first
pass into the total, and every miss in these sessions is a first touch. That
also says where the remaining wins are. Stage D (prefetch) attacks the cold
pass, which is where all the misses live. Stage F (a persistent tier) attacks
the fact that this cache dies with the page, so every reload starts cold again.
Neither is a byte-budget change.

Stage G therefore lands as instrumentation and no policy change. The counters
stay because they are what proved the point, and because they are the check to
re-run before anyone proposes a bigger budget.

### 2.7 Measured: stage C removed the stall

The check is deliberately the same one that condemned the main-thread path in
2.5: HiP-CT (000026, roughly 1 TB, over S3), WebGL2 in Chrome, tab foregrounded,
streaming with no interaction, rAF gaps accumulated over a 24 ms budget.

| Figure | Stage B (main thread) | Stage C (worker pool) |
|---|---|---|
| Main-thread time lost over a 24 ms budget | 8604 ms | none |
| Worst single frame gap | 1052 ms | none over budget |
| Streaming work accounted for off-thread | 0 ms | 1898 ms, 100% |

The stall is gone rather than reduced: over the measured window not one frame
went over budget, against 8.6 seconds of lost frame time before. Every
millisecond of instrumented streaming work now lands in `offThreadMs`, and the
`workers` HUD row in the DANDI demo reports the share so a regression that
silently falls back to the main thread is visible rather than merely slow.

A slice-scrub on the smaller OCT store (000722, 4.5 GB), which is the more
interactive pattern, agrees: roughly 40 seconds of scrubbing left 2 ms of
main-thread streaming cost in total and 1 ms over budget across the whole
session, with 9874 ms accounted for off-thread.

Two caveats worth stating out loud. The GPU upload cannot move and did not: it
is still on the render thread, and it was already only 1.5 percent of the
problem. And a worker pool does not reduce the bytes fetched or decoded, it only
stops them competing with drawing. The amplification measured in 2.5, 15x to 39x
between bytes delivered and voxels used, is untouched and is what stage D is
for.

### 2.8 Stage F: bytes that survive a reload (`persistentByteCache.ts`)

Every tier described above dies with the tab. A second visit to a DANDI volume
re-fetched what the first visit had already paid for, which for a store over S3
is the most expensive thing we do.

Stage F adds a tier that persists. Three decisions shaped it.

**What to persist, and where.** The tier holds RAW compressed store bytes and
sits BELOW the byte LRU and ABOVE the fetch store, so it only ever sees what
memory could not answer. That layer wins on three counts: it is format-agnostic
(one path for every codec and dtype, rather than one per decoded
representation), it is keyed by something already unique and stable (the store
key), and it is the smallest form a chunk has. Decoding again is cheap next to
the round trip, and the round trip is what is being bought back.

**Absences are not persisted.** The in-memory `ByteLruCache` remembers a
missing chunk, because within one load a missing chunk means fill value and
that answer cannot change. Across days it can: a store still being written
would otherwise carry its holes forever in a cache the user cannot see. Bytes
are content-addressed by definition; an absence is the one thing that can turn
into something else.

**The index is the budget.** Cache Storage has no size limit and no eviction
policy, so ours must be the authority. `PersistentByteCache` keeps an in-memory
insertion-ordered map from store identity to backing key, re-inserted on every
hit so iteration order is LRU-first, and each entry's byte length rides in the
backing key itself. One `keys()` listing therefore rebuilds both the index and
the byte accounting without reading a single body. Across a reload the recency
order is lost (a listing returns insertion order), so a cold start evicts
oldest-written first and warms into true LRU as entries are touched. A quota
error halves our budget rather than retrying into the same wall: our ceiling is
a policy, the browser's is not.

Everything is best effort. The browser may clear the bucket, a write may exceed
quota, a non-secure context has no Cache Storage at all. Every failure is
counted in the stats and every read falls through to the store.

With the worker pool running, each worker opens its own cache over the SAME
backing and owns a SCOPE of it, with the budget split across workers. That is
sound precisely because `routeChunkToWorker` hashes the region key: a brick
always returns to the worker that holds it, so the scopes partition the store
rather than shadowing it. A worker leaves a sibling's keys alone and deletes
only what belongs to no current scope, which is what the leftovers of a
differently sized pool look like.

The tier is OFF by default, because it writes to the user's disk and that
should be the application's call. The DANDI demo opts in with 512 MB and
reports the warm-start rate in its HUD; `clearPersistentByteCaches()` empties
it. All browser contact is confined to a four-method backing interface, so the
cache logic is unit-tested under Bun (which has no `caches`) and an OPFS
implementation would need no change to it.

### 2.9 Measured: what a warm start buys, and what nearly broke it

Same instrument as 2.6 and 2.7, smaller store: the DANDI demo's default block
(000722 OCT, 106 MB, over S3), WebGL2 in Chrome, four chunk workers, 512 MB
persistent budget, 25 seconds of streaming with no interaction.

| Figure | Cold (cache deleted) | Warm (reload) |
|---|---|---|
| Persistent hit rate | 0% of 26 lookups | 85% of 26 lookups |
| Entries written | 22 | 0 |
| Bytes on disk after the run | 1.0 MB | 1.0 MB, unchanged |

The 15% that still missed are the misses that cannot be served: the first
lookups of the run race the writes of the same chunks, and one level's
metadata is fetched before any chunk key exists. Nothing was re-fetched that
had been paid for before.

The interesting part is what the numbers looked like BEFORE the fix. The unit
tests all passed, the built bundle contained the scoping code, and the hit rate
was still respectable, because an unscoped cache is not a broken cache: every
worker simply adopted every key. What gave it away was reading the keys
themselves in Chrome, where all 22 sat under no scope at all instead of
splitting across `w0/` and `w3/`. The cause was one layer above the cache:
`openPersistTier` picked `maxBytes` and `name` out of its options and dropped
the rest, so `scope` never reached the constructor (`eb661670`). The cost of
leaving it in would have been paid only on a warm start with a full cache, when
each of four workers would have evicted the pool down to its own quarter share
and thrown away three quarters of the disk it had filled.

Two lessons worth keeping. A unit test cannot see an options field that is
never forwarded, because both sides of the boundary are correct in isolation;
the assertion that catches it has to be on the artifact the system actually
produced, which here is the key. And a cache whose only symptom is a
lower-than-necessary hit rate is a bug that hides well, so the stats worth
exposing are the ones that would have to be a specific shape if the design were
working, not just the ones that go up when it is.

## 3. What we should say tomorrow

We are not starting from nothing, and as of this week we are not mid-list
either. The four gaps this doc opened with have all closed: the priority queue
(A), off-thread fetch and decode (C), real prediction (D), and demotion instead
of destruction (E), on top of the tiers we already had, byte budgets
everywhere, frame-accurate LRU protection, a coarse floor that means we never
draw a hole, and a stale-request discipline on the slide side that
Neuroglancer's design agrees with. Each of those was measured before and after
rather than asserted, which is what stage B bought.

The one number worth putting on a slide: streaming a HiP-CT volume from S3 for
20 seconds costs the render loop 8.6 seconds, and 125 ms of that is GPU upload.
The rest is decode on the main thread. That is the case for the worker, and it
is measured rather than asserted.

Two places we can be BETTER than Neuroglancer rather than catching up:

- **Persistence across sessions.** Every in-memory cache dies on reload. For
  DANDI over S3 the expensive part is the round trip, so stage F (2.8) added a
  Cache Storage tier under the byte LRU: a second visit to a dataset starts
  warm. Neuroglancer does not do this. It is the most visible thing we can
  offer a workshop audience clicking the same demo repeatedly.
- **The coarse floor.** A whole-volume coarsest level pinned resident is a
  cheap guarantee that the screen is never empty, and it composes with
  everything above.

## 4. Proposed order

| Stage | Work | Cost | Why here |
|---|---|---|---|
| A | DONE (`1a9d525d`) Stale-drop + per-frame reprioritization in `ChunkResidencyManager` | small | Pure CPU, shared by both backends, testable without a GPU, fixes a felt problem |
| B | DONE Per-phase timing (`chunkTimingStats`) plus a main-thread stall monitor in the demo | small | Turned stage C from a guess into a measurement |
| G | DONE Hit / miss / eviction counters on `ByteLruCache`, exposed as `source.byteCache.stats` | small | Measured (2.6): zero evictions on a 1 TB store, so no budget or policy change was needed |
| C | DONE Worker pool for chunk fetch + decode (`omeZarrChunkWorkerPool.ts`, `workers/omeZarrChunk.worker.ts`) | medium | Measured (2.7): the 8.6 s of lost frame time is gone, 100% of streaming work is off-thread |
| D | DONE (`1281a74b`) Directional prefetch: travel of the working-set centroid, extrapolated and fetched ahead (`chunkPrediction.ts`) | small | One mechanism covers scrub and pan, no camera plumbing, identical on both backends |
| E | DONE Decoded-chunk demotion tier under GPU eviction (`decodedChunkCache.ts`) | medium | Makes eviction cheap to undo; sized off the GPU budget and the source datatype |
| F | DONE (`d6037b60`, `eb661670`) Persistent raw-byte cache in Cache Storage (`persistentByteCache.ts`) | medium | The differentiator; measured (2.9): a reload serves 85% of its lookups from disk |

A, B, G and C are done. A and B were the two that make every later stage
measurable, and B changed the order of what followed: G came straight out of the
measurement and turned out to need no policy change at all, while C was
confirmed as the big one and delivered accordingly. The in-flight half of A, an
`AbortController` on fetches already issued, folded into C as planned: the
worker pool owns the fetch, so a cancelled read is now aborted on the wire
rather than merely ignored on arrival.

D followed and attacked a cost C did not touch, since a worker pool moves the
decode but does not avoid it. Its one surprise was that the demo cannot easily
show it working: see the verification note at the end of 2.4.

E then removed the decode altogether for a brick the GPU had already seen, and
corrected the design this doc had sketched for it (2.3): the tier cannot hold
only evicted chunks, it must shadow the resident set, and the reason that is
affordable is the 8-bytes-on-GPU against 1-to-4-on-CPU ratio rather than any
cleverness about what to admit.

F closed the list, and it is the one stage that makes a difference the user
sees without measuring anything: the second visit to a dataset is faster than
the first. Its design is in 2.8 and its numbers are in 2.9; the short version
is that the persisted unit is raw store bytes, and our own index is the budget
because Cache Storage will not bound itself. It also produced the one bug in
the series that no test could have found, which 2.9 records.

## 5. Known gaps not covered above

- The 3D slide-plane renderer (`gl/slidePlaneRender.ts`,
  `wgpu/slidePlaneRender.ts`) drives its working set from world geometry via
  `requestTile` and does not use the new coarse fallback layer. Same fix
  applies, different visibility source.
- The slide fallback layer only walks COARSER levels. Zooming OUT to a level
  whose tiles are not cached still shows placeholders, even when finer tiles
  covering part of the view are resident. Lower value than the zoom-in case
  (the finer tiles only cover the middle of the new viewport) but it is the
  symmetric half of the same idea.
