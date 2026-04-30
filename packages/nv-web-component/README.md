# @niivue/nv-web-component

Lit-based Web Components for NiiVue. The package registers standard custom elements that work with plain HTML, Vite, Lit, React, Vue, Svelte, or any other browser environment that supports Web Components.

The API is DOM-first: configure elements with properties, call methods on the element instance, and listen for `CustomEvent`s.

## Install

```bash
bun add @niivue/nv-web-component @niivue/niivue lit
```

## Getting started: single viewer

Importing the package registers `<niivue-viewer>` automatically.

```html
<niivue-viewer id="viewer" style="height: 600px"></niivue-viewer>

<script type="module">
  import '@niivue/nv-web-component'

  await customElements.whenDefined('niivue-viewer')

  const viewer = document.querySelector('#viewer')

  viewer.volumes = [
    {
      url: '/volumes/mni152.nii.gz',
      name: 'MNI152',
      colormap: 'gray',
    },
  ]

  viewer.addEventListener('image-loaded', (event) => {
    console.log('loaded volume', event.detail)
  })

  viewer.addEventListener('location-change', (event) => {
    console.log('location', event.detail)
  })

  viewer.addEventListener('niivue-error', (event) => {
    console.error('NiiVue error', event.detail)
  })
</script>
```

### Updating viewer settings

Use element methods for common NiiVue operations. The standalone viewer methods target its own NiiVue instance.

```js
const viewer = document.querySelector('niivue-viewer')

await viewer.setColormap(0, 'hot')
await viewer.setOpacity(0, 0.8)
await viewer.setCalMinMax(0, 10, 200)

viewer.setColorbarVisible(true)
viewer.setCrosshairVisible(false)
viewer.setPrimaryDragMode(DRAG_MODE.pan)
```

With imports:

```js
import { DRAG_MODE } from '@niivue/nv-web-component'
```

## Getting started: scene of viewers

Use `<niivue-scene>` when you want multiple independent NiiVue viewers managed as one scene. The `layout` property controls how many viewer slots exist.

```html
<niivue-scene id="scene" layout="2x2" style="height: 600px"></niivue-scene>

<script type="module">
  import '@niivue/nv-web-component'

  await customElements.whenDefined('niivue-scene')

  const scene = document.querySelector('#scene')
  await scene.updateComplete

  const volume = {
    url: '/volumes/mni152.nii.gz',
    name: 'MNI152',
    colormap: 'gray',
  }

  // The 2x2 layout creates four viewer slots. Load the same image into each
  // viewer as separate NiiVue volume instances.
  await Promise.all(
    Array.from({ length: scene.snapshot.viewerCount }, (_value, index) =>
      scene.loadVolume(index, volume),
    ),
  )

  scene.addEventListener('scene-change', (event) => {
    console.log('scene snapshot', event.detail)
  })
</script>
```

`customElements.whenDefined()` waits for element registration. Wait for Lit's
`scene.updateComplete`, or for the first `scene-change` event, before reading
`scene.snapshot.viewerCount` or loading volumes into scene viewers.

### Updating all scene viewers

Scene methods that target volumes take both a viewer index and a volume index. Batch operations across viewers with `Promise.all`.

```js
const scene = document.querySelector('niivue-scene')

await Promise.all(
  Array.from({ length: scene.snapshot.viewerCount }, (_value, index) =>
    scene.setColormap(index, 0, 'hot'),
  ),
)
```

Viewer-wide scene settings accept an optional `viewerIndex`. If omitted, they apply to every viewer in the scene.

```js
import { DRAG_MODE } from '@niivue/nv-web-component'

scene.setColorbarVisible(true)
scene.setCrosshairVisible(false)
scene.setPrimaryDragMode(DRAG_MODE.pan)

// Apply only to viewer 0.
scene.setCrosshairVisible(true, 0)
```

### Changing layouts and broadcasting

```js
scene.layout = '1x2'
scene.broadcasting = true

scene.addEventListener('location-change', (event) => {
  const { viewerIndex, data } = event.detail
  console.log(`viewer ${viewerIndex}`, data)
})
```

## API reference

### `<niivue-viewer>`

Properties:

- `volumes: ImageFromUrlOptions[]` - declarative volume list, diffed automatically.
- `options: Partial<NiiVueOptions>` - NiiVue construction options.
- `sliceType: number` / `slice-type` attribute - active slice type.
- `nv: NiiVueGPU | null` - raw NiiVue instance after initialization.

Methods:

- `setColormap(volumeIndex, colormap)`
- `setOpacity(volumeIndex, opacity)`
- `setCalMinMax(volumeIndex, calMin, calMax)`
- `setColorbarVisible(visible)`
- `setCrosshairVisible(visible)`
- `setPrimaryDragMode(mode)`
- `setSecondaryDragMode(mode)`

Events:

- `location-change`
- `image-loaded`
- `niivue-error`

### `<niivue-scene>`

Properties:

- `layout: string` - one of the exported `defaultLayouts` keys (`1x1`, `1x2`, `2x1`, `1x3`, `3x1`, `2x2`, `3x3`).
- `broadcasting: boolean` - synchronizes crosshair/camera interactions across viewers.
- `snapshot: NvSceneControllerSnapshot` - current scene state.
- `scene: NvSceneController` - controller for advanced usage.

Methods:

- `addViewer(options?)`
- `removeViewer(index)`
- `canAddViewer()`
- `setViewerSliceLayout(index, layout)`
- `loadVolume(index, opts)`
- `loadVolumes(index, optsArray)`
- `removeVolume(index, url)`
- `setColormap(viewerIndex, volumeIndex, colormap)`
- `setOpacity(viewerIndex, volumeIndex, opacity)`
- `setCalMinMax(viewerIndex, volumeIndex, calMin, calMax)`
- `setColorbarVisible(visible, viewerIndex?)`
- `setCrosshairVisible(visible, viewerIndex?)`
- `setPrimaryDragMode(mode, viewerIndex?)`
- `setSecondaryDragMode(mode, viewerIndex?)`

Events:

- `scene-change`
- `viewer-created`
- `viewer-removed`
- `location-change`
- `image-loaded`
- `niivue-error`
- `volume-added`
- `volume-removed`

## Manual registration

```ts
import { defineNiivueWebComponents } from '@niivue/nv-web-component'

defineNiivueWebComponents({
  elementName: 'my-niivue-viewer',
  sceneElementName: 'my-niivue-scene',
})
```

## Exports

The package exports `NiivueViewerElement`, `NiivueSceneElement`, `NvSceneController`, `defaultLayouts`, `defaultSliceLayouts`, `defaultViewerOptions`, `DRAG_MODE`, `SLICE_TYPE`, and NiiVue types.
