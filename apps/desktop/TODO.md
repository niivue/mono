# NeuroVue — Work To Be Done

Living backlog. Update as items ship (check them off / delete) and add new ones.
Mobile portability is a standing constraint — see `AGENTS.md`. Completed work is
in the git history.

Priority: **[P1]** soon / high value · **[P2]** worthwhile · **[P3]** nice-to-have.
Size: _(S)_ contained · _(M)_ medium · _(L)_ large / own session.

## Mobile (iPhone / iPad)

The codebase is already Tauri-v2 mobile-capable; these are the remaining blockers
to an actual iOS/iPadOS build. See `AGENTS.md` for the guardrails.

- [ ] **[P1] (L) Data transport for mobile.** The local axum HTTP server on
  `127.0.0.1` won't port cleanly (ATS blocks cleartext http, sockets suspend on
  lifecycle). Abstract data access behind a transport seam and add a custom
  protocol / IPC implementation for mobile. Keep desktop on the HTTP server.
- [ ] **[P1] (M) Dataset acquisition on mobile.** iOS sandbox needs document-
  picker URLs / security-scoped bookmarks, not arbitrary `canonicalize()` paths.
  Abstract "pick/open dataset".
- [ ] **[P2] (M) niimath via WASM on mobile/web.** Native sidecar is desktop-only
  (`src-tauri/src/niimath.rs`). Wire the niimath WASM build behind
  `src/domain/niimath.ts` so the Operations feature works cross-platform.
- [x] **[P2] (S) Hide the terminal UI on mobile.** Its commands aren't registered
  there (terminal is `#[cfg(desktop)]`); add a runtime platform check to hide the
  toggle/dock.
- [ ] **[P2] (M) Responsive layout + touch.** iPhone layout (small screen), touch
  equivalents for wheel-zoom (pinch) and any hover-reveal affordances. No
  hover-only / wheel-only controls. Concrete regressions found in the
  2026-07-01 code review (both desktop-only today):
  - **Slice paging is wheel-only** (`NiivueStage.tsx` `sliceWheelStep` /
    `handleWheelCapture` → `moveCrosshairInVox`). No touch/pointer path, so 2D
    slice navigation is unreachable on iPad/iPhone. Add a drag/swipe (or
    on-screen slice slider) equivalent.
  - **3D camera snap is keyboard-only.** The redesign replaced the on-screen
    render-snap buttons with the 2D/3D view-mode buttons, so `snapRenderView`
    (Coronal/Sagittal/Axial camera angles) is now reachable only via the
    numpad/Blender digit shortcuts — gone on touch. Re-expose a snap affordance
    for the 3D render pane.
- [ ] **[P3] (M) Set up the `tauri ios` project/build** and validate on simulator/
  device once the above land.
- [ ] **[P3] (M) AirDrop / share-sheet dataset hand-off (Apple-only, one-shot).**
  Transport for the assign→work→resync flow (see "Assign → work-offline → resync"
  under Reproducibility), not live sync. Apps can't initiate AirDrop directly —
  present the OS share sheet (`NSSharingServicePicker` macOS,
  `UIActivityViewController` iOS) with AirDrop as one option, and register
  NeuroVue as a handler
  for the dataset/bundle file type so received bundles open via the same
  pick/open-dataset seam. Needs a native plugin per platform; keep it as one
  transport option, not the primary mechanism (no Windows/Android/web).
  - **Prior art for the native-iOS shim:** the chronicle cache app
    (`~/Developer/personalized-newspaper`) already ships working Tauri-v2 Swift
    plugins that expose native iOS APIs to JS via `Invoke` —
    `src-tauri/plugins/tauri-plugin-tts/ios/Sources/TtsPlugin.swift` and
    `tauri-plugin-bgrefresh/ios/Sources/BgRefreshPlugin.swift`, with
    `src-tauri/ios/` bridging header and `ios-run.sh` for build/deploy. Use it as
    the template for a share-sheet plugin (and other iOS-native features).

## Performance & scale

- [x] **[P2] (M) Unload far-offscreen previews.** Current viewport-gated loading
  is load-once (`StablePreviewImage`); to hard-bound live `<img>`/memory on huge
  datasets, unload when scrolled far away (re-loads from cache on return).
- [x] **[P2] (M) Decoded coarse-level cache (server).** Cold preview renders
  re-decode the full source NIfTI per slice; cache the decoded coarse level by
  signature so repeated slices reuse it (`volumetric_server.rs::render_slice_bmp`).
