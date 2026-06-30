# Slide Plane Review TODOs

Follow-up items from review passes on `poc-client-only-range-requests`
conducted on 2026-06-30. These should be resolved before treating the
slide-plane, slide drawing, and slide vector annotation work as merge-ready.

## CI blockers

- [ ] Fix the `codespell` blocker around the level-of-detail abbreviation.
  Prefer spelling it out in comments, tests, and examples. If the abbreviation
  is intentionally kept, add an explicit ignore entry in the CI workflow.

## Renderer lifecycle and memory

- [ ] Add slide-plane renderer cache lifecycle controls for both backends.
  The GL and WebGPU slide-plane renderers currently key uploaded tile textures by
  tile key only (`L<level>/<x>/<y>`). Switching slides can reuse stale textures,
  and long sessions can accumulate GPU textures after `NVSlide` evicts its
  `ImageBitmap` cache.

- [ ] Reset or namespace renderer textures on `setSlidePlane()` and
  `clearSlidePlane()`. Prefer also reconciling uploaded textures against visible
  or resident tile keys so stale GPU resources are released promptly.

- [ ] Unify and expose memory-budget accounting across client-only slide and
  volume paths. `NVSlide` already has `maxCacheBytes`, and chunked volumes
  already have GPU residency budgeting. The remaining gap is decoded CPU/GPU
  texture accounting, renderer cache eviction, and shared diagnostics rather
  than a brand-new budget concept.

## Document restore contract

- [ ] Decide and implement the `.nvd` restore contract for adapter-backed
  slides. Serialization currently stores the manifest, transform, raster
  drawing, and vector shapes, then restores via `NVSlide.fromManifestUrl()` or
  `new NVSlide(manifest)`. DZI/TIFF/SVS sources carry fetch state outside the
  manifest, so geometry can restore while tiles fail to load.

- [ ] Either persist a source descriptor/factory key for DZI/TIFF/SVS-style
  sources or explicitly reject/warn when serializing slide planes that cannot be
  restored from the stored manifest alone.

- [ ] Make vector-only slide annotations visible and restorable. The controller
  vector drawing path currently depends on an existing `SlideDrawing` raster and
  `SlidePlaneState.annotation`; documents containing only `vectorShapes` restore
  the shapes but do not create an annotation overlay to render them.

## Drawing tools

- [ ] Bound magic-wand reference construction. The current controller and
  `slides.html` demo implementations request every tile in the selected pyramid
  level for a single wand click. Limit this to a local window around the seed, or
  build the reference from already-resident tiles and schedule visible-nearby
  fetches incrementally.

- [ ] Clarify undo/clear semantics across raster and vector slide annotation
  tools. Today vector undo depends on the active tool, while clear operations are
  partly demo-managed. Decide whether public controller helpers should operate
  on raster only, vector only, or both.

## OpenSlide fixtures

- [ ] Hamamatsu-2 does not load. Its instances are JPEG **TILED_FULL** (not a
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

## Verification targets

- [ ] `bunx nx run niivue:typecheck --skipNxCache`
- [ ] `bunx nx run niivue:lint --skipNxCache`
- [ ] `bunx nx run niivue:test --skipNxCache`
- [ ] `bunx nx run niivue:build --skipNxCache`
- [ ] `bunx nx run niivue:build:examples --skipNxCache`
- [ ] `bun run check-boundaries`
- [ ] Run the package `codespell` command from `AGENTS.md`.
