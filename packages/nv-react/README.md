# @niivue/nvreact

Lightweight React bindings for [Niivue](https://github.com/niivue/niivue) with multi-instance scene management, declarative hooks, and a standalone viewer component.

## Install

```bash
bun add @niivue/nvreact @niivue/niivue react react-dom
```

## Quick start

```tsx
import { NvScene, NvSceneProvider, useScene } from "@niivue/nvreact";

function App() {
  const { scene, snapshot } = useScene();
  return (
    <NvSceneProvider scene={scene}>
      <p>{snapshot.viewerCount} viewers</p>
      <button onClick={() => scene.addViewer()}>Add</button>
      <NvScene scene={scene} style={{ height: 600 }} />
    </NvSceneProvider>
  );
}
```

## Standalone viewer

`NvViewer` is a single-instance component with declarative volume management — pass a `volumes` array and it handles loading/diffing automatically.

```tsx
import { NvViewer } from "@niivue/nvreact";

function App() {
  return (
    <NvViewer
      volumes={[{ url: "https://example.com/brain.nii.gz", name: "brain" }]}
      style={{ height: 600 }}
      onImageLoaded={(vol) => console.log("loaded:", vol.name)}
      onLocationChange={(data) => console.log("location:", data)}
      onError={(err) => console.error(err)}
    />
  );
}
```

### NvViewer props

| Prop | Type | Description |
|------|------|-------------|
| `volumes` | `ImageFromUrlOptions[]` | Volumes to load (diffed automatically) |
| `options` | `Partial<NVConfigOptions>` | Niivue config overrides |
| `sliceType` | `number` | Slice type (default: `SLICE_TYPE.AXIAL`) |
| `className` | `string` | CSS class for the container div |
| `style` | `CSSProperties` | Inline styles for the container div |
| `onLocationChange` | `(data) => void` | Crosshair location callback |
| `onImageLoaded` | `(volume: NVImage) => void` | Volume loaded callback |
| `onError` | `(error) => void` | Error callback |

## Hooks

### `useScene(controller?, layouts?, viewerDefaults?)`

Creates (or wraps) an `NvSceneController` and subscribes to its snapshot via `useSyncExternalStore`.

```tsx
const { scene, snapshot } = useScene();
```

Pass an existing controller to wrap it instead of creating a new one:

```tsx
const controller = useMemo(() => new NvSceneController(defaultLayouts), []);
const { scene, snapshot } = useScene(controller);
```

### `useNiivue(scene, index)`

Returns the raw `Niivue` instance at the given viewer index, or `undefined` if the index is out of range.

```tsx
const nv = useNiivue(scene, 0);
```

### `useSceneEvent(scene, event, callback)`

Subscribes to scene events with automatic cleanup. The callback ref is stable so it always calls the latest function.

```tsx
useSceneEvent(scene, "viewerCreated", (nv, index) => {
  console.log(`viewer ${index} created`);
});

useSceneEvent(scene, "imageLoaded", (viewerIndex, volume) => {
  console.log(`loaded ${volume.name} in viewer ${viewerIndex}`);
});

useSceneEvent(scene, "locationChange", (viewerIndex, data) => {
  console.log(`viewer ${viewerIndex}: ${data.string}`);
});
```

#### Events

| Event | Callback signature |
|-------|-------------------|
| `viewerCreated` | `(nv: Niivue, index: number) => void` |
| `viewerRemoved` | `(index: number) => void` |
| `locationChange` | `(viewerIndex: number, data: unknown) => void` |
| `imageLoaded` | `(viewerIndex: number, volume: NVImage) => void` |
| `error` | `(viewerIndex: number, error: unknown) => void` |
| `volumeAdded` | `(viewerIndex: number, imageOptions, image: NVImage) => void` |
| `volumeRemoved` | `(viewerIndex: number, url: string) => void` |

## Context

`NvSceneProvider` makes a scene controller available to any descendant via `useSceneContext()`.

```tsx
import { NvSceneProvider, useSceneContext } from "@niivue/nvreact";

function Toolbar() {
  const scene = useSceneContext();
  return <button onClick={() => scene.addViewer()}>Add</button>;
}

function App() {
  const { scene, snapshot } = useScene();
  return (
    <NvSceneProvider scene={scene}>
      <Toolbar />
      <NvScene scene={scene} />
    </NvSceneProvider>
  );
}
```

## Scene controller

### Viewer management

```tsx
scene.addViewer();
scene.removeViewer(0);
scene.canAddViewer(); // false when at layout capacity
```

### Layouts

```tsx
import { defaultLayouts } from "@niivue/nvreact";

// Layout keys are rows x columns (e.g. "2x2", "1x2", "3x3")
scene.setLayout("2x2");
```

### Per-viewer slice layouts

```tsx
import { defaultSliceLayouts } from "@niivue/nvreact";

scene.setViewerSliceLayout(0, defaultSliceLayouts["axial-hero"].layout);
scene.setViewerSliceLayout(0, null); // reset to default
```

### Broadcast interactions

```tsx
scene.setBroadcasting(true); // sync crosshair across all viewers
```

### Volume management

```tsx
await scene.loadVolume(0, { url: "https://example.com/brain.nii.gz", name: "brain" });
await scene.loadVolumes(0, [
  { url: "https://example.com/t1.nii.gz", name: "t1" },
  { url: "https://example.com/overlay.nii.gz", name: "overlay" },
]);
scene.removeVolume(0, "https://example.com/brain.nii.gz");
```

## API reference

### Components

- **`NvScene`** — multi-viewer container bound to an `NvSceneController`
- **`NvViewer`** — standalone single-instance viewer with declarative volumes

### Hooks

- **`useScene(controller?, layouts?, viewerDefaults?)`** — create/wrap a controller + subscribe to snapshots
- **`useNiivue(scene, index)`** — access a raw `Niivue` instance by index
- **`useSceneEvent(scene, event, callback)`** — subscribe to controller events

### Context

- **`NvSceneProvider`** — provides an `NvSceneController` via React context
- **`useSceneContext()`** — consume the nearest `NvSceneProvider`

### Controller

- **`NvSceneController`** — manages multiple Niivue instances, layout, broadcasting, and volumes
- **`NvSceneController#on(event, handler)`** / **`off(event, handler)`** — event subscription
- **`NvSceneController#loadVolume(index, opts)`** / **`loadVolumes(index, opts[])`** — load volumes into a viewer
- **`NvSceneController#removeVolume(index, url)`** — remove a volume by URL

### Presets

- **`defaultLayouts`** — grid layout presets (1x1, 1x2, 2x2, etc.)
- **`defaultSliceLayouts`** — per-viewer slice layout presets
- **`defaultViewerOptions`** — default Niivue config
- **`defaultMouseConfig`** — default mouse interaction config

## Build (local)

```bash
bun run build:package
```

## Publish

```bash
bun run build:package
bun publish --access public
```
