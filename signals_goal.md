# signals_goal.md — Implementation plan for a third data class: **Signal**

> **Status (implementation complete):** M1–M8 landed and passing all gates
> (lint, typecheck, 291 tests, lib + examples build, boundaries). Added beyond
> the original plan per review feedback: full-canvas signal layout that skips
> all spatial rendering (slices/crosshair/orient labels) when only a signal is
> loaded; an interactive signal cursor emitting `signalLocationChange` for the
> status bar; WebGPU/WebGL2 + background-color controls in both demos.
> NVD documents persist signals at version 8 (round-trip tested).
>
> **One deferred design decision** (plan §10): the exact volume-frame ↔ physio-time
> alignment convention for a *moving marker* that ties 4D-volume scrubbing to a
> cursor on the physio time axis. Storage (`attachedToId`) and simultaneous
> display already work; only the alignment marker awaits a chosen convention.


## 1. Purpose

NiiVue currently renders two spatial data classes:

- **Vertex-based** meshes (triangulated mesh, streamline, connectome) — `src/mesh/NVMesh.ts`
- **Voxel-based** volumes — `src/volume/NVVolume.ts`

This plan adds a third, **non-spatial** class: **Signal** (`src/signal/NVSignal.ts`). Signals are
1-D-over-an-independent-axis datasets that are shown as **2-D line plots**, not in 3-D space.

Target use cases:

- **Physiology** — pulse/cardiac, respiration, head-motion (3 rotation + 3 translation), recorded during a 4-D acquisition. Multi-column real time-series.
- **Spectroscopy (MRS / SVS)** — complex FID, Fourier-transformed to a frequency/ppm spectrum, optionally averaged over transients.

Signals must work **two ways**:

1. **Standalone** — drag-and-drop a `.tsv[.gz]` or `.nii[.gz]` and see the plot, no spatial data required.
2. **Associated** — bound to a mesh/volume (a physio trace beside a 4-D time-series; a spectrum at a sampling location). The current 4-D-volume time-course graph is the prototype for this.

---

## 2. Locked design decisions

These were agreed before implementation (see questions resolved at planning time). Treat them as fixed; deviations need a new decision.

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | **Plot rendering** | **Extend the existing GPU `NVGraph`** (`src/view/NVGraph.ts`). One plotting path for everything. | Demo interactivity (ppm sliders, signal selector) lives in **HTML controls** that call NiiVue setters; the plot itself is GPU-rendered in the WebGL2/WebGPU canvas. `NVGraph` must gain multi-line color, a legend, and a real-valued/reversible x-axis. |
| D2 | **NIfTI volume-vs-signal detection** | **Auto-detect + explicit override.** Route to signal when (a) there is **no spatial extent** (`dim1==dim2==dim3==1 && dim4>1`), **or** (b) the sidecar / NIfTI header extension carries **MRS-relevant fields** (`SpectrometerFrequency`, `ResonantNucleus`). **Datatype is NOT a trigger** — spatial MR is routinely complex (real/imaginary). Provide an override (`asSignal: true/false`, and the explicit `loadSignals()` API). | One ambiguity heuristic, centralized in the loader; users can always force the interpretation. Complex stays a normal volume unless it is non-spatial or self-declares as MRS. |
| D3 | **Spectroscopy processing** | **Store raw complex FID; transform (FFT + transient averaging + ppm window + real/imag/magnitude/phase) on demand at draw time.** | Live ppm-range and averaging sliders need no recompute plumbing. Derived spectrum is cached and invalidated when display params change. |
| D4 | **Sequencing** | **Standalone demos first.** Core data model + readers + GPU-graph extension, then `svs.html` and `physio.html` standalone, then main-viewer drag-drop routing and volume association. | Visible validation early. Note: because of D1, the `NVGraph` multi-line extension must land **before** the demos (it is a demo prerequisite, not after). |

### 2.1 Design choices already decided as defaults (no further input needed)