- [x] **[P2] (M) Broaden + parallelize pyramid warming + show progress.** Warmer
  is single-threaded and only warms the coarsest level; warming is invisible to
  the user. Parallelize across cores, warm mid levels, add a warming indicator.
- [x] **[P3] (S) Manifest refresh via ETag / version endpoint** instead of polling
  the full manifest and diffing a stringified signature (`App.tsx`).
- [ ] **[P3] (S) Scope setVolume re-application to the changed layer.** The
  display-option effect (`NiivueStage.tsx` ~L426, deps `[layers, loadedVersion,
  onResolvedWindows]`) re-runs `setVolume` for *every* layer and forces a full
  `drawScene()` whenever the `layers` array identity changes — so dragging one
  overlay's opacity slider repaints the whole scene and re-applies all layers per
  frame. Diff against the prior applied options and only `setVolume` the layer(s)
  that actually changed. (Found in the 2026-07-01 review; PLAUSIBLE/efficiency,
  no correctness impact.)

## Backend correctness / hardening

- [x] **[P2] (S) Strengthen cache signature.** Pyramid/preview keys use
  `len + mtime` only, so in-place edits (same size/mtime) can serve stale data.
  Add a content hash and decode-affecting header fields
  (`volumetric_server.rs::source_signature`).
- [x] **[P2] (M) IIIF correctness.** `region` is ignored and `info.json` advertises
  native dims/tiling that don't match the downsampled bytes served. Either honor
  `region` (crop) or advertise full/max-only and reject region requests. Only
  matters if external IIIF clients consume the endpoints.
- [x] **[P3] (S) Strict CSP (production).** `tauri.conf.json` has `csp: null`. Set a
  strict policy and verify against a **production build** (dev CSP would break
  vite HMR). Pair with confirming dataset-derived strings are escaped in the UI.
- [x] **[P3] (S) Remaining lock-poison sites.** `patch` and `pyramid_locks` still
  use `.lock().ok()` (they degrade gracefully). Convert to `lock_recover` for
  consistency if desired.

## Frontend refactor

- [x] **[P1] (M) Decompose `App.tsx`.** Done: `useRecentDatasets`,
  `useTerminalDock`, `useVolumeFilters` (+ `domain/volumeFacets`), `useClipPlanes`,
  `NiimathOperationsPanel`, `DatasetDesktop`, `VolumeFilterPanel`,
  `useDatasetManifest`.
  Completed:
  - [x] `useDatasetManifest` — manifest/selectedId/status + the load & poll
    effects + `applyDatasetOpenResult`/`refreshDesktopManifest` (the tangled one,
    intertwined with serverUrl/BIDS/recents).
  - [x] Memoize `selected` so it stops defeating child memoization.
  - [x] Consider extracting large sub-components (`DatasetDesktop`,
    `VolumeFilterPanel`) into their own files — that's what keeps `App.tsx` large
    now, and it's lower-risk than hook extraction.

## UX / product

- [x] **[P2] (M) Overlay + atlas footer readout.** Add overlay layer loading,
  mark an optional atlas/parcellation layer, and surface NiiVue crosshair
  location/region labels in the footer from `locationChange`.
- [x] **[P2] (S) Global overlay import.** Pick an external NIfTI overlay,
  register it with the local volume server, and keep it active across selected
  base volumes.
- [x] **[P2] (S) Auto-detect imported atlas sidecars.** When a loaded overlay has
  a same-folder label JSON sidecar, select it as the atlas layer automatically.
- [x] **[P2] (S) Atlas visibility toggle.** Let users hide the atlas layer while
  keeping it loaded for crosshair region lookup.
- [x] **[P2] (S) Crosshair keyboard nudges.** Bind active render panes to
  NiiVue-style voxel steps: `H/L`, `J/K`, and `Ctrl+U`/`Ctrl+D`.
- [x] **[P2] (S) Hide atlas legend.** Keep atlas labels available for the footer
  region readout while suppressing NiiVue's in-canvas label legend.
- [x] **[P2] (M) Per-layer colormap.** Colormap is currently a per-volume control
  parked in the Operations tab; make it a per-layer setting when overlays exist.
- [x] **[P3] (S) niimath mask path picker.** Replace the free-text mask path input
  with the file dialog + existence validation (`NiimathOperationsPanel`).
