// @niivue/uikit root entry: the drawing primitives (line, rect, text and their
// overlays), the measuring widgets (ruler, crosshair, point label, magnifier),
// the input router (UIKitControls) and the overlay hook types. It needs no
// @niivue/niivue: an overlay registers on a NiiVue controller or on a bare
// canvas through UIKitCanvasHost. Canvas form controls are in '@niivue/uikit/controls',
// widgets that drive a NiiVue scene in '@niivue/uikit/niivue'. Each widget is a
// pure geometry builder plus an overlay that owns its GPU resources; the
// builders' models stay package-private unless exported here.

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type { UIKitCanvasHostOptions } from './canvasHost'
export { UIKitCanvasHost } from './canvasHost'
export type {
  UIKitControlsOptions,
  UIKitHost,
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
export { UIKitControls } from './controls'
export type { CrosshairGeometry, CrosshairSpec } from './crosshair'
export { buildCrosshair } from './crosshair'
export type { CrosshairPlacement } from './crosshairOverlay'
export { UIKitCrosshairOverlay } from './crosshairOverlay'
export type {
  UIKitBackendHandle,
  UIKitOverlayBounds,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './hook'
export type { LineData, LineTerminators } from './line'
export { buildLine, buildTerminatedLine, LineTerminator } from './line'
export { UIKitLineOverlay } from './lineOverlay'
export type { UIKitMagnifierOverlayOptions } from './magnifierOverlay'
export { UIKitMagnifierOverlay } from './magnifierOverlay'
export type {
  PointLabelBounds,
  PointLabelGeometry,
  PointLabelSpec,
} from './pointLabel'
export { buildPointLabel } from './pointLabel'
export type {
  MMPoint,
  MMProjector,
  PointLabelPlacement,
} from './pointLabelOverlay'
export { UIKitPointLabelOverlay } from './pointLabelOverlay'
export type { RectData, RectSpec, UIKitBox } from './rect'
export { buildRect } from './rect'
export { UIKitRectOverlay } from './rectOverlay'
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
export {
  autoOutlineColor,
  layoutText,
  measureWidth,
  readableAngle,
} from './text/layout'
export type { UIKitTextItem } from './textOverlay'
export { UIKitTextOverlay } from './textOverlay'
