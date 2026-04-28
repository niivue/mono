# @niivue/nv-ext-dcm2niix

Browser-side DICOM-to-NIfTI conversion for [NiiVue](https://github.com/niivue), wrapping the [`@niivue/dcm2niix`](https://www.npmjs.com/package/@niivue/dcm2niix) WebAssembly build of Chris Rorden's [`dcm2niix`](https://github.com/rordenlab/dcm2niix). No data leaves the browser.

## Installation

```bash
bun add @niivue/nv-ext-dcm2niix
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

### Folder picker

```ts
import NiiVueGPU from '@niivue/niivue'
import { runDcm2niix } from '@niivue/nv-ext-dcm2niix'

const nv = new NiiVueGPU()
await nv.attachTo('gl1')

const input = document.querySelector<HTMLInputElement>('#dicomFolder')!
input.addEventListener('change', async () => {
  const niftiFiles = await runDcm2niix(input.files)
  await nv.loadVolumes([{ url: niftiFiles[0] }])
})
```

The input should declare `webkitdirectory` so the browser exposes folder structure:

```html
<input id="dicomFolder" type="file" webkitdirectory multiple />
```

### Drag-and-drop folders

```ts
import { runDcm2niix, traverseDataTransferItems } from '@niivue/nv-ext-dcm2niix'

dropTarget.addEventListener('drop', async (e) => {
  e.preventDefault()
  const files = await traverseDataTransferItems(e.dataTransfer!.items)
  const niftiFiles = await runDcm2niix(files)
  await nv.loadVolumes([{ url: niftiFiles[0] }])
})
```

### Power users

The underlying `Dcm2niix` class is re-exported for callers that need full control over dcm2niix command-line flags (compression level, BIDS sidecars, etc.):

```ts
import { Dcm2niix } from '@niivue/nv-ext-dcm2niix'

const dcm2niix = new Dcm2niix()
await dcm2niix.init()
const result = await dcm2niix.input(files).compressionLevel(9).bids('n').run()
```

## Development

```bash
bunx nx build nv-ext-dcm2niix
bunx nx typecheck nv-ext-dcm2niix
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
