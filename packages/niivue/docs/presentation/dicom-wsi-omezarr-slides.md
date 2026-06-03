---
marp: true
theme: gaia
paginate: true
title: Massive Volumetric Imaging in the Browser
author: NiiVue
class: lead
---

<!--
Render this deck with Marp:
  bunx @marp-team/marp-cli@latest packages/niivue/docs/presentation/dicom-wsi-omezarr-slides.md -o slides.html
  bunx @marp-team/marp-cli@latest packages/niivue/docs/presentation/dicom-wsi-omezarr-slides.md --pdf
Or live-preview in VS Code with the "Marp for VS Code" extension.
Slides are separated by `---`; this also renders as a reveal.js deck if preferred.
-->

# Massive Volumetric Imaging in the Browser

### DICOM-WSI + OME-Zarr streaming in NiiVue

Tiled rendering, level-of-detail pyramids, and an IIIF volumetric server

`feat/dicom-wsi-omezarr`

<!--
Presenter: Open warm. This is work that lets a browser render datasets that
do not fit in RAM or on the GPU — pathology whole-slides, electron-microscopy
stacks, big CT. Two source formats this branch adds: OME-Zarr and DICOM-WSI.
The trick is that we never load the whole thing; client and server stream a
working set. Promise a live demo at the end so people stay engaged.
-->

---

## The pitch in one sentence

> Stream and interactively render **virtually unlimited-size** volumetric
> datasets — whole-slide pathology, microscopy, CT — inside a plain web
> browser, on commodity GPUs, with **no plugin and no download**.

Same viewer. Same code path. WebGPU **and** WebGL2.

<!--
Presenter: The one line to remember. "No plugin, no download" is the headline
for clinical/research users — data stays on the server, the browser pulls only
the bytes it can show. Emphasise commodity GPUs: this runs on a laptop iGPU,
not just a workstation. Parity across backends means it works everywhere,
including Safari/WebGL2 where WebGPU isn't available yet.
-->

---

## Why this is hard

A naive volume renderer tries to:

1. Download the whole file into RAM
2. Upload it as one 3D GPU texture
3. Ray-march through it

Each step has a hard ceiling:

| Limit | Typical value | What breaks |
| --- | --- | --- |
| Browser tab RAM | a few GB | 50 GB download crashes the tab |
| `maxTextureDimension3D` | 2048³ (some 4096–16384) | larger volume = silent **black frame** |
| GPU VRAM | 2–8 GB | a 10 GB volume crashes integrated GPUs |

A single 4096³ float32 volume is **256 GB**. WSI and EM stacks blow past every limit routinely.

<!--
Presenter: Three independent ceilings — don't conflate them. (1) RAM: the file
is too big to download. (2) Texture dimension: even if it fit in RAM, the GPU
refuses a 3D texture bigger than maxTextureDimension3D — and the failure is
SILENT, you just get a black frame, which is why this bit people before.
(3) VRAM: even split up, you can't keep it all resident. The 256 GB number
lands the point: this isn't a tuning problem, it's an architecture problem.
-->

---

## The shape of the solution

A tightly-coupled **client ↔ server conversation**, not a file download.

```
  Browser (NiiVue)                    Volumetric server
  ----------------                    -----------------
  Which chunks are visible?  ──────▶  OME-Zarr / DICOM pyramid
  Give me bbox @ LOD 3       ──────▶  Bounding-box subvolume read
                             ◀──────  Tiny downsampled payload
  Upload to GPU, ray-march
  Zoom in → need LOD 0       ──────▶  Higher-res chunks for center
                             ◀──────  Full-res payload
  Evict off-screen chunks (LRU)
```

Neither side ever holds the whole dataset.

<!--
Presenter: This is the whole talk in one slide — if someone only remembers one
diagram, make it this. Walk top to bottom: client asks what's visible, asks the
server for a bounding box at a coarse level, gets a tiny payload, draws it.
Then on zoom-in it asks for full-res just for the center and evicts what scrolled
off. The key word is "conversation" — it's continuous and driven by the camera.
Next few slides drill into each half: client (3 slides) then server (2 slides).
-->

---

## Client side — Tiled volumes