- **Naming** follows the project convention: `src/signal/NVSignal.ts`, `src/signal/readers/*.ts`, types in `src/NVTypes.ts`, constants in `src/NVConstants.ts`. No barrel files (Biome `noBarrelFile`).
- **Reader discovery** mirrors volume/mesh: `import.meta.glob('./readers/*.ts')` + `NVLoader.buildExtensionMap`; each reader exports `extensions: string[]` and `read(buffer, name?)`.
- **NIfTI reuse**: the signal NIfTI reader reuses `nifti-reader-js` header parsing (as `src/volume/readers/nii.ts` does) but **does not** go through `nii2volume()` (that path is GPU-volume-specific and drops complex data). It reads raw bytes + header and keeps complex as interleaved float32 real/imag.
- **Sidecar policy** (sandbox-safe, see §5.3): when loading by **URL**, attempt to fetch the sibling `.json`; when loading by **File** (drag-drop), accept a **multi-file drop** that pairs `data + .json`, and if the sidecar is absent fall back to safe defaults (x = sample index) and expose setters to supply `SamplingFrequency`/`StartTime`/`SpectrometerFrequency` later.
- **Color palette + legend**: a fixed categorical palette (color-blind-safe, e.g. an Okabe-Ito-style set) cycled per series; legend drawn inside the graph backing rect.

---

## 3. Data model

### 3.1 Types (`src/NVTypes.ts`)

```ts
export type SignalKind = 'physio' | 'spectroscopy'

// One plotted trace.
export type SignalSeries = {
  label: string                 // legend text (e.g. "cardiac", "transient 12", "real")
  /** dependent values */
  y: Float32Array
  /** independent axis values, same length as y. If null, use index 0..n-1. */
  x: Float32Array | null
  color?: [number, number, number, number] // optional override; else palette by index
  visible: boolean
}

export type SignalAxis = {
  label: string                 // "Time (s)", "Chemical shift (ppm)", "Frequency (Hz)", "Sample"
  reversed: boolean             // ppm convention: high value on the left
  /** optional fixed window; null = autoscale to data */
  min: number | null
  max: number | null
}

export type NVSignalRaw =
  | { kind: 'physio'
      columns: Float32Array[]   // one per BIDS column
      columnLabels: string[]
      samplingFrequency: number | null  // Hz; null => x is sample index
      startTime: number }       // seconds; BIDS StartTime (often negative)
  | { kind: 'spectroscopy'
      /** complex FID: real/imag interleaved, shape [nPoints*2, nTransients] flattened */
      fid: Float32Array
      nPoints: number
      nTransients: number
      dwell: number             // seconds (pixdim[4])
      spectrometerFreq: number | null // MHz
      nucleus: string }         // '1H', '31P', ...

export type NVSignalDisplay = {
  // spectroscopy
  average: boolean
  mode: 'real' | 'imag' | 'magnitude' | 'phase'
  ppmRange: [number, number] | null
  ppmRef: number | null         // default by nucleus
  useHz: boolean
  // physio
  selectedColumns: number[] | null // null = all; demo selector drives this
  stacked: boolean              // stacked subplots vs overlay (different scales)
  // shared
  showLegend: boolean
}

export type NVSignal = {
  kind: SignalKind
  id: string
  name: string
  url?: string
  raw: NVSignalRaw
  display: NVSignalDisplay
  /** association: id of a volume/mesh this signal is bound to (optional) */
  attachedToId?: string
  /** cached derived series (invalidated when display changes) */
  _seriesCache: SignalSeries[] | null
  _axisCache: SignalAxis | null
}
```

### 3.2 Storage & API surface (parallels volumes/meshes)

- `NVModel`: add `signals: NVSignal[]`; methods `addSignal`, `removeSignal`, `getSignal(id)`.
- `NVControlBase`: add `loadSignals(opts: SignalFromUrlOptions[])`, `addSignal`, and events `signalLoaded`/`signalRemoved`. Extend the `loadImage()` dispatcher (see §6) with a signal branch.
- `SignalFromUrlOptions = { url: string | File; name?; kind?: SignalKind; asSignal?: boolean; sidecar?: File | object; display?: Partial<NVSignalDisplay>; attachToId?: string }`.

---

## 4. Domain processing (`src/signal/processing.ts`)

Pure functions, fully unit-testable, no GPU/DOM:

