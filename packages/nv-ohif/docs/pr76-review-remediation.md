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

---

# Round 3 (2026-07-30): review of round-2 fixes (0cbe70e8) + Codex 83c30abc

Two high reviews: one on the round-2 recursion/label fixes, one on Codex's
"preserve reflected annotation geometry" commit. Findings merged and deduped. NO
fixes applied yet.

## Must-fix (confirmed correctness)

### R3-0 reflect-failure deletes the row + churns the uid (dominant; unifies R2-1, R2-4, and the freehand-guard fallout)

reconcile's update branch does `if (!ok) removeNiivueAnnotation(...)`, and the new
branch ignores the false return and re-attempts every event. So:
- A freehand edited into a hole / two components (Codex's new guard makes reflect
  return false) has its panel row + stats DELETED mid-edit; simplifying it back
  re-adds it with a fresh uid (lost selection/tracking).
- A transient backing-series miss deletes and re-mints.
- A permanently-unreflectable annotation (NIfTI-URL viewport, no backing series)
  re-runs a doomed reflect on every pointer event.

Fix (one change): on reflect-failure do NOT remove the row. Make `ReflectedRow.uid`
optional and, on failure, store `{ uid: existing?.uid, hash: currentHash }` — a
"negative cache". Effect: the uid is preserved (no churn), the stale row stays
(better than vanishing), and because the stored hash now equals the current one we
STOP re-attempting until the geometry actually changes again (kills the thrash).
removeNiivueAnnotation/clearNiivueAnnotations skip the OHIF remove for a
uid-less entry but still delete bookkeeping.

### R3-1 arrow points are reversed (Codex 83c30abc)

annotationPointsLps emits arrow points as `[start, end]`, but niivue's
`shape.end` is the arrowHEAD/tip (generateArrow) while cornerstone3D ArrowAnnotate
takes `points[0]` as the arrowhead / annotated location. Jump-to-measurement and
SR export target the empty tail instead of the lesion the arrow points at. Fix:
emit `[end, start]` (tip first).

### R3-2 a label cannot be cleared; the internal default leaks onto the canvas

Clearing a measurement's label in OHIF reverts it to the generic `NiiVue <Tool>`:
reflect's `rowLabel` falls back to that default when `annotation.text` is empty,
and the echo writes it back onto the shape. Fix: `rowLabel = annotation.text ?? ''`
(no `NiiVue <Tool>` fallback — applyDefaultAnnotationText already supplies the
real default on add), so a cleared label stays blank and the echo carries `''`,
which the unchanged-text guard absorbs.

### R3-3 R2-7 introduced an unbounded leak — revert it

Keeping bookkeeping when `measurementService.remove` is absent means unmount never
clears the maps, which grow forever across mount/unmount. The rows can't be
removed anyway when `remove` is absent, so keeping bookkeeping does not help. Fix:
revert R2-7 — always delete bookkeeping (best-effort `remove?.()`).

## Should-fix (plausible)

### R3-4 undefined MEASUREMENT_UPDATED label clears the canvas text

subscribeOhifLabelSync passes `m.label ?? ''`, so an update that omits `label`
(tracking/cachedStats change) clears the user's on-canvas label. Fix: only apply
when `typeof m.label === 'string'`; treat missing as no-op.

### R3-5 arrow mapping registration points:1 disagrees with the 2-point payload

ANNOTATION_TO_OHIF.arrow still registers `points: 1` while emitting 2. Fix: set
`points: 2` to match (verify OHIF ArrowAnnotate accepts the value type with 2
points on the rig; if not, reconsider the 2-point change).

## Cleanup

### R3-6 recursion regression test doesn't isolate the re-entrancy guard

The test passes with only the unchanged-text guard (removing just the re-entrancy
guard still stays under the bound). Fix: add a variant whose echo carries a label
that CHANGES each time (so the unchanged-text guard never fires), leaving the
re-entrancy guard as the sole thing preventing overflow.

### R3-7 content hash stringifies all vertices per annotation per event

annotationContentHash now JSON.stringify's every polygon outer+holes for each live
annotation on every reconcile. Fine for typical counts; revisit with a cheaper
fingerprint if dense freehand/spline editing shows latency.

