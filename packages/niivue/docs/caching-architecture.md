# How NiiVue Caching Works

Reference for the caching and prefetch machinery in the streaming paths: what
each tier holds, what bounds it, who owns its lifetime, and how to watch it
work. It describes the code as it stands after the staged work of August 2026.

Companion docs. `caching.md` is the history: the plan, the stage table, and
the measurements that decided each stage, including the numbers quoted below.
`high-res-streaming.md` explains how the chunked volume path works end to end,
`budget-plans.md` how a plan decides which bricks to want, and
`parity-neuroglancer-napari.md` compares the wider feature surface.

## 1. The shape of the problem

A streamed pyramid is too large to hold, so every view is a working set that
the user moves. Each move asks for bricks or tiles the view does not have and
abandons ones it does. Caching is what keeps that movement from re-paying the
full cost of the round trip, the codec, and the upload every time.

The costs are not equal, so neither are the tiers. Measured on a 1 TB HiP-CT
store over S3, a brick read averaged 189 ms of network per store get against
125 ms of GPU upload across a whole 20 second window. Bytes are expensive,
decode is expensive, upload is nearly free. Every tier below exists because it
removes one of those, and the ones that remove the network sit furthest out.

## 2. Volume path

Five tiers, listed in the order a read consults them. The first four are ours;
the last is the browser's and we simply do not defeat it.

| Tier | Holds | Keyed by | Budget | Lifetime | Code |
|---|---|---|---|---|---|
| GPU bricks | Uploaded 3D textures, color plus gradient | Chunk index in the current plan | 1.5 GB planned, per volume | Render entry | `volume/ChunkResidency.ts` |
| Decoded chunks | Decoded source bytes, pre-orient | Chunk index in the current plan | `min(384 MB, shadow x 1.5)` | Render entry | `volume/decodedChunkCache.ts` |
| Store bytes | Raw compressed store responses, plus remembered absences | Store key | 256 MB, split across workers | Page | `omeZarrChunkedSource.ts` (`ByteLruCache`) |
| Disk bytes | The same raw store responses | Store key, scope-prefixed | 512 MB, opt-in, split across workers | Cross-session | `volume/persistentByteCache.ts` |
| HTTP cache | Whatever the server allowed | URL | Browser policy | Browser | not ours |

**GPU bricks.** A byte-budgeted LRU with a frame-accurate exemption: a chunk
the working set asked for since the last `beginFrame()` can never be evicted in
that frame, so a same-frame admit cannot drop what is about to be drawn. The
upload queue follows the same discipline. A queued chunk is re-stamped every
frame the view still wants it and dropped after one frame of not being asked
for (`STALE_REQUEST_FRAMES = 1`), which is what stops a pan from filling the
queue with viewports the user has already left.

**Decoded chunks.** The tier that makes an eviction cheap to undo: a hit turns
a brick's return into an upload alone, with no network, no codec, and no
multi-chunk assemble. It necessarily SHADOWS the resident set rather than
holding only evicted chunks (section 7 explains why that is not a choice), and
it is affordable because a chunk is 1 to 4 bytes per voxel on the CPU against 8
on the GPU. `decodedTierBudgetBytes` sizes it at that shadow plus a 50 percent
tail, and the tail is the part that pays: it is what a scrub finds when it
turns around. Eviction is plain LRU, which for this shape is exactly right,
since the newest entries are the chunks still on the GPU (free to lose) and the
oldest are the ones evicted longest ago.

**Store bytes.** An LRU under the zarrita store, so it sits below the codec and
above the network. It also remembers ABSENCES, because zarr treats a missing
chunk as fill value and a store is immutable for the life of a load, so a
sparse store's holes are not re-requested on every plan rebuild. Its counters
answer the question a byte budget always raises: many evictions and few hits is
thrash, few evictions and few hits means there was nothing to reuse. Measured
on the 1 TB store it was the second: 51 percent hits and zero evictions, so the
budget was already right and the stage that was going to resize it closed
without a policy change.