- **`deriveSpectroscopySeries(raw, display) -> { series, axis }`**
  - Reshape FID `[nPoints, nTransients]` complex.
  - If `display.average && nTransients>1`: mean across transients (one series) else one series per transient.
  - `fftshift(fft(fid))` per series (implement a small radix-2/Bluestein FFT in TS; `nPoints=1024` here is power-of-two — start with radix-2, guard non-power-of-two with Bluestein or zero-pad as a later task).
  - Build Hz axis from `dwell`; if `spectrometerFreq`: ppm = `-hz/specFreq + ppmRef`; reversed axis.
  - Apply `mode` projection (real/imag/magnitude/phase).
  - `ppmRange` -> set `axis.min/max`; **y autoscale is computed over the visible x-window** (mirrors `spec2graph.py`, otherwise the water peak dominates).
  - Default `ppmRef` by nucleus (`1H/2H = 4.65`, else `0`).
- **`derivePhysioSeries(raw, display) -> { series, axis }`**
  - x = `startTime + i/samplingFrequency` when `samplingFrequency` known, label "Time (s)"; else x = index, label "Sample".
  - One series per selected column; default all. `stacked` decides layout (handed to graph).

Reference parity (do not import; reimplement in TS): `/Users/chris/src/dcm_qa_spec/spec2graph.py` (FFT/ppm/window) and `/Users/chris/src/dcm_validate/dcm_qa_physio/viewtsv` (tsv parsing, sidecar, time axis, stacked subplots, NaN gaps).

---

## 5. Readers (`src/signal/readers/`)

### 5.1 `tsv.ts` — BIDS physio
- `extensions = ['TSV', 'TSV.GZ']`.
- gunzip if needed (reuse existing gzip path used by volume readers / `fflate` or `DecompressionStream`).
- Headerless by spec, but robust: a leading all-non-numeric row becomes column labels; non-numeric cells → `NaN` (gap in trace).
- Returns partial `NVSignalRaw{kind:'physio'}`; `samplingFrequency/startTime/columnLabels` filled from sidecar (§5.3) when available.

### 5.2 `nii.ts` (signal variant) — NIfTI / NIfTI-MRS
- `extensions = ['NII', 'NII.GZ']` **shared with volumes** — disambiguation happens in the loader (§6), not by extension, and **not by datatype** (spatial MR is routinely complex).
- Parse header with `nifti-reader-js`; read raw image bytes **without** float64→float32 or RGB coercion.
- **Spectroscopy** (MRS fields present in sidecar/header extension, typically also complex + non-spatial): interpret complex bytes as interleaved real/imag → `kind:'spectroscopy'`, `nPoints = dim[4]`, `nTransients = product(dim[5..7])`, `dwell = pixdim[4]`. (`COMPLEX64` datatype 32; `COMPLEX128` 1792 → convert float64 pairs to float32 on read.)
- **Physio** (non-spatial, no MRS fields, `dim1..3==1 && dim4>1`): `kind:'physio'`, columns = higher dims.
- `spectrometerFreq`/`nucleus` resolved from sidecar/header extension (§5.3).
- **MRSI note (deferred):** spatial+spectral spectroscopy (CSI/MRSI, `dim1..3>1` with MRS fields) is out of scope for the initial signal class — flag it and fall back to volume routing for now; revisit when a sample exists.

### 5.3 Sidecar & sandbox handling (`src/signal/sidecar.ts`)
- **By URL**: derive sibling `.json` (strip `.tsv.gz`/`.tsv`/`.nii.gz`/`.nii`, append `.json`), `fetch` it; tolerate 404.
- **By File (drag-drop)**: the drop handler collects **all** dropped files; pair a data file with a `.json` of matching basename. If absent, proceed with defaults and surface a non-fatal notice.
- **Fields consumed**: physio → `Columns`, `SamplingFrequency`, `StartTime`. MRS → `SpectrometerFrequency` (fallback `ImagingFrequency`), `ResonantNucleus` (default `1H`). MRS fallback to NIfTI header extension (ecode 44 / BEP005) when no sidecar.
- **Setters** on `NVSignal` allow supplying these later (covers the case where sandbox blocks the sibling read but the user can re-drop the json).

