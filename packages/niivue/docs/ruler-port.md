# UIKit module + niivue rendering-lifecycle exposure (design)

**UIKit** is a collection of controls/widgets (rulers, and eventually buttons,
sliders, panels, labels, ...) integrated into niivue's rendering lifecycle. It ships
as a **separate module** (`@niivue/uikit`) with **privileged access to niivue's
rendering lifecycle** - a trusted sibling that hooks directly into the frame, not a
sandboxed plugin. The **ruler** is the first widget and the proof of the pattern.

## Context (NIH grant)

A UIKit grant is submitted to NIH. If funded, we want the **base module already in
place**: the `@niivue/uikit` package, niivue's lifecycle exposure, and a real widget
(the ruler) working on both backends - a self-contained thing we can point to when
asked about UIKit, and a foundation the funded work extends.

## Strategy: duplicate line/text drawing into UIKit (isolate + bake in)

UIKit carries its **own** line and text rendering, **duplicated** rather than
carved out of core. Rationale:

- **No regression risk.** Core's `LineRenderer`/`FontRenderer` (and everything that
  uses them - colorbar, crosshair, measurements, graph, legend) stay untouched. In
  particular, transformed text is added to UIKit's copy, so the core font path is
  never destabilized.
- **A self-contained base module.** UIKit renders on its own; it is demonstrable
  end to end without threading changes through core - the artifact to show for the
  grant.
- **A bake-in phase.** UIKit's rendering matures behind the ruler (and later
  widgets) while core keeps its own. Only once UIKit is proven do we **migrate core's
  overlays onto UIKit and remove the duplicated line/text from core** - a deliberate,
  reversible cutover, not a big-bang refactor.

End state: UIKit is niivue's overlay-rendering layer; core delegates to it. Interim:
the two coexist. The duplication is the cost we pay for that safety and independence.

## Two responsibilities, two homes

### niivue core - expose the rendering lifecycle (privileged, minimal)

Core does NOT gain drawing primitives. It exposes a small privileged surface so a
trusted module can render inside the frame on either backend:

- **Lifecycle hooks / phases** - at minimum an `overlay` draw phase (after the scene,
  canvas-pixel space) and a `settled` signal (scene gone idle). Registration is
  privileged (first-party modules), not a public sandbox.
- **A backend handle** passed to the `overlay` hook: which backend is active and the
  context/target it should render into (`{ backend, gl? , wgpu?, target, canvasSize,
  dpr }`) - enough for UIKit to run its own renderers. No core draw primitives; UIKit
  brings those.

That's the whole core change: a privileged render hook + a backend handle + a settle
signal. Small, and it does not touch existing rendering.

### `@niivue/uikit` - the widget toolkit + its own rendering (separate package)

A new workspace package depending on `@niivue/niivue` (pattern: `nv-react` /
`nv-web-component`). It contains:

- **Its own line + text renderers**, duplicated from core and extended - both **WebGL2
  and WebGPU** (shader pair + a TS class each, mirrored), with **terminators** on the
  line renderer and a **transform** on the text renderer from the start. This is the
  base-module bulk.
- **Widgets** - `Ruler` first, the grant's future controls next - composing those
  renderers; no per-backend code in a widget.
- **Lifecycle glue** - register with niivue's `overlay` hook; render via the backend
  handle.

## Performance ("keep rendering fast")

UIKit is privileged and its widgets are render-cheap (a ruler is a few lines + a
label), so the primary path is: draw in the `overlay` phase every frame through
UIKit's own renderers. Interactive rendering (rotation, scroll, streaming) stays
smooth because widget cost is bounded.

For an expensive widget, an **offscreen + settle** escalation is available: render
into an owned layer only when the scene **settles** (a debounced idle period with no
`drawScene`), and each interactive frame just composite the cached layer (one
textured quad). Heavy widgets then never run on an interactive frame. Deferred (see
Open questions); the base module ships the cheap overlay path. Settle detection
reuses niivue's RAF-coalesced `drawScene` (a debounced idle timer -> `settled`).

## The rendering pieces (all inside UIKit's own renderers)

### A. Terminated lines (UIKit line renderer)

UIKit's line path builds a base segment plus terminator segments - arrowheads are
extra segments, so no shader change beyond the base line shader UIKit already
carries. Implement `ARROW`; reserve `CIRCLE`/`RING`/styles. The terminator
*composition* (arrow = two segments) is backend-agnostic pure-data - **that pure
builder is Module 1 (first PR), detailed below**, and it stands alone before the
renderer/package exist.

### B. Transformed text (UIKit text renderer)

UIKit's duplicated text renderer supports an optional per-glyph `transform` (rotation
angle + pivot, typed to grow to affine) from day one - so nothing in core changes and
no existing label can regress. Both backends: the duplicated MSDF font shader pair +
TS classes, mirrored, plus layout tests and a per-backend visual check.

## The Ruler widget (`@niivue/uikit`)

Composes UIKit's `terminatedLine` + `rotatedText` + hash marks: an offset parallel
line + `ARROW` terminators back to the endpoints + numbered hash marks (taller/labeled
every 5th) + a rotated length/units label. Registered on the `overlay` phase; runs on
both backends from one implementation. During bake-in it is an opt-in measurement
render style; core's existing measurement overlay (`view/NVMeasurement.ts`,
`control/dragModes.ts`) is left untouched until the cutover.

**Readability guard (upside-down / backward label).** Ported from the old uikit
`drawRuler`: with `angle = atan2(dy, dx)`, when `|angle| > pi/2` add `pi` and recompute
the label anchor/offset so it stays centered on the line midpoint on the correct side,
reading left-to-right. A widget-layer concern; the `rotatedText` primitive just takes
the final angle + pivot.