- [ ] **[P3] (S) Tune layout constants** if needed (section-label headroom,
  preview tiers) on real datasets.

## Scientific / clinical viewer review

From a two-person expert review (neuroscience researcher + neurological
clinician) of the viewer UI/UX, 2026-06-24. Both reviewers independently
converged on the top three blockers. The viewer is currently a 3D surface-render
*previewer* with strong dataset browsing — it is **not** safe for judgments that
depend on laterality, intensity, or thresholds until the blockers land.

### Blockers — must ship before the viewer is used for analysis/reading

- [x] **[P1] (S) Non-diagnostic disclaimer.** No statement anywhere that this is
  a research/preview tool. Add a persistent, non-dismissable line: "Research/
  preview tool — not a certified diagnostic device. Do not use for clinical
  diagnosis." Cheap, do first.
- [x] **[P1] (M) Orientation labels (L/R/A/P/S/I).** The #1 retraction risk and a
  wrong-side patient-safety trap — a user cannot tell a left-flipped volume from
  a correct one. The render has no laterality marker (`NiivueStage.tsx:253`
  legend off, `:446-451` no canvas annotation) and the mm readout prints signed
  XYZ but never as anatomical letters (`App.tsx:1421-1424`). Enable NiiVue's
  orientation cube / corner L-R-A-P-S-I text, convert mm sign to letters in the
  readout (e.g. `R 32 / A 18 / S 5 mm`), and state the convention
  (neurological/radiological) from sform/qform explicitly.
  Done: `isOrientCubeVisible` enabled + anatomical-letter readout (RAS+).
  Remaining: per-pane 2D orientation letters (rolls in with multiplanar
  below) and an explicit on-screen convention statement.
- [ ] **[P1] (L) 2D multiplanar slices + voxel-intensity readout.** The stage is
  hard-pinned to 3D render mode (`NiivueStage.tsx:254-255`); the axial/coronal/
  sagittal buttons only rotate the camera. There is no slice view, no slice
  scroll, no through-plane navigation. Add a multiplanar mode (NiiVue 2×2
  with-render layout), per-pane orientation letters, and a slice-position
  readout. Done: per-layer voxel intensity now shows in the footer readout
  (`locationIntensity` in `App.tsx`).
  **Fold in here:** the interactive window/level (cal_min/cal_max) control.
  It was built and wired end-to-end, but cal_min/cal_max have no visible
  effect on the 3D raycast, so it was removed pending this 2D view where
  W/L is the primary interaction and is verifiable. Re-introduce per-pane
  W/L drag + numeric min/max (and CT presets if/when CT data is loaded —
  current sample data is T1w MRI only).
- [~] **[P1] (M) Window/level + visible intensity ranges + diverging colormap.**
  Done: intensity colorbar enabled and kept clear of the status overlay; a
  "Warm/Cool (diverging)" colormap (NiiVue warm + colormapNegative cool) for
  signed/stat overlays (`9b96232`). Deferred: the interactive window/level
  control — see the multiplanar item above (no visible effect in 3D-only
  render). Still open: clinical W/L presets and auto-selecting the diverging
  map for signed data (needs the volume's value range surfaced —
  see the affine/range item below).

### Per-layer controls redesign (design locked 2026-06-25)

From a three-person design team (neuroimaging-tools survey, interaction design,
codebase architecture). All three independently converged on the same design.
**Do this after the multiplanar branch merges** (its bolted-on Min/Max strip is
the thing this replaces).

