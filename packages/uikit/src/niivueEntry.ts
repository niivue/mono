// @niivue/uikit/niivue: widgets that drive a NiiVue scene (the slide panels,
// minimap and magnifier wiring, the drawing slice list and the subvolume
// selector). They need @niivue/niivue, an optional peer of the package.

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type { UIKitDrawingSource } from './drawingSlices'
export { UIKitDrawingSlices } from './drawingSlices'
export type { MinimapCorner, SlideMinimapLayout } from './slideMinimap'
export type {
  UIKitMinimapSlide,
  UIKitSlideMinimapOptions,
} from './slideMinimapOverlay'
export { UIKitSlideMinimapOverlay } from './slideMinimapOverlay'
export type { SlideHudRows } from './slideView'
export {
  attachSlideChannelPanel,
  attachSlideHud,
  attachSlideMagnifier,
  attachSlideMinimap,
  attachSlidePlaneControl,
} from './slideView'
export type {
  SubvolumeSelection,
  SubvolumeSelectorHost,
  UIKitSubvolumeSelectorOptions,
} from './subvolumeSelector'
export { UIKitSubvolumeSelector } from './subvolumeSelector'