**Disk bytes.** The same raw bytes, in Cache Storage, so a second visit to a
dataset starts warm. It is opt-in because it writes to the user's disk. Three
rules define it. It persists bytes and not absences, since bytes are
content-addressed by definition while a chunk missing today can be bytes
tomorrow. Our in-memory index is the budget, because Cache Storage bounds
nothing and evicts nothing: each entry carries its byte length in its backing
key, so one `keys()` listing rebuilds the index and the accounting without
reading a body. And every failure is soft: a quota error halves our own budget
rather than retrying into the same wall, and any miss falls through to the
store. Measured on the demo's 106 MB block, a reload serves 85 percent of its
lookups from disk and writes nothing.

### Where the tiers live relative to each other

The store chain is built once per reading thread:

```
FetchStore -> withPersistentBytes -> withByteCaching -> withChunkTiming
```

so the persistent tier only ever sees what memory could not answer, and the
timing recorder sees everything. Above that, `fetchChunk` assembles the region
from store blocks; above that, the render entry consults the decoded tier
before it calls the source at all.

## 3. Slide path

A deep-zoom slide is a different resource, so it has its own stack.

| Tier | Holds | Budget | Code |
|---|---|---|---|
| Tile textures | Per-tile GPU textures | 128 MB per renderer | `slide/tileTextureCache.ts` |
| Decoded tiles | `ImageBitmap` per tile | 96 MB, counted as RGBA | `slide/NVSlide.ts` |
| HTTP cache | Range responses | Browser policy | not ours |

Tile textures are evicted once per frame, before `beginFrame()`, so the
previous frame's working set is exempt and a texture referenced by an
unsubmitted command encoder cannot be destroyed under it. That eviction pass
exists because a deep-zoom pan across a gigapixel slide used to ratchet GPU
memory up until the browser's GPU process was killed.

The decoded-tile cache counts RGBA bytes rather than the JPEG size, because
encoded accounting silently blew the budget. Above it sits the coarse fallback
layer: when the target level's tiles are not resident, the visible set is
returned with a layer of ALREADY-cached coarser tiles covering the same
viewport, ordered coarsest first, painted under the target tiles. It never
issues a fetch of its own. This is what makes a zoom fade in rather than flash
empty, and it is the slide-side equivalent of the volume path's coarse floor.

## 4. The scheduling around the caches

Caches decide what is kept. These four decide what is asked for.

**The coarse floor.** The coarsest pyramid level is fetched whole, oriented
into one texture and pinned as a backdrop under the streamed bricks, so the
screen is never empty and a missing brick degrades to blur rather than a hole.
It is skipped with a warning when the coarsest level is too large or its
datatype is unsupported.

**Working-set streaming with stale-drop.** The view hands the residency manager
the chunks it wants this frame; the manager admits, evicts and drains against
that set alone. There is no cross-frame FIFO to go stale.

**Prediction.** `ChunkTravelPredictor` watches the centroid of the working set
move in chunk-grid coordinates, smooths it, extrapolates three frames
(`LOOKAHEAD_FRAMES`), and proposes the same footprint translated by the
resulting whole-chunk step. That covers a scrub and a pan with one mechanism
and needs nothing from the camera plumbing, which is why it is identical on
both backends. It returns chunks to FETCH, never to make resident, and only
leftover fetch slots serve it (`CHUNK_PREDICT_WINDOW = 4`), so a guess can
never delay or evict something visible. A settled view predicts nothing, and so
does a jump larger than `JUMP_CHUNKS`, since a teleport is not travel.

**The worker pool.** Up to four chunk workers (half the reported cores, clamped
to one through four) each open the store themselves and hold their own share of
the byte and disk budgets. Requests route by HASHING the region key rather than
by picking the idlest worker, so a brick always returns to the worker that
already holds its bytes. An abort reaches the worker's own fetch, so a
cancelled read is cancelled on the wire. A worker failure falls back to the
calling thread only when the WORKER failed; a read that failed on its own terms
(a missing store, a region that will not decode) is marked final so the same
failure is not paid for twice.

## 5. Configuring and observing

Everything is per source, and the defaults are the ones in the tables above:

```ts
const source = await fetchOmeZarrChunkedSource(url, {
  cacheBytes: 256 * 2 ** 20,  // store-byte LRU, split across workers
  workers: 4,                 // 0 keeps every read on the calling thread
  persist: { maxBytes: 512 * 2 ** 20 },  // opt-in disk tier
})
```

What to read while it runs:

- `source.byteCacheStats()` and `source.persistStats()`: hits, misses,
  evictions, bytes, and for the disk tier writes and failures. Under a pool
  these are summed across workers.
- `chunkTimingSnapshot()` after `resetChunkTiming()`: per-phase totals for
  `net`, `read`, `assemble` and `upload`, plus `offThreadMs`, which is how you
  tell a silent fallback to main-thread reading from a fast one.
- The DANDI demo HUD reports all of the above live, including the share of
  streaming work that ran off-thread and the warm-start rate.

Two traps in reading those numbers. Divide each phase by its own count, since a
mean taken across two phases with different counts means nothing. And do not
derive decode time as `read - net - assemble`: one `zarr.get` fans out into
several concurrent store gets, so the phases overlap and the subtraction is not
a bound.

## 6. Compared with Neuroglancer

Neuroglancer is the reference implementation for this problem and was the
benchmark the staged work aimed at. The comparison below reflects its published
design (a chunk queue manager with tiered priorities, an explicit chunk state
machine split across frontend and backend, and separate GPU and system memory
capacities) rather than a line-by-line read of a pinned revision. Correct it if
you check the source.

| Concern | NiiVue | Neuroglancer |
|---|---|---|
| Fetch and decode location | Pool of up to four chunk workers, routed by region hash | Dedicated chunk worker (backend) |
| GPU residency | Byte-budgeted LRU per volume, frame-stamped, working set exempt | Capacity-bounded LRU over chunk states |
| CPU tier below the GPU | Decoded-chunk tier shadowing the resident set plus a tail | GPU eviction demotes a chunk to system memory |
| Compressed-byte tier | Byte LRU under the store, absences remembered | No separate tier; relies on the HTTP cache |
| Across sessions | Cache Storage tier for raw store bytes, opt-in, scoped per worker | None beyond the browser HTTP cache |
| Request priority | Per-frame working set, visible-first ordering, stale-drop after one frame | Explicit priority tiers recomputed per frame |
| Request lifecycle | Implicit in maps and sets; no state enum | Explicit chunk state machine |
| Cancellation | `AbortController` reaching the worker's own fetch | Cancellation through the queue manager |
| Prediction | Working-set centroid travel, extrapolated in chunk-grid space | Prefetch of anticipated navigation states at a lower tier |
| Never-empty guarantee | Whole-volume coarse floor, plus a coarse fallback layer on slides | Draws whatever resolution is resident |
| Renderer backends | WebGPU and WebGL2 at parity | WebGL2 |
| Shareable viewer state | URL params in, no write-back | URL-encoded state, the reference implementation |

Two places we are ahead: nothing else in this class persists bytes across
sessions, and the coarse floor is a stronger guarantee than drawing what
happens to be resident. Two places Neuroglancer is still ahead: the explicit
request-state model, and shareable URL state, which is not a caching concern
but is the thing users ask for next.

## 7. What we tried that did not work

The measurements changed the plan more than once, and the dead ends are worth
keeping because each one looks reasonable from the outside.

**Resizing the byte cache.** The first reading of the timing data said the byte
cache was thrashing, and a stage was scheduled to resize it. It was a
misreading: the `net` phase counts cache hits as well as misses, so a high
`net` count did not mean a high miss count. The counters that settled it showed
51 percent hits and zero evictions on a 1 TB store. The stage closed as a
conclusion rather than a rewrite.

**A tier holding only evicted chunks.** The obvious design for the decoded tier
is to admit a chunk when the GPU drops it. It cannot be built: to have an
evicted chunk's bytes you must already be holding them at the moment of
eviction, which means holding them throughout its residency. Any tier that can
demote is already a shadow of the resident set, so the honest version budgets
the shadow instead of wishing it away.

