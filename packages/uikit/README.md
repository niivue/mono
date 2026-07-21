# @niivue/uikit

UIKit: a collection of controls and widgets (rulers, and later buttons, sliders,
panels, labels) integrated into the [NiiVue](https://github.com/niivue/niivue)
rendering lifecycle.

> **Status: base module.** This package is being stood up as the foundation for the
> UIKit work. Today it ships the line-drawing primitives (including arrow
> terminators). The rendering-lifecycle hook, UIKit's own line/text renderers
> (WebGL2 + WebGPU, with a text transform), and the first widget (a ruler) land
> next. See `docs/ruler-port.md` in `@niivue/niivue` for the design.

## Design in one paragraph

UIKit is a **separate module with privileged access to NiiVue's rendering
lifecycle**. NiiVue core exposes a small hook (an overlay draw phase + a backend
handle + a settled signal); UIKit registers into it and draws with **its own**
line/text renderers on both backends. UIKit carries a duplicated copy of the line
and text drawing so core stays untouched during a bake-in phase; once UIKit is
proven, core's overlays cut over onto it and the duplicate in core is removed.

## Today

```ts
import { buildTerminatedLine, LineTerminator } from '@niivue/uikit'

// A line with an arrowhead at the end, as plain LineData segments.
const segments = buildTerminatedLine(0, 0, 100, 40, 2, [1, 0, 0, 1], {
  end: LineTerminator.ARROW,
})
```