NiiVue logically partitions every volume into 3D **chunks**, each its own GPU texture:

```
   Volume (too big for one texture)        Chunk grid (each ≤ device limit)
   +---------------------------+           +--------+--------+--------+
   |                           |           | c0  ][ | c1  ][ | c2     |   ][ = 3-voxel
   |                           |    ===>    +--------+--------+--------+        halo overlap
   |                           |           | c3  ][ | c4  ][ | c5     |        on interior
   |                           |           +--------+--------+--------+        faces
   +---------------------------+           | c6     | c7     | c8     |
                                           +--------+--------+--------+
```

- Each chunk ≤ device texture limit; **3-voxel halo** on interior faces
  - 1 voxel suffices for seam-free trilinear; gradient pass reads ±2 → carry margin
- Composited back-to-front, premultiplied-alpha **OVER** blending
- *Every* volume is "chunked" (count = 1 common case) → one hot path

`src/volume/chunking.ts`

<!--
Presenter: Halo is the detail people poke at — be ready. Each chunk carries a
3-voxel skirt of its neighbours' data so sampling at the seam has valid
neighbours and there's no visible crack. Why 3 not 1? Trilinear alone needs 1,
but the gradient/lighting (Sobel + blur) reads two voxels out, so we keep margin.
"Treat every volume as chunked" is a software-engineering win: count==1 for a
normal small volume, so there's exactly ONE render path to maintain, not two.
-->

---

## Client side — Visibility-driven working set

Every frame, NiiVue computes *exactly* which chunks touch the screen:

- **3D view:** camera frustum vs. each chunk's bounding box
- **2D slice:** which chunk boundaries the slice plane crosses

Only those chunks enter the **working set**.

Result: a 256 GB dataset costs GPU memory proportional to **what you can see**, not what exists.

<!--
Presenter: This is what makes the budget bounded instead of best-effort. We
don't upload "nearby" chunks hopefully — we compute the exact set intersecting
the view, every frame. In 3D it's a frustum test against each chunk's box; in
2D it's which chunks the slice plane passes through (at most a handful). The
punchline line is the last one: cost tracks the viewport, not the dataset.
-->

---

## Client side — `ChunkResidencyManager` (LRU)

A strict GPU memory budget (e.g. **1.5 GiB**):

- New visible chunk → queued for upload via an async **pump** (no main-thread stutter)
- Budget exceeded → **Least-Recently-Used** eviction destroys the longest-off-screen chunk textures
- `beginFrame()` runs *before* the working-set request, so a same-frame admit can never evict a chunk we're about to draw

Phase 3a–3d: visibility math → uploader → working set → LRU eviction → tunable budget.

<!--
Presenter: The residency manager is the GPU-memory governor. Three things to
land: (1) uploads go through an async pump so we never block the main thread —
no jank while streaming. (2) When we exceed budget, LRU throws out whatever has
been off-screen longest. (3) The frame-ordering subtlety — beginFrame() stamps
the working set BEFORE we request uploads, so eviction in the same frame can't
accidentally drop a chunk we're literally about to draw. That ordering bug is
the kind of thing that's invisible until it isn't; we codified it. Phase 3a-3d
is just how this landed incrementally over the branch.
-->

---

## Server side — LOD pyramids + spatial queries

```
   LOD pyramid (precomputed)        Bounding-box query at a level
   Level 0  ██████████████  100%    "X 1000-2000, Y 1000-2000,
   Level 1  ███████          50%     Z 0-1000 @ LOD 2"
   Level 2  ███              25%         |
   Level 3  █                12%         v   server returns ONLY
   ...                                   +-> that sub-block, downsampled
```

The `iiif-volumetric-server` (proof of concept):

- **Image pyramid** — coarse-to-fine, pick the level matching screen resolution
- **Bounding-box queries** instead of file requests (see above)
- **3D IIIF manifests** (Presentation API 4.0 alpha) publish dataset
  dimensions, LOD levels, and grid structure to the client
- Occupancy grid for sparse subvolume prefetch

Per-format adapters: **NIfTI · NRRD · OME-Zarr · DICOM**

