# @niivue/nv-ext-save-html

Export a [NiiVue](https://github.com/niivue) scene as a self-contained HTML file.

## Installation

```bash
bun add @niivue/nv-ext-save-html
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import NiiVueGPU from '@niivue/niivue'
import { saveHTML } from '@niivue/nv-ext-save-html'

const nv = new NiiVueGPU()
await nv.attachTo('gl1')
await nv.loadVolumes([{ url: 'brain.nii.gz' }])

// Fetch a pre-built standalone niivue bundle (all deps inlined)
const bundleSource = await fetch('/niivue-standalone.js').then(r => r.text())

// Download the current scene as a self-contained HTML file
await saveHTML(nv, 'scene.html', {
  niivueBundleSource: bundleSource,
  title: 'My NiiVue Scene',
})
```

## Development

```bash
bunx nx build nv-ext-save-html    # Build
bunx nx typecheck nv-ext-save-html # Type-check
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
