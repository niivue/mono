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
  restore overlay; bounding the magic-wand reference; formal undo/clear contract.
  Reasons noted inline per item. (SVG field escaping was on this list; it was
  resolved 2026-07-08 — see the SVG export section.)

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

- [x] Escape or validate SVG vector annotation fields before export. DONE
  2026-07-08 (`0c71711c`): `SlideVectorLayer.toSVG` was interpolating `shape.color`
  raw, so a hostile value broke out of `stroke="…"`. Colors now go through
  `safeCssColor` (allowlist, falls back to `none`) and all numbers through
  `svgNumber` (NaN/Infinity -> `0`). Shared helpers in `src/NVSvg.ts`.
  (Superseded rationale: this was triaged "acceptable for now" on the grounds that
  every in-repo path passes a controlled `#rrggbb` and the SVG is downloaded rather
  than inlined into the DOM. Still true — but `color` is public API, so it is now
  validated at the boundary instead of trusted.)

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
- [x] **SVG field escaping** (shared with the slide SVG item above) — DONE
  2026-07-08 (`0c71711c`); see the SVG export section above.

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

**All five done 2026-07-08** (commits `e707b728`, `0c71711c`, `b3ebd681`,
`529a2b84`). Full gate green after each; codespell clean.

### Second review pass (2026-07-08, commit `6c90a2e2`)

A follow-up review of the P1 work found five real defects in it. Two are traps
worth remembering:

1. **The pointerup `finally` was not exception-safe.** `resetDragState` ends with
   `isDragging = false`, and that SETTER CALLS `drawScene()` — so the "cleanup"
   helper renders, and could throw before `releasePointerCapture` ran, stranding
   exactly what the `finally` existed to protect. Capture is released first now,
   and the rendering statement is last in the helper.
2. **A throwing finalize REPLAYED the stroke.** `_drawPenFillPts` and friends are
   cleared at the END of their branch (after the call that can throw) and were
   absent from `resetDragState`, so the next bare pointerup re-committed a stroke
   the user never drew. Same latent bug on pointercancel; both fixed.
3. `svgNumber` mapping a non-finite vertex to `0` MOVED it to the panel origin,
   quietly self-intersecting the ring — worse than the old `NaN`, which at least
   failed loudly. `ringPath` drops non-finite vertices now; a bad `stroke-width`
   falls back to 1, not 0 (invisible).
4. `slicePosition` silently applied ACROSS planes once `sliceType` became optional
   (a depth means z/y/x depending on the plane). It requires a plane now, and warns.
5. Panel-local coords made the export non-invertible; each `<g>` now carries
   `data-origin-mm`. Negative `pad` is clamped. Dead `escapeXmlAttr` removed.

Regression tests for 1 and 2 live in `e2e/drag-state-recovery.spec.ts`, each
confirmed to FAIL against the pre-fix code. `e2e/annotation-interaction.spec.ts`
pins draw/select/resize (the selection must SURVIVE pointerup while the drag state
must not) plus the raster-over-vector priority and its warning.

**Verification:** 690 unit + 14 e2e green; typecheck / lint / build / boundaries /
codespell clean. All 55 demo pages smoke-loaded with zero console errors (the sole
exception, `vox.min.webgpu.html`, correctly refuses to run when the harness removes
`navigator.gpu`). Hand-exercised in a real browser: `vox.draw.explode` (2D pen, 3D
block pen, Alt+right-drag rotates without painting, vector draw, SVG export, undo)
on WebGL2 and WebGPU; `slide3d` vector SVG export (stroke colour survives
`safeCssColor`); `vox.draw`, `vox.tiled`, `slides`, `vox.basic`.

Note: WebGPU chunk streaming for `vox.draw.explode` takes ~35 s on this machine
(the volume-load worker fails `postMessage` and falls back to a main-thread decode
that blocks JS). Reproduced identically on the pre-session baseline via a worktree
— NOT a regression, but it makes the demo look broken for the first half-minute.

### The five P1 items

3. [x] **(S) Wrap stroke finalize in try/finally.** DONE (`e707b728`). The
   pointerup finalize work is wrapped; the state reset + `releasePointerCapture`
   moved into the `finally`. Extracted `resetDragState()`, shared with
   pointercancel and now a superset — a cancelled drag also clears the 2D
   annotation preview / brush path (previously stranded). The pointerUp emits run
   after the `finally` and are intentionally skipped on a throw.
