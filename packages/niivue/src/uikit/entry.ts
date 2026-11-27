// @niivue/niivue/uikit: NiiVue widgets built on @niivue/uikit (the slide
// panels, minimap and magnifier wiring, the drawing slice list and the
// subvolume selector). Imported only from this entry, so a core-only app
// bundles none of them.

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