Confirmed against samples in `packages/dev-images/images/signals/`:
- `*_recording-cardiac_physio.json` → `{Columns:["cardiac","trigger"], SamplingFrequency:200, StartTime:-13.72}`
- `*_recording-respiratory_physio.json` → `{..., SamplingFrequency:50, StartTime:-13.72}` (different rate — supports the simultaneous-display case)
- `svs_se_30.nii.gz` → shape `(1,1,1,1024,64)`, `complex64`, `pixdim[4]=5e-4` (dwell); `svs_se_30.json` has `ImagingFrequency: 297.154513` (7T 1H).

---

## 6. Loader integration (`src/NVControlBase.ts` `loadImage`, `src/control/interactions.ts` drag-drop)

Disambiguation order in `loadImage(pathOrFile, options)`:

1. `ext = getFileExt(...)`.
2. If `options.asSignal === true` → `loadSignals`.
3. If `ext ∈ signalOnlyExts` (`TSV`, `TSV.GZ`) → `loadSignals`.
4. If `ext ∈ meshExts` → `loadMeshes`.
5. If `ext ∈ {NII, NII.GZ}` and not `asSignal===false`:
   - resolve sidecar/header-extension metadata (§5.3) and peek the header (cheap: first ~352 bytes; for `.gz` the reader already buffers).
   - route to `loadSignals` if **either**: MRS fields present (`SpectrometerFrequency`/`ResonantNucleus`) **or** no spatial extent (`dim1..3==1 && dim4>1`).
   - **Datatype/complex is not consulted** — a complex spatial volume (real/imaginary) stays a volume.
   - else → `loadVolumes`.
6. else → `loadVolumes`.

Drag-drop (`setupDragAndDrop`): collect the full `DataTransfer` file list, group by basename so a `data + .json` pair is loaded together; `.nvd` still routes to `loadDocument`.

---

## 7. GPU graph extension (`src/view/NVGraph.ts`)

This is the largest engineering item and a **prerequisite for the demos** (per D1).

Current `NVGraph` limitations: single line (`LINE_RGB` red), integer x-axis hard-labeled "Volume", autoscale only, selected-frame marker, no legend.

Required additions (keep the existing 4-D-volume path working — it becomes one caller):

1. **Generalize `GraphData`** to carry either the legacy `lines: number[][]` (frame-indexed) **or** a new `series: SignalSeries[]` + `xAxis: SignalAxis` + `legend: boolean` + `stacked: boolean`. Keep back-compat by treating the volume path as a single series with integer x and `label:"Volume"`.
2. **Multi-line color**: per-series color from palette; line drawing loop uses `series[j].color`.
3. **Real-valued x-axis**: replace the integer/stride x-tick logic with `calculateTickSpacing` over `[xAxis.min,xAxis.max]`; support `reversed` (ppm). Per-series x arrays (different lengths/rates) map through the same x scale.
4. **X-window + y-rescale**: when `xAxis.min/max` set, clip and rescale y to visible points only.
5. **Legend**: a small swatch+label stack inside the backing rect (reuse `buildText`/`buildLine`); toggled by `display.showLegend`.
6. **Stacked mode (physio)**: optional N x-linked sub-plots stacked vertically (different scales), mirroring `viewtsv`. Start with **overlay** (simpler); add stacked as a sub-task within M3.
7. **Layout/hit-test**: extend `computeGraphLayout`/`graphHitTest` for legend area and the real x domain. Keep `graphTotalWidth` behavior.

Both render paths call this: `wgpu/NVViewGPU.ts:~727` and `gl/NVViewGL.ts:~435` already call `collectGraphData()`; signals feed the same draw via a new `NVModel.collectSignalGraphData()`.

---

## 8. Demos

### 8.1 `packages/niivue/examples/svs.html` (+ `svs.js`)
Emulates `python spec2graph.py ./Ref/svs_se_30.nii -a --ppm-range 1.9 3.3`.
- Loads `svs_se_30.nii.gz` via `loadSignals`.
- HTML controls (drive NiiVue setters → GPU graph redraw):
  - **ppm-range** dual slider (default 1.9–3.3).
  - **Average** toggle (transients averaged vs overlaid).
  - **Mode** select (real/imag/magnitude/phase).
- Reversed ppm x-axis, y autoscaled to the visible ppm window.