<!--
Presenter: Now the server half. Two ideas. (1) The pyramid: the data is stored
pre-downsampled at multiple resolutions, so when you're zoomed out we ship the
tiny level, not the full one — same idea as map tiles / OpenSeadragon, but in
3D. (2) Bounding-box queries: the API isn't "give me the file", it's "give me
this box at this level". The IIIF manifest is how the client discovers the
dataset's dimensions and which levels exist. Note this is the same server
abstraction across four formats — the adapters hide the format differences.
-->

---

## The two source formats

### OME-Zarr (NGFF)

- Real chunk reads via `zarrita` — Zarr v2 + v3, blosc/gzip/zstd
- Walks `multiscales` datasets, surfaces only levels present on disk
- NGFF spatial axes (…, z, y, x) map to NiiVue's (x, y, z) with **no transpose**

### DICOM-WSI (whole-slide imaging)

- One instance per pyramid level; **TILED_FULL** JPEG tiles decoded on demand
  (`dicom-parser` + `jpeg-js`) — a bbox read decodes only the covering tiles
- Surfaced as a **depth-1 RGB volume** per level → renders on niivue unchanged
- Fixtures pulled from the public **NCI Imaging Data Commons** (IDC):
  CPTAC-BRCA, TCGA, … whole-slide pathology

<!--
Presenter: These are the two new sources this branch adds. OME-Zarr (a.k.a.
NGFF) is the emerging open standard for bioimaging — we read real compressed
chunks with zarrita, both Zarr v2 and v3. Nice detail: the axis order lines up
with ours so there's no transpose, it's a pure relabel. DICOM-WSI is digital
pathology — gigapixel slides stored as a tiled JPEG pyramid of DICOM instances.
Two facts to land: (1) we decode the JPEG tiles on demand, only the ones a
view covers; (2) a slide is just a volume that's one voxel deep and RGB, so it
reuses the viewer with no new render path — next slide. We pull real anonymised
series from NCI's public IDC, so anyone can reproduce — open standards + open
data, no vendor lock-in.
-->

---

## The complete workflow

**Zoomed out (overview)**
- Many voxels per screen pixel → pick coarse LOD (e.g. Level 3)
- Request visible Level-3 chunks → tiny payloads → upload

**Zooming in (drill down)**
- Screen-space error rises → request Level-0 chunks for the center
- Keep showing blurry Level-3 as a **placeholder** while they load
- Level-0 arrives → cache admits it → view **pops** into sharp focus
- VRAM tight? LRU evicts the high-res chunks that just panned off-edge

<!--
Presenter: Tie the two halves together with the user's actual experience. The
"placeholder" behaviour is the bit that feels good live: you never stare at a
blank region — you see a blurry version immediately and it sharpens as full-res
arrives. That's coarse-first / progressive refinement. If the demo is up, this
is the slide to switch to it: zoom out (instant, coarse), then zoom in and let
the audience watch it pop. The LRU eviction on pan is what keeps it from ever
running out of VRAM during exploration.
-->

---

## The GPU upload pipeline

Same three stages on both backends, both single-texture and chunked paths:

| Stage | In → Out | Fires |
| --- | --- | --- |
| 1. Orient + colormap | scalar 3D tex → RGBA8 in RAS | per chunk mutation |
| 2. Gradient (Sobel + blur) | RGBA8 color → RGBA8 gradient | per chunk mutation |
| 3. Ray-march | color + gradient + matcap → framebuffer | every frame |

Steady-state residency: **8 bytes/voxel** (4 color + 4 gradient).
A single `chunkTexCoord()` helper makes the *same* shader run on both paths.

<!--
Presenter: This slide is for the graphics-curious; skip lightly for a general
audience. Point: stages 1 and 2 are pre-processing that runs once when a chunk's
data changes (orient into RAS + colormap, then compute a gradient for lighting);
stage 3 is the per-frame ray-march. The 8-bytes-per-voxel number is the memory
accounting that feeds the budget. The single chunkTexCoord helper is the reason
chunked and non-chunked share one shader — it remaps full-volume coords into the
current chunk's texture, and is a no-op identity transform when there's 1 chunk.
-->

---

## Backend parity is a hard rule

WebGPU and WebGL2 mirror each other line-for-line. Only genuine API
asymmetries are allowed:

