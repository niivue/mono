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
| `buildNumberInput` | `UIKitNumberInputOverlay` | Number fields: typed entry with validation, a spinner, arrow keys and the wheel |
| `buildTextInput` | `UIKitTextInputOverlay` | Single-line text fields with a placeholder, selection, Enter to submit |
| `buildTextArea` | `UIKitTextAreaOverlay` | Multi-line text fields that soft-wrap and scroll by whole rows |
| `buildColorControl` | `UIKitColorControlOverlay` | Color pickers the legacy way: a preview, R/G/B(/A) channel sliders and palette swatches |
| `buildFilePicker` | `UIKitFilePickerOverlay` | File pickers: a Choose button and a readout; the host chooser and downloads go through bridges |
| `buildDialog` | `UIKitDialogOverlay` | Modal dialogs: a scrim, a panel with a title, wrapped message, hosted widgets and action buttons |
| `buildMenuButton`, `buildMenuPopup` | `UIKitMenuOverlay` | Menu buttons with popups of actions, check items and radio groups |
| `selectMenuSpec` | `UIKitSelectOverlay` | Drop-down lists: a button showing the chosen option over a popup of options |
| `buildSegmented` | `UIKitSegmentedOverlay` | Segmented controls: one row of segments with exactly one selected |
| `scrollWindow`, `revealRow`, `buildScrollArrow` | (used by the overlays above) | Row scrolling for any container whose list outgrows its viewport |
| `editKey`, `textWindow`, `caretIndexAt` | (used by the overlays above) | Single-line text editing: caret, selection, key edits, whole-glyph scrolling |
| `buildTextFieldContent` | (used by the overlays above) | The text, selection and caret of any field, clipped to the glyphs that fit |
| | `UIKitControls` | The control layer: one owner of the pointer, wheel and keyboard for every widget above |

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

`UIKitControls` is the one place that owns the canvas pointer, wheel and
keyboard for every interactive widget, so widgets never compete for an event. Add the widget
overlays to it in draw order, register the layer as NiiVue's overlay renderer,
and `attach(nv)` to the canvas. Pointer down goes to the topmost widget that
claims it; that widget then captures every move and the up and takes keyboard
focus. Only the topmost widget under the pointer hovers. A widget that is modal
(a menu with its popup open) sees every event first until it closes, and the
click that dismisses it is consumed. Keys go to the modal widget, else the
focused one. A wheel turn goes to the modal widget, else to the topmost widget
under the pointer that handles wheels (an open popup scrolls with it; the page
scrolls otherwise). Events a widget consumes are stopped in the capture phase,
so a click on a control never starts a NiiVue drag or moves the crosshair. Popups are
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
check color and width, text color and size, the label halo
(`textOutlineWidth`, default 1, and `textOutlineColor`, null for automatic
contrast), press scale and focus ring.

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

The label and value sit on the scene, so they draw with a halo outline:
`textOutlineWidth` (default 1; 0 for none) and `textOutlineColor` (default
null, which picks black or white for contrast with `textColor`) in
`SliderStyle`.

## Menus

`UIKitMenuOverlay` draws menu buttons (a label with a chevron) and, when one is
open, its popup. Items are actions, check items, radio items (exclusive within
their `group`) or separators, each with an optional right-aligned shortcut
label and `enabled` flag. The popup opens below the button and flips above it
when it would overflow the canvas; when it fits neither way it takes the
roomier side and scrolls (see "Scrolling containers" below). While open the
overlay is modal: it
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
all behave as for a menu, a long list scrolls, and the list opens with the
current option highlighted and in view. A focused closed select also changes its value straight from the
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

## Scrolling containers

Any container that shows a list taller than the space it has scrolls by whole
rows through the shared model in `scroll.ts`, so a container only ever draws
rows that lie fully inside its viewport and needs no GPU scissor.
`scrollWindow(heights, viewport, first)` returns the run of rows that fits from
`first`, clamped so the list never scrolls past its end; `revealRow` finds the
least scroll that brings a row into view (a keyboard move, or opening on an
item); `WheelAccumulator` turns a trackpad's small wheel deltas into row steps;
`buildScrollArrow` draws the chevron on a strip. Menu and select popups are the
first consumers: a scrollable popup reserves a strip at each end
(`scrollStripHeight`, `scrollArrowSize`, `scrollArrowWidth`, `scrollArrowColor`
in `MenuStyle`), shows an arrow on a strip with rows beyond it, scrolls on the
wheel or a press on a strip, keeps the keyboard highlight in view, and reports
`scrollable`, `firstRow`, `endRow` and the strip boxes in its popup layout. A
widget that scrolls implements `wheel(x, y, deltaX, deltaY)` from
`UIKitInteractive`; the control layer routes the canvas wheel to it.

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

