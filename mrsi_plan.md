# Plan: MRSI (MR Spectroscopic Imaging) support for NiiVue

> **ARCHIVED (historical planning artifact).** Phases 0–2 shipped. The canonical,
> up-to-date feature status lives in `packages/niivue/FEATURE_PARITY.md` (§35
> MRSI) and the port provenance in `packages/nv-ext-mrs/PORTING.md`. Deferred
> items (Phase 3 fit-results, `wref` scaling, interactive drag-phasing, dims 5–7
> reduction) are tracked there. This file is kept only for the original design
> rationale; do not treat it as live status.

Status: **decisions confirmed (2026-06-07) — ready for autonomous development.**
Goal: a live demo `mrsi.html` that faithfully replicates the FSLeyes MRS plugin's
MRSI visualization, built as a NiiVue extension (`nv-ext-mrs`) following the
established `nv-ext-*` / `demo-ext-*` pattern.

### Confirmed decisions (maintainer sign-off)

- **D1 = Thin core + fat extension.** Minimal core enabler (a `spectroscopy` signal
  can be backed by a spatial complex volume; the graph shows the crosshair voxel's
  spectrum); all FSL-MRS specifics in `nv-ext-mrs`. Reuse the existing graph.
- **v1 scope = navigate + spectrum + maps (Phases 0–2).** Fit-results overlay
  (Phase 3, D8) is **deferred** — the provided dataset has no `fsl_mrsi` results dir.
- **D5 = add MRS transforms to core `processing.ts`** (halve-first-point,
  apodization, 0/1-order phase), shared with `svs.html`, **gated by a parity test**
  against fsleyes reference values; if it shifts the current `svs` baseline, make
  halve-first-point an opt-in display flag (do not regress `svs.html`).