### R3-8 degenerate zero-length arrow (start==end) passes minPoints:2

A click-without-drag reflects a 1-pixel arrow. Optional: reject when start==end.

## Recommended order
R3-0 (unifies the biggest cluster) -> R3-1 -> R3-2 + R3-4 -> R3-3 -> R3-5 ->
R3-6; R3-7/R3-8 optional. Then full gate + rig verification (freehand hole edit,
arrow direction on jump, label clear, resize selection-stability).

---

# Round 4 (2026-07-30): review of Codex 756cb9c9 / c23d4502 (post round-3)

xhigh review. Codex reworked commands.ts (~276 lines), added the core
annotationMergesOverlaps option + storeAnnotation, and a new jump-to-measurement
feature. The good parts (merges-overlaps default-true preserves prior behavior;
storeAnnotation; the permanent-vs-retryable status split; jump feature) are sound
in shape, BUT the refactor SILENTLY REVERTED round-2/3 hardening and deleted the
tests that guarded it. 7 defects, 5 correctness (1 refuted).

## Regressions of prior fixes (must restore)

- R4-0 (was R3-0): the `permanentlyUnsupported` reconcile branch now DELETES a
  previously-reflected row when a valid shape is edited into an OHIF-unrepresentable
  geometry (freehand hole / split). Round-3 kept the row + uid + user label
  (negative cache). Restore: keep the row, do not remove.
- R4-1 (was R3-3): removeNiivueAnnotation returns false WITHOUT clearing bookkeeping
  when measurementService.remove is absent, and reconcile ignores the return — the
  unbounded-map leak is back. Restore: always delete bookkeeping (best-effort remove).
- R4-2 (was R3-0): the negative cache for RETRYABLE failures was removed (comment
  now "Transient failures are never cached"), so reconcile re-runs a full reflect
  (incl. addRawMeasurement) on every annotationChanged for a persistently
  un-reflectable series. Restore: negative-cache retryable failures by content hash.
- R4-3 (was R2-3/R3-3): tool-aware default labels removed; every tool is stamped
  'ROI #N' again (an arrow labeled 'ROI #3'). Restore the per-tool prefix (Arrow /
  Length / Bidirectional / ROI).
- Deleted tests to reinstate: 'keeps the row + uid on a failed update and stops
  re-attempting (R3-0)' and 'applyDefaultAnnotationText labels by tool and never
  reuses a number'.

## New defects in Codex's additions

