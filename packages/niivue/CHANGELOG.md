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