**Design:** one unified **Layers list** with **expandable rows** (FSLeyes
completeness, OHIF space-efficiency). One row per layer (base/overlay/atlas);
the selected row expands inline (accordion), one open at a time. Rejected:
all-controls-per-row (overflows 300px touch panel), detached detail panel
(splits a layer's identity), popovers (hover-hostile). The base-volume card and
the atlas selector merge into the list as rows; the standalone WindowControl
moves into the base/overlay row's expansion.

**Role asymmetry:** base = colormap + intensity window, no opacity/threshold;
overlay = full kit; atlas = visibility + opacity + outline/labels toggles, no
colormap/window (discrete label map).

**State:** collapse `layerColormaps` + `layerWindows` into one
`Record<id, LayerSettings>` (`colormap?/opacity?/hidden?/window?/threshold?`);
keep `overlayIds`/`atlasId` for membership. Deletes the three hardcoded opacity
literals (`App.tsx` overlay 0.48 / atlas 0.34) and unifies atlas show/hide with
overlay visibility via one `hidden` flag.

**Guardrails (codebase-specific):** new settings must never enter
`layerLoadSignature` (else every slider drag reloads the LOD pyramid — route via
the in-place `setVolume` effect); preserve base→overlay→atlas order (in-place
effect maps list index → NiiVue volume index positionally); gate window/threshold
off for atlas rows (it uses `setColormapLabel`).

Phases (threshold deferred per decision):
- [x] **[P2] (S) A — Consolidate state** → `layerSettings` map + handlers + single prune branch.
- [x] **[P2] (S) B — Per-layer opacity** (field + slider); delete hardcoded opacity literals.
- [x] **[P2] (S) C — Unify visibility** into a `hidden` flag. Done: `hidden` on
  `LayerSettings` + `renderOpacityForItem` (effective opacity = `hidden ? 0 :
  opacity`); atlas migrated off the standalone `isAtlasVisible` state, so hide/show
  preserves the layer's opacity. Overlays share the plumbing; their per-row
  visibility toggle lands with the unified row in D (current overlay on/off is
  still membership via `overlayIds`).
- [x] **[P2] (M) D — Unified `LayerRow` list** with expandable detail; fold in colormap + opacity + WindowControl + per-row visibility (`hidden`) toggle for every layer. Numeric-first window (Min/Max + Auto), opacity slider+readout, diverging colormap stays a colormap option. Done: one accordion list (base→overlay→atlas order), one row open at a time, role asymmetry (base = colormap+window, overlay = full kit, atlas = opacity only), per-row eye toggle + remove (X), and a compact "Add overlay" pool replacing the 157-row checklist. Atlas `outline/labels` toggles still TODO (NiiVue `setColormapLabel` exists but no UI).
- [x] **[P3] (M–L) E — Threshold** (display threshold via cal_min). Overlay rows
  show a **Threshold + Max** control (distinct from the base's Min/Max window);
  values below the threshold render transparent (NiiVue's transparent-below-
  calMin). Stat overlays **auto-seed** their threshold from the loaded volume's
  robust max (`windowOptionForLayer` in `NiivueStage.tsx`) so they render
  thresholded instead of as a "purple block"; this needed a post-load re-apply
  (`loadedVersion` bump) since per-volume stats aren't ready when the overlay is
  first toggled on. True/destructive masking (niimath `-thr`) deferred as a
  separate "Mask" op. Possible follow-up: tune the default (robust max = top ~2%
  is conservative) and a threshold slider once the value range is surfaced.

Touch/iPad: ≥44px targets, no hover-only reveals, full-width inputs with explicit
min-width (the zero-width-grid collapse bug recurs otherwise), one row open at a
time to stay thumb-scrollable.

### Review pass 2026-06-30 (post-redesign viewer)

Fresh researcher + clinician pass after the layer redesign / threshold / guard /
wheel-paging work. Several findings are regressions-of-trust in the *new*
features — a control that can quietly mislead is worse than no control.

- [x] **[P1] (S) Stat-overlay threshold can hide signal silently — surface the
  cutoff.** Done, three parts: (1) the window/Threshold readout + placeholders
  show the *effective* values instead of a bare "auto" (`onResolvedWindows` →
  `resolvedWindows` → `WindowControl`, dimmed); (2) softened the default from
  `robustMax` (top ~2%) to **half** the robust max with contrast saturating at
  robustMax, so moderate activation shows, not just the strongest; (3) a "Show
  all (no threshold)" button on overlay rows resets to the full robust range
  (`resolved.robustMin/Max`). Verified live: default reads `auto · 183.67 –
  367.34`; Show-all → `0 – 367.34`.
- [x] **[P1] (M) Mismatch guard is subject-only — don't let "no warning" read as
  "match".** Done: added a **world-space** check alongside the subject check.
  NiivueStage reports each layer's world bounding box (`onLayerExtents`, post-load
  via `loadedVersion`); `layerSpaceWarning` flags an overlay whose box overlaps
  the base's by < 50% (intersection-over-smaller — ~1.0 for co-registered volumes
  at any resolution, → 0 for a different space). This catches the **non-BIDS** and
  **same-subject-different-space** cases the subject check misses; `layerWarning`
  combines them (subject first). Verified live: cactus base + ds000001 overlay →
  "0% world overlap" warning (subject check is silent there). Threshold 0.5 is
  tunable; co-registered no-false-positive is logically sound (nested boxes) but
  wasn't re-tested with a coregistered pair this session.