### 8.2 `packages/niivue/examples/physio.html` (+ `physio.js`)
Emulates `viewtsv` on the cardiac/respiratory samples.
- Loads one or both `*_physio.tsv.gz` (+ sidecars).
- **Dropdown**: `respiration` | `pulse` | `both` → sets `display.selectedColumns`/visible series.
- Time (s) x-axis from `SamplingFrequency`+`StartTime`; legend distinguishes traces. Demonstrates two different sampling rates on a shared time axis.

Both demos follow the existing example pattern (`vox.4d.html`/`vox.4d.js`): `import NiiVue from '../src/index.ts'`, served by `bun run dev` (vite, port 5273). Add entries to `examples/index.html`.

---

## 9. Milestones & pass gates

Each milestone is independently shippable and must pass its gate before the next starts. Global gate for any milestone that touches `packages/niivue`:
`bunx nx run niivue:lint && :typecheck && :test && :build` all exit 0; `bun run check-boundaries` clean; no emoji/`any`/`!`/barrel files.

| M | Title | Status | As-built notes |
|---|-------|--------|----------------|
| **M1** | Types + readers (no UI) | **Done** | `NVTypes` raw/sidecar types; `readers/tsv.ts` (pure `parseTsv` + gz `read`), `readers/nii.ts` (complex FID / non-spatial physio, no `nii2volume`); `sidecar.ts`; `NVSignal.ts` glob map. Tests parse all 3 fixtures. |
| **M2** | Domain processing | **Done** | `processing.ts`: radix-2 FFT + O(n²) DFT fallback, transient averaging, ppm/Hz axis, windowed physio time axis, NaN gaps. Synthetic-tone test verifies ppm peak placement; real-SVS test. |
| **M3** | GPU graph extension | **Done** | `NVGraph` signal mode: palette colors, real/reversible x-axis, x-window + y-rescale, legend. **Overlay only** (stacked sub-plots not implemented — see §10). Legacy 4-D path untouched; 8 stub-builder geometry tests; `vox.4d.html` visually unchanged. |
| **M4** | `NVSignal` + model/control API | **Done** | `NVSignal.ts` `createSignal`/`loadSignal`; `NVModel.signals` + add/remove/get + `collectSignalGraphData` (merges all signals); controller `loadSignals`/`addSignal`/`removeSignal`/`removeAllSignals`/`setSignal`; `signalLoaded`/`signalRemoved` events. Series derived **on demand** (no cache — correctness over the planned cache; revisit if profiling shows redraw cost). |
| **M5** | `svs.html` demo | **Done** | average/component/ppm-range/full-range + WebGPU + bg-color controls. Visually confirmed by reviewer. |
| **M6** | `physio.html` demo | **Done** | respiration/pulse/both selector + legend + WebGPU + bg-color. `collectSignalGraphData` merges multiple signals on one time axis. Visually confirmed. |
| **M7** | Main-viewer drag-drop integration | **Done** | `_dispatchImage` shared by `loadImage`/`addImage`; `detect.ts` `niftiBufferIsSignal` (non-spatial OR MRS fields; datatype not consulted); multi-file drag-drop pairs data+`.json`; `asSignal` override. Detection unit-tested incl. real spatial volume stays a volume. |
| **M8** | Volume association + persistence | **Done (marker deferred)** | `signal/persistence.ts` `serializeSignal`/`reconstructSignal`; NVD **v8** `signals[]`; CBOR round-trip tested. `attachedToId` stored + persisted; simultaneous signal+volume display works via merge. Frame↔time **alignment marker** deferred (§10). |

### Enhancements added during review (beyond original plan)

| Item | As-built notes |
|------|----------------|
| Full-canvas signal layout | When the scene is signal-only (`signals>0 && volumes==0 && meshes==0`), `GraphData.fullCanvas` makes the plot fill the instance area; both renderers **skip the entire spatial pass** (no slices/crosshair/orient labels) and the placeholder counts signals as content. |
| Interactive cursor | `graphHitTest` returns `signalCursor` for plot clicks; `setSignalCursorFraction` stores `model.signalCursorX`, draws a faint marker (`buildSignalGraphElements`), and emits `signalLocationChange` with per-series values (status-bar readout). Helpers `signalXValueAtFrac`/`signalValuesAt`. |
| Demo controls | WebGPU/WebGL2 toggle + background-color picker + `signalLocationChange` footer wiring in both demos. |

---

## 10. Open items / known limitations (as-built)