## Number inputs

`UIKitNumberInputOverlay` draws a bordered field showing a number, with a
two-button spinner at its right end and an optional label to its left. A
press on the text takes keyboard focus and selects the whole number, so typing
replaces it; a second press places the caret and dragging selects. Typed text
is checked on every keystroke (the border turns `invalidBorder` while it is
not a number) and `onInput` fires whenever it means a new valid number. Enter
commits, Escape reverts to the committed value, and losing focus commits, as
does every step: ArrowUp/Down (Shift: ten steps), PageUp/PageDown, the spinner
buttons and the wheel over a focused field. A committed value is clamped to
`[min, max]` (either end optional) and snapped to `step` (counted from `min`,
or 0), and `onChange` fires once per committed change. The field shows only
the glyphs that fit, scrolled by whole glyphs to keep the caret in view.

```ts
const numbers = new UIKitNumberInputOverlay(font, units)
numbers.addNumberInput({
  id: 'elevation',
  label: 'Elevation',
  x: 250,
  y: 172,
  width: 80, // the field; the label adds to it
  min: -90,
  max: 90,
  step: 5,
  value: 10,
  format: (v) => `${v}`, // optional; default shows the step's decimals
  onInput: (v) => { nv.elevation = v }, // each new valid number while typing, each step
  onChange: (v) => save(v), // once per committed change
})
numbers.setValue('elevation', 0) // silent
numbers.getValue('elevation') // the committed value
numbers.getText('elevation') // what the field shows, edit in progress included
```

`NumberInputStyle` holds the field fill, hover and disabled fills, the border
with its focus and invalid colors, text color and size, the label halo
(`textOutlineWidth`, `textOutlineColor`), padding, the default `fieldWidth`,
the spinner width, faces, dividers and chevrons, and the caret and selection
colors. `parse` on a spec replaces the default `Number` parser.

The editing itself is the shared model in `textEdit.ts`: a `TextEditState`
(text, caret, selection anchor), `editKey` for the caret moves, Backspace,
Delete, select-all and typed characters a key means, `caretIndexAt` for the
pointer, and `textWindow`, which scrolls a field by whole glyphs through the
scroll model. `textField.ts` turns that state into the selection, text and
caret geometry of any field. Text inputs reuse both.

## Text inputs

`UIKitTextInputOverlay` draws a bordered single-line field with an optional
label and a dimmed placeholder while it is empty. A press takes keyboard
focus and places the caret at the pointer, dragging selects, and a second
press within the double-click interval selects all. The arrows, Home and End
move the caret (Shift extends the selection, Meta or Ctrl jumps to the ends),
Backspace and Delete edit, Meta or Ctrl plus A selects all. `onInput` fires
on every keystroke that changes the text. Enter commits the text (firing
`onChange` when it differs from the committed text) and then fires `onSubmit`
whether or not it changed; Escape reverts to the committed text; losing focus
commits. Long text scrolls by whole glyphs to keep the caret in view.

Entry is keyboard-only: no DOM input backs the field, so there is no paste
and no IME composition. Tab and other keys the field does not use fall
through to the host.

```ts
const texts = new UIKitTextInputOverlay(font, units)
texts.addTextInput({
  id: 'command',
  label: 'niimath',
  x: 12,
  y: 340,
  width: 220, // the field; the label adds to it
  placeholder: '-sqr -add 2',
  maxLength: 200,
  accept: (ch) => ch !== '\t', // optional keyboard filter
  onInput: (text) => preview(text), // every change
  onChange: (text) => save(text), // Enter or blur, when changed
  onSubmit: (text) => run(text), // Enter, always
})
texts.setValue('command', '') // silent
texts.getValue('command') // the committed text
texts.getText('command') // what the field shows, edit in progress included
```

