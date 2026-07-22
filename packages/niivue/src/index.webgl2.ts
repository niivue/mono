/**
 * NiiVue — WebGL2-only distribution.
 */

export type { NVCanvasViewportControllerOptions } from './control/NVCanvasViewportController'
// biome-ignore lint/performance/noBarrelFile: package entry point
export { NVExtensionContext } from './extension/context'
export type {
  BackgroundVolumeAccess,
  DrawingAccess,
  DrawingDims,
  MrsVolumeAccess,
  NVExtensionEventMap,
  SharedBufferHandle,
  SlicePointerEvent,
} from './extension/types'
export type { LogLevel } from './logger'
export type { WriteOptions } from './mesh/writers'
// MRSI scene controller (FSLeyes MRS plugin workflow): anatomy + MRSI grid +
// crosshair spectrum + metabolite maps, built on the core spectroscopy APIs.
export {
  defaultSpectrumDisplay,
  type MakeMapOptions,
  type MetaboliteMapOptions,
  MrsScene,
  type MrsSceneOptions,
  makeMetaboliteMap,
  PROTON_PEAK_ANNOTATIONS,
  paddedPpmRange,
} from './mrs/MrsScene'
export { DRAG_MODE } from './NVConstants'
export { default, default as NiiVue } from './NVControlWebGL2'
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
  MrsVolumeMeta,
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
// MRS / spectroscopy processing (used by the MrsScene controller above and by
// other spectroscopy extensions)
export {
  apodize,
  deriveSpectroscopySeries,
  GYRO_MAG_RATIO,
  halveFirstPoint,
  integratePpmBandMap,
  PPM_RANGE,
  PPM_SHIFT,
  type PpmBandOptions,
  phaseCorrection,
  ppmRefForNucleus,
} from './signal/processing'
// Crosshair-focused multi-resolution (multi-LOD) streamed volumes
export type {
  ChunkedVolumeFetch,
  ChunkedVolumeLevel,
  ChunkedVolumeSource,
} from './volume/ChunkedVolumeSource'
export type {
  UIKitBackendHandle,
  UIKitOverlayBounds,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './view/NVOverlayHook'
export type {
  ChunkPlan,
  MultiLodFocus,
  MultiLodOptions,
  Vec3f,
  Vec3i,
  VolumeChunkDesc,
} from './volume/chunking'
export { chunkVolumeGrid, chunkVolumeMultiLOD } from './volume/chunking'
// MRSI (spatial spectroscopic imaging) volume helpers
export { buildDerivedScalarVolume, isMrsiVolume } from './volume/mrsi'
export {
  type ChunkedVolumeOptions,
  NVChunkedVolume,
} from './volume/NVChunkedVolume'
export {
  createStreamingNVImage,
  type StreamingVolumeSpec,
} from './volume/streamingVolume'
export type { TransformInfo, TransformOptions } from './volume/transforms'
export { extractVoxelFid, getImageDataRAS } from './volume/utils'