- **D2 = MRSI grid shown as a ppm-band integral map** (integrate `|spectrum|` over the
  nucleus' default ppm range) as the default derived scalar; retain the complex FID
  buffer on the volume for spectral extraction.
- Minor defaults (no objection assumed): the `demo-ext-mrs` app's entry page **is**
  `mrsi.html`; use `mask.nii.gz` to hide empty voxels; `wref` scaling deferred.

Remaining input needed only for Phase 3: an `fsl_mrsi` results directory for this
dataset (or confirmation to ship without fit-results).

---

## 1. What MRSI is (primer)

- **Single-voxel spectroscopy (SVS)** — which we already support (`svs.html`) — is one
  spectrum from one box in the brain: a complex time-domain FID → FFT → a spectrum
  plotted against chemical shift (ppm).
- **MRSI (a.k.a. CSI / spectroscopic imaging)** is a *grid* of those voxels: every
  spatial voxel holds its own complex FID/spectrum. So a single file is **spatial +
  spectral** at once — a low-resolution image where "intensity" is a whole spectrum.
- The clinical workflow: overlay the MRSI grid on a high-res anatomical (T1), move the
  cursor to a voxel, and inspect that voxel's spectrum; optionally integrate a ppm band
  (e.g. the NAA peak) across all voxels to make a metabolite map; optionally overlay
  FSL-MRS *fit results* (fitted model, baseline, residual, concentration maps).

**This breaks our long-standing invariant** that signals are non-spatial
(`dim1..3 == 1`). MRSI is `dim1..3 > 1` AND `dim4 = spectral`. The plan's central
question is how to model that cleanly (see Decisions).

---

## 2. The proven FSLeyes approach (what we are cloning)

Source: `/Users/chris/src/fsleyes-plugin-mrs` (BSD-3, © 2021 William Clarke, University
of Oxford). The plugin is a thin layer over FSLeyes' existing plot panel. Key facts
established from the source (cite-backed in the agent reports):

**Data flow per displayed spectrum** (`series.py`, `utils.py`):
1. Read complex FID for the cursor voxel: `volume[x,y,z, :, d5,d6,d7]`, reducing any
   higher dims 5–7 by index / mean / difference (`apply_higher_dim_operations`).
2. Optional exponential **apodization** in time domain: `window = exp(-t * broadeningHz)`.
3. **`calcSpectrum`**: `fid[0] *= 0.5; fft(fid); fftshift(fid)` (no conjugation).
4. **Hz axis**: `fftshift(fftfreq(N, dwell))`, `dwell = pixdim[4]` (NIfTI-MRS).
5. Optional **phase correction**: `exp(1j·2π·(p0/360 + freqs·p1)) · spectrum`
   (p0 in degrees, p1 in seconds; UI stores p1 in ms).
6. Plot a component (real / imag / magnitude / phase).

**The ppm axis is a *display-only* transform**, never baked into the data
(`views.py:_set_mrs_plot_scale`):
```
ppm = Hz · (-1/spectrometerFreqMHz) + PPM_SHIFT[nucleus]   ; x-axis inverted (invertX)
```
Default x-limits come from `PPM_RANGE[nucleus]` padded 10%.

**Cursor → spectrum coupling**: the series listens on the shared cursor location; when
the ortho crosshair moves, it re-reads that voxel's FID and re-runs steps 1–6. That is
the entire MRSI navigation mechanism.

**Constants** (`constants.py`, port verbatim):
```
GYRO_MAG_RATIO = {1H:42.576, 2H:6.536, 13C:10.7084, 31P:17.235}  # MHz/T
PPM_SHIFT      = {1H:4.65, 2H:4.80, 13C:0.0, 31P:0.0}            # referencing offset
PPM_RANGE      = {1H:(0.2,4.2), 2H:(0,6), 13C:(10,100), 31P:(-20,10)}
```

**Range tool → metabolite map** (`range_tool.py:draw_overlay`): integrate a selected
ppm band over *all* voxels (sum of `abs` or `real` across the band) → a 3D map →
add as a new overlay named `SpecSum_{lo}_{hi}`.

**MRSI fit results** (`tools.py`): load an FSL-MRS results directory
(`concs/ fit/ qc/ uncertainties/` described by a `.tree`); plot `fit/baseline/residual`
as extra spectra that track the cursor, and load concentration/QC maps as ortho
overlays styled by a `*colourscheme.json`.

**Interactive phasing** (`profiles.py`): Ctrl-drag = 0th-order phase, Shift-drag =
1st-order phase.

**UX (MRS view)**: an ortho/anatomy panel + a spectrum plot; pinning spectra for
comparison drops a colour-matched ellipse annotation on the ortho at the voxel origin;
real component by default, ppm x-axis reversed.

---

## 3. The demo data (`~/fsl_course_data/fsl_mrs/mrsi`)

| File | Format | Dims | Type | Notes |
|---|---|---|---|---|
| `mrsi.nii.gz` | **NIfTI-2** | 48×48×1×**1024** | **complex64** | the MRSI data; ecode-44 MRS header; pixdim4=0.0008 s (1250 Hz BW) |
| `wref.nii.gz` | **NIfTI-2** | 48×48×1×1024 | complex64 | water reference (same grid); ecode-44 |
| `mask.nii.gz` | NIfTI-1 | 48×48×1 | int32 | which voxels have valid spectra; **same affine as mrsi** |
| `T1.anat/T1.nii.gz` | NIfTI-1 | 232×256×170 | float32 | 1 mm anatomy |
| `mrsi_basis/*.json` | JSON | 21 metabolites | — | FSL-MRS basis FIDs (16384 pts); only needed for *fitting*, not visualization |

MRS header extension (ecode 44) JSON: `SpectrometerFrequency:[123.227369]` MHz,
`ResonantNucleus:["1H"]`, no higher-dim tags (dim5-7 = 1). NIfTI-2 stores
`SpectrometerFrequency`/`ResonantNucleus` as **arrays** — our sidecar parser already
unwraps `[x]`/`["1H"]`.

**Footprint**: 48×48×1024 complex64 = **~18 MiB** per volume (mrsi + wref ≈ 36 MiB);
plan for 2–3× transiently during FFT. Trivial for a desktop browser.

**Two hard facts for loading**:
1. These are **NIfTI-2** (`sizeof_hdr` 540). `nifti-reader-js` (which core already uses)
   parses NIfTI-2, so header parsing is covered — but any of our code that assumes
   NIfTI-1 offsets must go through the library.
2. The provided data has **no fit-results directory** (only basis spectra). So the
   fit-results overlay feature cannot be demoed without first running `fsl_mrsi`
   (heavy, Python). → fit-results is a later phase, gated on getting result data.

---

## 4. Where MRSI fits in NiiVue today (gap analysis)

Already present (reusable):
- **Signal graph** (`view/NVGraph.ts` signal mode): multi-series, reversed/windowed
  **ppm x-axis**, legend, cursor, **annotations** — exactly the spectrum plot we need.
- **Spectral transforms** (`signal/processing.ts`): `fft`, `deriveSpectroscopySeries`,
  `ppmRefForNucleus`, ppm/Hz axis. (Needs parity tweaks — see D5.)
- **Extension context** (`extension/context.ts`): `slicePointerMove` / `locationChange`,
  `vox2mm`/`mm2vox`, `addVolume`, `registerVolumeTransform`, live `volumes`.
- **NIfTI-2 + complex parsing**: volume path reads NIfTI-2 via the library; the signal
  nii reader already decodes complex64/128 (`signal/readers/nii.ts`).
- Ortho/multiplanar/render, crosshair, overlay volumes + colormaps + colorbar (for the
  anatomy + metabolite maps).

Missing (the work):
- **Spatial-spectral routing**: `detect.ts` sends `dim1..3>1` to the *volume* path
  (correct — MRSI *is* a volume), but nothing then exposes the per-voxel spectrum.
- **Complex spatial volume display**: the volume path has no general complex→scalar
  path (only V1/tensor RGB). A complex MRSI volume needs a derived scalar (e.g. ppm-band
  integral, or first-point magnitude) to show the grid on the ortho.
- **Crosshair-voxel spectrum**: nothing extracts "the FID at the current crosshair
  voxel of a 4D complex volume" and feeds it to the graph.
- **FSL-MRS algorithm parity**: halve-first-point, exponential apodization, 0/1-order
  phasing, nucleus constants `PPM_SHIFT`/`PPM_RANGE`/`GYRO_MAG_RATIO`, referencing.
- **Range→map tool**, **fit-results overlay** (phase 3).

---

## 5. Core design decisions (need sign-off)

> Each decision lists options, a recommendation (★), and the rationale. These are the
> "discuss before coding" items; once agreed, implementation can proceed autonomously.

### D1 — Core vs extension split (the big one)

The spectrum **plot**, ppm axis, annotations, and crosshair plumbing already live in
**core**. Re-implementing them in the extension would duplicate a lot and drift from
`svs.html`. But MRSI's FSL-MRS specifics (apodization defaults, phasing, referencing,
range→map, fit-results, colourschemes) are exactly what an extension should own.

