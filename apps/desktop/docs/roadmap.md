# NeuroVue roadmap — 2026-07-07

Synthesis of three planning passes (architecture/solidification, provenance
implementation, per-device/iPad UX). This is the strategy narrative; the
actionable backlog lives in `TODO.md`, the provenance design in
`docs/provenance.md`. Items already tracked in `TODO.md` are cross-referenced,
not repeated.

## Suggested sequencing

1. **Quick solidify wins** — layer-role→volume-index map, magic-number config,
   atlas-cache + fetch-timeout (already tracked), the layer-settings converter.
2. **Provenance Phase 1a → 1 → 2** — manifest v2 (`generatedBy` + PROV-JSON) and
   content-hash integrity. Small, standards-aligned, mobile-safe.
3. **Layout 3-tier refactor + OSD-as-gallery** — unblocks a usable iPad and fixes
   the cold-boot / Split-View layout desync at the root.
4. **Provenance Phase 3–5** — hash-chained changelog, niimath→PROV, assign/resync.
5. **iPad polish** (Pencil, touch OSD) and the optional DataLad adapter.

---

## 1. Solidify the app (architecture & correctness)

Highest-leverage structural fixes. The correctness-bug passes (`TODO.md` review
2026-07-06 / 07) covered the shallow bugs; these are the load-bearing ones.

- **[P1] Layer-role → NiiVue volume-index map — the top fragility.** `layers.map((l,
  i) => nv.setVolume(i, …))` (`NiivueStage.tsx:416,459,1067`) couples *array
  position* to NiiVue's volume index — across `setVolume`, `setColormapLabel`,
  clip, and the atlas colormap array — **and** the export/import role→position
  assignment (`App.tsx:364–410`). Any layer reorder or mid-op mutation silently
  renders the wrong volume. Introduce an explicit `LayerRole {Base,Overlay,Atlas}`
  + an id→volumeIndex table as the single source of truth. Prerequisite for a
  layer-reorder feature and for robust import replay.
- **[P2] Consolidate volume registration.** `register_derived_volume` vs
  `register_overlay_volume` (`volumetric_server.rs:560–711`) duplicate ~70 lines
  (header read, `unique_volume_id`, entry push, warming). Extract a
  `register_volume_entry` core so fixes land once.
- **[P2] One layer-settings → volume converter.** `buildBundleViewState`
  (`bundle.ts:91`) and `renderLayers` (`App.tsx`) both hand-map
  `LayerSettings → {colormap,opacity,calMin/calMax}`. A new settings field must be
  added in two places or the bundle silently drops it. Extract one converter.
- **[P2] Config block + mobile-tunable memory budgets.** Scattered magic numbers
  (preview/decoded-level caches `volumetric_server.rs:52,102`, thread `clamp(2,4)`,
  zip budget `50×/256MB`, preview grid `1024/96`, split limits, default opacities
  `App.tsx:104`) — group with rationale comments and make the memory budgets
  env-overridable (the AGENTS mobile-memory constraint has no path today).
- **[P2] Perf: diff-apply layer settings.** The in-place effect calls `setVolume`
  for *every* layer + a full `drawScene` whenever `layerSettings` changes, so an
  opacity drag repaints the whole 3D scene. Diff against last-applied; touch only
  changed layers.
- **Cross-referenced (already in `TODO.md`):** fetch timeouts/abort;
  atlas-colormap cache caching rejected promises; crosshair/clip-plane restore on
  import (the app-side fix is to gate the one-shot on `loadedVersion`);
  overlay-registered-before-manifest-ready; error-handling / async-feedback
  consistency; retire the vestigial `savePatch` UI (keep the NeuroFlow sink);
  God-object decomposition (`App.tsx` ~2635 LOC, `volumetric_server.rs` ~3720,
  `styles.css` ~2635 — split by concern, extract `pyramid.rs`/`bundle.rs`/
  `discovery.rs`, move inline sub-components to files).

## 2. Provenance implementation

Full phased plan in the design note; align with W3C PROV → NIDM → BIDS-prov /
BIDS-Derivatives `GeneratedBy` + DataLad's content-addressed model (see
`docs/provenance.md`). Everything is pure Rust + JSON in the app sandbox except
the desktop-only DataLad adapter — no git-annex on the iOS path.

- **Phase 1a (smallest first increment):** emit per-volume BIDS `generatedBy` in
  the manifest from the existing `VolumeDerivation`; bump `nvbundle` → `"2"`; add
  the JS types. Handful of lines in `export_bundle` + `bundle.ts`; round-trips
  with BIDS tooling; fully mobile-safe.
- **Phase 1:** add the bundle-level PROV-JSON `provenance` block (entities keyed by
  SHA-256; agents = software + person; activities = ops; used/wasGeneratedBy/
  wasAssociatedWith edges). Emit both `generatedBy` (BIDS) and PROV.
