# NeuroVue — Work To Be Done

Living backlog. Update as items ship (check them off / delete) and add new ones.
Mobile portability is a standing constraint — see `AGENTS.md`. Completed work is
in the git history.

Priority: **[P1]** soon / high value · **[P2]** worthwhile · **[P3]** nice-to-have.
Size: _(S)_ contained · _(M)_ medium · _(L)_ large / own session.

## Mobile (iPhone / iPad)

The codebase is already Tauri-v2 mobile-capable; these are the remaining blockers
to an actual iOS/iPadOS build. See `AGENTS.md` for the guardrails.

**iOS build works — app runs on the simulator (2026-07-06).** `tauri ios init`
scaffolded `src-tauri/gen/apple`; the Rust lib cross-compiles for
`aarch64-apple-ios-sim` and the app **launches on the iPhone 17 simulator**, the
local axum server is reachable, and the viewer initializes. Enablement (all
committed): (1) `"tauri": "tauri"` npm script — the generated Xcode "Build Rust
Code" phase calls `npm run -- tauri ios xcode-script`; (2) `tauri.ios.conf.json`
clearing `bundle.externalBin` (no iOS niimath sidecar); (3) `#[cfg(desktop)]`-gate
the menu bar in `lib.rs` (`tauri::menu` doesn't exist on iOS); (4)
`NSAllowsLocalNetworking` in the iOS `Info.plist`.

**Phone layout done (2026-07-06).** A `@media (max-width: 700px)` block +
`isPhoneViewport()` collapse the 3-column workbench to a full-screen NiiVue
viewer with the dataset/inspector panels as slide-in drawers (toggled by
mobile-only topbar buttons + a tap-to-close scrim); the OSD desktop browser is
hidden on phones; the topbar compacts. iPad (≥700px) keeps the desktop layout.
Verified on the simulator.

**Two iOS render fixes (2026-07-06):** (a) `preferredBackend()` now forces
**WebGL2 on iOS** — iOS WebKit exposes `navigator.gpu` but NiiVue's WebGPU path
renders a black canvas there (AGENTS.md flagged this); WebGL2 renders correctly.
(b) Phones default to the **axial 2D slice** instead of the 3D render (clearer on
a small screen).

**Default dataset on iOS — FIXED (2026-07-06); the brain renders on iPhone.**
Root cause was `fallback_mni152_volume()` (`volumetric_server.rs`) searching
hardcoded dev-machine paths (`~/Dev/mono/...`, `~/Dev/niivue/...`) absent from the
iOS sandbox, registering a phantom volume with `source_path: None` (raw endpoints
404/500). Fix: **bundle `mni152.nii.gz` (4.1 MB) as a Tauri resource**
(`src-tauri/resources/`, added to `bundle.resources`); `lib.rs` now spawns the
server inside `.setup()`, resolves the resource via
`app.path().resolve("resources/mni152.nii.gz", Resource)`, and sets
`NEUROVUE_DEFAULT_VOLUME`, which `discovery_roots()` appends **last** (so desktop
still prefers a real dev dataset). Verified on the simulator: launches → renders
an axial MNI152 slice with A/L orientation labels. Note: on iOS the resource lands
at `.app/assets/resources/mni152.nii.gz` and `BaseDirectory::Resource` resolves it
correctly. A user-facing **document picker** for opening *arbitrary* datasets is
still the separate dataset-acquisition item below.

- [ ] **[P3] (M) Device build + signing.** Validate on a physical iPhone (needs a
  development team for code signing); the socket-lifecycle check for the transport
  item wants a real device.

- [~] **[P1] (~~L~~ → M) Data transport for mobile — LARGELY A NON-ISSUE on iOS.**
  The theoretical blocker didn't materialize: the local axum HTTP server on
  `127.0.0.1` **works in the iOS simulator** once `NSAllowsLocalNetworking` is set
  (done) — the WKWebView reaches it and data loads. So the full transport-seam /
  custom-protocol rewrite is **not** required for a working foreground app.
  Remaining, much smaller: (a) confirm the same on a **physical device** (sim ≠
  device for local sockets); (b) handle **background lifecycle** — the socket may
  suspend when the app backgrounds, so re-bind/re-check the server on foreground
  (or lazily on next request). Keep desktop on the HTTP server. Downgraded from L
  to M and from "rewrite" to "verify + lifecycle hardening."
- [ ] **[P1] (M) Dataset acquisition on mobile.** iOS sandbox needs document-
  picker URLs / security-scoped bookmarks, not arbitrary `canonicalize()` paths.
  Abstract "pick/open dataset".
- [ ] **[P2] (M) niimath via WASM on mobile/web.** Native sidecar is desktop-only
  (`src-tauri/src/niimath.rs`). Wire the niimath WASM build behind
  `src/domain/niimath.ts` so the Operations feature works cross-platform.
- [x] **[P2] (S) Hide the terminal UI on mobile.** Its commands aren't registered
  there (terminal is `#[cfg(desktop)]`); add a runtime platform check to hide the
  toggle/dock.
- [~] **[P2] (M) Responsive layout + touch.** Layout done (see the phone-layout
  note at the top of this section). Touch progress:
  - [x] **Slice paging** now has a touch path: a **slice slider** overlaid at the
    bottom of the viewer in the single-plane 2D modes (`NiivueStage.tsx`
    `.nv-slice-slider`). It reads the current through-plane voxel from NiiVue's
    `location.vox[axis]` (stays in sync with clicks/paging) and pages via
    `moveCrosshairInVox`; the wheel path stays for desktop. Renders correctly on
    the sim (e.g. `108 / 215`); **drag interaction not yet confirmed by touch**
    (couldn't tap headlessly — no `idb`/`simctl tap`; verify on device).
  - [ ] **Pinch-zoom** is expected to work via NiiVue's native canvas touch
    (`touch-action: none` on the canvas hands all touch to NiiVue) — **verify on
    device**; add an explicit path only if it doesn't.
  - [ ] **3D camera snap** (numpad `1/3/7` for Coronal/Sagittal/Axial camera
    angles) is still keyboard-only. The on-screen Ax/Cor/Sag/MPR/3D buttons cover
    view switching; a dedicated in-render camera-snap affordance is deferred
    (niche vs. the 2D flow that matters on a phone).
- [x] **[P3] (M) Set up the `tauri ios` project/build** — done 2026-07-06,
  validated on the iPhone 17 **simulator** (see the status note at the top of this
  section). Device validation (needs a signing team) still pending.
- [x] **[P1] (M) Phone layout + touch slice paging — DONE 2026-07-06.** The
  desktop 3-column layout now collapses to a full-screen viewer with drawers (see
  the phone-layout note above), and 2D slice paging has a touch slider. Remaining
  touch polish (pinch verify, 3D camera snap) is tracked under "Responsive layout
  + touch" above. The document picker (open your own datasets) is the next real
  gap for a shippable phone app.
- [~] **[P3] (M) AirDrop / share-sheet dataset hand-off (Apple-only, one-shot).**
  **macOS send landed (2026-07-06):** `export_bundle` writes a portable
  `.nvbundle` (manifest + hashed data), and the **Share2** button
  (`shareViewViaAirDrop` → `share_view_via_airdrop` command) stages the current
  view to `cache_root/shares/<name>.nvbundle` and hands it to
  `NSSharingService(.sendViaAirDrop).performWithItems` on the main thread via
  `share.rs` (`objc2`/`objc2-app-kit`, macOS-only dep; gated in the UI by the new
  `airdropAvailable` runtime capability). No Swift plugin, no iOS project.
  Verified live: sent a bundle to an iPhone; cancel is clean. **Remaining:**
  - **iOS send** — the `UIActivityViewController` equivalent (needs a Swift
    plugin + the `tauri ios` project).
  - **Receive side** — register NeuroVue as a handler for the `.nvbundle` type so
    an AirDropped bundle opens straight into the existing import seam
    (`read_bundle` + open) instead of landing in Downloads for a manual open.
  - **Single-item AirDrop polish** — the bundle is a *directory*; AirDrop sends
    it fine (verified), but zipping to one file or registering `.nvbundle` as a
    macOS package UTI would make it read as a single item.
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
- [ ] **[P2] (S) Bound the NIfTI file read to the declared voxel extent.**
  `read_nifti_file` (`volumetric_server.rs:1959-1978`) validates voxel count
  against `max_source_voxels()` then `read_to_end()`s the whole file — a header
  declaring shape at the limit but with gigabytes appended (or a gzip bomb)
  allocates/decompresses all of it, bypassing the voxel-count cap → OOM/DoS.
  Cap the read at `vox_offset + prod(shape) * bytes_per_voxel` (and bound the
  gzip inflate) instead of reading to EOF. (Found in the 2026-07-06 review; the
  rest of the backend audit came back clean — checked_mul everywhere, guarded
  indexing, cache budgets, no path traversal.)

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
- [ ] **[P2] (S–M) Explode control (3D render).** Surface niivue's chunk-explode
  in the 3D render controls — spreads the volume's streamed/chunk blocks apart so
  you can see between them. Works on **single-chunk-loaded** volumes too (not just
  streamed ones). **Blocked on the niivue PR (#64, `poc-client-only-range-requests`)
  landing on niivue `main`** so the API is stable — see [[niivue-dep-wiring]] (the
  code is already in our symlinked dist, but keep to a merged main).
  Recipe (from niivue `examples/range.js` `syncExplode()` — a live per-frame
  update, no re-stream):
  ```js
  vol.chunkPlan = chunkPlan                                  // volume needs a plan
  vol.chunkExplode = { enabled: true, scale: [1.5, 1.5, 1.5] } // VolumeChunkExplode
  nv.drawScene()
  ```
  - **First: verify** `nv.volumes[0].chunkPlan` exists on a plain neurovue-loaded
    volume. If the render path auto-assigns a (single-chunk) plan, no extra work;
    if not, build one on load via `chunkVolume(dims, deviceLimit)` /
    `chunkVolumeGrid(dims, gridDims, deviceLimit)` and assign `vol.chunkPlan`.
  - **UI:** an "Explode" checkbox + spacing slider (→ `chunkExplode.scale`) in the
    3D render section (with the clip-plane controls); set `chunkExplode` on the
    rendered volume(s) + `drawScene()`. `chunkExplode` is **per-entry**, so it can
    explode the base without exploding an overlay.
  - Plumb through NiivueStage like the existing declarative render props (not a
    fiber-walk); it's 3D-render-only, so hide it in 2D modes.

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
- [~] **[P1] (L) 2D multiplanar slices + voxel-intensity readout.** Mostly done on
  the `viewer-multiplanar` branch (merged): axial/coronal/sagittal slice modes +
  a multiplanar layout (`VIEW_MODES` / `sliceType`), mouse-wheel through-plane
  paging (`sliceWheelStep`), a slice-position readout in the window header
  (`slicePositionLabel`, e.g. `Axial · I 168 mm`), per-layer voxel intensity in
  the footer (`locationIntensity`), and the interactive **intensity window /
  threshold** control re-introduced per layer (numeric Min/Max, now verifiable in
  2D). Remaining: **per-pane 2D orientation letters** (NiiVue draws them per
  slice, but confirm/expose consistently) and W/L **drag** on a pane (numeric
  min/max is done; drag is not). CT presets deferred until CT data is loaded
  (sample data is T1w MRI only).
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
- [x] **[P2] (S) Add-overlay guard rail.** Done: the "Add overlay" pool now
  surfaces the subject relationship *before* adding — a candidate whose BIDS
  subject differs from the base gets an amber ⚠ and an explanatory tooltip
  (`layerSubjectWarning(selected, item)` per row, `.nv-layer-add-warn` /
  `.is-warning`). Chose an inline cue over a confirm dialog (no modal). Only the
  subject check runs here (the world-space check needs post-load extents the
  pool volumes don't have yet); candidates without a BIDS subject still show no
  rail, same limitation as the per-row guard.

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

- [~] **[P2] (M) Save/share full view state.** The **export** half landed with
  the bundle foundation (2026-07-06): the new `.nvbundle` (Package button →
  `exportDatasetBundle` → `export_dataset_bundle` command →
  `volumetric_server::export_bundle`) serializes the full view into
  `manifest.json` alongside the copied volumes. The `view` blob is deliberately
  **shaped to mirror niivue's `NVDocumentData`** (`buildBundleViewState` in
  `domain/bundle.ts`): a `volumes[]` array in base→overlay→atlas order with
  per-volume `role`/`colormap`/`opacity`/`calMin`/`calMax`/`hidden`, plus a
  `scene` with `crosshairPos` + enabled `clipPlanes`, `viewMode`, `backend`.
  **This is intentionally NOT yet a real NVDocument** — mono's `serialize()`
  always embeds volume bytes and lacks the old-niivue sparse/linked path
  (`json(embedImages=false)` + `fetchLinkedData`), now tracked in
  **mono `packages/niivue/FEATURE_PARITY.md` §5**. When that lands, this maps to
  a *linked* NVDocument (volumes reference the bundle's `data/` files) via a
  near-mechanical rename. **Import/reload also landed (2026-07-06, interim):**
  the PackageOpen button → `pickBundle`/`readBundle` → `read_bundle_manifest`
  command → `volumetric_server::read_bundle` reads + SHA-256-verifies the
  manifest (surfacing a `⚠ N file(s) failed the integrity check` warning), opens
  the bundle's `data/` dir as the working dataset, remaps each recorded volume id
  to its freshly-registered id (`bundleVolumeId` mirrors Rust `volume_id`), and
  **replays the view** into app state (base/overlays/atlas membership + order,
  per-layer colormap/opacity/window/hidden, viewMode). Verified live: a saved
  view round-trips (volumes + layer settings restore). **Two gaps in the interim
  replay, deliberately deferred to the `loadDocument()` port** (both are
  `scene`-level in a real NVDocument, so niivue restores them for free — not worth
  patching the hand-rolled replay):
  - **Crosshair position** not restored — `setCrosshairTarget` fires a one-shot
    go-to before the volume finishes warming, so it's consumed with no volume.
  - **Clip planes** not restored — `applyClipPlanes` sets state but the planes
    don't take effect on load (our-side, not niivue-blocked; a quick fix if we
    want it before the port).
  Also interim-wart: import promotes the bundle's `…/data` subdir into recent
  datasets (should promote the `.nvbundle` path). Remaining beyond that: a
  lighter "save view only" (no data copy) if wanted. `savePatch` (the old obscure
  "Save correction patch") still only writes clip planes + backend and is
  superseded for view-sharing.
- [x] **[P2] (S) Persistent, copyable RAS coordinate widget.** Done: a
  **Crosshair** section in the Inspect panel (`CrosshairPanel`) that persists the
  last crosshair position as an anatomical RAS+ readout (`R/A/S` letters),
  copies it as a signed `x, y, z` mm triplet (clipboard), and offers **go-to** —
  three R+/A+/S+ mm fields (synced to the current crosshair) + Go that drives
  `nv.setCrosshairPos` via a one-shot `crosshairTarget` prop on NiivueStage.
  Verified live: readout/copy/go-to all work; go-to round-trips an interior
  coordinate exactly and snaps an out-of-range one to the nearest voxel. (The
  transient status-bar readout stays; `show3Dcrosshair` left off.)
- [ ] **[P2] (M) Surface affine / qform / sform.** Metadata panels show shape/
  spacing (`App.tsx:1059-1080`, `VolumeFilterPanel.tsx:204-232`) but never the
  affine, qform/sform codes, or orientation string. Add them, plus `mm` units on
  spacing. Document NaN/Inf and overlay-zero handling (0 ≠ "no data" in stat
  maps).
- [x] **[P2] (S) Tie atlas region readout to a named atlas.** Done:
  `locationRegion(location, atlasName)` now binds to the atlas layer — it matches
  the location value whose `name` (minus the ` L<level>` LOD suffix,
  `volumeBaseName`) equals the atlas's display name, instead of grabbing the
  first labelled value across all layers. The readout is prefixed with the atlas
  (`aal: Precentral_L`), and no region shows when no atlas is bound. Verified
  live via a synthetic `locationChange`: a stray labelled value is suppressed
  when unbound (old code would have shown it) and coords/intensity are intact;
  the positive atlas-name path is logic-verified (no atlas fixture in the
  browser-dev server).
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
    - **Started 2026-07-06:** bundle export already computes streaming **SHA-256**
      per data file (`sha256_file` in `volumetric_server.rs`, recorded as
      `sha256` in each bundle manifest entry). Reuse that helper for the
      dataset-level integrity hash + verify-on-load; the remaining work is the
      cache-identity swap and the append-only changelog.
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
- [x] **[P2] (S) Per-layer opacity sliders.** Done in the layer-controls redesign
  Phase B: each overlay/atlas row has an opacity slider + readout backed by
  `layerSettings[id].opacity`; the hardcoded 0.48/0.34 literals are gone.
- [x] **[P2] (S) Scroll pages slices.** Mouse-wheel now pages through slices in
  the single-plane 2D modes (axial/coronal/sagittal) by driving the crosshair's
  through-plane voxel (`sliceWheelStep` + `handleWheelCapture`); scroll-down
  advances. Zoom/clip-depth stay 3D-only. Two follow-ups: multiplanar paging is
  still native (needs per-pane hit-testing to know which plane the cursor is
  over), and paging steps in voxel space so the anatomical direction varies with
  volume orientation — page in mm for a consistent up=superior feel.
- [ ] **[P3] (M) Measurement tools.** No length/angle/ROI or Hounsfield readout.
  Add basic distance + voxel-value-under-crosshair.
- [x] **[P3] (S) Keep base volume grayscale-only.** Done: the anatomical base's
  colormap dropdown is restricted to grayscale-family maps (`BASE_COLORMAP_OPTIONS`
  = Gray, Bone); overlays/stat maps keep the full set. Also clamps the *render*
  and the select value via `baseColormap()` so a pseudocolor setting leaked from
  a volume's prior overlay/atlas role can't paint the base (parallels the base
  opacity-leak fix). Base-as-atlas keeps its label colormap. Verified live: base
  dropdown = Gray/Bone, overlay = all 5, Bone applies to the base render, and a
  viridis overlay promoted to base renders gray (dropdown shows gray, not blank).
- [ ] **[P3] (S) Dark-reading dropdown hygiene.** OS-native `<select>`/`<option>`
  popups flash bright white in a dark reading room; style them dark or use a
  custom menu.

### Discoverability (both reviewers)

- [ ] **[P2] (S) Keyboard help overlay + standard nav.** Crosshair nudges are
  vim-style `H/L/J/K` + `Ctrl+U/D` (`NiivueStage.tsx:502-516`) and view snaps use
  Blender numpad `1/3/7` (`:119-174`) — invisible and colliding with FSLeyes/
  FreeView muscle memory. Add a `?` cheatsheet and standard arrow/PageUp-Down
  navigation.

## Review pass 2026-07-06 (bullet-proof / intuitive / easy to use)

Fresh robustness + ease-of-use sweep (frontend error paths, backend hardening,
first-run/UX friction). Backend came back nearly clean — see the read-bound item
under "Backend correctness / hardening". These are the frontend/UX findings.

### Robustness — don't let failures go silent or hang

- [ ] **[P1] (S) Timeouts + abort on every server fetch.** Manifest, version,
  metadata, volume-file, and savePatch fetches have no timeout or `AbortSignal`
  (`domain/desktop.ts:193-215`, `NiivueStage.tsx:862-876`, `App.tsx:2281-2298`).
  If the local server stalls, the UI hangs on a spinner with no recovery. Wrap
  fetches in a shared `fetchWithTimeout` (AbortController) and surface a
  retryable error. Keep it transport-agnostic for the mobile IPC seam.
- [ ] **[P2] (S) Inverted intensity window is silently discarded.** `WindowControl`
  only calls `onChange` when `min < max` (`App.tsx:1449`); typing `min ≥ max`
  looks accepted but is dropped with no cue. Show an inline invalid state (and
  the same input has no live validation — `App.tsx:1468-1486`).
- [ ] **[P2] (S) Don't cache failed atlas-colormap fetches forever.**
  `atlasColorMapCache` (`NiivueStage.tsx:898-904`) caches rejected promises with
  no TTL, so one transient failure permanently kills atlas labels for all
  volumes until reload. Cache successes only; let failures retry.
- [ ] **[P2] (S) Distinguish "metadata failed" from "not loaded yet."**
  `useVolumeMetadata` (`useVolumeMetadata.ts:30-31`) collapses errors into a
  bare status, so a failed fetch reads identically to "n/a / loading." Add a
  distinct error state (with retry).
- [ ] **[P3] (S) Go-to crosshair: show when a coordinate is out of bounds.**
  The go-to fields validate finite but not bounds (`App.tsx:1602-1607`); NiiVue
  snaps out-of-range input to the nearest voxel with no feedback, so the user
  thinks they jumped somewhere they didn't. Clamp explicitly and flag the snap.
- [ ] **[P3] (S) Overlay-load ordering race.** `loadOverlayVolume`
  (`App.tsx:470-490`) can register an overlay before `serverUrl`/manifest are
  ready, so it silently lands without its correct layer settings. Gate the add
  on a refreshed manifest (or reconcile settings on the next refresh).

### First-run & feedback — the blank-canvas / "did it work?" gaps

- [ ] **[P1] (S) First-run empty state needs a real call to action.** With no
  dataset, the canvas is blank with only a small "Waiting for a dataset
  selection" line (`NiivueStage.tsx:314`, `.nv-render-status`), and that text
  overlaps the stage-title at the same `top:14px/left:14px`
  (`styles.css:1448-1461` vs `875-891`). Add a prominent centered "Open dataset"
  affordance (+ sample-data hint) and fix the overlap.
- [ ] **[P2] (S) Explain *why* controls are disabled.** The niimath Run button
  (`NiimathOperationsPanel.tsx:207`, and it's very faint at `opacity:0.42`) and
  the Axial/Coronal/Sagittal view-mode buttons (`NiivueStage.tsx:636,639`) go
  disabled with no `title` telling the user what's missing. Add explain-disabled
  tooltips; bump the disabled contrast.
- [ ] **[P2] (S) Remove-layer has no confirm or undo.** The overlay/atlas row X
  (`App.tsx:1157`) deletes the layer + its settings immediately. Add an
  undo (toast) or a lightweight confirm — accidental removal means re-adding and
  re-tuning the layer.
- [ ] **[P2] (S) niimath operand units + run feedback.** Threshold / upper-
  threshold operands give no unit or range hint (`NiimathOperationsPanel.tsx:160-167`,
  unlike Smooth's live FWHM readout); "Run"→"Running" has no spinner
  (`:212`); and the output path/status truncate with no way to expand or copy
  (`:220`, `styles.css:2126-2133`). Also tell the user *where* to select a
  volume — the panel says "Select a local NIfTI volume" but selection lives in
  the Inspect tab (`:216-217`).
- [ ] **[P3] (S) "No matching volumes" needs an inline Clear-filters button.**
  The filtered empty state (`DatasetDesktop.tsx:242`, `VolumeFilterPanel.tsx:149`)
  strands the user with no adjacent way to reset the filters.
- [ ] **[P3] (S) Consistent async feedback.** Overlay load (`App.tsx:1231`) and
  the copy-coordinate confirm (`App.tsx:1595,1626`, a 1.5s custom icon) use
  ad-hoc, easy-to-miss cues. Standardize on a small toast/spinner pattern so
  "is it working?" is answered consistently across panels.

## Housekeeping

- [ ] Prune merged remote feature branches on origin
  (`git push origin --delete <branch> …`).
