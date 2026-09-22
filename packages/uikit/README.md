# @niivue/uikit

UIKit: a collection of controls and widgets (rulers, crosshairs, annotations,
and later buttons, sliders, panels) integrated into the
[NiiVue](https://github.com/niivue/niivue) rendering lifecycle.

> **Status: shipping widgets.** The rendering-lifecycle hook, UIKit's own
> line/text renderers (WebGL2 + WebGPU, with a text transform), and the first
> widgets (ruler, annotation, crosshair) are in. See `docs/ruler-port.md` in
> `@niivue/niivue` for the design.

## Design in one paragraph

UIKit is a **separate module with privileged access to NiiVue's rendering
lifecycle**. NiiVue core exposes a small hook (an overlay draw phase + a backend
handle + a settled signal); UIKit registers into it and draws with **its own**
line/text renderers on both backends. UIKit carries a duplicated copy of the line
and text drawing so core stays untouched during a bake-in phase; once UIKit is
proven, core's overlays cut over onto it and the duplicate in core is removed.

## Widgets

Each widget is a pure geometry builder (spec in, plain line + text draw data out,
unit-testable without a GPU) paired with an overlay that owns the GPU resources
and draws that data through the lifecycle hook.

| Builder | Overlay | Draws |
| --- | --- | --- |
| `buildRuler` | `UIKitRulerOverlay` | A measuring ruler with graduated ticks and a distance label |
| `buildCrosshair` | `UIKitCrosshairOverlay` | A screen-space cross marking a point, optionally graduated and numbered |
| `buildAnnotationGeometry` | `UIKitAnnotationOverlay` | Free-form annotation lines |

```ts
import { loadDefaultFont, UIKitCrosshairOverlay } from '@niivue/uikit'

// One font fetch, shared by every widget on the pane.
const crosshair = new UIKitCrosshairOverlay(await loadDefaultFont())
renderer.overlayDraw = (frame) => crosshair.drawOverlay(frame)

crosshair.setCrosshair({
  at: [x, y],
  gapPx: 10, // leave the pixel being pointed at uncovered
  showTicks: true,
  showTickNumbers: true,
  pxPerUnit: [devicePxPerUm, devicePxPerUm], // per axis: planes can be anisotropic
  unitsPerTick: 100,
  units: 'um',
})
```

The builders are usable on their own if you want the geometry but not UIKit's
renderers:

```ts
import { buildTerminatedLine, LineTerminator } from '@niivue/uikit'

// A line with an arrowhead at the end, as plain LineData segments.
const segments = buildTerminatedLine(0, 0, 100, 40, 2, [1, 0, 0, 1], {
  end: LineTerminator.ARROW,
})
```
