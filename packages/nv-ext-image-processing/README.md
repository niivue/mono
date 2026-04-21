# @niivue/nv-ext-image-processing

Image processing extensions for [NiiVue](https://github.com/niivue) — includes Otsu thresholding, haze removal, and more.

## Installation

```bash
bun add @niivue/nv-ext-image-processing
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import NiiVue from '@niivue/niivue'
import { otsu, removeHaze, conform, connectedLabel } from '@niivue/nv-ext-image-processing'

const nv = new NiiVue()
const ctx = nv.createExtensionContext()

// Register transforms (runs heavy work in a Web Worker)
ctx.registerVolumeTransform(otsu)
ctx.registerVolumeTransform(removeHaze)

await nv.attachToCanvas(canvas)
await nv.loadVolumes([{ url: 'brain.nii.gz' }])

// Apply Otsu thresholding and add result as an overlay
const vol = ctx.volumes[0]
const segmented = await ctx.applyVolumeTransform('otsu', vol)
await ctx.addVolume(segmented)
```

## Development

```bash
bunx nx build nv-ext-image-processing    # Build
bunx nx typecheck nv-ext-image-processing # Type-check
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