- **Option A — thin core + fat extension (★ recommended).** Add the *minimal* core
  capability: "a signal can be backed by a spatial 4D complex volume, and the graph
  shows the spectrum at the current crosshair voxel." Everything FSL-MRS-specific lives
  in `nv-ext-mrs`. Matches the user's "easily captured in our extension" intent and the
  fsleyes plugin philosophy, while reusing the proven graph.
- **Option B — fat core (new MRSI data class).** A full spatial-spectral class in core.
  More invasive; pulls FSL-specific concerns into core; rejected.
- **Option C — fat extension, no core change.** Extension fetches/parses the file,
  keeps complex data, and draws its *own* spectrum canvas. Maximum isolation but
  duplicates the graph/ppm/annotation/legend work and diverges visually from `svs`.

★ **A.** Smallest, most consistent footprint; the next decisions assume A.

### D2 — Data representation & ownership

The complex FID grid (~18 MiB) must be retained for spectral extraction, *and* a scalar
must be shown on the ortho.

- **Option A (★):** Core loads `mrsi.nii.gz` as a normal volume, but for a complex MRSI
  NIfTI it (a) computes a **derived scalar volume** for display (default: integral of
  `|spectrum|` over the nucleus' default ppm range, à la a "total signal" map — or
  simply first-point magnitude as a cheap default) and (b) **retains the raw complex
  FID** on the `NVImage` (e.g. `NVImage.complexData: Float32Array` + spectral metadata)
  so the graph/extension can extract any voxel. One fetch, one parse, no duplication.
- **Option B:** The extension fetches & parses the MRSI file itself (own complex buffer)
  and calls `context.addVolume()` with a derived scalar. Keeps complex out of core, but
  duplicates NIfTI-2/complex/ecode-44 parsing the signal reader already does, and the
  extension can't reuse core's voxel→spectrum path.

★ **A**, with the complex buffer + MRS metadata exposed read-only via the extension
context (`context.backgroundVolume.complexData` / `mrsMeta`). Rationale: single source
of truth, lets the core graph render the spectrum, lets the extension run the range tool
over the same buffer.

### D3 — Spectrum-at-crosshair coupling

- **Option A (★):** Generalize the signal model: an `NVSignal` of kind `spectroscopy`
  may carry `attachedToId` → a spatial complex volume + a flag `followsCrosshair`.
  `collectSignalGraphData` extracts the crosshair voxel's FID from that volume, runs the
  derive pipeline, and emits the series. `refreshSignalLocation` already re-runs on
  `locationChange`, so the spectrum updates as the crosshair moves — exactly the fsleyes
  mechanism, reusing all existing graph code (annotations included). The MRSI "voxel
  marker" can reuse the existing connectome-node/`svs.html` marker idea, or draw a
  crosshair-driven highlight.