- **Phase 2:** SHA-256 as the *integrity* identity — **lazy + cached** on
  `VolumeEntry` (never hash on every manifest poll), invalidated by the existing
  cache signature; verify-on-load + a mismatch warning. Keep `id` as the single
  handle.
- **Phase 3:** generalize `persist_correction_patch`/`provenance.jsonl` into an
  always-on, append-only, **parent-hash-chained** PROV activity log, stored under
  `cache_root()/provenance/<dataset-id>/` (NOT the dataset root — iOS Inbox copies
  are ephemeral/read-only), keyed by dataset **id** not path. Canonical-bytes
  serialization is load-bearing for the chain.
- **Phase 4:** wire niimath ops → a complete PROV activity (argv, in/out SHA-256,
  timing, exit code) at `niimath.rs` (desktop-only, but appends to the shared
  always-on changelog so iOS edit-provenance still works).
- **Phase 5:** assign → work-offline → resync — assignment unit + per-assignee
  bundle + resync/merge with **conflict flagging** (not last-write-wins), on the
  changelog + share seam. Transport-agnostic (AirDrop/folder/server).
- **Phase 6 (optional, desktop-only):** DataLad import/export adapter (`#[cfg(
  desktop)]`), mapping our SHA-256-addressed entities to git-annex keys.

**Risks to bake in:** (a) **local-path leakage** — argv and `datasetRoot` embed
`~/…` user paths; relativize/content-address before recording and export. (b)
**over-hashing perf** — SHA-256 stays lazy. (c) **changelog canonicalization** —
non-deterministic JSON breaks the chain → false tamper alarms; fix field order +
test. (d) manifest v1↔v2 tolerance.

**Factual correction (fix in TODO/docs):** `file_content_hash`
(`volumetric_server.rs:2912`) is **FNV-1a**, not `DefaultHasher`. It's for
cache-busting only; SHA-256 (Phase 2) becomes the integrity identity.

## 3. Per-device UX, iPad, and screen real estate

The single `@media (max-width: 700px)` + `isPhoneViewport()` switch conflates two
independent axes — *size tier* and *input class* — and forces every iPad into
desktop chrome (unusable tri-column in portrait/Split View).

- **[P1] Replace the one breakpoint with a 3-tier `ResizeObserver` model.**
  Derive `layoutTier` from the **app-root element width** (not `matchMedia` read
  once at mount — which is also the cold-boot race and the Split-View/rotation
  desync root cause):
  - `compact` (< ~680px) — today's phone architecture (full-screen viewer +
    slide-in drawers).
  - `medium` (~680–1080px) — viewer-primary + collapsible **rails** (not fully
    hidden drawers) → overlay sheets; OSD as an on-demand gallery.
  - `expanded` (≥ ~1080px) — 3-column; OSD on-demand (permanent split only
    ≥~1280).
  Derive an independent `inputClass` from `(pointer: coarse)`/`maxTouchPoints` —
  so iPad landscape at desktop width still gets touch affordances + 44px targets.
  CSS media queries stay as the presentation layer but key off the same tiers.
- **[P1] Resolve the OSD-vs-drawer duplication (biggest coherence problem).** The
  dataset is browsable two ways today (`VolumeFilterPanel` facet list + the
  `DatasetDesktop` OSD zoom-grid), both permanent on desktop, competing for the
  middle; the phone layout just deletes the OSD, proving it's redundant. Make the
  drawer the **primary index** and the OSD grid an **on-demand gallery/lightbox**
  toggle over the viewer area — not a permanent half-workspace. Removes the
  default splitter too.
- **iPad = "phone grown" (portrait) / "desktop" (landscape).** Medium tier for
  portrait and any Split View / Stage Manager width; expanded for landscape
  full-screen — chosen live from the ResizeObserver, so rotation/resize is free.
- **Touch parity:** give the OSD grid a **pinch-zoom + two-finger-pan** path
  (`DatasetDesktop.tsx:136` is wheel-only → violates the AGENTS touch rule on any
  touch iPad in landscape, which never hits the phone block).
- **Apple Pencil** (`pointerType === 'pen'` + pressure) → the deferred
  **measurement tools** (distance/angle/ROI) and precise crosshair / W-L drag.
- **Usability (ranked):** tame the ~9-icon topbar into grouped Data / view-action
  menus (retire Save-patch); a real **first-run empty state** with an Open CTA
  (and fix the `.nv-render-status` / `.nv-stage-title` overlap at
  `styles.css:1546`/`:879`); **explain disabled / mode-gated controls** (Zoom/Clip
  swap to prose off-render — keep a greyed affordance + tooltip); one consistent
  async-feedback pattern; a `?` keyboard/gesture cheatsheet.
