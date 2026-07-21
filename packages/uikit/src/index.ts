// @niivue/uikit public entry. UIKit is a collection of controls/widgets that
// integrate into NiiVue's rendering lifecycle. This is the base module; the
// lifecycle hook, the line/text renderers, and the ruler widget land next (see
// docs/ruler-port.md in @niivue/niivue).

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type { LineData, LineTerminators } from './line'
export { buildLine, buildTerminatedLine, LineTerminator } from './line'
export { UIKitLineOverlay } from './lineOverlay'
