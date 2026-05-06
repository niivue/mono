# @niivue/nv-ext-brain2print

Tinygrad-generated WebGPU brain segmentation models for [NiiVue](https://github.com/niivue), plus voxel-to-mesh helpers that turn the resulting label volume into an exportable 3D triangle mesh. Two segmentation models are bundled — `tissue_fast` (fast tissue-class segmentation) and `subcortical` (gray/white + subcortical structures); both expect a conformed 256³ 1 mm T1 input. All inference runs on the user's GPU; no data leaves the browser.

The model implementations under `src/models/` are tinygrad codegen output (WGSL + JS). They are kept verbatim — only a typed wrapper at the bottom matches the public `BrainModel` shape.

## Installation

```bash
bun add @niivue/nv-ext-brain2print
```

Peer deps: `@niivue/niivue`, `@niivue/nv-ext-image-processing` (for the `conform` transform), `@niivue/nv-ext-niimath` (fast mesh path), `@itk-wasm/cuberille` and `@itk-wasm/mesh-filters` (quality mesh path). Weight blobs are not bundled — host the `.safetensors` files alongside your app and pass the URL.

The quality mesh path lazily fetches its WASM modules from the `@itk-wasm/*` packages' default CDN (`cdn.jsdelivr.net`) on first call. The fast path runs entirely in-process via the niimath WASM worker.

**Trust boundary.** A CDN compromise or MITM during the first quality build would inject WASM that runs against the user's GPU and loaded volumes. There is no SRI hash on the runtime fetch. Consumers who can't accept that risk should vendor the pipeline `.wasm`/`.js` blobs locally and call `setPipelinesBaseUrl()` from `@itk-wasm/cuberille` and `@itk-wasm/mesh-filters` at app startup to point at a same-origin path.

## Try the demo

A working demo lives at [`apps/demo-ext-brain2print`](../../apps/demo-ext-brain2print). From the monorepo root:

```bash
bun install
bunx nx dev demo-ext-brain2print     # serves at http://localhost:8090
```

The dev server picks up `t1_crop.nii.gz` from `@niivue/dev-images` automatically and the weight blobs from the demo's `public/` directory. First load takes ~5 s (WebGPU pipeline compile + weight fetch). The demo keeps one active inferer and disposes it on model switch so GPU memory stays bounded. Drop any other `.nii` / `.nii.gz` onto the page to replace the background and re-segment — `prepareInput` handles arbitrary input dims and orientation.

Requires a browser with WebGPU, the `shader-f16` feature, and ≥1.4 GB of GPU storage-buffer headroom (recent desktop Chrome / Edge / Firefox-Nightly on a discrete GPU works; most phones do not — the demo blocks the Segment button and shows a fallback panel when these aren't available).

## Usage

```ts
import NiiVueGPU from '@niivue/niivue'
import {
  BRAIN_MODELS,
  COLORMAP_TISSUE_SUBCORTICAL,
  buildSegmentationVolume,
  getBrainGPUDevice,
  prepareInput,
} from '@niivue/nv-ext-brain2print'
import { conform } from '@niivue/nv-ext-image-processing'

const nv = new NiiVueGPU()
await nv.attachTo('gl1')
const ctx = nv.createExtensionContext()
// prepareInput dispatches the 'conform' transform through ctx — register
// it once at startup.
ctx.registerVolumeTransform(conform)

// 1. Acquire device once (returns null on hardware that can't run the models).
const device = await getBrainGPUDevice()
if (!device) {
  // Show "WebGPU with shader-f16 + 1.4 GB buffers required" in the UI.
  return
}

// 2. On Segment click:
await nv.loadVolumes([{ url: '/volumes/t1_crop.nii.gz' }])
const { conformed, img32 } = await prepareInput(ctx, nv.volumes[0])
const model = BRAIN_MODELS.tissue_fast
const inferer = await model.load(device, '/net_tissue_fast.safetensors')
const [labels] = await inferer(img32)
const seg = buildSegmentationVolume(conformed, labels, COLORMAP_TISSUE_SUBCORTICAL)
await ctx.addVolume(seg)
inferer.dispose()
```

## API

### `getBrainGPUDevice(): Promise<GPUDevice | null>`

Requests an adapter + device with `shader-f16` and ~1.4 GB max storage buffer. Returns `null` when any requirement is missing — callers should branch on that to render an explanatory fallback rather than failing silently.

### `prepareInput(ctx, volume): Promise<{ conformed, img32 }>`

Conforms `volume` to a 256³ 1 mm grid (FreeSurfer-style) using `nv-ext-image-processing`'s `conform` transform, then normalizes the values to `[0, 1]`. Pass the returned `img32` straight to `inferer(img32)`; pass `conformed` to `buildSegmentationVolume` so the output volume shares the input's geometry.

The conform pass is skipped only when the input is already 256³, 1 mm isotropic, **and** in FreeSurfer-canonical orientation (`permRAS = [-1, 3, -2]`). Matching dims alone is unsafe (wrong-axis voxels); matching dims + permRAS at non-1 mm spacing would scale anatomy.

**The caller must register the `conform` transform on `ctx` once at startup:**

```ts
import { conform } from '@niivue/nv-ext-image-processing'
ctx.registerVolumeTransform(conform)
```

### `BRAIN_MODELS`

```ts
{
  tissue_fast: { name, label: 'Tissue (fast)', load },
  subcortical: { name, label: 'Subcortical',   load },
}
```

`load(device, weights)` returns a disposable inferer closure `(img32) => Promise<Float32Array[]>`. `weights` accepts a URL string, `ArrayBuffer`, or `Uint8Array`. `await inferer.dispose()` when replacing a model or tearing down the view — it waits for every in-flight inference to settle (tracked via an internal `Set` + `Promise.allSettled`) before destroying the tracked GPU buffers, so a slower call can't still be running on freed buffers. Subsequent calls to a disposed inferer reject; `dispose()` itself is idempotent. The library does **not** serialize concurrent calls (the tinygrad pipeline races on shared input/output buffers) — callers must do that themselves.

### `buildSegmentationVolume(conformed, labels, colormap): NVImage`

Wraps `labels` as a label-coloured `NVImage` sharing `conformed`'s grid. Sets `colormapLabel` via `makeLabelLut(colormap)` and defaults `opacity` to `0.5`. Append the result with `await ctx.addVolume(seg)`.

### `COLORMAP_TISSUE_SUBCORTICAL`

`ColorMap` constant used by both models. Inlined — no JSON fetch needed.

### `buildMeshFromVolumeFast(niimath, volume, opts?): Promise<ArrayBuffer>`

Turns a label or scalar `NVImage` into an MZ3 triangle mesh via niimath's `hollow → close → mesh` chain. Caller passes an already-`init()`ed `Niimath` instance — reuse it across calls so the WASM worker cold-start is paid once. Options:

| Field          | Default                                      | Notes |
|----------------|----------------------------------------------|-------|
| `isoValue`     | `0.5` for labels (`intent_code === 1002`); `240` for everything else | |
| `hollow`       | `0`                                          | mm; negative values hollow with a `-hollow`-mm wall |
| `close`        | `0`                                          | mm; positive values morph-close before meshing |
| `reduce`       | `0.25`                                       | (0, 1] simplification factor |
| `largestOnly`  | `true`                                       | keep only the largest connected component |
| `fillBubbles`  | `false`                                      | fill internal bubbles |

Returns a raw MZ3 buffer with niimath's native CW winding. Use `loadFastMeshAndFlipFaces` to land it in NiiVue with the winding fixed and the GPU index buffer refreshed in one call.

### `loadFastMeshAndFlipFaces(nv, buffer, name?): Promise<void>`

Loads a `buildMeshFromVolumeFast` MZ3 buffer into the given NiiVue instance, flips every triangle's winding in place (niimath emits CW; NiiVue's mesh shader assumes CCW), and calls `nv.updateGLVolume()` so the GPU index buffer is re-uploaded to match — without that re-upload, mutating `mesh.indices` alone leaves the previously-uploaded buffer on the GPU and the mesh renders inside-out until a slider tweak forces a refresh. The Quality path emits CCW already and does not need this; load its buffer directly via `nv.loadMeshes`.

```ts
const buf = await buildMeshFromVolumeFast(niimath, volume)
await loadFastMeshAndFlipFaces(nv, buf)
```

### `buildMeshFromVolumeQuality(volume, opts?): Promise<ArrayBuffer>`

Higher-quality watertight mesh via `@itk-wasm/cuberille` (or `antiAliasCuberille` for label volumes) → `repair` → `keepLargestComponent` → `smoothRemesh` → `repair`. Returns a `.iwm.cbor` buffer that niivue's mesh reader picks up by extension. Options:

| Field              | Default                                | Notes |
|--------------------|----------------------------------------|-------|
| `isoValue`         | `0.5` for labels, `240` for scalar     | ignored when `useAntiAlias` is true (the anti-alias path operates on a normalized `[-4, 4]` image and uses its WASM default) |
| `useAntiAlias`     | `true` for labels, `false` for scalar  | switches to `antiAliasCuberille` when set |
| `smoothIterations` | `30`                                   | Newton iterations passed to `smoothRemesh` |
| `shrinkPct`        | `25`                                   | output point count, percent of bounding-box diagonal |
| `maxHoleArea`      | `50`                                   | passed to `repair` (percent of total area) |

```ts
import {
  buildMeshFromVolumeFast,
  buildMeshFromVolumeQuality,
  loadFastMeshAndFlipFaces,
} from '@niivue/nv-ext-brain2print'

const buf = await buildMeshFromVolumeFast(niimath, segVolume, { hollow: 0, close: 0 })
await loadFastMeshAndFlipFaces(nv, buf)

// Quality variant — first call fetches the cuberille + mesh-filters WASM
// modules from jsdelivr (npm default CDN for @itk-wasm/*).
const buf2 = await buildMeshFromVolumeQuality(segVolume)
await nv.loadMeshes([{ url: new File([buf2], 'mesh.iwm.cbor') }])
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
