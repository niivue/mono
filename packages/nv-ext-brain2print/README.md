# @niivue/nv-ext-brain2print

Tinygrad-generated WebGPU brain segmentation models for [NiiVue](https://github.com/niivue). Two models bundled — `tissue_fast` (fast tissue-class segmentation) and `subcortical` (gray/white + subcortical structures). Both expect a conformed 256³ 1 mm T1 input. All inference runs on the user's GPU; no data leaves the browser.

The model implementations under `src/models/` are tinygrad codegen output (WGSL + JS). They are kept verbatim — only a typed wrapper at the bottom matches the public `BrainModel` shape.

## Installation

```bash
bun add @niivue/nv-ext-brain2print
```

Peer deps: `@niivue/niivue`, `@niivue/nv-ext-image-processing` (for the `conform` transform). Weight blobs are not bundled — host the `.safetensors` files alongside your app and pass the URL.

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

`load(device, weights)` returns a disposable inferer closure `(img32) => Promise<Float32Array[]>`. `weights` accepts a URL string, `ArrayBuffer`, or `Uint8Array`. Call `inferer.dispose()` when replacing a model or tearing down the view to release the generated WebGPU buffers.

### `buildSegmentationVolume(conformed, labels, colormap): NVImage`

Wraps `labels` as a label-coloured `NVImage` sharing `conformed`'s grid. Sets `colormapLabel` via `makeLabelLut(colormap)` and defaults `opacity` to `0.5`. Append the result with `await ctx.addVolume(seg)`.

### `COLORMAP_TISSUE_SUBCORTICAL`

`ColorMap` constant used by both models. Inlined — no JSON fetch needed.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