4. [x] **(S-M) Reconcile the 3D crosshair fraction space.** DONE (`529a2b84`).
   `crosshairExplodeOffset` now takes world mm + `mm2tex` and converts to texture
   fraction, exactly as the annotation path does, so the two agree by
   construction. Both backends updated. The math moved to a new pure module
   `view/crosshairExplode.ts` (NVCrosshair pulls in the mesh `import.meta.glob`
   graph, so it is unreachable from the Bun runner); unit-tested, including a case
   proving scene fraction picks the *opposite* block.
5. [x] **(S-M) `annotationsToSVG`: export all planes, not just the first.** DONE
   (`0c71711c`). `sliceType` is optional; omitting it emits one
   `<g data-slice-plane=…>` panel per plane, laid out left-to-right in
   panel-local coordinates (a plane's two in-plane axes differ per sliceType, so
   panels cannot share a frame). The controller omits it when no single slice
   plane is on screen, and still restricts to it when one is. Tested.
6. [x] **(S) SVG field escaping.** DONE (`0c71711c`). The real hole was
   `SlideVectorLayer.toSVG` interpolating `shape.color` (a raw string) into
   `stroke="…"` — `#fff" onload="…` broke out. Colors are validated against a
   CSS-color allowlist (`safeCssColor`, falls back to `none`). All numbers go
   through `svgNumber`, which collapses NaN/Infinity to `0` (a non-finite number
   in a path `d`/`viewBox` makes the document unrenderable). `annotationsToSVG`
   was already injection-safe via numeric coercion but could emit `NaN`. Shared
   helpers in `src/NVSvg.ts`, unit-tested with the escape payloads.
7. [x] **(S) Enforce (or intentionally define) vector-vs-raster exclusivity.**
   DONE (`b3ebd681`). Chose "define the priority" over mutating state in a setter.
   One rule (`rasterDrawWins()`): raster drawing takes precedence when it can
   actually draw (`draw.isEnabled` + a `drawingVolume` exists). That matches the
   pre-existing 2D behavior, so only the 3D render-tile case changes. The first
   genuinely ambiguous pointerdown warns, once per instance — the warning is at
   the interception point, NOT in the setters, because a caller legitimately
   passes through a both-on state while switching tools (the `vox.draw.explode`
   selector did; it now leaves the outgoing mode first). Both missing vector
   guards added: the mid-drag branch checks the live `annotation.isEnabled`, and
   `finish3DAnnotationStroke` discards (not commits) a stroke whose mode was
   turned off mid-drag.

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

- [x] **2D draws with left-drag, 3D with right-drag.** ADDRESSED 2026-07-07
  (commit `b42531b3`): the contextual hint line now spells out the gesture per
  view — "2D slice: left-drag …; 3D block: right-drag a block …" — so the split
  is explicit. (The interaction itself is inherent: left must orbit the 3D
  camera.)
- [x] **3D drawing silently requires Explode ON.** ADDRESSED 2026-07-07
  (commit `b42531b3`): with explode off, the hint's 3D clause becomes a warning
  "turn on Explode to draw on the 3D blocks."
- [x] **(quick win) Discoverability.** `title` tooltips on every control
  (`570c6625`) + a contextual, tool/view/explode-aware hint bar that acts as the
  active-tool indicator (`b42531b3`) + a tool-reflecting canvas cursor (crosshair
  for Pen/Eraser/Vector, cell for Fill/Wand, default for Off; commit `81718831`).
- [x] **3D render is easy to miss** — DONE 2026-07-07 (commit `81718831`): a new
  default "Hero (3D + slices)" View puts the exploded blocks in a large hero tile
  (heroFraction 0.6, heroSliceType RENDER) with an A/C/S slice strip beside them,
  so the headline surface is front-and-center while 2D slices stay usable. Other
  View entries set heroFraction 0 (hero off); the hero render tile is a live
  render tile (orbits on left-drag; same isRender hit-test powers block-drawing).

## Low

- [x] Single right-click in Vector mode does nothing → covered by the contextual
  hint wording ("drag to draw a polygon"), which implies a drag not a click
  (commit `b42531b3`).
