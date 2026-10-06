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
| `buildToggle` | `UIKitToggleOverlay` | Check boxes with a label: pointer or Space/Enter flips them |
| `buildSlider` | `UIKitSliderOverlay` | Horizontal sliders with min/max/step, ticks, a value readout, drag and arrow keys |
| `buildMenuButton`, `buildMenuPopup` | `UIKitMenuOverlay` | Menu buttons with popups of actions, check items and radio groups |
| `selectMenuSpec` | `UIKitSelectOverlay` | Drop-down lists: a button showing the chosen option over a popup of options |
| `buildSegmented` | `UIKitSegmentedOverlay` | Segmented controls: one row of segments with exactly one selected |
| | `UIKitControls` | The control layer: one owner of the pointer and keyboard for every widget above |

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

## Control layer

`UIKitControls` is the one place that owns the canvas pointer and keyboard for
every interactive widget, so widgets never compete for an event. Add the widget
overlays to it in draw order, register the layer as NiiVue's overlay renderer,
and `attach(nv)` to the canvas. Pointer down goes to the topmost widget that
claims it; that widget then captures every move and the up and takes keyboard
focus. Only the topmost widget under the pointer hovers. A widget that is modal
(a menu with its popup open) sees every event first until it closes, and the
click that dismisses it is consumed. Keys go to the modal widget, else the
focused one. Events a widget consumes are stopped in the capture phase, so a
click on a control never starts a NiiVue drag or moves the crosshair. Popups are
drawn after every widget. A press anywhere else in the page, focus moving to
another element or the window losing focus deactivates the layer (held press
cancelled, popups dismissed, focus dropped), so keys reach the page again
instead of the last widget the user touched; `deactivate()` does the same from
code.

```ts
import {
  loadDefaultFont, UIKitButtonOverlay, UIKitControls, UIKitMenuOverlay,
  UIKitSliderOverlay, UIKitToggleOverlay,
} from '@niivue/uikit'

const font = await loadDefaultFont()
const units = { cssUnits: true }
const buttons = new UIKitButtonOverlay(font, units)
const toggles = new UIKitToggleOverlay(font, units)
const sliders = new UIKitSliderOverlay(font, units)
const menus = new UIKitMenuOverlay(font, units)
const controls = new UIKitControls().add(buttons).add(toggles).add(sliders).add(menus)
nv.registerOverlayRenderer(controls)
const detach = controls.attach(nv) // call detach() to unwire the events
```

A widget added to a layer takes the layer's redraw requester, which `attach`
defaults to `nv.drawScene`. A host that is not a NiiVue controller can feed the
layer itself through `pointerDown`, `pointerMove`, `pointerUp`, `pointerCancel`
and `keyDown` in canvas pixels; each returns whether a widget consumed the event.
`UIKitButtonOverlay.attach` still works on its own: it is a one-widget layer.

## Toggles

A toggle is a square box with a check mark and a label beside it. Pointer press
and release inside flips it; the pressed toggle takes focus (a ring around the
box) and Space or Enter flips it from the keyboard. `onChange` fires for user
changes only; `setChecked` is silent.

```ts
toggles.addToggle({
  id: 'colorbar',
  label: 'Colorbar',
  x: 12,
  y: 52,
  checked: false,
  onChange: (checked) => { nv.isColorbarVisible = checked },
})
toggles.setChecked('colorbar', true) // from code, no callback
toggles.toggle('colorbar') // as the user would: fires onChange
toggles.setEnabled('colorbar', false)
```

`ToggleStyle` holds the box size, radius, gap, fills for each state, border,
check color and width, text color and size, press scale and focus ring.

## Sliders

A slider is a horizontal track with a round thumb, an optional label on the
left and value readout on the right, and optional tick marks. Pressing the track
jumps the value there and starts a drag; the thumb follows the pointer however
far it strays vertically. Values snap to `step` (default: a hundredth of the
range) and clamp to `[min, max]`. With focus, ArrowLeft/Down and ArrowRight/Up
move one step, Shift and PageUp/PageDown move ten, Home and End go to the ends.

```ts
sliders.addSlider({
  id: 'gamma',
  label: 'Gamma',
  x: 12,
  y: 84,
  width: 220,
  min: 0.1,
  max: 3,
  step: 0.05,
  value: 1,
  showValue: true,
  format: (v) => v.toFixed(2), // optional; default shows the step's decimals
  tickStep: 0.5, // optional tick marks
  onInput: (v) => { nv.gamma = v }, // every change, including during a drag
  onChange: (v) => save(v), // once, when a drag or key press settles a new value
})
sliders.setValue('gamma', 1) // silent
sliders.getValue('gamma')
```