- R4-4 (jump, CONFIRMED): jumpToNiivueMeasurement prefers annotation.anchorMM, which
  is the drag-START corner of a 2D shape (arrow tail), so the crosshair lands on the
  corner/tail, not the center/tip; the centroid branch is dead code. Fix: use the
  shape/polygon centroid (and ensure it is converted to the SAME mm space anchorMM
  uses before setCrosshairPos — verify setCrosshairPos's expected space).
- R4-5 (jump, PLAUSIBLE): the JUMP_TO_MEASUREMENT handler reads
  payload.measurement.uid; OHIF may carry the uid at the payload top level, making
  the jump a silent no-op. Verify the real event shape on the rig.
- R4-6 (cleanup): apps/iiif-volumetric-server bun test --max-concurrency=1 only caps
  test.concurrent cases, not cross-file port contention — may not fix the flake.

## Refuted
- centroid (start+end)/2 for a circle is correct (center+edge), not a bug.

## Coordination note
Codex is editing these same files in parallel. Restoring R4-0..R4-3 means
re-applying round-3 behavior on TOP of Codex's status-machine + jump additions
(keep those, fix the failure branches + labels). Sequence with Codex to avoid
clobbering; do not both edit commands.ts simultaneously.

---

# Round 5 (2026-07-30): product rulings + Codex reconciliation

Codex disputed the round-4 changes. Product owner ruled:
- Default labels: KEEP tool-specific ('Length #N' / 'Arrow #N' / 'Bidirectional #N'
  / 'ROI #N'). No change (round-4 R4-3 stands).
- Unsupported geometry: DELETE the OHIF row (do not keep a stale row). Reverted
  round-4 R4-0 back to: permanentlyUnsupported -> delete + negative-cache the hash.
  This also settles #3: retryable failures stay UNcached and retry on the next
  reconcile (so a row appears once the DICOM series finishes loading), which was
  Codex's intent; the NIfTI-URL "thrash" is bounded to user-edit frequency and each
  attempt is a cheap resolveBackingSeries check.

Kept from round-4 (not disputed by the ruling): R4-1 (removeNiivueAnnotation clears
bookkeeping when remove is absent/succeeds; keeps only on a THROWN remove for retry
-> no unmount leak) and R4-4 (jump to the shape center / arrow tip, in mm).

Not changed / out of scope:
- clearNiivueAnnotations still discards bookkeeping on a THROWN remove during a bulk
  clear. This is intentional: clear runs on teardown/unmount where there is no retry
  trigger, so keeping bookkeeping would reintroduce the R4-1 unmount leak. A thrown
  remove during a live series-swap can orphan an OHIF row (rare); leak-avoidance
  wins. removeNiivueAnnotation's keep-on-throw is itself cleaned up by clear on
  unmount, so nothing leaks permanently.
- ipyniivue generated bindings + WSI docs are outside commands.ts/commands.test.ts
  (core / other packages) and belong to Codex/core under the ownership split.

## Final review pass (reverse-sync: panel delete + visibility)

High-effort workflow review of the panel-delete and visibility-toggle commits
(`afbf1703`, `e7d3664d`). Five findings; three fixed, one documented, none
regressed prior fixes.

- **[1] Fixed - hidden flag un-set on the reconcile drop-row path.**
  `removeNiivueAnnotation` also runs on reconcile's `permanentlyUnsupported`
  branch, which drops the OHIF row while the NiiVue annotation is still alive.
  It unconditionally cleared the hidden flag, so a hidden annotation edited into
  an unsupported shape reappeared on the canvas with no row left to re-hide it.
  Fix: only `clearHiddenAnnotation` when the annotation is actually gone from
  `nv.annotations` (`removeAnnotation` splices before emitting `annotationRemoved`,
  so a genuine delete still cleans up). Test: hidden flag survives a row-drop while
  the annotation lives, and is cleared once the annotation is gone.

- **[2] Fixed - hide dropped on a transiently missing viewport entry.**
  `applyOhifVisibilityToAnnotation` early-returned on a null `getNiivueEntry`
  before recording the hidden state, so a toggle during a viewport remount was
  lost. Fix: record the hidden state first; the entry is only needed for the
  immediate `drawScene` repaint (the next render's filter honours the recorded
  state regardless). Test: a hide toggled while the entry is unregistered still
  filters the shape out.

- **[3] Fixed - teardown echo re-entered on bulk clear.**
  `clearNiivueAnnotations` runs on unmount BEFORE the `MEASUREMENT_REMOVED`
  subscription is torn down, and did not populate `removingUids`, so each
  `remove()` echoed into `applyOhifRemoveToAnnotation` -> a redundant
  `nv.removeAnnotation` + `drawScene` per row (and a mid-iteration mutation of the
  map being looped). Fix: mark each uid in `removingUids` (add before remove,
  delete in `finally`), mirroring `removeNiivueAnnotation`, so the echo no-ops.
  Test: a bulk clear with a live subscription removes every OHIF row without
  re-entering `nv.removeAnnotation`.

- **[0] Known limitation (not fixed) - hide is inert on the built-in-draw
  fallback.** The UIKit overlay (ruler, labels, AND the visibility filter) is only
  wired inside `loadDefaultFont().then()`; if the bundled font fails to load, the
  `catch` leaves `isAnnotationDrawn = true` and NiiVue's built-in draw renders
  every annotation without consulting `hiddenAnnotations`. This is inherent to the
  fallback (the whole overlay treatment is gated on the font, which ships in the
  bundle so the failure is rare). Making hide work there would require teaching
  NiiVue core about per-annotation visibility - the core change this feature
  deliberately avoids for GL/WebGPU parity reasons. Left as-is.