- **Frame↔time alignment marker (deferred decision):** a moving cursor tying 4-D-volume frame scrubbing to a position on the physio time axis needs a defined convention (does physio `StartTime` align to frame 0 at acquisition onset, and is volume frame mapped via TR?). Storage (`attachedToId`) and simultaneous display already work; only the marker awaits the convention.
- **Non-power-of-two FFT:** handled by an O(n²) DFT fallback (correct but slow). Real fixtures are 1024 pts (radix-2). If large non-pow2 spectra appear, add Bluestein/zero-pad.
- **Stacked physio sub-plots:** not implemented — signals render as an **overlay** (distinct colors + legend). Different-scale columns (e.g. cardiac vs 0/1 trigger) share one y-axis; the demos select the recording column to avoid this. Stacked layout remains a future enhancement.
- **On-demand series derivation:** `collectSignalGraphData` recomputes series each draw (FFT included). Fine for the averaged single-series default and physio; a non-averaged 64-transient spectrum recomputes 64 FFTs per redraw — add a display-keyed cache if interaction lag appears.
- **`COMPLEX128`** (datatype 1792): converted float64→float32 on read. Untested against a real file (samples are `complex64`).
- **Sandbox sidecar reads:** URL load fetches the sibling `.json` (404-tolerant); drag-drop pairs a dropped `.json`; otherwise axis degrades to sample index. Setters can supply metadata later.
- **NVD v8:** older readers (≤v7) reject v8 files by design; v7 files load with `signals` absent (empty).

---

## 11. File manifest (as-built)

New files (each with a co-located `*.test.ts` except where noted):

```
src/signal/NVSignal.ts            # glob reader map; loadSignalRaw/loadSignal/createSignal; SignalFromUrlOptions  (no test; uses import.meta.glob)
src/signal/processing.ts          # FFT (radix-2 + DFT), averaging, ppm/Hz + physio axes, defaultSignalDisplay  (+ processing.test.ts)
src/signal/sidecar.ts             # sibling .json resolve + parse + hasMrsFields + fetchSidecar  (+ sidecar.test.ts)
src/signal/detect.ts              # niftiBufferIsSignal (non-spatial OR MRS fields)  (+ detect.test.ts)
src/signal/persistence.ts         # serializeSignal/reconstructSignal (CBOR-safe)  (+ persistence.test.ts)
src/signal/readers/tsv.ts         # BIDS physio tsv[.gz]: parseTsv + read  (+ readers/tsv.test.ts)
src/signal/readers/nii.ts         # NIfTI/NIfTI-MRS signal reader (no nii2volume)  (+ readers/nii.test.ts)
examples/svs.html, svs.js         # spectroscopy demo
examples/physio.html, physio.js   # physio demo
```

Edited files:

```
src/NVTypes.ts                    # signal types (raw, display, series, axis, NVSignal, sidecar)
src/NVEvents.ts                   # signalLoaded / signalRemoved / signalLocationChange + detail types
src/NVModel.ts                    # signals[], signalCursorX, add/remove/get, collectSignalGraphData, collectGraphData prefers signal
src/NVControlBase.ts              # loadSignals/addSignal/removeSignal/removeAllSignals/setSignal/setSignalCursorFraction; _dispatchImage routing
src/control/interactions.ts       # multi-file drag-drop data+json pairing; signalCursor hit handling
src/view/NVGraph.ts               # GraphData signal mode: GraphSeries/GraphAxis, multi-series + legend + reversed/windowed x-axis, fullCanvas, cursor, signalXValueAtFrac/signalValuesAt  (+ NVGraph.test.ts)
src/wgpu/NVViewGPU.ts             # skip spatial pass + placeholder when signal-only
src/gl/NVViewGL.ts                # skip spatial pass + placeholder when signal-only
src/NVDocument.ts                 # NVD v8: signals[] serialize/restore via signal/persistence
examples/index.html               # "Signal Scenes" links
```

Test coverage: 291 tests total; signal-specific suites cover readers (real fixtures), processing (analytic FFT/ppm), NVGraph geometry (stub builders), detection, and persistence (real CBOR round-trip). Renderer/controller/glob paths are validated by typecheck + build (consistent with the package's existing "not Bun-unit-tested" set).
