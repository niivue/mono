/**
 * NiiVueGPU — WebGPU/WebGL2 medical image visualization library.
 *
 * @packageDocumentation
 */

// Viewport controller (OpenSeadragon-style smooth pan/zoom on the shared canvas).
// Opt-in: not in the static graph so apps that don't need the UX don't pay for it.
// Import directly: `import { NVCanvasViewportController } from '@niivue/niivue/viewport'`
export type { NVCanvasViewportControllerOptions } from './control/NVCanvasViewportController'
// Extension API
// biome-ignore lint/performance/noBarrelFile: package entry point
export { NVExtensionContext } from './extension/context'
export type {
  BackgroundVolumeAccess,
  DrawingAccess,
  DrawingDims,
  NVExtensionEventMap,
  SharedBufferHandle,
  SlicePointerEvent,
} from './extension/types'
// Whole-slide-image tile viewer (standalone 2D deep-zoom over HTTP byte ranges).
// NVSlide is the backend-agnostic model; SlideRenderer (WebGL2) /
// SlideRendererGPU (WebGPU) draw it.
export { SlideRenderer } from './gl/slide'
// Logger
export type { LogLevel } from './logger'
// Mesh writer types
export type { WriteOptions } from './mesh/writers'
// Enums
export {
  DRAG_MODE,
  MULTIPLANAR_TYPE,
  NiiDataType,
  SHOW_RENDER,
  SLICE_TYPE,
} from './NVConstants'
export { default, default as NiiVueGPU } from './NVControl'
// Event types
export type {
  AzimuthElevationChangeDetail,
  CanvasResizeDetail,
  ClipPlaneChangeDetail,
  ColormapAddedDetail,
  DrawingChangedDetail,
  DrawingEnabledDetail,
  FrameChangeDetail,
  MeshLoadedDetail,
  MeshRemovedDetail,
  MeshUpdatedDetail,
  NVEventListener,
  NVEventMap,
  NVEventTarget,
  PenValueChangedDetail,
  PointerUpDetail,
  PropertyChangeDetail,
  SliceTypeChangeDetail,
  ViewAttachedDetail,
  VolumeLoadedDetail,
  VolumeRemovedDetail,
  VolumeUpdatedChanges,
  VolumeUpdatedDetail,
} from './NVEvents'
// Core types used in the public API
export type {
  AffineMatrix,
  AffineTransform,
  BackendType,
  CanvasViewport,
  ColorMap,
  CustomLayoutTile,
  DragReleaseInfo,
  ImageFromUrlOptions,
  MeshFromUrlOptions,
  MeshLayerFromUrlOptions,
  MeshUpdate,
  NIFTI1,
  NIFTI2,
  NiiVueLocation,
  NiiVueLocationValue,
  NiiVueOptions,
  NVBounds,
  NVConnectomeOptions,
  NVFontData,
  NVGlobalCamera,
  NVImage,
  NVInstance,
  NVMesh,
  NVMeshLayer,
  NVTractOptions,
  SaveVolumeOptions,
  SyncOpts,
  TypedVoxelArray,
  ViewHitTest,
  VolumeChunkExplode,
  VolumeChunkSource,
  VolumeChunkSourceRequest,
  VolumeUpdate,
} from './NVTypes'
export type {
  NVSlideColor,
  NVSlideLevelChoice,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideOptions,
  NVSlideRangeEvent,
  NVSlideRangeStatus,
  NVSlideScreen,
  NVSlideScreenRect,
  NVSlideSpatialTransform,
  NVSlideStats,
  NVSlideTileCodec,
  NVSlideTileFragment,
  NVSlideTileManifest,
  NVSlideViewport,
  NVSlideVisibleTile,
  NVSlideVisibleTiles,
  NVSlideYAxis,
  SlideSourceHost,
  SlideTileDecoder,
  SlideTileSource,
} from './slide/NVSlide'
export { ManifestRangeSource, NVSlide } from './slide/NVSlide'
export type {
  ChunkPlan,
  Vec3f,
  Vec3i,
  VolumeChunkDesc,
} from './volume/chunking'
export { chunkVolumeGrid } from './volume/chunking'
// Transform types
export type {
  OptionField,
  ResultDefaults,
  TransformInfo,
  TransformOptions,
  VolumeTransform,
} from './volume/transforms'
// Volume utilities for extensions
export { getImageDataRAS } from './volume/utils'
export { SlideRendererGPU } from './wgpu/slide'
// Worker bridge for external transform packages
export { NVWorker } from './workers/NVWorker'