`TextInputStyle` holds the field fill, hover and disabled fills, the border
and its focus color, text, placeholder and disabled text colors, the label
halo (`textOutlineWidth`, `textOutlineColor`), padding, the default
`fieldWidth`, and the caret and selection colors. The overlay options take
`doubleClickMs` (default 400) and a `now` clock for it.

## Text areas

`UIKitTextAreaOverlay` draws a bordered field of a fixed number of rows with
an optional label above it. Text soft-wraps at the field's width (after the
last space that fits, else by glyph) and scrolls by whole rows through the
shared scroll model, with a scrollbar once the rows overflow: the wheel
scrolls a hovered area, and the caret is kept in view while editing. A press
takes keyboard focus and places the caret at the pointer, dragging selects
across rows, and a second press within the double-click interval selects
all. Enter inserts a newline; the arrows move by glyph and by row (a run of
vertical moves keeps its column), Home and End move within the row, PageUp
and PageDown move by a page of rows, and Meta or Ctrl jumps to the text's
ends. Shift extends the selection; Backspace, Delete and Meta or Ctrl plus A
come from the single-line model. `onInput` fires on every keystroke that
changes the text. Meta or Ctrl plus Enter commits (firing `onChange` when the
text changed) and then fires `onSubmit`; Escape reverts to the committed
text; losing focus commits.

Entry is keyboard-only, like the text input: no paste and no IME.

```ts
const areas = new UIKitTextAreaOverlay(font, units)
areas.addTextArea({
  id: 'notes',
  label: 'Notes',
  x: 12,
  y: 540,
  width: 300,
  rows: 4, // visible rows; longer text scrolls
  placeholder: 'Findings...',
  maxLength: 2000,
  onInput: (text) => preview(text), // every change
  onChange: (text) => save(text), // Meta/Ctrl+Enter or blur, when changed
  onSubmit: (text) => run(text), // Meta/Ctrl+Enter, always
})
areas.setValue('notes', '') // silent
areas.getValue('notes') // the committed text
areas.getText('notes') // what the field shows, edit in progress included
areas.getFirstRow('notes') // the scroll position, in rows
```

`TextAreaStyle` adds to the text-input knobs a `lineHeight` (rows are
`textSizePx * lineHeight`, default 1.4), the default `rows`, and the
scrollbar's `scrollbarWidth`, `scrollbarGap`, `scrollbarColor` and
`scrollbarTrackColor`. The pure model (`wrapRows`, `rowOfCaret`,
`moveCaretRows`, `textAreaKey`) is exported for hosts that lay out
multi-line text themselves.

## Color controls

`UIKitColorControlOverlay` edits a color the way the legacy demos do, with
channel sliders and named palette choices rather than a browser color picker.
Each control shows a preview swatch (over a grey backdrop, so a translucent
color shows its alpha), a stack of R, G and B sliders (and A with `alpha`)
composed from a slider overlay, and a row of palette swatches that wraps to
the control's width. Dragging a slider, or pressing an arrow, Home, End or
Page key on the focused one, changes a channel; pressing a swatch sets the
whole color, and the swatch matching the current color wears a ring.
`onInput` fires on every change and `onChange` once per committed one (a
slider release, a key press, a swatch press).

```ts
const colors = new UIKitColorControlOverlay(font, units)
colors.addColorControl({
  id: 'crosshair',
  label: 'Crosshair',
  x: 12,
  y: 380,
  width: 220,
  value: [1, 0, 0, 1],
  alpha: false,
  palette: [
    { name: 'Red', color: [1, 0, 0, 1] },
    { name: 'Green', color: [0, 1, 0, 1] },
    { name: 'White', color: [1, 1, 1, 1] },
  ],
  onInput: (c) => { nv.crosshairColor = c },
  onChange: (c) => save(c),
})
colors.setValue('crosshair', [0, 1, 0, 1]) // silent
colors.getValue('crosshair')
```

`ColorControlStyle` holds the text color and size with the label halo
(`textOutlineWidth`, `textOutlineColor`), the preview size, radius, border
and backdrop, the gaps, `slider` overrides for the channel sliders, and the
swatch size, gap, radius, border and the selected and hover rings.

## File pickers and downloads

