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

---

# Exploded-block voxel drawing + vector SVG (2026-07-06)

Follow-ups from the drawing-on-exploded-blocks work (`vox.draw` /
`vox.draw.explode` demos): raster pen/eraser/stroke/flood-fill/magic-wand on
exploded blocks, voxel magic wand + 2D/3D mode, vector (SVG) annotations drawn on
2D slices **and directly on the 3D blocks**, explode-aware 3D annotation
rendering. All shipped + verified in-browser (WebGPU + WebGL2 where noted); items
below are known limitations / deferred improvements, none blocking.

## 3D vector annotations

### DESIGN DECISION (2026-07-07): vector = straight lines in world space

How should a vector (SVG) shape behave on a curved surface (gyri/sulci)? Two
possible modes:

- **(A) Surface-conforming (deferred).** Ray-march each rendered point onto the
  visible tissue surface so the line hugs the gyri/sulci. This is **windowing-
  dependent** — the "surface" is defined by the transparency threshold
  (`calMin`/`calMax`), so the shape would shift/redrape as the window changes.
  Would be a render-time re-projection each frame.
- **(B) Straight lines in world space (CHOSEN, and what we ship today).** The
  shape is a fixed world-space (mm) polygon; the only thing that moves it is the
  exploded-view offset. Not windowing-dependent, doesn't redrape on the surface.

Current state matches (B): `buildAnnotation3DRenderData` renders the stored
polygon at fixed mm + explode offset with **no `calMin`/`calMax` dependence**
(verified). Nuance: at DRAW time the pick still ray-marches to the visible tissue
surface (`pickBlockMM` → threshold from the window), so a new point lands on the
tissue you see at the current window; once placed it's world-fixed. That's
intentional (draw on what you see, then it stays put). Pens: color voxels and
ray-march to choose which voxels (windowing-dependent voxel selection) — current
behavior, kept.

Follow-ups from this decision:

- [ ] **(L) Option A — surface-conforming SVG** as an opt-in mode (render-time
  ray-march onto the threshold surface; redrapes with `calMin`/`calMax`).
  Deferred; pairs with the non-planar type below.
