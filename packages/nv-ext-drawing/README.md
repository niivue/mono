# @niivue/nv-ext-drawing

Drawing interpolation and segmentation tools for [NiiVue](https://github.com/niivue).

## Installation

```bash
bun add @niivue/nv-ext-drawing
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  findDrawingBoundarySlices,
  interpolateMaskSlices,
} from '@niivue/nv-ext-drawing'

const nv = new NiiVue()
const ctx = nv.createExtensionContext()
await nv.attachToCanvas(canvas)
await nv.loadVolumes([{ url: 'brain.nii.gz' }])

// Enable drawing and let the user paint on a few slices...
ctx.createEmptyDrawing()

// Find first/last drawn slices along the axial axis
const dr = ctx.drawing!
const bounds = await findDrawingBoundarySlices(
  SLICE_TYPE.AXIAL, dr.bitmap, dr.dims
)

// Interpolate between drawn slices to fill gaps
const filled = await interpolateMaskSlices(
  dr.bitmap, dr.dims, null, 1, undefined, undefined,
  { sliceType: SLICE_TYPE.AXIAL },
)
dr.update(filled)
```

## Development

```bash
bunx nx build nv-ext-drawing    # Build
bunx nx typecheck nv-ext-drawing # Type-check
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
