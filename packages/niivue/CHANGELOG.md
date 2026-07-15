## 1.0.0-rc.10 (2026-07-01)

### Features

- **niivue:** independent slice/render mesh shader + MRSI packaging, exports, and demo polish ([05778c5](https://github.com/niivue/mono/commit/05778c5))
- **niivue:** promote MRSI scene controller to core; retire nv-ext-mrs ([6d40058](https://github.com/niivue/mono/commit/6d40058))
- **niivue:** graphics-backend fallback + harden >2 GiB partial 4D loading ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** auto-cap 4D loads to the ArrayBuffer limit; clamp nFrame4D to data ([76cdbb6](https://github.com/niivue/mono/commit/76cdbb6))
- **niivue:** partial 4D load (limitFrames4D) via streaming gzip — avoids the 2 GiB cap ([8755b97](https://github.com/niivue/mono/commit/8755b97))
- **niivue:** renderPivotMM — orbit/zoom the 3D render about a world point ([47e50e0](https://github.com/niivue/mono/commit/47e50e0))
- **niivue:** centerRenderOnMM — rebase the 3D render origin on a world point ([89900d8](https://github.com/niivue/mono/commit/89900d8))
- **niivue:** true-ortho render zoom + tile-clipped focus boxes; multiplanar WYSIWYG clip ([407cbe6](https://github.com/niivue/mono/commit/407cbe6))
- **niivue:** WebGL2 multi-LOD render parity + correct mixed-size chunk ordering ([a827644](https://github.com/niivue/mono/commit/a827644))
- **niivue:** 2:1 balanced multi-LOD octree for smoother LOD transitions ([ec8eb69](https://github.com/niivue/mono/commit/ec8eb69))
- **niivue:** per-brick multi-LOD focus fixes, LOD debug boxes, in-place plan swap ([58e327d](https://github.com/niivue/mono/commit/58e327d))
- **niivue:** 3D crosshair tracks the exploded block ([6d6d764](https://github.com/niivue/mono/commit/6d6d764))
- **niivue:** focus-box overlay + explode-aware chunked depth-pick ([ae54f99](https://github.com/niivue/mono/commit/ae54f99))
- **niivue:** per-brick multi-LOD volumes + chunked depth-pick ([562f45a](https://github.com/niivue/mono/commit/562f45a))
- **niivue:** SLICE_TYPE.NONE - hide slices so the signal graph fills the canvas ([b6a7c3b](https://github.com/niivue/mono/commit/b6a7c3b))
- **niivue:** export nii2volume, writeVolume, makeLabelLut for extensions ([0b6fd4b](https://github.com/niivue/mono/commit/0b6fd4b))
- **niivue:** cross-fade streaming chunks in over the coarse floor (2D + 3D) ([58652d1](https://github.com/niivue/mono/commit/58652d1))
- **niivue:** coarse floor in the 3D render (no pop-in while streaming) ([6f20990](https://github.com/niivue/mono/commit/6f20990))
- **niivue:** smooth WSI deep-zoom level transitions via a coarse floor ([9cb5f32](https://github.com/niivue/mono/commit/9cb5f32))
- **niivue:** coarse LOD floor for smooth 2D deep-zoom streaming ([3c86c36](https://github.com/niivue/mono/commit/3c86c36))
- **niivue:** LOD-aware texture-to-texture resampler (resampleInto) ([d23aff7](https://github.com/niivue/mono/commit/d23aff7))
- **niivue:** clipPlaneOverlay to clip overlays with the base volume ([02f4281](https://github.com/niivue/mono/commit/02f4281))
- **niivue:** rebakeChunkedOverlays() for in-place overlay re-bake ([e3d4b88](https://github.com/niivue/mono/commit/e3d4b88))
- **niivue:** render streamed combined overlays on 2D slices ([2bf7d84](https://github.com/niivue/mono/commit/2bf7d84))
- **niivue:** streamed combined overlays on the base grid (strategy A) ([fdac690](https://github.com/niivue/mono/commit/fdac690))
- **niivue:** independent hi-res chunked overlay layer ([ef1b77d](https://github.com/niivue/mono/commit/ef1b77d))
- **niivue:** draw on exploded blocks with right-click, free left-drag for rotate ([793a061](https://github.com/niivue/mono/commit/793a061))
- **niivue:** draw directly on 3D exploded blocks ([2919265](https://github.com/niivue/mono/commit/2919265))
- **niivue:** incremental per-chunk drawing upload for large volumes ([3708476](https://github.com/niivue/mono/commit/3708476))
- **niivue:** cull clip-plane-hidden chunks from the streaming working set ([2794b17](https://github.com/niivue/mono/commit/2794b17))
- **niivue:** stream chunks center-first, spiralling outward ([2949c96](https://github.com/niivue/mono/commit/2949c96))
- **iiif-volumetric-demo:** stream chunked RGB in the wsi.html OSD viewer ([87a9cfc](https://github.com/niivue/mono/commit/87a9cfc))
- **niivue:** viewport-cull the 2D chunked-slice working set ([f7c0b95](https://github.com/niivue/mono/commit/f7c0b95))
- **iiif-volumetric-demo:** stream DICOM-WSI as chunked RGB in the streaming viewer ([eb1c0d9](https://github.com/niivue/mono/commit/eb1c0d9))
- **niivue:** support RGB/RGBA color in the chunked volume path ([894dfed](https://github.com/niivue/mono/commit/894dfed))
- **iiif-volumetric-demo:** smooth OpenSeadragon-style zoom for WSI viewer ([220f77f](https://github.com/niivue/mono/commit/220f77f))
- **iiif-volumetric-demo:** DICOM-WSI deep-zoom viewer (wsi.html) ([8431cfe](https://github.com/niivue/mono/commit/8431cfe))
- add scivis OME-Zarr fetcher and high-res streaming docs ([575d9a8](https://github.com/niivue/mono/commit/575d9a8))
- add aspect-aware OME-Zarr exploded blocks ([7a34939](https://github.com/niivue/mono/commit/7a34939))
- add exploded OME-Zarr chunk rendering ([59ba931](https://github.com/niivue/mono/commit/59ba931))
- **niivue:** Phase 3d demo chunk-budget control ([f5641b2](https://github.com/niivue/mono/commit/f5641b2))
- **niivue:** Phase 3d configurable chunk residency budget ([5a9fbec](https://github.com/niivue/mono/commit/5a9fbec))
- **niivue:** Phase 3d renderer wiring for chunk eviction ([57fddbf](https://github.com/niivue/mono/commit/57fddbf))
- **niivue:** Phase 3d LRU eviction in ChunkResidencyManager ([b6d2139](https://github.com/niivue/mono/commit/b6d2139))
- **niivue:** Phase 3c visibility-driven chunk working set ([2258910](https://github.com/niivue/mono/commit/2258910))
- **niivue:** Phase 3c on-demand chunk uploader and streaming pump ([c5b2828](https://github.com/niivue/mono/commit/c5b2828))
- **niivue:** Phase 3a-3c chunk residency manager and visibility math ([2a327df](https://github.com/niivue/mono/commit/2a327df))
- **niivue:** tiled rendering for volumes exceeding maxTextureDimension3D ([20f0cd0](https://github.com/niivue/mono/commit/20f0cd0))
- **niivue:** renderPan API, atomic loadVolumes swap, worker-based load ([b87f09b](https://github.com/niivue/mono/commit/b87f09b))
- **niivue:** port opts.instances and global3d tile space to WebGPU ([6f8e1d6](https://github.com/niivue/mono/commit/6f8e1d6))
- **niivue:** per-volume GPU texture cache for multi-instance scenes ([db2b2b8](https://github.com/niivue/mono/commit/db2b2b8))
- **niivue:** mirror niivuegpu pan/zoom + instancing ([ff25cb2](https://github.com/niivue/mono/commit/ff25cb2))
- **niivue:** expose volumeTransmittanceCutoff as renderer uniform ([af5117a](https://github.com/niivue/mono/commit/af5117a))

### Fixes

- **niivue:** persist urlImageData for detached-format deferred 4D reload ([#3](https://github.com/niivue/mono/issues/3), [#59](https://github.com/niivue/mono/issues/59), [#1](https://github.com/niivue/mono/issues/1), [#2](https://github.com/niivue/mono/issues/2))
- **niivue:** MRSI crosshair spectrum averages transients to match maps ([8cd8f08](https://github.com/niivue/mono/commit/8cd8f08))
- **niivue:** guard DOMException for non-browser runtimes ([#59](https://github.com/niivue/mono/issues/59))
- **niivue:** address Copilot review (overlay placement, File names, malformed headers) ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** audit round 8 — isBusy try/finally, deferred ownership guard, RGB partial gate ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** audit round 7 — deferred-reload conversion, graph/backend hardening ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** 4D-volume time-course graph fills the canvas on SLICE_TYPE.NONE ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** cap vox_offset for header read to MAX_HEADER_BYTES (64 KiB) ([798b5b1](https://github.com/niivue/mono/commit/798b5b1))
- **niivue:** address Copilot review (URL fragment ext, vox_offset, swiftshader caution) ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** robustness LOWs from the PR review ([1f8b79e](https://github.com/niivue/mono/commit/1f8b79e))
- **niivue:** don't composite a whole-volume overlay in the chunked 2D path (render M2) ([512fab1](https://github.com/niivue/mono/commit/512fab1))
- **niivue:** cull multi-LOD bricks per slice by voxel extent (chunking M3) ([fe8622f](https://github.com/niivue/mono/commit/fe8622f))
- **niivue:** average MRSI crosshair FID over transients ([82e672b](https://github.com/niivue/mono/commit/82e672b))
- **niivue:** wrap GL per-volume updateVolume in try/catch (WebGPU parity) ([a24519e](https://github.com/niivue/mono/commit/a24519e))
- **niivue:** backend-parity and graph-cache correctness fixes ([79b2b5a](https://github.com/niivue/mono/commit/79b2b5a))
- **niivue:** enforce maxBricks by coarsening the multi-LOD root grid ([2dc448e](https://github.com/niivue/mono/commit/2dc448e))
- **niivue:** guard chunk upload against a stale plan swap ([7f87f2b](https://github.com/niivue/mono/commit/7f87f2b))
- **niivue:** exact BSP back-to-front order for mixed-size chunks ([4695056](https://github.com/niivue/mono/commit/4695056))
- **niivue:** wire modulation placeholder into the chunked orient path ([01fd6df](https://github.com/niivue/mono/commit/01fd6df))
- **niivue:** drop unused import and sort exports after merge (lint) ([13addf6](https://github.com/niivue/mono/commit/13addf6))
- bypass linter for makeLabelLut re-export ([e4575ba](https://github.com/niivue/mono/commit/e4575ba))
- stop "missing image data" crash on rapid overlay-option changes ([9e83564](https://github.com/niivue/mono/commit/9e83564))
- **niivue:** land exploded-block drawing on the visible tissue, not air or clipped voxels ([b7064a1](https://github.com/niivue/mono/commit/b7064a1))
- **niivue:** don't draw on exploded blocks the clip plane has hidden ([089f1dd](https://github.com/niivue/mono/commit/089f1dd))
- **iiif-volumetric-demo:** correct WSI minimap + drag Y orientation ([eb93b6d](https://github.com/niivue/mono/commit/eb93b6d))
- **iiif-volumetric-demo:** smooth, drift-free WSI zoom/pan ([ce73b70](https://github.com/niivue/mono/commit/ce73b70))
- **niivue:** keep exploded chunks resident during rotation ([b223deb](https://github.com/niivue/mono/commit/b223deb))
- address codespell gate ([a0a4657](https://github.com/niivue/mono/commit/a0a4657))
- eliminate streamed volume seam artifacts ([8be40df](https://github.com/niivue/mono/commit/8be40df))
- stabilize streamed OME-Zarr chunk rendering ([90ed416](https://github.com/niivue/mono/commit/90ed416))
- smooth tiled volume rendering ([004f567](https://github.com/niivue/mono/commit/004f567))
- **niivue:** request adapter's max 3D texture limit on WebGPU ([042fdad](https://github.com/niivue/mono/commit/042fdad))
- **iiif-volumetric:** address PR #42 review ([#42](https://github.com/niivue/mono/issues/42))
- **niivue:** correct fan-out and hit-test for shared-canvas multi-instance ([052f4a5](https://github.com/niivue/mono/commit/052f4a5))

### Performance

- **niivue:** stream partial 4D image into one pre-sized buffer ([#60](https://github.com/niivue/mono/issues/60))
- route background volume through the orient-texture cache, cache matcap ([a4982d2](https://github.com/niivue/mono/commit/a4982d2))
- **niivue:** split residency budget between base and chunked overlay ([184f068](https://github.com/niivue/mono/commit/184f068))
- **niivue:** parallel-prefetch chunk source fetches ahead of upload ([b6480bd](https://github.com/niivue/mono/commit/b6480bd))
- **niivue:** time-budgeted round-robin chunk upload pump + stream stats ([edde445](https://github.com/niivue/mono/commit/edde445))

### Thank You

- Chris Drake
- Claude Opus 4.7
- Claude Opus 4.8
- Claude Opus 4.8 (1M context)
- Massny
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.9 (2026-06-12)

### Features

- **niivue:** trigger rug uses the measure-specific <name>_trigger column ([4558b8c](https://github.com/niivue/mono/commit/4558b8c))
- **niivue:** trigger rug at top of signal graph; address PR review + codespell ([f3d33f1](https://github.com/niivue/mono/commit/f3d33f1))
- **niivue:** signal-graph range/zoom interaction (auto-reset + reactive sync) ([#1](https://github.com/niivue/mono/issues/1), [#2](https://github.com/niivue/mono/issues/2))
- **niivue:** signal-graph pan/zoom, missing-data rug, long-physio demo ([fc8db6a](https://github.com/niivue/mono/commit/fc8db6a))
- **niivue:** modulate scalar and background volumes via setModulationImage ([fe0eaca](https://github.com/niivue/mono/commit/fe0eaca))
- **niivue:** add MRSI (MR spectroscopic imaging) support ([bf07b72](https://github.com/niivue/mono/commit/bf07b72))
- **niivue:** annotate signal graphs and add spectroscopy MRI/MRS/voxel demo ([0a68aee](https://github.com/niivue/mono/commit/0a68aee))
- **niivue:** volume+physio association, signal graph UX, audit fixes ([1361053](https://github.com/niivue/mono/commit/1361053))
- **niivue:** add Signal data class (physio + spectroscopy) ([a26b4b3](https://github.com/niivue/mono/commit/a26b4b3))
- **niivue:** bench:report — add fps head-to-head table ([8de6492](https://github.com/niivue/mono/commit/8de6492))
- **niivue:** bench:report — backend-specific tables, real-GPU only ([301794d](https://github.com/niivue/mono/commit/301794d))
- **niivue:** bench:report — self-contained HTML perf report (WebGPU + WebGL2) ([b5a17c7](https://github.com/niivue/mono/commit/b5a17c7))
- **niivue:** dual-backend bench (WebGPU + WebGL2) with GPU timer queries ([fde4c8f](https://github.com/niivue/mono/commit/fde4c8f))
- **niivue:** nv.perf API for per-frame interaction metrics ([876cb52](https://github.com/niivue/mono/commit/876cb52))
- **niivue:** replace CI perf gate with local bench:compare script ([7c6c322](https://github.com/niivue/mono/commit/7c6c322))
- **niivue:** perf gate — handle bootstrap (main predates infra) ([2fb4fae](https://github.com/niivue/mono/commit/2fb4fae))
- **niivue:** perf-regression CI gate (compare PR vs main) ([d92d018](https://github.com/niivue/mono/commit/d92d018))
- **niivue:** add Playwright bench runner ([e492b21](https://github.com/niivue/mono/commit/e492b21))
- **niivue:** add autorun mode to benchmark suite ([ea42a63](https://github.com/niivue/mono/commit/ea42a63))
- **niivue:** minimal perf example + benchmark guardrails ([cc38632](https://github.com/niivue/mono/commit/cc38632))
- **niivue:** gate perf instrumentation on __NIIVUE_PERF__ build flag ([df61452](https://github.com/niivue/mono/commit/df61452))
- **niivue:** port perf harness from niivuegpu ([b648895](https://github.com/niivue/mono/commit/b648895))

### Fixes

- **niivue:** audit round - per-series triggers, default trigger exclusion, doc restore ([d6725ad](https://github.com/niivue/mono/commit/d6725ad))
- **niivue:** audit round - MRS dwell sidecar-first, trigger guards, label, frame index ([5383dca](https://github.com/niivue/mono/commit/5383dca))
- **niivue:** restrict graph double-click reset to the zoom-out button; format sidecars ([8fa900f](https://github.com/niivue/mono/commit/8fa900f))
- **npy:** set trailing pixDims to 0 for NIfTI consistency ([ea071aa](https://github.com/niivue/mono/commit/ea071aa))
- **niivue:** 4D wheel scroll, frame-aware contrast, DPR-change resize ([a4ef65f](https://github.com/niivue/mono/commit/a4ef65f))
- **niivue:** address perf-harness review feedback ([5354456](https://github.com/niivue/mono/commit/5354456))

### Performance

- **niivue:** reduce bench variance + fix asymmetric fps comparison ([b1e0592](https://github.com/niivue/mono/commit/b1e0592))

### Thank You

- Chris Drake
- Claude Opus 4.7
- Claude Opus 4.7 (1M context)
- Claude Opus 4.8
- Claude Opus 4.8 (1M context)
- Matt McCormick @thewtex
- neurolabusc

## 1.0.0-rc.8 (2026-05-13)

### Features

- **niivue:** port legacy colormaps ([06902e0](https://github.com/niivue/mono/commit/06902e0))

### Fixes

- **niivue:** validate colormap channel bounds ([27b3882](https://github.com/niivue/mono/commit/27b3882))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.7 (2026-05-12)

### Fixes

- **niivue:** update README package reference ([9f1ffe0](https://github.com/niivue/mono/commit/9f1ffe0))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.6 (2026-05-12)

### Fixes

- **niivue:** correct package import examples ([7e4567c](https://github.com/niivue/mono/commit/7e4567c))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.5 (2026-05-12)

### Fixes

- **niivue:** sort imports after merge conflict resolution ([aa6a73d](https://github.com/niivue/mono/commit/aa6a73d))
- **niivue:** clean up overlay texture transitions ([a3b861f](https://github.com/niivue/mono/commit/a3b861f))
- address Copilot second-round PR review ([53651fb](https://github.com/niivue/mono/commit/53651fb))
- **niivue:** repair loadDeferred4DVolumes after limitFrames4D ([#28](https://github.com/niivue/mono/issues/28))
- **niivue:** address affine review feedback ([185c5f5](https://github.com/niivue/mono/commit/185c5f5))
- **niivue:** invalidate label colormap texture cache ([3808d90](https://github.com/niivue/mono/commit/3808d90))

### Performance

- **niivue:** cache affine overlay rebakes ([2717694](https://github.com/niivue/mono/commit/2717694))

### Thank You

- Claude Opus 4.7 (1M context)
- hanayik @hanayik
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.4 (2026-05-01)

### Features

- extract NiiVue <-> WKWebView bridge into reusable packages ([4a929a1](https://github.com/niivue/mono/commit/4a929a1))
- **nv-ext-dcm2niix:** add DICOM-to-NIfTI extension and demo ([04a3898](https://github.com/niivue/mono/commit/04a3898))

### Fixes

- **niivue:** extend default drawing colormap to 8 colors ([#8](https://github.com/niivue/mono/issues/8))
- **niivue:** tolerate VTK files missing the title line ([c4d9b49](https://github.com/niivue/mono/commit/c4d9b49))
- **ipyniivue:** suppress JupyterLab cell context menu on canvas right-click ([a58bd8c](https://github.com/niivue/mono/commit/a58bd8c))

### Thank You

- Claude Opus 4.7 (1M context)
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.3 (2026-04-27)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.2 (2026-04-27)

### Features

- add vox.torso.html link to examples index page ([280c831](https://github.com/niivue/mono/commit/280c831))
- **niivue:** drawing matcap lighting and bench modularization ([d0e6e7f](https://github.com/niivue/mono/commit/d0e6e7f))
- **niivue:** drawing labels, loadDrawing fix, and render bench harness ([3334824](https://github.com/niivue/mono/commit/3334824))
- **medgfx:** add native macOS/iOS app with embedded NiiVue web view ([38d7a70](https://github.com/niivue/mono/commit/38d7a70))

### Fixes

- **niivue:** inline asset images as base64 data URIs in lib build ([#10](https://github.com/niivue/mono/issues/10))

### Thank You

- Claude Opus 4.7 (1M context)
- hanayik @hanayik
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.1 (2026-04-22)

### 🚀 Features

- **niivue:** add custom layout support ([26f23c5](https://github.com/niivue/mono/commit/26f23c5))

### 🩹 Fixes

- **ci:** use bunx --bun to force Bun runtime for vite commands ([19e1df2](https://github.com/niivue/mono/commit/19e1df2))
- **ci:** use bunx for vite commands and resolve typecheck errors ([6e637db](https://github.com/niivue/mono/commit/6e637db))
- **niivue:** preserve aspect ratio in custom layout tiles ([aa418c8](https://github.com/niivue/mono/commit/aa418c8))
- **nv-react:** update to new niivue API and switch dev server to Vite ([5c90bc4](https://github.com/niivue/mono/commit/5c90bc4))
- **niivue:** resolve TypeScript strict null check errors across codebase ([f3936c3](https://github.com/niivue/mono/commit/f3936c3))

### ❤️ Thank You

- Taylor Hanayik @hanayik