- [ ] **Planar-only storage** (intentional per (B), but note the shape is fit to
  the best axis-aligned plane (smallest-spread axis = depth) and flattened, so a
  stroke across a very oblique/curved face flattens onto the mean-depth plane. A
  non-planar 3D annotation type (arbitrary 3D polylines) would remove the
  flattening AND enable Option A — sizable change to the annotation model,
  renderer, and SVG export. Deferred.
- [ ] **Occlusion by the opaque volume.** 3D annotations render at their true
  slice depth, so they sit *inside* the block and are partly hidden unless a clip
  plane cuts to them. Consider an opt-in "always-visible" render (draw
  annotations with depth-test off / on top), so interior shapes show without a
  clip plane. Today the clip plane is the workaround.
- [ ] **Explode-aware offset is per-vertex-by-block.** `buildAnnotation3DRenderData`
  offsets each vertex by the explode offset of the block containing it. A polygon
  that spans the gap between two blocks stretches across the gap (each vertex
  follows its own block). Edge case; acceptable, but note if free 3D strokes land.
- [ ] **Only WebGPU visually confirmed for the 3D-vector-draw flow.** The pick +
  annotation creation are backend-agnostic and the explode-aware render was
  verified on both backends, but the specific "right-drag on a block draws a
  shape" path was only eyeballed on WebGPU (via synthetic pointer events —
  automation can't right-drag). Quick WebGL2 spot-check is a nice-to-have.

## SVG export (voxel)

- [ ] **`annotationsToSVG` exports a single plane.** In render/multiplanar views
  it falls back to the first annotation's plane, so annotations spread across
  different planes only partly export. A multi-plane SVG (a `<g>` per plane, or
  explicit plane selection) is the follow-up.
- [ ] **Raster drawing -> SVG (`drawingToSVG`) is unsurfaced.** It traces a
  drawing-bitmap slice into run-length `<rect>`s per label; implemented + unit
  tested, but the demo button was removed to avoid confusion with the vector SVG.
  Re-enable in a dedicated demo (or behind a toggle) if wanted.
- [ ] **SVG field escaping** (shared with the slide SVG item above): colors/points
  are controlled today, but arbitrary public-API/loaded input should be escaped.

## Clip-plane / interaction

- [ ] **Fixed-angle Clip toggle.** The `vox.draw.explode` "Clip" checkbox cuts at
  a fixed angle so the right mouse stays free to draw. Rotating the clip plane
  still requires leaving the draw mode (right-drag draws in a draw mode). **Nice
  follow-up:** a modifier — e.g. Shift+right-drag rotates the clip plane while a
  draw mode is active — so both are usable at once (small core change to
  `control/interactions.ts`).

## Drawing caps (acceptable)

- [ ] 3D flood fill and magic wand cap at 4M voxels (warn + stop) to bound a click
  on a huge connected region. Fine in practice; revisit if a legitimate fill
  exceeds it.
- [ ] Magic-wand tolerance cache: `magicWand3D` reads live source data each call
  (no stale cache), but an in-place edit of the source volume between calls isn't
  a concern here — noted for parity with the modulation cache caveat.

## Review pass (2026-07-06) — fixed + remaining

Adversarial review (3 parallel passes: interactions state machine, core
algorithms/coordinate math, range H2 + demos). The core explode-offset math
(`mm2tex` fraction space), nullable-`drawingVol` guards, pointer-capture pairing,
and state-reset coverage were **verified correct**.

**Fixed in commit `d59675af`:** 3D-stroke undo snapshot skipped on a ray-miss
start (HIGH); range H2 gated on `activeSource?.serial` (null during a switch) →
gate on `sourceSerial` (MED); `_drawLabelColor` throw on non-finite label
(MED-LOW); `floodFill3D` stack spike (mark-visited-on-push); degenerate 3D vector
stroke committing an empty annotation; `vox.draw` undo routing in Vector mode;
`vox.draw.explode` `isClipPlaneCutaway` stuck true; eraser-cap comment.

**Remaining (not fixed — mostly by design or pre-existing):**

- [ ] **Vector vs raster intercepts aren't enforced mutually exclusive.** The
  `drawIsEnabled` / `annotationIsEnabled` setters only flip their own flag. If an
  app enables BOTH, a 3D right-drag draws a vector annotation (checked first) and
  the pen/wand/fill never fire. The demos keep them exclusive; core API could.
- [ ] **Asymmetric mid-drag mode guard.** The raster drag branch bails if
  `draw.isEnabled` flips false mid-stroke; the vector drag branch has no
  `annotation.isEnabled` equivalent. Only reachable via a programmatic toggle
  during a drag.
- [ ] **Stroke finalize runs before the `isDragging` reset without try/catch**
  (both the new `finish3DAnnotationStroke` and the pre-existing 2D annotation
  finalize blocks). A throw would strand `isDragging` and stall streaming. Pre-
  existing pattern; wrap in try/finally for robustness.
- [ ] **3D crosshair uses scene fraction with `explodeOffsetMMAtFrac`** while the
  annotation path (correctly) uses texture fraction. They differ when the scene
  AABB ≠ the volume's texture extent (extra meshes / multiple volumes / origin
  flip). Reconcile the crosshair to texture fraction. Pre-existing, out of the
  drawing diff.
