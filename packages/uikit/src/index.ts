// @niivue/uikit root entry: the drawing primitives (line, rect, text and their
// overlays), the measuring widgets (ruler, crosshair, point label, magnifier),
// the input router (UIKitControls) and the overlay hook types. It needs no
// @niivue/niivue: an overlay registers on a NiiVue controller or on a bare
// canvas through UIKitCanvasHost. Canvas form controls are in '@niivue/uikit/controls';
// widgets that drive a NiiVue scene are NiiVue's ('@niivue/niivue/uikit'). Each widget is a
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
export type { UIKitImageSource } from './imageOverlay'
export { UIKitImageOverlay } from './imageOverlay'
export type { LineData } from './line'
export { buildLine, FLOATS_PER_LINE } from './line'
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
export { buildRect, rectContains } from './rect'
export { UIKitRectOverlay } from './rectOverlay'
export { GlLineRenderer, GlRectRenderer } from './render/glInstanced'
export type { UIKitAtlasSource } from './render/glTextRenderer'
export { GlTextRenderer } from './render/glTextRenderer'
export { WgpuLineRenderer, WgpuRectRenderer } from './render/wgpuInstanced'
export { WgpuTextRenderer } from './render/wgpuTextRenderer'
export type {
  RulerGeometry,
  RulerSegment,
  RulerSpec,
  Vec2,
} from './ruler'
export { buildRuler, rulerSegments, rulerTickNumbers } from './ruler'
export { UIKitRulerOverlay } from './rulerOverlay'
export { loadDefaultFont } from './text/defaultFont'
export type {
  RawFontFile,
  UIKitFont,
  UIKitFontMetrics,
  UIKitGlyph,
} from './text/font'
export { parseFont } from './text/font'
export type { RGBA, TextLayoutOptions } from './text/layout'
export {
  autoOutlineColor,
  FLOATS_PER_GLYPH,
  layoutText,
  measureWidth,
  readableAngle,
} from './text/layout'
export { UBUNTU_FONT_ATLAS, UBUNTU_FONT_METRICS } from './text/ubuntuFont'
export type { UIKitTextItem } from './textOverlay'
export { UIKitTextOverlay } from './textOverlay'