Opening a file chooser and saving a download are the two things a canvas
widget cannot do by itself. UIKit keeps the affordance and its state on the
canvas and hands the browser-only step to a host bridge: `FilePickerBridge`
opens the chooser and resolves with the files (an empty array on cancel),
`DownloadBridge` saves a blob under a name. `createBrowserFilePicker()` and
`createBrowserDownload()` are the browser implementations (a hidden
`<input type="file">`, a temporary anchor over an object URL); both take the
DOM as a parameter so a test or another host can supply its own. Browsers
only open a chooser inside a user activation, so call a bridge synchronously
from a click, menu or key handler, as the widgets below do.

`UIKitFilePickerOverlay` is the canvas half of `<input type="file">`: a push
button ("Choose file...") composed from a button overlay beside a readout of
what was chosen ("No file chosen", one name, or "3 files"; a long name keeps
its tail behind leading dots). Pressing the button, Enter or Space on it, or
`open(id)` asks the bridge with the spec's `accept`, `multiple` and
`directory`; the picker then shows the names and fires `onPick`, or
`onCancel` when the chooser closed empty.

```ts
import {
  acceptExtensions,
  createBrowserDownload,
  UIKitFilePickerOverlay,
} from '@niivue/uikit'

const pickers = new UIKitFilePickerOverlay(font, units) // pickFiles: a custom bridge
pickers.addFilePicker({
  id: 'volume',
  label: 'Open volume...',
  x: 12,
  y: 480,
  width: 300,
  accept: acceptExtensions(['nii', 'nii.gz', 'mgz']),
  onPick: ([file]) => nv.loadVolumes([{ url: file, colormap: 'Gray' }]),
})
pickers.setFiles('volume', ['mni152.nii.gz']) // silent

const download = createBrowserDownload()
menus.addMenu({ id: 'file', label: 'File', x: 12, y: 12, items: [
  { id: 'export', label: 'Export settings', onSelect: () =>
    download(new Blob([JSON.stringify(settings)], { type: 'application/json' }), 'settings.json') },
]})
```

`FilePickerStyle` holds the `button` overrides, the gap, the readout colors
(chosen, empty and disabled), size and halo, and the default readout width.

## Dialogs

`UIKitDialogOverlay` holds dialogs that open one at a time. An open dialog is
modal: a scrim covers the canvas, the panel (centered, or placed at the spec's
`x`, `y`) shows a title, a message wrapped to the panel width (`\n` forces a
line), a content box `contentHeight` tall for hosted widgets, and a row of
right-aligned action buttons. Pressing a button closes the dialog and fires
`onClose` with that button's id. Enter presses the button with the `default`
role (drawn in the accent style), Escape the one with the `cancel` role, or
closes with a null result when there is none. A press on the scrim closes with
null only when `closeOnScrim` is set; otherwise it does nothing, and every
other pointer, wheel and key event is swallowed while the dialog is open.

Hosted widgets are ordinary overlays (text inputs, number inputs, toggles,
selects, ...) added with `addChild`: while the dialog is open it routes
events among them like a control layer (a press captures and focuses, a
modal child such as an open select sees everything first) and draws them over
the panel. They must use the same units as the dialog. `onLayout` reports the
panel and content boxes in spec units whenever the panel is placed (the first
draw, a resize), which is where to position them. A dialog is not a popup: a
press elsewhere in the page only blurs its children, so a window blur never
closes a half-filled form.

```ts
const dialogs = new UIKitDialogOverlay(font, units)
const fields = new UIKitTextInputOverlay(font, units)
controls.add(dialogs) // the dialog hosts `fields`; do not add them to the layer
dialogs.addDialog({
  id: 'rename',
  title: 'Rename volume',
  message: 'The name shows in the layer list and in exports.',
  contentHeight: 36,
  buttons: [
    { id: 'cancel', label: 'Cancel', role: 'cancel' },
    { id: 'ok', label: 'Rename', role: 'default' },
  ],
  onLayout: ({ content }) => {
    fields.updateTextInput('name', { x: content.x, y: content.y + 4 })
  },
  onClose: (result) => {
    if (result === 'ok') rename(fields.getValue('name'))
  },
})
dialogs.addChild('rename', fields)
fields.addTextInput({ id: 'name', x: 0, y: 0, width: 300, value: 'mni152' })
dialogs.open('rename')
dialogs.close('cancel') // from code, with any result
```

`DialogStyle` holds the scrim color, the panel fill, border and radius, its
default `width`, `padding` and `gap`, the title and message colors and sizes,
the message `lineHeight`, the `buttonGap`, and `button` and `defaultButton`
overrides of the button style.