- [x] Wand "Tol" units → live "%" readout next to the slider (commit `995a0fee`).
- [x] Color swatch reflecting the active color (dimmed when it doesn't apply) —
  commit `995a0fee`. (A tool-reflecting cursor is still deferred; see Medium.)
- [x] "Overwrite" semantics — tooltip added (`570c6625`).
- [x] **Core-default question — CONFIRMED 2026-07-07:** the core
  `DRAW_DEFAULTS.clickToSegmentIs2D` stays `true` (2D). Rationale (per the user):
  the **3D drawing/segmentation features are the most experimental**, so the safe,
  Photoshop-like 2D behavior is the library default and the 3D grow is opt-in.
  Use this as the guiding principle for other draw/annotation defaults too:
  **2D = stable default; 3D-on-exploded-blocks = experimental, opt-in.**

## Also parked (outside the drawing work)

- [x] **(M-L) Sparse NVDocument settings.** DONE 2026-07-07/08 (`29f943e8` +
  `9d6bcb48`). SAVE side: `serialize` omits any setting equal to its default (all
  8 groups incl. annotation); control via `nv.settingsSavePolicy`
  (`neverSave`/`alwaysSave`). LOAD side (revised per user 2026-07-08 — "what's in
  the NVD overrides everything; a sparse NVD is filled by defaults or current;
  default is defaults"): a specified setting always wins; an omitted setting is
  filled per a **fill policy** — DEFAULT resets to the built-in default (so a
  document is a complete scene), `'current'` keeps the instance value. Control via
  `nv.settingsFillPolicy` + per-call `loadDocument(src, { fill })`, by group or
  `'group.key'`. Crosshair persistence = `{ 'scene.crosshairPos': 'current' }`.
  `documentSettings.ts` (`sparsifyGroup`/`fillGroup`); unit-tested + e2e-verified.
  NVD v8 -> 9. The earlier "keep current by default" behavior was corrected to
  "defaults by default" (resolves the review's headline finding), and
  annotationConfig is now sparse+filled like the other groups.
- [x] **Linked NVD documents (reference volumes by URL, don't embed).** DONE
  2026-07-07 (commit `56f2a21f`). `saveDocument`/`serializeDocument` take
  `{ linkData: true }`: a volume with a fetchable URL is serialized without its
  bytes and the loader refetches it (`reconstructVolume` already had the URL-
  fallback branch). Volumes with no linkable URL still embed (+warn) so the doc
  round-trips. serialize's 3rd arg is now `SerializeOptions` (`{ settings,
  linkData }`). Verified: linked mni152 doc ~1 KB vs ~11 MB, reload refetches.
  Tests (`documentLinkData.test.ts`): pure link decision (`isLinkableUrl`/
  `shouldLinkVolume`) + a CBOR wire-contract round-trip (linked vol has url + no
  `data`) using real niivue test-image URLs, plus an opt-in network test
  (`RUN_NETWORK_TESTS=1`) that fetches the live test image. Full fetch->reload
  round-trip stays browser-verified (needs NiiVue's import.meta.glob graph + GPU).
  Follow-up (not done): **meshes still always embed** — the mesh URL-restore path
  doesn't reapply overlay layers / tract/connectome options, so linking a mesh
  would silently drop that state; needs `reconstructMesh`'s `else if (m.url)`
  branch extended to reapply layers + tract/connectome options first.
- Slide-plane review items (renderer cache lifecycle, memory budget, `.nvd`
  restore contract, magic-wand reference bounding) — see the top of this doc;
  all "acceptable for now".
- `empty-brick-skip-proposal.md` (chunked-volume perf) — not scheduled.
- Demo-hardening "nice / latent" items in `demo-hardening-audit.md` (range M1/M2/
  M4/M5, slides M1, pointer-capture LOWs).

## Suggested first move tomorrow

SUPERSEDED — P0 and P1 are both complete (2026-07-07 / 2026-07-08). Next up is
**P2** (UX / feature polish): item 8 (on-top render option for 3D annotations) is
the only one with real design content; 9 and 10 are small. P3 item 11 (non-planar
3D annotation type) still needs scoping + a go/no-go from the user before any
code. Everything remains local/unpushed per the review hold.
