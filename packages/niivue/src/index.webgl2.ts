/**
 * NiiVue — WebGL2-only distribution.
 */

// biome-ignore-all lint/performance/noBarrelFile: package entry point

// Exploded-block picking: resolve a click on an exploded brick, then copy that
// brick out as a standalone volume that keeps the parent's anatomical frame.
export type { ExplodedBlockPick } from './control/interactions'
export { pickExplodedBlock } from './control/interactions'
// Programmatic measurement API (NiiVue.addMeasurement options)
export type { AddMeasurementOptions } from './control/measurements'
export type { NVCanvasViewportControllerOptions } from './control/NVCanvasViewportController'
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
export {
  DRAG_MODE,
  LAYER_GRADIENT_MODE,
  MULTIPLANAR_TYPE,
  NiiDataType,
  SHOW_RENDER,
  SLICE_TYPE,
  VOLUME_RENDER_MODE,
} from './NVConstants'
export { default, default as NiiVue } from './NVControlWebGL2'
export type {
  AffineMatrix,
  AffineTransform,
  BackendType,
  CanvasViewport,
  ColorMap,
  CompletedMeasurement,
  CustomLayoutTile,
  DragReleaseInfo,
  ImageFromUrlOptions,
  LodCompensationLevel,
  LodCompensationReport,
  MeasurementScreenLine,
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
export type {
  UIKitBackendHandle,
  UIKitOverlayBounds,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './view/NVOverlayHook'
// Allen "volume-viewer" JSON + PNG atlas datasets (multi-channel microscopy)
export {
  type AllenAtlasImage,
  type AllenAtlasInfo,
  allenAtlasSpacing,
  allenAtlasVolumeDims,
  deinterleaveAllenAtlasPlane,
  findAllenAtlasChannel,
  parseAllenAtlasInfo,
} from './volume/allenAtlas'
export {
  type AllenAtlasLoadOptions,
  allenAtlasChannelColormap,
  allenAtlasChannelFile,
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
} from './volume/allenAtlasLoader'
// Budget plans: the policy that shapes a streamed volume's octree
export {
  BUDGET_PLANS,
  type BudgetPlan,
  type BudgetPlanName,
  type BudgetPlanOptions,
  type BudgetPlanSpec,
  resolveBudgetPlan,
} from './volume/budgetPlans'
export type { ExtractedSubVolume } from './volume/ChunkExtract'
export {
  extractChunkBlock,
  extractSubVolume,
  subVolumeAffine,
} from './volume/ChunkExtract'
// Crosshair-focused multi-resolution (multi-LOD) streamed volumes
export type {
  ChunkedVolumeFetch,
  ChunkedVolumeLevel,
  ChunkedVolumeSource,
} from './volume/ChunkedVolumeSource'
// OME-TIFF and plain TIFF stacks (multi-channel microscopy)
export {
  CHANNEL_COLORMAPS,
  channelColormapFor,
} from './volume/channelColormaps'
export type {
  ChunkPlan,
  MultiLodFocus,
  MultiLodOptions,
  Vec3f,
  Vec3i,
  VolumeChunkDesc,
} from './volume/chunking'
export { chunkVolumeGrid, chunkVolumeMultiLOD } from './volume/chunking'
// Chunk-streaming phase timing (docs/caching.md stage B)
export {
  type ChunkPhase,
  type ChunkPhaseTiming,
  type ChunkTimingSnapshot,
  chunkTimingSnapshot,
  mergeOffThreadChunkTiming,
  type OffThreadChunkTiming,
  recordChunkPhase,
  resetChunkTiming,
} from './volume/chunkTiming'
// OME-Zarr chunk-streaming adapter for nv.loadChunkedVolume
export { fetchOmeZarrChunkedSource } from './volume/fetchOmeZarrChunkedSource'
// MRSI (spatial spectroscopic imaging) volume helpers
export { buildDerivedScalarVolume, isMrsiVolume } from './volume/mrsi'
export {
  type ChunkedVolumeOptions,
  NVChunkedVolume,
} from './volume/NVChunkedVolume'
export {
  type ImageJStackInfo,
  type OmeChannel,
  type OmeTiffInfo,
  omeChannelName,
  omeLengthToMicrons,
  omePlaneCount,
  omePlaneIndex,
  parseImageJDescription,
  parseOmeColor,
  parseOmeXml,
} from './volume/omeTiff'
export {
  fetchOmeTiff,
  loadOmeTiffVolumes,
  type OmeTiffLoadOptions,
  omeTiffChannelColormap,
  omeTiffChannelFile,
  omeTiffVolumesFrom,
} from './volume/omeTiffLoader'
// OME-Zarr (OME-NGFF) multiscale microscopy stores
export {
  type OmeZarrAxis,
  type OmeZarrAxisIndices,
  type OmeZarrChannel,
  type OmeZarrDataset,
  type OmeZarrInfo,
  type OmeZarrSpatialOrder,
  type OmeZarrWindow,
  omeZarrAxisIndices,
  omeZarrResolveAxes,
  omeZarrSpatialOrder,
  omeZarrSpatialScaleUm,
  parseOmeroColor,
  parseOmeZarrAttrs,
} from './volume/omeZarr'
export {
  type ByteCacheStats,
  ByteLruCache,
  type FetchOmeZarrChunkedSourceOptions,
  OME_ZARR_CHUNK_CACHE_BYTES,
  OME_ZARR_CHUNK_ERROR,
  type OmeZarrChunkedSource,
  type OmeZarrChunkedSourceOptions,
  omeZarrChunkedSource,
  openOmeZarrChunkedSource,
  withChunkTiming,
} from './volume/omeZarrChunkedSource'
export type { OmeZarrChunkPoolOptions } from './volume/omeZarrChunkWorkerPool'
export {
  defaultOmeZarrLevel,
  fetchOmeZarr,
  loadOmeZarrVolumes,
  OME_ZARR_LEVEL_BUDGET_BYTES,
  type OmeZarrLevel,
  type OmeZarrLoadOptions,
  type OmeZarrSource,
  type OpenOmeZarrOptions,
  omeZarrBlockToDisplay,
  omeZarrChannelColormap,
  omeZarrChannelCount,
  omeZarrChannelFile,
  omeZarrChannelName,
  omeZarrNiftiDatatype,
  omeZarrVolumesFrom,
  openOmeZarr,
} from './volume/omeZarrLoader'
export {
  clearPersistentByteCaches,
  OME_ZARR_PERSIST_BYTES,
  openCacheStorageBacking,
  openPersistentByteCache,
  PERSISTENT_CACHE_NAME,
  PersistentByteCache,
  type PersistentCacheBacking,
  type PersistentCacheOptions,
  type PersistentCacheStats,
  withPersistentBytes,
} from './volume/persistentByteCache'
export {
  createStreamingNVImage,
  type StreamingVolumeSpec,
} from './volume/streamingVolume'
export {
  parseTiff,
  readTiffImage,
  type TiffFile,
  type TiffIfd,
  type TiffImage,
  tiffImageDescription,
  tiffResolutionMm,
} from './volume/tiff'
export {
  describeTiff,
  readTiffVolume,
  type TiffSource,
  type TiffVolume,
  type TiffVolumeSelection,
  tiffChannelCount,
  tiffChannelName,
  tiffIsTiled,
  tiffPlaneIndices,
  tiffTimepointCount,
  tiffVolumeAffine,
} from './volume/tiffVolume'
export type { TransformInfo, TransformOptions } from './volume/transforms'
export { extractVoxelFid, getImageDataRAS } from './volume/utils'