- [~] **[P2] (S) Slice locator + consistent wheel direction.** Done: the NiiVue
  window header now shows the current slice's **through-plane position** as an
  anatomical mm coordinate (`slicePositionLabel`, e.g. `Axial · I 168 mm`) — RAS+
  so it's correct regardless of voxel orientation, and it updates as you page
  (`moveCrosshairInVox` fires `locationChange`). Remaining: `sliceWheelStep` still
  steps in voxel space, so scroll *direction* can flip by volume orientation
  (page in mm / orientation-aware for a consistent up=superior feel) — lower
  priority now that the mm position is visible. Note: header position populates
  after the first crosshair move (NiiVue doesn't emit an initial location).
- [ ] **[P2] (S) Add-overlay guard rail.** The pool blends any of 157 unrelated
  dataset volumes onto the base with only the subject check as a rail — easy to
  mis-add. Consider surfacing relationship (same subject/space) in the pool or a
  confirm on a clearly-mismatched add.

(Already tracked but **raised in priority** by this pass: Save/share full view
state — now the only way to capture the new per-layer settings, whose defaults
show "auto"; on-screen orientation convention; affine/qform/sform; persistent
RAS+value widget.)

### High-trust cheap wins — data already plumbed, just surface it

- [x] **[P2] (S) Surface the niimath command + stderr.** The Rust side already
  captures full `argv`/`stdout`/`stderr` (`src-tauri/src/niimath.rs:230-262`) and
  ships it to the client (`domain/niimath.ts:18-20`), but the panel renders only
  the output path (`NiimathOperationsPanel.tsx:209-211`). Show
  `result.argv.join(' ')` in a copyable block plus a collapsible stderr panel.
- [x] **[P2] (S) Fix smoothing units.** `-s` takes **sigma in mm**
  (`src-tauri/src/niimath.rs:79-80`) but the field is unlabeled with a default of
  `2` (`NiimathOperationsPanel.tsx:23,67`) — a user typing "8" expecting 8 mm
  FWHM gets ~19 mm. Label "Sigma (mm)" with a live "= X mm FWHM" readout; state
  threshold units (intensity vs percentile) too.

### Reproducibility & data-trust (researcher)

- [ ] **[P2] (M) Save/share full view state.** `savePatch` saves only enabled
  clip planes + backend (`App.tsx:1485-1512`) — not overlays, colormaps, ranges,
  or camera. Serialize full view state and support reload so a researcher can
  save/share "this exact view." ("Save correction patch" is also an obscure label
  for a save-view action.)
- [ ] **[P2] (S) Persistent, copyable RAS coordinate widget.** `show3Dcrosshair`
  is off (`NiivueStage.tsx:254`) and the only spatial readout is the transient
  status bar. Add a copyable coordinate field with go-to.
- [ ] **[P2] (M) Surface affine / qform / sform.** Metadata panels show shape/
  spacing (`App.tsx:1059-1080`, `VolumeFilterPanel.tsx:204-232`) but never the
  affine, qform/sform codes, or orientation string. Add them, plus `mm` units on
  spacing. Document NaN/Inf and overlay-zero handling (0 ≠ "no data" in stat
  maps).
- [ ] **[P2] (S) Tie atlas region readout to a named atlas.** `locationRegion`
  grabs the first non-air label across *all* layers (`App.tsx:1427-1437`), so it
  can report a region from the wrong volume and can't say which atlas. Bind the
  lookup to the named atlas layer and show the atlas name.
- [ ] **[P2] (M) Content-hash data integrity + local edit changelog
  (foundational, single-user).** Stands alone — no collaboration required, and
  the viewer must be rock-solid on this before anything multi-user is built. Hash
  every dataset/derived artifact, verify on load, and surface a clear warning when
  the bytes don't match what an edit/view was made against (stale, modified, or
  corrupt data). Keep an append-only local changelog of edits — each entry: author,
  ts, parent entry hash, payload content hash, action — by generalizing the
  per-session `provenance.jsonl` (`volumetric_server.rs:1245-1280`, currently
  NeuroFlow-gated and only logging `correction.save`) into a dataset-level log.
  Append-only + hash chain = tamper-evident provenance and a replayable history.
  - **Upgrade the hash for integrity use.** `file_content_hash`
    (`volumetric_server.rs:2455`) is a non-cryptographic `u64` (`DefaultHasher`) —
    fine for cache-busting, **not** for tamper-evidence. Use a cryptographic hash
    (SHA-256 / BLAKE3) as the integrity + changelog identity; keep `id` as the
    dataset's single notion of identity so there aren't two.