| Concern | WebGPU | WebGL2 |
| --- | --- | --- |
| Bytes upload | `queue.writeTexture` | `texImage3D` |
| Orient | compute → storage texture | layered fragment passes |
| Gradient | 2 compute pipelines | 2 fragment passes (layered FBO) |
| Chunk depth | `pipelineChunked` `depthCompare:'always'` | `depthFunc(ALWAYS)` |

> "If you find a real asymmetry that isn't on the list, it is almost certainly a bug."

<!--
Presenter: Why parity matters for an audience: WebGPU is the future but isn't
everywhere yet (Safari, older Firefox). WebGL2 is everywhere. We refuse to ship
a feature on one backend only — it lands on both in the same change, mirrored
line-for-line. The table is the short list of differences the APIs FORCE on us;
everything else is identical by rule. The quote is our engineering discipline in
one line — it makes divergence a bug, not a shrug.
-->

---

## Correctness war stories

Two bugs that read as "shader problems" but weren't (commit `8be40df`):

- **Concentric-ring darkening** — transparent chunk layers were depth-testing
  against each other and rejecting chunks behind already-drawn ones.
  Fix: chunked path skips depth self-testing.
- **Per-chunk alpha inflation** — scaling output alpha by `1/earlyTermination`
  over-occluded the chunks behind, compounding per chunk crossing.
  Fix: snap alpha to 1 only on full coverage.

Invariants now codified + unit-tested in `docs/high-res-streaming.md` §8.

<!--
Presenter: Optional "we earned this" slide — good for a technical crowd, cut for
execs. Both bugs produced the SAME symptom (concentric-ring darkening) from two
different causes, which is why they were nasty to chase. The lesson worth voicing:
compositing many transparent layers across draw calls breaks assumptions that hold
for a single texture (depth self-testing, alpha normalisation). We turned each fix
into a documented invariant with a unit test so it can't silently regress.
-->

---

## DICOM-WSI — whole slides, no new render path

A slide is a 2D image, so each level is a **depth-1 RGB volume** `[W,H,1]`.
NiiVue's axial slice *is* the slide face — **reused unchanged, zero niivue edits.**

```
  whole-slide overview        zoom toward cursor       cellular detail
  (coarsest level, whole)  →  (window via bbox)    →   (L0 tiles, ~1:1)
```

- `wsi.html`: **OpenSeadragon-style** smooth zoom + pan, minimap, click-to-jump
- **Auto-LOD** swaps the pyramid window when a texel crosses ~1:1 with the
  screen — scale-matched, so only the detail sharpens
- Same **bbox subvolume** API as OME-Zarr; CPTAC-BRCA base is **2.66 gigapixels**
  (53783×49534) and never materialised

<!--
Presenter: This is the most relatable demo — a pathology slide you deep-zoom
like Google Maps, in a plain browser, no plugin. The clever, honest bit: it
needed NO new niivue rendering code. A whole slide is just a volume that's one
voxel deep and RGB, so it drops straight into the 2D slice path. The deep-zoom
(overview -> window -> cells) reuses the exact same bounding-box subvolume API
OME-Zarr uses. All the OpenSeadragon-style smoothness — cursor-anchored zoom,
drag pan, the auto-LOD window swap, the minimap — is demo code driving niivue's
2D pan/zoom. If the demo is live, THIS is the one to show: open wsi.html, scroll
into the tissue until individual nuclei resolve, drag around, click the minimap.
-->

---

## Live demos

`apps/iiif-volumetric-demo` — every page has a `?backend=webgl2|webgpu` toggle:

- **`wsi.html`** — DICOM whole-slide deep zoom: OSD-style smooth zoom/pan,
  minimap, auto-LOD *(headline — pathology slide)*
- **`omezarr.html`** — OME-Zarr pyramid viewer: level selection, subvolume
  streaming, exploded-block layout *(headline — 3D streaming)*
- `index.html` — 3-pane IIIF slices + 3D render from a Presentation 4.0 manifest
- `osd-volume-desktop.html` — deep-zoom 2D desktop with a matched-LOD 3D pane
- `sheet.html` — 3×3 grid of independent volumes on one zoomable canvas