## Provenance

Old niivue (`niivue/niivue`), branch `cdrake/uikit-integration`,
`packages/uikit/src/uikrenderer.ts` (WebGL2-only): `drawLine` (terminators/styles),
`drawRotatedText` (per-glyph rotate-Z MVP), `drawRuler`, triangle/circle/rounded-rect.
This design carries that toolkit forward as a separate module with its own dual-backend
rendering over an exposed niivue lifecycle.

## Build order

1. **Module 1** - the terminator composition as a backend-agnostic pure-data builder
   (`ARROW`; builder-only). First PR; detailed below. No renderer/package needed.
2. **`@niivue/uikit` skeleton + line renderer** (duplicated, both backends) + the
   niivue `overlay` lifecycle hook + backend handle. A trivial "draw a line" proof.
3. **UIKit text renderer** (duplicated, both backends) with the transform.
4. **Ruler widget** - composes 1-3; the readability guard; opt-in measurement style.
5. **Settle escalation** (pending Open questions) - settle signal + offscreen +
   compositing, for heavy widgets.
6. **Cutover (later, post-bake-in)** - migrate core overlays onto UIKit; remove the
   duplicated line/text from core.

## Open questions

1. **Settle escalation: base module or funded milestone?** Lean: base = the cheap
   overlay path + ruler; settle/offscreen as grant milestone 1.
2. **How much text renderer to duplicate.** Full MSDF font pipeline (atlas load,
   metrics, backing panels) copied into UIKit, or the minimum the ruler needs (glyph
   quads + transform) first and grow it? Lean: minimum-plus-transform first; grow
   toward parity with core over bake-in.
3. **Escape hatch.** The backend handle already gives UIKit raw `gl`/`wgpu`; do widgets
   get it directly, or only UIKit-internal renderers? Lean: only UIKit's renderers
   touch the handle; widgets use UIKit's drawing API (keeps widgets backend-free).

## Out of scope (the surface must not foreclose them)

Line `CIRCLE`/`RING` terminators + dashed/dotted styles; the rest of the toolkit
(triangle/circle/rounded-rect, future widgets); non-ruler transformed-text uses +
affine transforms; NVSlide interaction + physical (um/mm) scale + the measurement data
path; the eventual core-overlay cutover (step 6) beyond noting it.

---

# Module 1 implementation plan - terminated-line builder

**Scope:** the terminator vocabulary + `ARROW` as a backend-agnostic pure-data
builder over a line record. Builder-only: no renderer, shader, package, or backend
code - the arrow-from-segments math that UIKit's (and, if ever wanted, core's) line
renderer will consume. Self-contained first PR that de-risks the geometry before any
plumbing exists.

**Home:** it composes line records. Two options depending on decision (2)/timing:
land it in `packages/niivue/src/view/NVLine.ts` next to `buildLine` (immediately
useful, no new package), then re-export/duplicate into `@niivue/uikit` when the
package lands; or start it in the new package. Lean: land in `view/NVLine.ts` now
(smallest first PR), copy into UIKit at step 2. Either way the code is identical.

**Files:** `src/view/NVLine.ts` (+ `src/view/NVLine.test.ts`). Reuses `buildLine`.
No changes to `gl/`, `wgpu/`, or the view loops.

### API

Keep `buildLine` unchanged. Add the terminator vocabulary and a terminator-aware
builder returning the base segment plus terminator segments:

```ts
export enum LineTerminator {
  NONE = 0,
  ARROW = 1,
  CIRCLE = 2, // reserved (needs a disc primitive; not in this PR)
  RING = 3,   // reserved
}

export interface LineTerminators {
  start?: LineTerminator // default NONE
  end?: LineTerminator   // default NONE
}

// Base segment + terminator segments, all LineData. Mirrors the old uikit
// drawLine({ startEnd, terminator }) in the data-emitting model.
export function buildTerminatedLine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thickness: number,
  color: number[],
  terminators?: LineTerminators,
): LineData[]
```

- No terminators -> `[buildLine(...)]`.
- `ARROW` appends two short segments at the terminated end (~+/-150 deg from the line
  direction, half-angle ~30 deg, length `max(8, thickness * 4)`), via `buildLine`;
  `start` mirrors at the start point.
- Base segment shortened by `arrowLen/2` at any terminated end so it does not
  overshoot the arrowhead (matches uikit).
- `CIRCLE`/`RING` throw `not implemented`.

### Arrow geometry

```
dir   = normalize(end - start)
back  = -dir
left  = rotate(back, +arrowAngle) * arrowLen
right = rotate(back, -arrowAngle) * arrowLen
tip   = (endX, endY)
segments: buildLine(tip, tip + left), buildLine(tip, tip + right)
```

### Tests (`src/view/NVLine.test.ts`)

- No options -> one `LineData` equal to `buildLine`.
- `end: ARROW` -> 3 `LineData`; heads share the tip, carry thickness/color, symmetric
  about the direction.
- `start: ARROW` mirrors; `start` + `end` -> 5.
- Base segment shortened at each terminated end (no overshoot).
- `CIRCLE`/`RING` throw.

### Not in this PR

The `@niivue/uikit` package, the duplicated line/text renderers, transformed text, the
lifecycle hook, the ruler widget, the settle escalation, the core cutover. Module 1
only nails the arrow geometry so everything downstream calls
`buildTerminatedLine(..., { end: ARROW })`.
