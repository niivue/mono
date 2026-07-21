// @niivue/uikit public entry. UIKit is a collection of controls/widgets that
// integrate into NiiVue's rendering lifecycle. This is the base module; the
// lifecycle hook, the line/text renderers, and the ruler widget land next (see
// docs/ruler-port.md in @niivue/niivue).

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type { LineData, LineTerminators } from './line'
export { buildLine, buildTerminatedLine, LineTerminator } from './line'
export { UIKitLineOverlay } from './lineOverlay'
export type { RulerGeometry, RulerSpec, Vec2 } from './ruler'
export { buildRuler } from './ruler'
export { UIKitRulerOverlay } from './rulerOverlay'
export { loadDefaultFont } from './text/defaultFont'
export type {
  RawFontFile,
  UIKitFont,
  UIKitFontMetrics,
  UIKitGlyph,
} from './text/font'
export { parseFont, screenPxRange } from './text/font'
export type { RGBA, TextLayoutOptions } from './text/layout'
export { layoutText, measureWidth, readableAngle } from './text/layout'
export type { UIKitTextItem } from './textOverlay'
export { UIKitTextOverlay } from './textOverlay'
