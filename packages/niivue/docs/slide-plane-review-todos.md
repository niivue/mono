# Slide Plane Review TODOs

Follow-up items from review passes on `poc-client-only-range-requests`
conducted on 2026-06-30. These should be resolved before treating the
slide-plane, slide drawing, and slide vector annotation work as merge-ready.

## Status (2026-06-30, end of day)

Triaged each item below as **Done** or **Acceptable for now** (a real follow-up
that the demos don't hit and that isn't a correctness risk for the current flow).
Nothing remaining is blocking.

- **Done:** codespell/LOD (CI ignore-list already covers it; package codespell
  clean); Hamamatsu-2 (diagnosed as a dicom-parser overrun, marked unsupported,
  demo option removed); all verification targets pass.
- **Acceptable for now (deferred):** renderer tile-texture cache eviction/reset;
  unified memory budget; adapter-backed (.nvd) restore warning; vector-only
  restore overlay; bounding the magic-wand reference; formal undo/clear contract;
  SVG field escaping. Reasons noted inline per item.

## CI blockers

- [x] Fix the `codespell` blocker around the level-of-detail abbreviation.
  **Done:** `LOD` is already in the CI workflow `ignore_words_list`
  (`.github/workflows/codespell.yml`), and the package codespell run is clean.

## Renderer lifecycle and memory

- [ ] Add slide-plane renderer cache lifecycle controls for both backends.
  The GL and WebGPU slide-plane renderers currently key uploaded tile textures by
  tile key only (`L<level>/<x>/<y>`). Switching slides can reuse stale textures,
  and long sessions can accumulate GPU textures after `NVSlide` evicts its
  `ImageBitmap` cache.

- [ ] Reset or namespace renderer textures on `setSlidePlane()` and
  `clearSlidePlane()`. Prefer also reconciling uploaded textures against visible
  or resident tile keys so stale GPU resources are released promptly.
  **Acceptable for now:** the demos register one slide per plane and never swap
  the plane's slide, so the stale-key reuse (e.g. `L0/0/0` colliding across
  slides) and unbounded growth aren't exercised. Real follow-up for apps that
  switch slides on a live plane.

- [ ] Unify and expose memory-budget accounting across client-only slide and
  volume paths. `NVSlide` already has `maxCacheBytes`, and chunked volumes
  already have GPU residency budgeting. The remaining gap is decoded CPU/GPU
  texture accounting, renderer cache eviction, and shared diagnostics rather
  than a brand-new budget concept.
  **Acceptable for now:** larger architectural item; no leak/crash in the demo
  flow. Pairs with the cache-eviction item above.

## Document restore contract

- [ ] Decide and implement the `.nvd` restore contract for adapter-backed
  slides. Serialization currently stores the manifest, transform, raster
  drawing, and vector shapes, then restores via `NVSlide.fromManifestUrl()` or
  `new NVSlide(manifest)`. DZI/TIFF/SVS sources carry fetch state outside the
  manifest, so geometry can restore while tiles fail to load.

- [ ] Either persist a source descriptor/factory key for DZI/TIFF/SVS-style
  sources or explicitly reject/warn when serializing slide planes that cannot be
  restored from the stored manifest alone.
  **Acceptable for now:** the manifest-range path (synthetic, DICOM-WSI) — the
  serialization-verified flow — restores fully; the DZI/TIFF limitation is
  documented. A warn-on-serialize is a cheap follow-up.

- [ ] Make vector-only slide annotations visible and restorable. The controller
  vector drawing path currently depends on an existing `SlideDrawing` raster and
  `SlidePlaneState.annotation`; documents containing only `vectorShapes` restore
  the shapes but do not create an annotation overlay to render them.
  **Acceptable for now:** the demo + serialization flow always calls
  `createSlideDrawing()`, so an `annotation` overlay always exists and restored
  vectors composite onto it (verified live: a polygon round-trips and renders).
  The gap is only for an app that uses `nv.slideVector` without ever calling
  `createSlideDrawing()`. Cheap follow-up: lazily create the overlay when vectors
  are present.

## Drawing tools

- [ ] Bound magic-wand reference construction. The current controller and
  `slides.html` demo implementations request every tile in the selected pyramid
  level for a single wand click. Limit this to a local window around the seed, or
  build the reference from already-resident tiles and schedule visible-nearby
  fetches incrementally.
  **Acceptable for now:** the reference level is chosen ≤ raster width
  (≤ ~1536 px), so it is a coarse level with few tiles — bounded in practice.
  Real follow-up for deep zoom on very large slides.

- [ ] Clarify undo/clear semantics across raster and vector slide annotation
  tools. Today vector undo depends on the active tool, while clear operations are
  partly demo-managed. Decide whether public controller helpers should operate
  on raster only, vector only, or both.
  **Acceptable for now:** behaviour is consistent and functional today
  (`slideDrawUndo` is tool-aware; slide3d's Clear wipes both raster + vector). The
  remaining work is documenting it as a public contract, not a bug fix.

## OpenSlide fixtures

- [x] Hamamatsu-2 does not load. **Handled (won't-fix now, documented).** Its instances are JPEG **TILED_FULL** (not a
  tiling issue), but `dicom-parser` throws `buffer overrun` parsing them — before
  the pixel data element — so `scripts/fetch-openslide-dicom.ts` cannot build a
  byte-range manifest. The preset is marked `unsupported` and the slides demo
  option removed. To support it, work around or replace dicom-parser for these
  files (e.g. scan for the pixel-data element + basic offset table directly
  instead of a strict sequential parse), or pre-transcode the archive.

## SVG export

- [ ] Escape or validate SVG vector annotation fields before export. `color` and
  other shape data can come from public API or loaded documents, so SVG output
  should avoid malformed or unsafe attributes.
  **Acceptable for now:** in every current path `color` is a controlled `#rrggbb`
  hex (from the `_draw` LUT) and points are numbers, and the SVG is a downloaded
  file (not inlined into the DOM), so there is no live injection surface. Cheap,
  worthwhile hardening for arbitrary public-API/loaded-document input.

## Verification targets

All green on 2026-06-30 (end of day):

- [x] `bunx nx run niivue:typecheck`
- [x] `bunx nx run niivue:lint`
- [x] `bunx nx run niivue:test` (426 pass, 0 fail)
- [x] `bunx nx run niivue:build`
- [x] `bunx nx run niivue:build:examples`
- [x] `bun run check-boundaries`
- [x] package `codespell` (clean)