**Cleverer eviction for that tier.** MRU-drop and restamp-on-eviction were both
traced against a scrub-and-reverse pattern and are worse than plain LRU. Under
LRU the newest entries are the still-resident chunks, whose copies cost nothing
to lose, and the oldest are the ones evicted longest ago, which a reversal
reaches last. Dropping from the old end keeps exactly the frontier the view is
about to cross back over.

**Persisting decoded bytes instead of raw ones.** Tempting, because it would
skip the codec too. Rejected: it is one path per decoded representation instead
of one for all of them, the entries are several times larger for the same
budget, and the decode it saves is cheap next to the round trip it does not.

**One unscoped disk cache shared by the workers.** The first working version
had every worker open the same Cache Storage cache with no scope. It hits, so
nothing failed, but each worker adopts every key and evicts the pool down to
its own share, which throws away most of the disk it just filled. Scoping each
worker to a `w<i>/` prefix over one backing fixes it, and is sound only because
routing is a deterministic hash: a brick always returns to the worker that
holds it. Two alternatives were weighed and dropped. A separate cache NAME per
worker still needs a sibling list to clean up after a resized pool, and it
orphans entries when the pool shrinks. Giving each worker the full budget
overruns the disk ceiling by up to the pool size, which makes the number we
told the user meaningless.

**Moving the disk tier to the main thread.** It would avoid scoping entirely.
It also moves the cacheable unit from the store key to the assembled brick,
whose identity depends on the current plan, so key stability is lost and a
re-plan invalidates a cache that should have survived it.

**Deriving decode time by subtraction.** `read - net - assemble` is not decode
time, because one `zarr.get` fans out into several concurrent store gets. The
main-thread stall monitor in the demo measures what the user actually feels and
is the instrument to use.

**Showing prediction working in the demo.** Stage D landed and is unit-tested,
but the demo cannot easily demonstrate it, because the default `focus` budget
plan sizes the plan to the byte budget: most demo datasets end up fully
resident, so the working set never travels far enough to predict. A preset
whose plan exceeds the residency budget at a fine level is still needed to read
`predicted > 0` live.

## 8. What we deliberately did not build

- **An explicit chunk state machine.** Request lifecycle lives in maps and sets
  rather than a state enum. Neuroglancer's model is better for reasoning about
  edge cases, but our transitions are few and the refactor would touch both
  backends. Recorded as a gap, not planned.
- **A closed-loop frame-time controller.** `BudgetPlan.targetFrameMs` is
  recorded but not acted on. Today the `interactive` preset buys headroom with
  a lower brick ceiling, which is the direct proxy for draw cost, since each
  brick is one ray-marched cube draw.
- **An OPFS backing for the disk tier.** Cache Storage was enough, and all
  browser contact is confined to a four-method backing interface, so an OPFS
  implementation would need no change to the cache logic. That interface is
  also what makes the tier unit-testable under Bun, which has no `caches`.
- **Persisting the decoded tier.** Same reasoning as above for raw versus
  decoded bytes. It would only pay for a codec expensive enough to rival the
  round trip, and we have not measured one.
- **Cancellation on the slide path.** Slide tiles are dropped at dequeue time
  when they leave the wanted set, but a fetch already on the wire runs to
  completion. The volume path got a real abort because its reads are large; a
  tile is small enough that the queue discipline is most of the win.
- **A coarser-to-finer fallback on zoom OUT.** The slide fallback layer only
  walks coarser levels. Zooming out to an uncached level still shows
  placeholders even when finer resident tiles cover part of the view. It is the
  symmetric half of the same idea, worth less, because those tiles only cover
  the middle of the new viewport.
- **The fallback layer in the 3D slide-plane renderer.** `gl/slidePlaneRender.ts`
  and its WebGPU twin drive their working set from world geometry through
  `requestTile` and do not use the fallback layer. Same fix, different
  visibility source.
- **A persistent tier for slides.** Slide tiles reach the browser as range
  responses that the HTTP cache already handles reasonably, and the decoded
  form is the expensive one to store. Not attempted.

## 9. Open

The list above is the honest backlog. The two items most likely to matter next
are the demo preset that would make prediction observable, and shareable viewer
state, which is not caching but is the remaining thing Neuroglancer does that
users ask us for. `streaming-todos.md` tracks both.
