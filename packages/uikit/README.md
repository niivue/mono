# @niivue/uikit

UIKit: a collection of controls and widgets (rulers, crosshairs, annotations,
buttons, and later sliders and panels) integrated into the
[NiiVue](https://github.com/niivue/niivue) rendering lifecycle.

> **Status: shipping widgets.** The rendering-lifecycle hook, UIKit's own
> line/text/rect renderers (WebGL2 + WebGPU, with a text transform), and the
> first widgets (ruler, annotation, crosshair, button) are in. See
> `docs/ruler-port.md` in `@niivue/niivue` for the design.

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
| `buildRect` | `UIKitRectOverlay` | Filled rounded rectangles with an optional border ring (the first filled primitive) |
| `buildButton` | `UIKitButtonOverlay` | Clickable, stylable push buttons with a text label and a press animation |

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

## Buttons

`UIKitButtonOverlay` draws push buttons into the scene and handles the pointer
for them. Each button is a rounded rect plus a centred label. The pointer gives
it a hover tint, a press that shrinks and darkens the face, and a release that
eases back; a click fires on pointer-up inside the button the pointer went down
on. `attach(nv)` wires the canvas pointer events so a click on a button is
consumed before NiiVue's own handlers see it (no stray drag or crosshair move),
and shows a pointer cursor over buttons.

```ts
import { loadDefaultFont, UIKitButtonOverlay } from '@niivue/uikit'

// cssUnits: lay the buttons out in CSS pixels; the overlay scales by the DPR.
const buttons = new UIKitButtonOverlay(await loadDefaultFont(), { cssUnits: true })
nv.registerOverlayRenderer(buttons)
const detach = buttons.attach(nv)

buttons.addButton({
  id: 'axial',
  label: 'Axial',
  x: 12,
  y: 12, // top-left; width/height default to the label plus padding
  onClick: () => { nv.sliceType = SLICE_TYPE.AXIAL },
})
buttons.addButton({
  id: 'reset',
  label: 'Reset',
  x: 90,
  y: 12,
  width: 120, // a fixed size is honoured per axis
  style: { fill: [0.55, 0.1, 0.12, 0.95], border: [1, 0.55, 0.55, 1], radius: 14 },
  onClick: resetView,
})

buttons.updateButton('reset', { label: 'Reset (3)' })
buttons.setEnabled('axial', false)
buttons.click('reset') // from a keyboard shortcut: same animation + callback
```

Every visual knob is in `ButtonStyle` (fill, hover, pressed and disabled fills,
border color and width, corner radius, text color and size, padding, press
shrink scale and press/release durations). Set defaults for the overlay with the
`style` option or `setDefaultStyle`, and override per button with `spec.style`.
Without `cssUnits`, all lengths are canvas (device) pixels, like every other
UIKit widget.

A host that is not a NiiVue controller can feed the overlay itself: call
`pointerDown`, `pointerMove`, `pointerUp` and `pointerCancel` with canvas-pixel
coordinates (each returns whether a button consumed the event) and pass a
`requestRedraw` option so the press animation can ask for frames.
