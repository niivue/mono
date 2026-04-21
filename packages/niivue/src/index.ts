/**
 * NiiVueGPU — WebGPU/WebGL2 medical image visualization library.
 *
 * @packageDocumentation
 */

// Extension API
export { NVExtensionContext } from "./extension/context"
export type {
  BackgroundVolumeAccess,
  DrawingAccess,
  DrawingDims,
  NVExtensionEventMap,
  SharedBufferHandle,
  SlicePointerEvent,
} from "./extension/types"
// Logger
export type { LogLevel } from "./logger"
// Mesh writer types
export type { WriteOptions } from "./mesh/writers"
// Enums
export { DRAG_MODE, NiiDataType, SHOW_RENDER, SLICE_TYPE } from "./NVConstants"
export { default, default as NiiVueGPU } from "./NVControl"
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
  VolumeUpdatedDetail,
} from "./NVEvents"
// Core types used in the public API
export type {
  BackendType,
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
  NVConnectomeOptions,
  NVFontData,
  NVImage,
  NVMesh,
  NVMeshLayer,
  NVTractOptions,
  SaveVolumeOptions,
  SyncOpts,
  TypedVoxelArray,
  ViewHitTest,
  VolumeUpdate,
} from "./NVTypes"
// Transform types
export type {
  OptionField,
  ResultDefaults,
  TransformInfo,
  TransformOptions,
  VolumeTransform,
} from "./volume/transforms"
// Volume utilities for extensions
export { getImageDataRAS } from "./volume/utils"
// Worker bridge for external transform packages
export { NVWorker } from "./workers/NVWorker"