- **Option B:** Extension listens to `locationChange`, extracts the voxel, and pushes a
  fresh ephemeral signal each move. Simpler core, but churns signals and bypasses the
  memoization/association machinery.

★ **A** — small, idiomatic extension of the association feature we already shipped.

### D4 — Loading path for NIfTI-2 complex MRSI

- Keep MRSI on the **volume** path (it is spatial); do **not** reroute to the signal
  loader. Add complex-aware handling there (D2). Reuse `signal/readers/nii.ts`'s
  complex-decode + ecode-44 logic by extracting it into a shared helper so both paths
  use one implementation (avoids the current "signal reader throws on MRSI" dead-end).
- Detection: a NIfTI is "MRSI" when it is complex AND `dim4>1` AND has MRS fields
  (ecode-44 or sidecar) AND `dim1..3` not all 1. This only *enriches* the volume (adds
  complex+spectrum capability); routing stays volume-side.

### D5 — Spectral transform parity (core `processing.ts` vs extension)

`processing.ts` already FFTs and builds a ppm axis for `svs`. FSL-MRS adds: **halve
first FID point**, **exponential apodization**, **0/1-order phase correction**. These
are generally useful for all spectroscopy (incl. `svs`).

- **Option A (★):** Add halve-first-point (verify against current `svs` output — it may
  shift the baseline; gate or make default-on for spectroscopy), `apodize`, and
  `phaseCorrection` to core `processing.ts`, ported from `utils.py`/`powerspectrumseries`.
  The extension supplies FSL-specific *defaults/constants* and the range tool.
- **Option B:** Keep these in the extension and have it post-process core's series.

★ **A** for the math (one FFT engine, benefits `svs`), with a parity test against
fsleyes values (`tests/test_utils.py` has reference numbers we can mirror). **Open
risk**: halving the first point changes existing `svs.html` output — must verify and,
if it regresses, make it an opt-in display flag.

### D6 — Referencing & nucleus constants

Port `PPM_SHIFT`, `PPM_RANGE`, `GYRO_MAG_RATIO` verbatim and reconcile with the existing
`ppmRefForNucleus` (confirm 1H = 4.65). ppm stays a **display transform**
(`ppm = Hz·(-1/specFreq) + shift`, x reversed) — which our graph already does via
`SignalAxis { reversed, min, max }`. Default window = `PPM_RANGE[nucleus]` padded 10%.

### D7 — Range-integration → metabolite map

Port `range_tool.draw_overlay` as a function that integrates `|spec|` (or `real`) over a
ppm band across all voxels → a 3D scalar → `context.addVolume` (named
`SpecSum_{lo}_{hi}`), with the MRSI affine so it overlays the anatomy.

- **Option A (★):** implement as a `registerVolumeTransform`-style routine in the
  extension, operating on the complex buffer exposed in D2. Keeps core generic.
- Core only needs to accept an added scalar volume (already supported).

### D8 — MRSI fit-results overlay (phase 3)

Port `tools.py` results loading (tree + colourscheme → fit/baseline/residual spectra +
concentration/QC maps). **Blocked on data**: the provided dataset has no results dir.
Decision: **defer to a later phase**; for the first demo, optionally pre-generate one
small results dir (run `fsl_mrsi`) or skip. The `.tree`/`file-tree` glob logic and the
restricted-`eval` colourscheme heuristics will be reimplemented in TS (the `eval` is a
security smell — replace with a small safe expression evaluator).

### D9 — Package layout, naming, licensing

- **`packages/nv-ext-mrs`** — the extension library (`@niivue/nv-ext-mrs`), peer-dep on
  `@niivue/niivue`, built with Vite like `nv-ext-niimath`. Houses: FSL-MRS algorithms
  (`processing` parity helpers if not in core), constants, range→map, (phase 3)
  fit-results loader, and a small controller that wires the extension context to the
  graph.
