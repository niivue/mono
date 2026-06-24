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
  hover-only / wheel-only controls.
- [ ] **[P3] (M) Set up the `tauri ios` project/build** and validate on simulator/
  device once the above land.

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

### Clinical reading ergonomics & safety (clinician)

- [ ] **[P2] (M) Geometry/subject mismatch guard.** Overlays from different
  volumes blend at fixed opacity (`App.tsx:240,251`) with no check they share
  affine/shape/subject — a silent study mix-up vector. Warn when an overlay's
  affine/shape doesn't match the base; show subject/session/modality in a fixed
  banner.
- [ ] **[P2] (S) Per-layer opacity sliders.** Overlay opacity is hardcoded at
  0.48 (`App.tsx:240`); blending is a core stats-viewing knob. Expose per-layer
  sliders (the layer panel already has per-layer colormap selects, `App.tsx:990`).
- [ ] **[P2] (S) Scroll pages slices.** Once multiplanar exists, mouse-wheel
  should page through slices (clinician muscle memory); it is currently bound only
  to zoom/clip-depth (`NiivueStage.tsx:413-437`).
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