<!--
Presenter: Two headliners now. wsi.html is the crowd-pleaser — a gigapixel
pathology slide you deep-zoom smoothly; lead with it for a clinical/biology
audience. omezarr.html is the 3D-streaming headliner — show the level selector
and the backend toggle so people see WebGPU and WebGL2 give the same image; lead
with it for a graphics/infra audience. The rest are proof of range. Don't demo
all of them — pick the headliner that fits the room, plus one more.
-->

---

## Demo: bring it up

```sh
# Terminal 1 — server
bun install && git lfs pull
bunx nx build niivue
bunx nx run iiif-volumetric-server:fetch-omezarr   # FIB-SEM OME-Zarr
bunx nx run iiif-volumetric-server:fetch-dicom-wsi # CPTAC-BRCA WSI
bunx nx dev iiif-volumetric-server                 # :8080

# Terminal 2 — demo
bunx nx dev iiif-volumetric-demo                   # :8087
```

Open `http://localhost:8087/wsi.html` · `…/omezarr.html`

<!--
Presenter: Backup slide — only show if someone asks "how do I run it" or the
live demo dies. Two terminals: server on 8080, demo on 8087. git lfs pull is the
classic gotcha — without it the headline volume/meshes are pointer files and you
get a blank viewer. Run the fetch scripts once to populate fixtures. If the demo
is already live, skip this entirely.
-->

---

## Where it stands

**Done**
- Tiled rendering past `maxTextureDimension3D`, both backends
- Chunk streaming + LRU residency with tunable budget (Phase 3a–3d)
- OME-Zarr (real chunk reads) + DICOM-WSI (real JPEG-tile decode) adapters
- **DICOM-WSI deep-zoom viewer** (`wsi.html`): OSD-style zoom/pan, auto-LOD, minimap
- **Chunked RGB** in niivue → the WSI streams as chunked-RGB bricks in the
  streaming viewer (`omezarr.html`), viewport-bounded by the frustum cull
- Seam-free gradients, correctness invariants, unit-tested chunk math

**Next**
- 2D-slice viewport cull → chunked RGB streaming inside the `wsi.html` 2D viewer
- Server-driven lazy chunk streaming for s0 of multi-GB EM stacks
- Dedicated chunked-path benchmark; cloud deployment (`CLOUD_DEPLOYMENT_PLAN.md`)

<!--
Presenter: Be honest about the boundary. What works today: rendering past the
texture limit on both backends, streaming + LRU residency, both new formats with
real decode, and a polished pathology deep-zoom viewer. Two remaining pieces: (1)
the WSI viewer streams windows (single-texture RGB) because niivue's chunked path
doesn't take RGB yet — adding that lets the whole base level stream/tile; (2)
fully server-driven lazy streaming for s0 of multi-GB EM stacks (today the
adapter reads a whole level into RAM, fine for coarse tiers, not s0). Plus a
chunked-path benchmark and cloud hosting. Invite collaboration.
-->

---

## Takeaways

1. **No file download** — the browser and server stream a working set
2. **Bounded GPU memory** — cost scales with what's visible, not what exists
3. **One viewer, two backends** — WebGPU and WebGL2 at parity
4. **Open standards** — OME-Zarr (NGFF) + IIIF 3D + DICOM, public IDC data

### Massive volumetric imaging, in a tab.

Questions?

<!--
Presenter: Land the four takeaways, then stop talking. If you only get one
sentence in someone's memory, make it the title line. Anticipated Q&A:
- "How big has it actually rendered?" — a 2.66-gigapixel pathology slide deep-zooms
  smoothly today; for 3D, bounded by server + budget, not voxel count.
- "Did the whole-slide viewer need new niivue rendering?" — no; a slide is a
  depth-1 RGB volume, so it reuses the 2D slice path. The OSD navigation is demo code.
- "Why not just WebGPU?" — reach; WebGL2 covers Safari/older browsers today.
- "Production-ready?" — adapters + viewer work end to end; coarse/window tiers
  stream now, chunked-RGB and s0 lazy streaming are the next milestones.
- "Does it need a GPU workstation?" — no, runs on laptop integrated GPUs.
-->