- **`apps/demo-ext-mrs`** — the demo app; its page is **`mrsi.html`** (decision: name
  the app's entry `mrsi.html` to match the requested deliverable, or keep `index.html`
  and add `mrsi.html` — I recommend the app's main page *be* `mrsi.html`).
- **Naming**: NiiVue camelCase/`NV*` conventions take precedence; where it doesn't
  conflict, mirror fsleyes names so the port is auditable (e.g. `calcSpectrum`,
  `apodize`, `PPM_SHIFT`, `PPM_RANGE`, `applyHigherDimOperations`). Document the mapping.
- **License**: add `packages/nv-ext-mrs/LICENSE.fsleyes-plugin-mrs` (verbatim BSD-3,
  © 2021 William Clarke, University of Oxford) and a `PORTING.md` noting which functions
  were ported and from where. Credit the FSL course data (permissive) in the demo.

### D10 — Demo UX (mirror the FSLeyes MRS view)

`mrsi.html` Phase-1 target: load `T1` (anatomy) + `mrsi` (overlay grid, shown as a
derived scalar map with a colormap + mask) + spectrum graph. Move the crosshair → the
spectrum updates; ppm x-axis reversed with 1H default range; real component. Controls
mirroring fsleyes: component (real/imag/mag/phase), apodize (Hz) slider, 0/1-order phase
(sliders first; interactive Ctrl/Shift-drag later), ppm-range → "make map" button,
metabolite-map opacity/colormap, WebGPU toggle. Keep the header style consistent with
`svs.html`.

---

## 6. Open questions for the user

1. **Scope of v1**: is Phase 1+2 (navigation + spectrum + manipulation + range→map)
   the target for `mrsi.html`, with fit-results (Phase 3) deferred? (The provided data
   has no fit-results dir.)
2. **Fit results**: do you have / can you generate an `fsl_mrsi` results directory for
   this dataset, or should we ship without it for now?
3. **Halve-first-point (D5)**: OK to change core spectroscopy to FSL-MRS semantics if it
   slightly alters the current `svs.html` baseline (with a parity check), or keep it
   extension-local?
4. **Derived scalar for the MRSI grid (D2)**: default to a ppm-band integral map
   (prettier, à la fsleyes range tool) or cheap first-point magnitude?
5. **Demo page name (D9)**: make `apps/demo-ext-mrs/`'s entry literally `mrsi.html`?
6. **Water reference / mask**: use `mask.nii.gz` to hide empty voxels and `wref` for
   scaling now, or defer?

---

## 7. Phased roadmap (once decisions are set)

- **Phase 0 — core enablers**: complex MRSI volume load + retained complex buffer + MRS
  metadata (D2/D4); expose via extension context; spatial-spectral signal + crosshair
  voxel spectrum in the graph (D3); processing parity helpers + parity tests (D5/D6).
- **Phase 1 — `nv-ext-mrs` + `mrsi.html` navigation**: load T1+mrsi+mask; crosshair →
  spectrum; ppm axis/referencing/default range; real component; voxel marker.
- **Phase 2 — manipulation + maps**: component select, apodize, phase (sliders → drag),
  ppm-range → metabolite map overlay (D7); colormap/opacity for maps.
- **Phase 3 — fit results** (data-gated): tree + colourscheme loader, fit/baseline/
  residual spectra, concentration/QC maps (D8).
- **Cross-cutting**: LICENSE/PORTING attribution (D9), tests (parity + persistence),
  docs (README/AGENTS/FEATURE_PARITY), manual headless smoke of `mrsi.html`.

---

## 8. Risks / unknowns

- **Halve-first-point regression** on existing `svs.html` (D5) — mitigate with a parity
  test and an opt-in flag if needed.
- **Complex volume on the GPU**: the ortho shows a *derived scalar*, not complex, so GPU
  texture handling is unaffected — but we must make sure the complex buffer isn't
  uploaded as a texture (memory) and is dropped from any GPU path.
- **NIfTI-2 corner cases** beyond what the library handles (vox_offset, ext parsing) —
  verify with the actual files (already decoded; offsets known).
- **Affine alignment** MRSI↔T1: the low-res grid must reslice/overlay correctly; NiiVue
  already reslices overlays to the background grid — confirm it handles the 5×5×15 mm
  grid over 1 mm T1.
- **Fit-results `eval`** in colourscheme heuristics — reimplement safely (no `eval`).
- **Scope creep**: the full fsleyes feature set is large; the phased plan keeps v1
  shippable.

---

## 9. Attribution

Port target: **fsleyes-plugin-mrs**, BSD-3-Clause, © 2021 William Clarke, University of
Oxford (co-author Vasilis Karlaftis; acks Paul McCarthy). Demo data: FSL course data
(`fsl_mrs/mrsi`), permissive. We will ship the upstream LICENSE verbatim in
`nv-ext-mrs`, a `PORTING.md` function-by-function provenance map, and credit FMRIB in
the demo and docs.
