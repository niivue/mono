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