- [ ] **Vertices outside the volume get a zero explode offset**
  (`explodeOffsetMMAtFrac` returns `[0,0,0]` when the point isn't in any chunk),
  so a slice-drawn annotation extending past the volume distorts at the boundary
  in the exploded 3D view. Not reachable for block-picked strokes.
- [ ] **H2 is source-scoped, not reload-scoped.** A same-source window/colormap
  reload keeps the serial and resets `stats`; in-flight chunk fetches from the
  previous stream of the same source still satisfy `isLiveSerial` and can double-
  count. Acceptable for a demo HUD.

## Verification targets (2026-07-06, after review fixes)

- [x] `bunx nx run niivue:typecheck`
- [x] `bunx nx run niivue:lint`
- [x] `bunx nx run niivue:test` (621 pass, 0 fail)
- [x] `bunx nx run niivue:build`
- [x] `bun run check-boundaries`
- [x] package `codespell` (clean)

---

# Next session — resume plan (start 2026-07-07)

State: features are at a good stopping point; all correctness bugs from the
review are fixed (commit `d59675af`). Branch `poc-client-only-range-requests`,
all commits local/unpressed (PR #-under-review hold). Everything below is
polish / robustness / optional feature work — nothing blocks. Effort key:
S (<1h), M (half day), L (bigger). **Start with P0** (fast, closes loops on what
we just built), then work down.

## P0 — close loops on this session's work (do first)

1. [x] **(S) WebGL2 spot-check of the 3D-vector-draw flow.** DONE 2026-07-07:
   drew a vector shape directly on an exploded block on `?backend=webgl2` — it
   renders on the block and SVG export yields a valid `<path>` in mm, identical
   to WebGPU. No errors in the WebGL2 flow. Added `?backend=` URL-param support to
   the demo (commit `109c3c63`) to test a backend from page load.
   - NOTE (resolved): WebGPU **view init** flaked mid-session —
     `attachToCanvas` threw `Cannot read properties of null (reading 'queue')`
     from `FontRenderer.resize` → `NVViewGPU._createResources` (device/queue null
     during init), so the demo wouldn't load on the default WebGPU backend
     ("No image loaded"). WebGL2 was unaffected. **A Chrome restart cleared it**
     (WebGPU then loaded clean, no errors), confirming a wedged/lost browser GPU
     device, not a code regression (this path is untouched by the session's work).
     Optional hardening if it ever recurs without a browser cause: guard a
     null/lost `device`/`queue` in the WebGPU init and fall back to WebGL2 (or
     surface a clean message) instead of a bare TypeError.
2. [x] **(S-M) Modifier to adjust the clip plane while in a draw mode.** DONE
   2026-07-07 (commit `4386ca3c`): used **Alt** not Shift (Shift is reserved for
   the context menu). Gated the two 3D-draw pointer-down intercepts on
   `!evt.altKey`, so Alt+right-drag falls through to the clip-plane rotation path
   while plain right-drag draws. Verified in-browser (WebGPU): Alt+right-drag
   rotates the cutaway with no paint; plain right-drag paints on a block.

## P1 — robustness / correctness the review flagged

3. [ ] **(S) Wrap stroke finalize in try/finally.** `finish3DAnnotationStroke`
   (and the pre-existing 2D annotation finalize blocks) run before the
   `isDragging = false` reset with no guard; a throw strands `isDragging` and
   stalls chunk streaming (gated on `!isDragging`). Wrap so cleanup always runs.
4. [ ] **(S-M) Reconcile the 3D crosshair fraction space.** `NVCrosshair.ts`
   passes `scene.crosshairPos` (scene fraction) to `explodeOffsetMMAtFrac`, while
   the annotation path (correctly) passes texture fraction; they differ with
   extra meshes / multiple volumes / origin-flip. Convert the crosshair to
   texture fraction (via `mm2tex`) or document why scene fraction is intended.
5. [ ] **(S-M) `annotationsToSVG`: export all planes, not just the first.** In
   render/multiplanar it falls back to `annotations[0].sliceType`, so shapes on
   mixed planes only partly export. Emit a `<g>` per slice plane (or group by
   plane) so every shape lands in one SVG. Add a test.
6. [ ] **(S) SVG field escaping.** `annotationsToSVG` / `SlideVectorLayer.toSVG`
   assume controlled color/points; escape/validate for arbitrary public-API or
   loaded-document input. Cheap hardening (shared with the slide-SVG TODO above).
7. [ ] **(S) Enforce (or intentionally define) vector-vs-raster exclusivity.**
   If an app enables both `drawIsEnabled` and `annotationIsEnabled`, a 3D
   right-drag draws vector and the pen/wand/fill never fire. Either make one
   setter clear the other, or document the priority. Also add the missing
   `annotation.isEnabled` mid-drag guard to the vector drag branch (mirror the
   raster branch's `draw.isEnabled` check).

## P2 — UX / feature polish

8. [ ] **(M) On-top render option for 3D annotations.** 3D annotations render at
   their true slice depth, so interior shapes are hidden inside the block unless
   a clip plane cuts to them. Add an opt-in "always visible" mode (draw the
   annotation fill/stroke with depth-test off / after the volume) so shapes show
   without a clip plane. Design decision: default off (keep depth-correct).
9. [ ] **(S) Re-surface the raster `drawingToSVG` export** in a dedicated demo or
   behind a toggle (method + tests already exist; the button was pulled from
   `vox.draw.explode` to avoid confusion with the vector SVG).
10. [ ] **(S-M) Explode-offset boundary behavior.** Decide clamp-vs-document for
    (a) annotation vertices outside the volume (`explodeOffsetMMAtFrac` → zero
    offset → boundary distortion) and (b) a polygon spanning two blocks (per-
    vertex offsets stretch across the gap). Fine for block-picked strokes; matters
    for slice-drawn annotations shown in the exploded 3D view.

## P3 — larger design (decide before starting)

11. [ ] **(L) Non-planar 3D annotation type.** The real fix for free-form drawing
    on 3D blocks: store arbitrary 3D polylines instead of a planar slice polygon,
    so oblique/curved strokes aren't flattened. Touches the annotation model,
    both renderers, and SVG export (3D→2D projection choice). Scope it and
    confirm it's wanted before committing.

# Usability review (2026-07-07)

Hands-on pass over `vox.draw.explode` (the wand flood verified live; the rest
traced through the interaction logic). Overall the tools work and are powerful;
these are places the behavior may not match a first-time user's expectation.
Most are demo-level UX; a couple touch core defaults.

## High

- [x] **(quick win) Magic wand floods more than expected.** DONE 2026-07-07
  (commit `570c6625`): flipped `DRAW_DEFAULTS.clickToSegmentIs2D` to true so a
  2D-slice wand click grows a bounded in-slice region; block right-click stays 3D
  by design. Verified: a click now fills a local patch, not the whole ribbon.
  Later polish (open): lower default tol / hover preview.
- [x] **(M) Ambiguous tool model — controls silently conflict.** DONE 2026-07-07
  (commit `2711a2fa`): consolidated `vox.draw.explode` to a single **Tool**
  selector (Pen/Eraser/Fill/Magic wand/Vector/Off) + separate **Color**, with each
  tool enabling only its relevant options (Color off for Eraser/Off, Size for
  Pen/Eraser, Tol+2D for Wand, SVG for Vector). One mode active at a time; no
  silent conflicts. Verified all six tools. (Note: `vox.draw` uses a different,
  already-single-selector model and wasn't touched.)

## Medium

- [ ] **2D draws with left-drag, 3D with right-drag.** A user learns left-drag on
  slices, then left-drag on 3D orbits the camera (no draw). Inherent (left must
  orbit 3D) but a real inconsistency; low discoverability.
- [ ] **3D drawing silently requires Explode ON.** With explode off, right-drag on
  the render rotates the clip plane instead of drawing; a user won't know they
  must explode to draw in 3D.
- [~] **(quick win) Discoverability.** Added `title` tooltips to every
  `vox.draw.explode` control (commit `570c6625`). Still open: cursor cues, an
  active-tool indicator, and de-densifying the help line.
- [ ] **3D render is easy to miss** in the default multiplanar view (small
  quadrant); the headline "draw on blocks" surface isn't front-and-center.
  Consider a hero/render-forward default layout.

## Low

- [ ] Single right-click in Vector mode on a block does nothing (needs a 3+ point
  drag) → feels unresponsive; add a status hint.
- [ ] Wand "Tol" units (% of window) only in a tooltip (add a visible unit / value).
- [ ] No swatch/cursor reflecting the active color/tool.
- [ ] "Overwrite" semantics are subtle (tooltip added).
- [ ] **Core-default question:** should the *core* `clickToSegmentIs2D` default to
  2D (done now, since the feature is unreleased) — confirm this is the desired
  library default, not just the demo default.

## Also parked (outside the drawing work)

- [ ] **(M-L) Sparse NVDocument settings: fall back to CURRENT options, not
  defaults.** Requested 2026-07-07. When a loaded `.nvd` omits a setting (a
  "sparse" document), the missing values currently resolve to the built-in
  DEFAULTS. Add a way for a dev to declare that specified settings should instead
  be read from the **current live niivue options** on the instance when the
  document doesn't specify them. Shape TBD — e.g. a load option listing which
  option keys (or groups: scene/layout/ui/volume/mesh/draw/annotation/interaction)
  are "inherit from current" vs "reset to default", applied per-key during
  `loadDocument`/`applyScene` where a value is absent. NOTE: sparse/partial
  settings serialization may not be fully implemented yet (cf. the FEATURE_PARITY
  "sparse / dataless document" rows — mono currently always embeds and the
  restore path is default-or-embedded), so this likely pairs with defining what
  "a document omits setting X" means on the serialize side first. Backlog only;
  not scheduled.
- Slide-plane review items (renderer cache lifecycle, memory budget, `.nvd`
  restore contract, magic-wand reference bounding) — see the top of this doc;
  all "acceptable for now".
- `empty-brick-skip-proposal.md` (chunked-volume perf) — not scheduled.
- Demo-hardening "nice / latent" items in `demo-hardening-audit.md` (range M1/M2/
  M4/M5, slides M1, pointer-capture LOWs).

## Suggested first move tomorrow

Do P0.1 (WebGL2 check) to warm up + confirm parity, then P0.2 (clip-plane
modifier) since it's the last piece of the "draw on blocks with a clip plane"
request. Then sweep P1 (all small, all robustness). Re-run the full gate after
each batch; commit locally per the review hold.
