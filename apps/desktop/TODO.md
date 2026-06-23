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
- [ ] **[P3] (S) Strict CSP (production).** `tauri.conf.json` has `csp: null`. Set a
  strict policy and verify against a **production build** (dev CSP would break
  vite HMR). Pair with confirming dataset-derived strings are escaped in the UI.
- [x] **[P3] (S) Remaining lock-poison sites.** `patch` and `pyramid_locks` still
  use `.lock().ok()` (they degrade gracefully). Convert to `lock_recover` for
  consistency if desired.

## Frontend refactor

- [ ] **[P1] (M) Decompose `App.tsx` (in progress).** Done: `useRecentDatasets`,
  `useTerminalDock`, `useVolumeFilters` (+ `domain/volumeFacets`), `useClipPlanes`,
  `NiimathOperationsPanel`.
  Remaining:
  - [ ] `useDatasetManifest` — manifest/selectedId/status + the load & poll
    effects + `applyDatasetOpenResult`/`refreshDesktopManifest` (the tangled one,
    intertwined with serverUrl/BIDS/recents).
  - [x] Memoize `selected` so it stops defeating child memoization.
  - [ ] Consider extracting large sub-components (`DatasetDesktop`,
    `VolumeFilterPanel`) into their own files — that's what keeps `App.tsx` large
    now, and it's lower-risk than hook extraction.

## UX / product

- [ ] **[P2] (M) Per-layer colormap.** Colormap is currently a per-volume control
  parked in the Operations tab; make it a per-layer setting when overlays exist.
- [x] **[P3] (S) niimath mask path picker.** Replace the free-text mask path input
  with the file dialog + existence validation (`NiimathOperationsPanel`).
- [ ] **[P3] (S) Tune layout constants** if needed (section-label headroom,
  preview tiers) on real datasets.

## Housekeeping

- [ ] Prune merged remote feature branches on origin
  (`git push origin --delete <branch> …`).
