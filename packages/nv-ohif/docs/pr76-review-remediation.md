# PR #76 review remediation plan

Two rounds of workflow-backed review (high, then xhigh) of the measurement /
annotation unification on `ohif-viewer-integration`, including a review of a
commit made by a second agent (Codex, `3bf0798f fix(nv-ohif): harden measurement
reflection`). This tracks the verified findings and how each is being addressed.

Findings are anchored to code at the time of review. Line numbers drift; anchor by
symbol.

## Verified findings

### [0] slice2DToMM argument swap (Codex) — CONFIRMED, high

`packages/nv-ohif/src/commands.ts`, `annotationPointToLps`.

Calls `slice2DToMM(point, annotation.sliceType, annotation.slicePosition)`, but the
signature is `slice2DToMM(point, slicePosition, sliceType)` (every niivue caller
passes it that way). The last two args are swapped.

- Coronal/sagittal annotations: wrong plane orientation AND wrong depth (falls into
  the AXIAL branch because the depth value never equals CORONAL(1)/SAGITTAL(2)).
- Axial annotation at non-zero depth: depth collapses to `sliceType` (0), so points
  land on z=0 instead of the real slice.
- Masked by the unit test, which uses `sliceType=0, slicePosition=0` (both orders
  coincide).

Fix: pass `(point, annotation.slicePosition, annotation.sliceType)`. Add a
regression test on a coronal slice at a non-zero `slicePosition`.

### [1] EllipticalROI point order (Codex) — CONFIRMED, high

`packages/nv-ohif/src/commands.ts`, `annotationPointsLps` `measureEllipse` branch.

Emits `[top, right, bottom, left]`. cornerstone3D's EllipticalROI value type reads
consecutive pairs as the two axes (`points[0..1]` one axis, `points[2..3]` the
other). Interleaved order makes the pairs the bounding-box diagonals, so a
reconstruction / SR export / cached-stats computes a rotated, mis-sized ellipse.

Fix: emit axis-endpoint pairs `[top, bottom, left, right]` (pair 0-1 = vertical
axis, pair 2-3 = horizontal axis). Verify against cornerstone3D's EllipticalROI
point contract. Add a test asserting the pair order.

### [2] reconcile regenerates measurement uids (my code) — CONFIRMED, medium

`packages/nv-ohif/src/commands.ts`, `reconcileNiivueAnnotations` (added in the
prior review-fix commit). It clears every reflected row and re-adds each live
annotation with a freshly incremented uid. Editing annotation A also re-mints B's
uid, so OHIF panel selection / jump-to-measurement on the untouched B breaks.

### [3] reconcile is non-transactional (my code) — PLAUSIBLE, medium

Same function. It removes ALL rows first, then re-reflects. If a re-reflect
transiently fails (backing series not resolvable that instant, or a points-guard
drop), that row is gone and not restored until a later reconcile happens to
succeed. The user loses rows they never edited.

Fix for [2]+[3] (single rewrite): make reconcile diff-based against the live
annotation set, keyed on annotation id:
- Remove rows only for annotations no longer present (precise; survivors untouched).
- Add rows only for annotations not yet reflected.
- For a survivor whose content changed (stats/points/text), update in place via
  `measurementService.update(uid, ...)` preserving the uid; skip if unchanged
  (track a per-annotation content hash: `id -> { uid, hash }`).
- Guard the label-sync loop: `applyOhifLabelToAnnotation` must no-op when the
  annotation text is already equal, so our own `update` (which fires
  MEASUREMENT_UPDATED) does not bounce back through `subscribeOhifLabelSync`.
- Fallback: if `measurementService.update` is absent, remove+re-add that one
  annotation (only the changed one churns). Never clear-all.
