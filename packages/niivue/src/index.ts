/**
 * NiiVueGPU — WebGPU/WebGL2 medical image visualization library.
 *
 * @packageDocumentation
 */

// Extension API
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
  SignalLoadedDetail,
  SignalLocationDetail,
  SignalRemovedDetail,
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
  ColorMap,
  CustomLayoutTile,
  DragReleaseInfo,
  ImageFromUrlOptions,
  MeshFromUrlOptions,
  MeshLayerFromUrlOptions,
  MeshUpdate,
  MrsVolumeMeta,
  NIFTI1,
  NIFTI2,
  NiiVueLocation,
  NiiVueLocationValue,
  NiiVueOptions,
  NVConnectomeOptions,
  NVFontData,
  NVImage,
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
  TypedVoxelArray,
  ViewHitTest,
  VolumeUpdate,
} from './NVTypes'
// Signal load options
export type { SignalFromUrlOptions } from './signal/NVSignal'
// MRS / spectroscopy processing (for nv-ext-mrs and other spectroscopy extensions)
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
// MRSI (spatial spectroscopic imaging) volume helpers
export { buildDerivedScalarVolume, isMrsiVolume } from './volume/mrsi'
// Transform types
export type {
  OptionField,
  ResultDefaults,
  TransformInfo,
  TransformOptions,
  VolumeTransform,
} from './volume/transforms'
// Volume utilities for extensions
export { extractVoxelFid, getImageDataRAS } from './volume/utils'
// Worker bridge for external transform packages
export { NVWorker } from './workers/NVWorker'