The callback contract: `onInput` fires on every value change the user makes
and `onChange` fires when the interaction ends with a value different from the
one it started with (a drag releases, a key press lands). Neither fires for
`setValue`.

## Menus

`UIKitMenuOverlay` draws menu buttons (a label with a chevron) and, when one is
open, its popup. Items are actions, check items, radio items (exclusive within
their `group`) or separators, each with an optional right-aligned shortcut
label and `enabled` flag. The popup opens below the button and flips above it
when it would overflow the canvas. While open the overlay is modal: it
highlights the row under the pointer, a click on a row activates it, a click
anywhere else closes the menu (and is not passed on), and Escape closes it.
ArrowUp/Down, Home and End move the highlight over selectable rows, Enter or
Space activates. A focused closed menu opens on Enter, Space or ArrowDown.

```ts
menus.addMenu({
  id: 'view',
  label: 'View',
  x: 12,
  y: 12,
  items: [
    { id: 'axial', label: 'Axial', kind: 'radio', group: 'view', shortcut: '1' },
    { id: 'mpr', label: 'Multiplanar', kind: 'radio', group: 'view', checked: true },
    { id: 'sep', kind: 'separator' },
    { id: 'colorbar', label: 'Colorbar', kind: 'check' },
    { id: 'reset', label: 'Reset view', onSelect: resetView },
    { id: 'undo', label: 'Undo', enabled: false },
  ],
  onSelect: (itemId, menuId) => { /* every activation */ },
  onChange: (itemId, checked, menuId) => { /* check and radio state changes */ },
})
menus.setItemChecked('view', 'colorbar', true) // silent; radio items clear their group
menus.isItemChecked('view', 'axial')
menus.setItems('view', newItems)
menus.open('view'); menus.close()
```

Activating a check item flips it; activating a radio item checks it and clears
the rest of its group. `onChange` reports each item whose state changed (the
activated one first), then the item's `onSelect` and the menu's `onSelect`
fire. `MenuStyle` holds the popup fill, border, radius and padding, row height,
highlight fill, text, mark and shortcut colors, separator and chevron sizes, and
`buttonStyle` is a `ButtonStyle` for the trigger.

## Selects

`UIKitSelectOverlay` draws drop-down lists: a menu button whose label is the
chosen option (or a `placeholder` while nothing is chosen) over a popup listing
every option as one radio group. The button is sized to the widest option so it
keeps its width as the value changes. Opening, highlighting, choosing on release
or Enter, dismissing on an outside press or Escape and being modal while open
all behave as for a menu, and the list opens with the current option
highlighted. A focused closed select also changes its value straight from the
keyboard: ArrowUp/Down (or Left/Right) step over the enabled options without
wrapping, Shift or PageUp/PageDown step by ten, Home and End jump to the ends,
and Enter, Space or Alt+ArrowDown open the list.

```ts
const selects = new UIKitSelectOverlay(font, units)
selects.addSelect({
  id: 'colormap',
  x: 12,
  y: 12,
  options: nv.colormaps.map((name) => ({ value: name, label: name })),
  value: 'gray',
  onChange: (value) => nv.setVolume(0, { colormap: value }),
})
selects.setValue('colormap', 'hot') // silent; a value no option holds clears it
selects.setOptions('colormap', fewerOptions) // a value no longer offered clears
selects.getValue('colormap')
```

`onChange(value, id)` fires once per user choice and not when the same option
is chosen again or the value is set from code. Options carry `enabled`; a
disabled option draws dimmed and is skipped by the keyboard. `buttonStyle` and
`style` are the menu's `ButtonStyle` and `MenuStyle`.

## Segmented controls

`UIKitSegmentedOverlay` draws a row of equal-width segments in one rounded
track with exactly one selected: a compact radio group for a mode or a view.
The pointer tints the segment under it, pressing darkens it, and releasing on
the segment the press started on selects it. The pressed control takes
keyboard focus (a ring around the track); ArrowLeft/Right (or Up/Down) then
move the selection through the enabled segments, wrapping, and Home and End
jump to the ends.

```ts
const segmented = new UIKitSegmentedOverlay(font, units)
segmented.addSegmented({
  id: 'view',
  x: 12,
  y: 52,
  segments: [
    { value: 'axial', label: 'Axial' },
    { value: 'mpr', label: 'MPR' },
    { value: 'render', label: 'Render', enabled: false },
  ],
  value: 'mpr',
  onChange: (value) => { /* apply the view */ },
})
segmented.setValue('view', 'axial') // silent
segmented.select('view', 'axial') // as the user would: fires onChange
```

`segmentWidth` fixes every segment's width instead of fitting the widest label;
`SegmentedStyle` holds the track fill and border, inset, radius, the selected,
hover and pressed faces, text colors and size, the divider and the focus ring.