`measurementService.update` interplay is browser-only-verifiable — verify on the
rig (draw two ROIs, select one, resize the other, confirm the selected row keeps
its selection and the resized row's stats refresh).

## Refuted (no action)

- points-guard "drops a one-axis bidirectional": refuted 5x. A completed
  bidirectional always carries both axes before `annotationAdded` fires, so
  `annotationPointsLps` yields 4 points; the guard never trips for a real
  bidirectional. Leave the guard.
- index.ts biome-ignore broadened to include organizeImports: not a defect.

## Prior review fixes — confirmed still intact

Re-verified by the second review, not flagged as regressed: multi-click depth fix
(now the extracted, unit-tested `shouldStartFreshMultiClickContour`),
`onAnnotationChanged` reconcile-on-non-draw, unmount `clearNiivueAnnotations`, the
`projectAnnotationScreenShapes` `isAnnotationDrawn` gate, and the `IN_PLANE_AXES`
consolidation. GL/WebGPU parity unaffected (shared projector).

## Order of operations

1. [0] arg-swap + coronal/non-zero-depth test.
2. [1] ellipse pair order + test.
3. [2]+[3] diff-based reconcile with update-in-place + loop guard + fallback;
   unit-test the diff logic with a stubbed update; rig-verify the update path.
4. Full gate (format/lint/typecheck/test/build/codespell) across niivue, uikit,
   nv-ohif; deploy to the rig; manual pass of resize/move/undo with two ROIs.
5. Commit; push on explicit request.

## Docs touched by Codex (verify, low priority)

- README DICOM "unshipped-dependency caveat" removed: accurate only if
  `@niivue/dcm2niix` is actually published (the DICOM support section says
  `1.3.20260724` is). Confirm, keep removed if so.
- PLAN.md point-geometry open-item removed: correct now that point geometry is
  implemented (once [0]/[1] land).

---

# Round 2 (2026-07-30): review of Codex commits 28d08284 + 6fc1ab8a

xhigh review of the two follow-up commits ("complete measurement reflection
hardening" and "render default annotation labels"). 9 findings survived
verification (8 refuted). NO fixes applied yet; this is the plan.

## Must-fix (confirmed correctness)

### R2-0 update-in-place recursion -> stack overflow (HIGHEST)

`reconcileNiivueAnnotations` + `subscribeOhifLabelSync`. Commit 28d08284 changed
the "changed annotation" branch from remove+re-add to update-in-place:
`reflectNiivueAnnotation(..., existing.uid)` reuses the uid, so real OHIF
`addRawMeasurement` UPSERTs and synchronously broadcasts `MEASUREMENT_UPDATED`.
The label-sync subscriber then calls `applyOhifLabelToAnnotation` ->
`nv.setAnnotationText`, which emits `annotationChanged{move}` even for identical
text (NVControlBase ~1652), re-entering `onAnnotationChanged` -> reconcile. The
stored hash is updated only AFTER `addRawMeasurement` returns, so the re-entrant
reconcile still sees a mismatch and reflects again -> update -> MEASUREMENT_UPDATED
-> ... until "Maximum call stack size exceeded". The test mock never emits
MEASUREMENT_UPDATED, so the suite is green while real OHIF crashes on any
resize/move/label-edit.

Fix (defense in depth):
- Guard `applyOhifLabelToAnnotation`: no-op when the annotation's current text
  already equals the incoming label. This breaks the loop at the boundary
  (rowLabel == annotation.text once applyDefaultAnnotationText has stamped it).
- Update `byView`'s stored `{uid, hash}` BEFORE calling `addRawMeasurement`, so a
  synchronous re-entrant reconcile sees the fresh hash and skips.
- Add a per-viewport re-entrancy guard around reconcile so our own updates cannot
  re-drive it.
- Alternative (simpler, provably loop-free): revert to remove+re-add. `remove`
  fires MEASUREMENT_REMOVED and `add` fires MEASUREMENT_ADDED, neither of which
  the label sync listens to, so no loop. Cost: the edited row's uid churns (loses
  its own selection) — acceptable. Decide guard-based vs revert.

### R2-1 reconcile ignores reflect's false return -> permanent stale row

`reconcileNiivueAnnotations` update branch calls `reflectNiivueAnnotation(...,
existing.uid)` without checking the boolean. On a false return (degenerate shape
under `minPoints`, transient `resolveBackingSeries` undefined, or `addRawMeasurement`
returns undefined) `byView` keeps the OLD hash + uid, so the row shows stale
geometry forever AND every later `annotationChanged` re-runs the failing reflect
(churn). Fix: use the return; on false for an existing row, remove the row +
bookkeeping so state stays consistent (or leave hash but stop re-attempting).

### R2-2 'draw' skipped, but mergeAnnotations consumes reflected annotations

`onAnnotationChanged` skips `action === 'draw'`, but niivue's `mergeAnnotations`
(fired on draw) can union/cut a PREVIOUSLY reflected annotation out of
`nv.annotations` with no `annotationRemoved` event, so its panel row lingers.
Fix: reconcile on 'draw' too (membership diff removes the consumed one; the newly
added one is already reflected by `onAnnotationAdded`). Depends on R2-0 being
fixed first so reconcile is loop-safe.

### R2-3 'ROI #N' stamped on Length/Arrow/Bidirectional

`applyDefaultAnnotationText` sets `text = 'ROI #N'` guarded only on empty text,
not tool type, so `reflectNiivueAnnotation`'s rowLabel becomes 'ROI #N' for a
Length ruler or an Arrow (semantically wrong; overrides the tool-specific label).
The user DID want default text on arrows, so keep default labels but make them
tool-aware (e.g. 'Length #N' / 'Arrow #N' / 'ROI #N', or reuse the tool label +
number).

### R2-4 ROI numbering collides after a deletion

Index-based `count = findIndex(...) + 1` reuses a number after a delete: draw #1
#2, delete #1, draw new -> live is [survivor(idx0), new(idx1)] -> new is labeled
'ROI #2', colliding with the survivor's persisted 'ROI #2'. Fix: monotonic
per-viewport counter (never reuse), or `max(existing #N) + 1`.

### R2-5 hash source mismatch: pre-merge event vs post-merge clone

`onAnnotationAdded` passes the pre-merge event object to `reflectNiivueAnnotation`,
which stores `hash(preMerge)`. But `nv.annotations` holds a clone
`{...newAnnotation, polygons: mergedPolygons}` (clipper output). Reconcile hashes
the clone, so for any polygon tool (freehand/spline/livewire) the hashes disagree
for a shape the user never touched -> needless re-reflect (and, pre-R2-0-fix, feeds
the loop). Fix: reflect should hash the STORED post-merge annotation (look up by id
in `nv.annotations`), or `onAnnotationAdded` should reflect the merged annotation.

## Plausible (should-fix / verify)

### R2-6 duplicate rows if addRawMeasurement appends instead of upserts

Update-in-place assumes `addRawMeasurement` upserts by the reused uid. The R2-0
trace found real OHIF DOES upsert (that's why it broadcasts MEASUREMENT_UPDATED),
so duplicates are unlikely on the deployed build — but the invariant "one row per
annotation" now rests entirely on that. If we revert to remove+re-add (R2-0
alternative) this concern disappears. Otherwise verify on the rig.

### R2-7 clear/remove drop bookkeeping even when remove is absent

`measurementService.remove` is optional. clear/remove call `remove?.(uid)` then
unconditionally delete internal maps, so if the host lacks `remove` the panel rows
orphan with no way to reclaim them. Low likelihood (OHIF has remove); guard by only
deleting bookkeeping when `remove` exists.

### R2-8 reconcile re-runs full reflect per drag step (perf)

If `annotationChanged{resize|move}` fires per pointer step, each runs full reflect
(resolveBackingSeries loop + points/LPS/display + addRawMeasurement) on the
interaction hot path. Coalesce (rAF/debounce) or reflect only on the terminal
event. Verify whether resize/move fire per-step or on release first.

## Refuted (no action) — 8

Keying bookkeeping on addRawMeasurement's RETURN value is correct; addMapping with
`points` undefined is valid; directly mutating the stored annotation's `.text` is
acceptable; the passed-uid vs return-uid divergence is handled; label-sync pushing
the internal fallback label as user text (does not occur since applyDefaultAnnotationText
always sets text first); reconcile's new-annotation branch missing applyDefaultAnnotationText.

## Recommended order

1. R2-0 first (unblocks everything; pick guard-based or revert to remove+re-add).
2. R2-5 (hash the stored annotation) + R2-1 (honor false return) — both remove
   spurious reflects that also stress R2-0.
3. R2-2 (reconcile on draw) once reconcile is loop-safe.
4. R2-3 + R2-4 (tool-aware default label + monotonic numbering).
5. R2-7, R2-8 (guards + coalescing).
6. Add a test with a MEASUREMENT_UPDATED-emitting mock so the recursion can never
   regress silently again. Full gate + rig verification of resize/move/undo/label
   edit with two ROIs.
