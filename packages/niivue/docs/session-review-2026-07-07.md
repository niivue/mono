# Pre-push review — drawing-on-blocks demo, sparse/linked NVD, e2e harness

Adversarial review of the unpushed work on `poc-client-only-range-requests`
(`origin..HEAD`, 34 files, +3014/-168) before pushing to the PR. Three independent
reviewers swept the NVD format, the drawing-on-blocks core, and the demos + e2e
harness; every notable finding below was re-verified against the actual code.

Legend: **[Confirmed]** verified in code · **[Pre-existing]** not introduced this
session but exposed/relevant · **[Plausible]** logic holds, not runtime-reproduced.

## Verdict by area

| Area | State | Gate to "rock solid" |
|---|---|---|
| NVD sparse settings | **Resolved** (#1, #2 done in `9d6bcb48`) | — |
| NVD linked data | Solid, one caveat | Document/guard the "URL == memory" invariant (#3) |
| Drawing-on-blocks core | Solid | Worth fixing before ship: per-move reorder (#4); minor: #5, #6 |
| Demos (vox.draw.explode etc.) | **Solid** | Optional insurance only (#9) |
| e2e harness | Works locally; **not CI-wired** | Add browser-install + `git lfs pull` before any CI use (#7); fix timeout (#8) |

The demo logic and the drawing core came out clean on the things that would have
been real bugs (no tool-state leaks, undo correctness, state reset, backend
parity, Alt+right-drag, magic-wand confinement — all explicitly cleared). The
one item that genuinely blocks "rock solid" is a **design decision** (#1), not a
defect.

---

## 1. [RESOLVED — `9d6bcb48`] Loading a document no longer fully restores the scene — the design tension

**Resolution (per user):** what's in the NVD always wins; an OMITTED setting is
filled per a load-time **fill policy** — DEFAULT resets it to its built-in default
(so a document is a complete scene), `'current'` keeps the instance value.
`nv.settingsFillPolicy` (persistent) + `loadDocument(src, { fill })` (per-call),
by group or `'group.key'`. Crosshair-persistence is now an explicit opt-in
(`{ 'scene.crosshairPos': 'current' }`). Original finding kept below for context.

---



**`NVControlBase.loadDocument` (4638) + `NVDocument.applyDocumentToModel` (615).**
`loadDocument` clears volumes/meshes/drawing but does **not** reset `model.scene`
or the config groups before applying. Since v9 omits any setting equal to its
default and the loader keeps the current value for omitted settings, loading a
document into a **reused** instance leaves default-valued settings at whatever the
previous scene set them to.

Failure scenario:
1. `nv.loadDocument(A)` — A saved at azimuth 250, white background → applied.
2. `nv.loadDocument(B)` — B saved at azimuth 110 (default → omitted), black
   background (default → omitted).
3. Result: azimuth **stays 250**, background **stays white**. B's saved viewpoint
   is silently wrong. Applies to every group (colorbar, crosshairPos, pan/zoom…).

This is exactly the behavior you asked for ("crosshairs not specified → leave them
where they are") — but as the *global default* it means **a document is no longer a
complete scene description**; the result depends on hidden prior state. Camera
azimuth/elevation/crosshair/pan are scene *content*, not just "settings," yet they
ride the same omit-defaults path, so a viewpoint saved at a default-valued angle is
unrecoverable when loaded onto a non-fresh instance.

**Decision needed (pick one):**
- **A. Keep as-is** — matches "only save what is not default" literally. Cost:
  document callers must load into a fresh instance for a faithful restore;
  document this loudly.
- **B. Reset-then-apply + explicit keep-list** (recommended for robustness): seed
  each group from its defaults before applying present keys (restores "load fully
  resets"), and encode the *reason* for omission — persist a small `neverSaved:
  string[]` in the doc so the loader resets default-omitted fields but leaves
  explicitly-`neverSave`d ones (crosshair) at the current value. This gives your
  crosshair use case **without** the broad stickiness. More work + a format field.

Until this is settled the NVD feature isn't "rock solid" — the two behaviors are
materially different for anyone reusing an instance.

## 2. [RESOLVED — `9d6bcb48`] `annotationConfig` is the odd group out

**Resolution:** annotation is now sparsified on save and filled on load through the
same `sparsifyGroup`/`fillGroup` path as the other 7 groups, so `settingsSavePolicy`
and the fill policy apply to it too (no more silent no-op). Original below.

---



**`NVDocument.ts:569` (serialize) + `:667` (apply).** The other 7 groups are
sparsified and merge on load; `annotationConfig` is still **always fully embedded**
(`{ ...model.annotation }`) and **wholesale-replaced** on load
(`model.annotation = { ...doc.annotationConfig }`). Consequences:
- `nv.settingsSavePolicy = { neverSave: ['annotation.brushRadius'] }` **silently
  does nothing** — the API accepts the string and ignores it.
- Loading any v9 doc clobbers a customized instance's annotation settings, while
  the other 7 groups preserve omitted keys — an inconsistency in the same load.

**Fix:** route annotation through `sparsifyGroup('annotation', …, ANNOTATION_DEFAULTS,
policy)` + `Object.assign(model.annotation, doc.annotationConfig)` on load (matches
the others), **or** explicitly document annotation as non-sparse and reject/warn on
policy entries naming it. Either way, remove the silent no-op.

## 3. [Confirmed] `linkData` assumes the URL's bytes still match memory

**`NVDocument.ts:365` + reconstruct `:728`.** Linking drops voxel bytes for *any*
URL-backed volume. If the in-memory volume was mutated in place after load
(`applyVolumeTransform`, `loadImgV1`, an edit that keeps `v.url`), a linked save
omits the bytes and reload refetches the **original** server file — the edit is
silently gone (display state and the drawing bitmap survive; only raw voxels
diverge). The warn only fires for *unlinkable* URLs, so this is silent.

**Fix:** document the invariant on `SerializeOptions.linkData` ("linked volumes
assume the URL content is immutable and matches memory"), and ideally warn when
linking a volume that has had a transform applied (or gate on a "pristine since
load" flag). Low likelihood in the current demos, real for app integrators.

## 4. [Confirmed] Per-pointermove full-volume reorder during 3D draw/vector

**`interactions.ts:355` (`pickExplodedDraw` → `getImageDataRAS`), reached per
`pointermove` from `draw3DOnExplodedBlock`/`pickBlockMM`.** For any volume whose
`img` isn't already a Float32Array in identity-RAS order (i.e. a normal
Int16/Uint8 NIfTI, and especially the **large chunked range-request volume this
branch targets**), `getImageDataRAS` allocates a fresh `Float32Array(nVox)` and
reorders the whole volume — **on every mouse-move sample**. That's millions of
voxels re-copied per event → drag jank + GC pressure exactly where it hurts most.

**Fix:** cache the RAS sample array (+ dims/threshold) on stroke-start
(`_draw3DActive`/`_annotation3DActive`) and reuse it for the drag; invalidate on
pointerup/cancel. The 2D wand click path (`:510`) is fine (one call per click).
Worth doing before ship given the branch's purpose.

## 5. [Confirmed] Fill/wand push a no-op undo step

**`interactions.ts:466`/`485` (fill) and `:525`/`544` (wand).** Both call
`snapshotDrawUndo` *before* the `if (result.filled === 0) return true` early-out,
so a right-click that changes nothing (seed below tolerance, or already-painted
with `overwrite=false`) still leaves a phantom undo entry that reverts nothing.
The raster pen path already does this right (defers via `_draw3DNeedsUndo`).
**Fix:** snapshot only after confirming `filled > 0` (or pre-check the seed).

## 6. [Confirmed] `pointercancel` drops an in-progress 3D **vector** stroke

**`interactions.ts:1232` vs `:1195`.** A vector annotation is committed only in
`finish3DAnnotationStroke` (pointerup). `pointercancel` just clears the accumulator
— so on touch/pen inputs (or capture loss) that end a drag with `pointercancel`,
the whole drawn polygon is lost with no feedback. Raster strokes are unaffected
(they paint incrementally). **Fix:** decide deliberately — commit on cancel too, or
document the abort. Low frequency with a mouse.

## 7. [Confirmed] e2e is not CI-runnable as wired

**`playwright.config.ts`, `package.json`, `project.json`.** The config is written
*as if* for CI (`forbidOnly`/`retries`/`reuseExistingServer` keyed on `CI`), but a
fresh runner is missing three things: (a) **no browser install** — `playwright
test` needs `playwright install chromium`, which nothing runs; (b)
**`/volumes/mni152.nii.gz` is Git-LFS** — without `git lfs pull` the dev-images
plugin serves the ~130-byte pointer and the linkData test hard-fails on parse; (c)
**no workflow invokes `e2e`** (orphaned target; `pr_gate` runs only lint/typecheck/
test). This is fine *today* (e2e is deliberately opt-in and passes locally), but
must be wired before anyone relies on `nx e2e` in CI. **Fix when wiring CI:** add
`playwright install --with-deps chromium` + `git lfs pull` to the job, and a
preflight check in the spec that fails clearly if the fetched volume is < ~1 KB.

## 8. [Plausible] Timeout asymmetry → cold-start flake

**`e2e/document-roundtrip.spec.ts:57`.** The sparse test runs under the default
30 s while paying the same one-time Vite dep-optimize/transform of the whole niivue
graph as the linkData test (which buys 90 s). On a cold CI runner with 2 parallel
workers this can approach 30 s. `retries: 1` (CI) would likely mask it, so it's a
flake not a hard fail. **Fix:** `test.setTimeout(60_000)` on the sparse test, or a
`globalSetup` warmup that imports `/src/index.ts` once.

## 9. [Low, optional] Minor hardening
- **`interactions.ts` fraction space [Pre-existing]:** the new annotation-explode
  code correctly uses texture-fraction (`mm2tex`); the *pre-existing* 3D crosshair
  feeds `explodeOffsetMMAtFrac` a **scene**-fraction. They diverge on oblique/
  sheared volumes (identical on axis-aligned, hence hidden in the demo). Not
  introduced here, but now the two are inconsistent — worth aligning the crosshair.
- **`finish3DAnnotationStroke` 1-D guard:** a stroke along a single line (two tiny
  extents, one non-zero) passes the all-three-tiny guard and commits a zero-area
  polygon. Require the two largest extents to exceed epsilon.
- **`documentSettings.settingEquals`:** treats any object with a numeric `length`
  as array-like (latent; no current group hits it) and never drops NaN (safe
  direction). Gate the array branch on `Array.isArray || ArrayBuffer.isView` if
  hardening.
- **`vox.draw.explode.js` `backend.onchange`:** re-runs `ensureTiled`/`applyExplode`
  but not `applyView`/`applyTool`; works only because state lives in the model.
  Cheap insurance: re-run `applyView(); applyTool()` after a backend switch.
- **e2e:** `--strictPort` makes the local webServer brittle if 5273 is busy;
  linkData test double-encodes the 11 MB embed just for a ratio (could assert a
  fixed small ceiling instead).

---

## Verified sound (the review cleared these)

- **Drawing undo/state:** `_draw3DNeedsUndo` set-once/consumed-once; all-miss
  strokes snapshot zero times and paint nothing; no double-snapshot; all transient
  fields reset on both pointerup and pointercancel (except the deliberate vector
  cancel asymmetry, #6).
- **Backend parity:** `buildAnnotation3DRenderData` called identically by gl +
  wgpu; explode offsets baked into shared vertex mm; pick/finish read only
  model-level state both loops populate. No WebGL2/WebGPU asymmetry.
- **Magic wand / floodFill3D:** cap enforced before paint (never exceeds/overpaints);
  mark-on-push == mark-on-pop painted set; 2D mode pins the correct axis; 3D
  block right-click stays 3D regardless of the 2D flag; tolerance scaling correct
  (incl. negative slope).
- **Alt+right-drag:** falls through to clip-plane rotation in every draw mode;
  Shift still reserved.
- **NVD backward/forward compat:** old full v8 docs load identically; version
  8→9 bump makes old readers *reject* v9 rather than misread it; SCENE_DEFAULTS
  refactor is byte-identical to the old inline defaults and never aliases the
  constant arrays; url-restore applies the same display fields as embedded; the
  `settings ?? persistent` precedence is correct.
- **Demos:** tool model sets all four mode flags every call (no stale-flag leak);
  Hero `heroFraction` reset on non-hero views, no `parseInt('hero')` NaN;
  cursor/hint/swatch refresh on all relevant changes; `range.js` `isLiveSerial`
  fix is correct (no dropped-live / kept-stale window); `slides.js` change is a
  real export-guard fix, no regression.
- **Gate hygiene:** e2e specs excluded from the Bun unit runner and `tsc`; biome
  lints them and they pass; artifacts gitignored.

## Suggested order before pushing
1. ~~Decide #1 (load semantics)~~ — **DONE** (`9d6bcb48`): fill policy, defaults by default.
2. ~~Fix #2 (annotationConfig)~~ — **DONE** (`9d6bcb48`). #3 (linkData invariant doc/warn) still open.
3. Fix #4 (cache RAS array per stroke) and #5 (defer fill/wand snapshot); decide #6.
4. Wire #7 + #8 whenever the e2e suite goes into CI (#8 partly done: sparse test now 60 s).
5. #9 items are optional polish.

**Remaining before "rock solid":** #3 (linkData invariant), #4 (per-move reorder),
#5 (phantom undo); #6/#9 are minor; #7 only matters when e2e enters CI.
