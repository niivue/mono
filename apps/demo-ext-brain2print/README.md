# demo-ext-brain2print

Demo app for [`@niivue/nv-ext-brain2print`](../../packages/nv-ext-brain2print) — drop a T1 NIfTI on the page and watch a tinygrad-generated WebGPU model produce a tissue-class or subcortical segmentation overlay. All inference runs on the user's GPU; no data leaves the browser.

The first run on each page load auto-segments a small built-in T1 (`t1_crop.nii.gz` from `@niivue/dev-images`) so you can see the pipeline end-to-end without uploading anything.

## Getting Started

```bash
bun install                            # From monorepo root
bunx nx dev demo-ext-brain2print       # Start dev server (port 8090)
```

The dev server proxies `@niivue/dev-images` for the auto-loaded T1, and serves the model weight blobs (`net_tissue_fast.safetensors`, `net_subcortical.safetensors`) from this app's `public/` directory.

## Build

```bash
bunx nx build demo-ext-brain2print
```

## What's wired up

- **Auto-load** — `t1_crop.nii.gz` loads at startup and is segmented with the default model so the page is interactive on first paint.
- **Drag-and-drop** — drop any `.nii` or `.nii.gz` onto the page to replace the background and re-segment automatically. The library's `prepareInput` conforms arbitrary-orientation inputs to the canonical 256³ 1 mm grid the models expect.
- **Model dropdown** — switch between `tissue_fast` (fast tissue-class segmentation) and `subcortical` (gray/white + subcortical structures). The demo keeps one active inferer and disposes it before loading the next model so GPU memory stays bounded.
- **Opacity sliders** — independent BG / Seg sliders adjust background and overlay opacity live.
- **Mesh** — once a segmentation exists, the Mesh button opens an inline `<details>` panel with a Quality (fast/quality) selector plus hollow / close / smooth / shrink / largest-only / fill-bubbles controls and a Create button. When no segmentation exists, Create is disabled and the panel is force-closed (the `<summary>` button itself can't be disabled, so the panel state plus disabled Create button are the actual gate). Fast uses niimath's `mesh` chain entirely in-process and lands the result via `loadFastMeshAndFlipFaces` (the lib helper handles CW→CCW winding + GPU re-upload in one call); Quality uses `@itk-wasm/cuberille` + `mesh-filters` (first call fetches the WASM modules from cdn.jsdelivr.net) and loads its already-CCW `.iwm.cbor` directly via `nv.loadMeshes`.
- **Save** — exports either the segmentation overlay as `.nii.gz` (Volume) or the current mesh as `.mz3`/`.obj`/`.stl`. The format dropdown is reset to `volume` after each fresh segmentation and to `mz3` after each mesh build (assigned directly on `saveFormat.value` at those transitions); the user can override either default before clicking Save.

## GPU requirements

The models need a WebGPU adapter with the `shader-f16` feature and ~1.4 GB of GPU storage-buffer headroom. Recent desktop Chrome / Edge / Firefox-Nightly on a discrete GPU works; most phones do not. The demo shows a `WebGPU unavailable` health badge and disables the Segment button when the requirements aren't met — see `getBrainGPUDevice` in [`@niivue/nv-ext-brain2print`](../../packages/nv-ext-brain2print) for the exact checks.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
