# NiiVue Parity vs Neuroglancer & Napari

Capability comparison of the NiiVue ecosystem against **Neuroglancer** (web,
WebGL2, client-side chunked decode; large EM/connectomics) and **Napari**
(Python/Qt desktop, in-memory n-dimensional arrays; analysis + plugins).

*Assessed: 2026-06-30.* This is a **capability** comparison, not an API map. The
relevant work is currently split across two unmerged feature branches, so verdicts
are attributed to where the code lives:

- **PR#42** = `feat/iiif-volumetric-server` — server-assisted streaming: an IIIF
  volumetric server decodes OME-Zarr / DICOM-WSI / NIfTI and streams raw bytes;
  the browser does per-brick multi-LOD volumetric rendering.
- **poc** = `poc-client-only-range-requests` — pure-client streaming: `NVSlide`
  (WSI tile viewer over HTTP range requests) and a `range` demo that decodes
  Zarr v3 **client-side** with `zarrita`. This branch is the merge target after
  PR#42 lands.

Legend: present, partial, missing.

---

## Architectural framing

| | NiiVue (PR#42) | NiiVue (poc) | Neuroglancer | Napari |
|---|---|---|---|---|
| Platform | Web (WebGPU+WebGL2) | Web (WebGPU+WebGL2) | Web (WebGL2) | Desktop (Python/Qt) |
| Where bytes decode | **Server** (thin client) | **Client** (zarrita / range) | Client | Local process |
| Dual GPU backend | yes | yes | WebGL2 only | n/a (OpenGL) |

NiiVue is the only one of the three with a **WebGPU + WebGL2** path at parity. The
two branches together show both the server-assisted *and* the pure-client
(Neuroglancer-like) streaming architectures.

---

## 1. Source pipeline & streaming runtime

| Item | Status | Evidence / notes |
|---|---|---|
| Unified source pipeline (`source → metadata → levels → chunks → fetch/decode/cache`) | partial | Shared low-level `VolumeChunkSource` + `volume/chunking.ts` + residency; per-page metadata loaders, no `Source`/`Adapter` abstraction. |
| Chunk scheduler w/ explicit request states | partial | Lifecycle implicit via Maps/Sets (`_uploadQueue`/`_inFlightUploads`/`_resident`/`failUpload`/`_evictToFit` in `volume/ChunkResidency.ts`); no state enum. |
| Stale-request cancellation (`AbortController`) | partial | Present for desktop thumbnails; the volume chunk fetches run uncancelled. |
| Priority + prefetch (view-centre, visible-first, LRU) | partial | `orderByViewCenter` + visible-first + LRU demotion (`volume/ChunkVisibility.ts`, `ChunkResidency.ts`). Neighborhood prefetch minimal. |
| Unified memory budgets | partial | GPU residency byte-budget + LRU unified across base+overlays; no CPU-decoded-bytes budget; `NVSlide` has its own bounded ImageBitmap LRU. |
| Serializable / shareable viewer state | partial | URL params read at init + in-memory camera snapshot; no write-back / shareable-state export. Neuroglancer's URL-state is the reference target. |

Neuroglancer's defining strengths here are the **explicit request-state model with
cancellation** and **URL-encoded shareable state**; both are NiiVue's weakest spots.

## 2. Data formats

| Item | Status | Evidence / notes |
|---|---|---|
| OME-Zarr (v2/v3, multiscales, codecs) | present | PR#42: server adapter via `zarrita` (v2/v3 detection, OME multiscales 0.4+0.5, scale transforms, UCUM units, dtype allowlist). poc: **client-side** `zarrita` decode in `examples/range.js` (`zarr.open.v3`). Gaps: `translation` transforms ignored, `dimension_names` unused. |
| Zarr v3 sharding + codecs (bytes/zstd/blosc/gzip/transpose) | present | Inherited from `zarrita` codec registry incl. `sharding_indexed`. Caveat: in-repo fixtures only exercise bytes+zstd. |
| DICOM-WSI | present | poc: `NVSlide` streams a `dicom-wsi-range-v1` manifest via HTTP range (CPTAC-BRCA fixture). PR#42: server-decoded. Documented in `docs/dicom-wsi.md`. |
| NIfTI / NRRD / mesh formats | present | Core readers (`volume/readers/`, `mesh/`). |
| Neuroglancer Precomputed | missing | No adapter. Deferred. |
| DeepZoom (DZI) | missing | No adapter (the "deep-zoom" UX in demos is OSD-style navigation, not the DZI tile format). |

## 3. Layer & transform model (the Napari axis)

| Item | Status | Evidence / notes |
|---|---|---|
| `NVSlide` WSI tile layer | present (poc) | `src/slide/NVSlide.ts` + `gl/slide.ts` + `wgpu/slide.ts`; pyramid manifest, viewport pan/zoom + LOD pick, HTTP-range tile streaming (206 + fallback), ImageBitmap LRU, request stats, `change` events. Exported from `src/index.ts`. |
| First-class slide pixel↔world transform | missing | No `pixelToWorld`/`worldToPixel` object with units/validation. `NVSlide` is viewport-space; not registered into volume world space. |
| Unified Napari-style layer model (volume/slide/labels/mesh w/ visibility/opacity/blending/transform/metadata) | missing | Model holds separate arrays (`volumes`/`meshes`/`signals`/`annotations`/`drawingVolume`); no common `NVLayer`. `NVSlide` is standalone, not a model layer. |
| `NVSlide` integrated into the main render cycle (standalone + over a base volume) | missing | `NVSlide` renders via its own `SlideRenderer`; not a layer in the NiiVue tile/render loop, cannot yet register onto a base image/volume. |
| Vector annotations (points/polylines/polygons/labels/measurement) | partial | Real subsystem (`annotation/`): polygons + measure tools + stats + undo. Gaps: **mm-anchored only** (no slide-pixel space), no point / open-polyline / text-label types. |

Napari's layer model and NiiVue's lack of a unified one is the biggest structural
gap. Note `NVSlide` *exists and works* as a standalone WSI viewer — the missing
piece is promoting it (and meshes/volumes) into one layer abstraction.

## 4. Rendering & UX

| Item | Status | Evidence / notes |
|---|---|---|
| Composite (translucent) volume render + matcap lighting | present | `gl/renderShader.ts`, `wgpu/render.wgsl`. |
| MIP (maximum-intensity projection) | missing | No additive/max mode. Standard in both Neuroglancer and Napari. **Top render gap.** |
| Iso-surface render | missing | No iso mode. |
| Interpolation (nearest/linear) | present | `isNearestInterpolation`. |
| Gamma | present | `gamma`. |
| Clip planes | present | Up to 6 (`MAX_CLIP_PLANES=6`) + cutaway, both backends. |
| Axis-aligned clip box | missing | Deferred (see `apps/iiif-volumetric-demo` TODO). |
| Colormaps + window/contrast | present | Many colormaps + calMin/calMax; no named-preset system. |
| WebGL2 / WebGPU parity for tile + chunk rendering | present | Both backends implement the chunk path; `NVSlide` ships `SlideRenderer` + `SlideRendererGPU`. |
| Streaming diagnostics (requests, 206/fallback, cache hits, wire bytes, failures) | present (poc) | `NVSlide` stats surfaced in `examples/slides.html`; volume side exposes `chunkStreamStats()`. |

---

## Biggest real gaps (priority order)

1. **MIP + iso-surface render modes** — most user-visible parity gap vs both tools;
   lands in the existing render shaders, both backends.
2. **Chunk-fetch cancellation + explicit request-state model** — Neuroglancer's
   signature robustness; today stale volume-chunk fetches run to completion.
3. **Unified layer model** — the Napari axis and the precondition for promoting
   `NVSlide` / labels / transforms to first-class layers.
4. **Serializable/shareable state** — Neuroglancer's URL-state.
5. **`NVSlide` ↔ volume world-space registration** (`pixelToWorld`) — to overlay a
   slide onto a base image rather than view it standalone.

## What NiiVue already does that these tools don't

- **WebGPU + WebGL2** rendering at parity (Neuroglancer is WebGL2-only; Napari is
  desktop OpenGL).
- **Per-brick multi-LOD volumetric** rendering with BSP back-to-front ordering and
  a coarse-floor streaming fallback (PR#42).
- Both **server-assisted** and **pure-client** streaming architectures in one
  codebase.

## Method & caveats

Findings come from a four-cluster source audit (pipeline, formats, layer model,
rendering) plus direct branch verification on 2026-06-30. The Neuroglancer/Napari
feature sets are taken from their documented capabilities (the local reference
checkouts used for the original gap scan are no longer on disk). Verdicts marked
"(poc)" are present on `poc-client-only-range-requests` and arrive in `main` only
after that branch merges (post-PR#42).
