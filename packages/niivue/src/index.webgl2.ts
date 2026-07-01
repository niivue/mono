/**
 * NiiVueGPU — WebGL2-only distribution.
 */

export type { NVCanvasViewportControllerOptions } from './control/NVCanvasViewportController'
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
export type { LogLevel } from './logger'
export type { WriteOptions } from './mesh/writers'
export { DRAG_MODE } from './NVConstants'
export { default, default as NiiVueGPU } from './NVControlWebGL2'
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
  NVSignal,
  NVSignalDisplay,
  NVSignalRaw,
  NVTractOptions,
  SaveVolumeOptions,
  SignalAnnotation,
  SignalAxis,
  SignalKind,
  SignalSeries,
  SignalSidecar,
  SignalSpectrumMode,
  SyncOpts,
  ViewHitTest,
  VolumeChunkSource,
  VolumeChunkSourceRequest,
  VolumeUpdate,
} from './NVTypes'
export type { SignalFromUrlOptions } from './signal/NVSignal'
export type {
  ChunkPlan,
  Vec3f,
  Vec3i,
  VolumeChunkDesc,
} from './volume/chunking'
export { chunkVolumeGrid } from './volume/chunking'
export type { TransformInfo, TransformOptions } from './volume/transforms'
export { getImageDataRAS } from './volume/utils'