- [ ] **[P3] (L) Assign → work-offline → resync (multi-user, additive).** Built
  *on top of* the integrity/changelog backbone above; explicitly not load-bearing
  — the single-user viewer ships and stays correct without it. Not live
  collaboration: a coordinator hands out parts of a dataset (whole volumes or
  slice ranges), each user works independently on their own device, then results
  sync back.
  - **Assignment manifest.** A unit of work = {dataset id, volume id(s) or slice
    range, assignee, base content hash}. Generate per-assignee bundles (data
    subset + manifest) so they can open and work offline.
  - **Resync/merge.** Bring an assignee's patches back, verify their base hash
    against the current dataset, append their entries to the changelog, and flag
    conflicts (two assignees touching the same unit) instead of silently
    last-write-wins. Extend the current single `correction.patch.json` /
    `savePatch` model (`App.tsx:1485-1512`, `/session/correction.patch.json`) to
    be per-assignment and mergeable; pairs with "Save/share full view state".
  - **Transport-agnostic.** The bundle hand-off is just file in / file out — see
    the AirDrop/share item under Mobile and the data-transport seam — so the same
    flow works over AirDrop, a shared folder, or a server round-trip.

### Clinical reading ergonomics & safety (clinician)

- [x] **[P2] (M) Geometry/subject mismatch guard.** Done: each layer row shows
  its BIDS `sub-/ses-` + modality + shape (`volumeSubject`/`volumeSession` in
  `volumeFacets.ts`, surfaced via `layerOptionMeta`), and an overlay/atlas whose
  subject differs from the base gets a per-row ⚠ + a panel warning banner
  (`layerSubjectWarning`). Subject mismatch is the reliable study-mix-up signal;
  geometry (shape/spacing) is shown but **not** warned on — co-registered stat
  overlays legitimately have a different grid, so warning there is constant
  noise. Follow-up: a true **space** check (native vs MNI, same subject) needs
  the post-load world extents/affine from NiiVue (`extentsMin/Max`) — wire it
  through the `loadedVersion` readback added in Phase E.
- [ ] **[P2] (S) Per-layer opacity sliders.** Overlay opacity is hardcoded at
  0.48 (`App.tsx:240`); blending is a core stats-viewing knob. Expose per-layer
  sliders (the layer panel already has per-layer colormap selects, `App.tsx:990`).
- [x] **[P2] (S) Scroll pages slices.** Mouse-wheel now pages through slices in
  the single-plane 2D modes (axial/coronal/sagittal) by driving the crosshair's
  through-plane voxel (`sliceWheelStep` + `handleWheelCapture`); scroll-down
  advances. Zoom/clip-depth stay 3D-only. Two follow-ups: multiplanar paging is
  still native (needs per-pane hit-testing to know which plane the cursor is
  over), and paging steps in voxel space so the anatomical direction varies with
  volume orientation — page in mm for a consistent up=superior feel.
- [ ] **[P3] (M) Measurement tools.** No length/angle/ROI or Hounsfield readout.
  Add basic distance + voxel-value-under-crosshair.
- [ ] **[P3] (S) Keep base volume grayscale-only.** Letting the base anatomical
  volume be set to viridis/magma (`App.tsx:77-81`) invites pseudocolor
  misreading; restrict colormaps to overlays/stat maps.
- [ ] **[P3] (S) Dark-reading dropdown hygiene.** OS-native `<select>`/`<option>`
  popups flash bright white in a dark reading room; style them dark or use a
  custom menu.

### Discoverability (both reviewers)

- [ ] **[P2] (S) Keyboard help overlay + standard nav.** Crosshair nudges are
  vim-style `H/L/J/K` + `Ctrl+U/D` (`NiivueStage.tsx:502-516`) and view snaps use
  Blender numpad `1/3/7` (`:119-174`) — invisible and colliding with FSLeyes/
  FreeView muscle memory. Add a `?` cheatsheet and standard arrow/PageUp-Down
  navigation.

## Housekeeping

- [ ] Prune merged remote feature branches on origin
  (`git push origin --delete <branch> …`).
