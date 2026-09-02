/**
 * NiiVue — WebGPU/WebGL2 medical image visualization library.
 *
 * @packageDocumentation
 */

// biome-ignore-all lint/performance/noBarrelFile assist/source/organizeImports: package entry point
// Label colormap helpers for extensions producing label/atlas volumes
export { lookupColorMap, makeLabelLut } from './cmap/NVCmaps'
export { slice2DToMM } from './annotation/sliceProjection'
// Viewport controller (OpenSeadragon-style smooth pan/zoom on the shared canvas).
// Opt-in: not in the static graph so apps that don't need the UX don't pay for it.
// Import directly: `import { NVCanvasViewportController } from '@niivue/niivue/viewport'`
export type { NVCanvasViewportControllerOptions } from './control/NVCanvasViewportController'
// Sparse-document settings policies: which settings saveDocument includes, and
// how loadDocument fills settings a sparse document omits
export type {
  SettingsFill,
  SettingsFillPolicy,
  SettingsSavePolicy,
} from './documentSettings'
// Extension API
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
// Whole-slide-image tile viewer (standalone 2D deep-zoom over HTTP byte ranges).
// NVSlide is the backend-agnostic model; SlideRenderer (WebGL2) /
// SlideRendererGPU (WebGPU) draw it.
export { SlideRenderer } from './gl/slide'
// Logger
export type { LogLevel } from './logger'
// Mesh writer types
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
// Enums
export {
  DRAG_MODE,
  LAYER_GRADIENT_MODE,
  MULTIPLANAR_TYPE,
  NiiDataType,
  SHOW_RENDER,
  SLICE_TYPE,
  VOLUME_RENDER_MODE,
} from './NVConstants'
export { default, default as NiiVue } from './NVControl'
// Document save options (settings policy + linkData)
export type { SerializeOptions } from './NVDocument'
// Event types
export type {
  AnnotationAddedDetail,
  AnnotationChangedDetail,
  AnnotationRemovedDetail,
  AzimuthElevationChangeDetail,
  CanvasResizeDetail,
  ChunkStreamDetail,
  ClipPlaneChangeDetail,
  ColormapAddedDetail,
  DrawingChangedDetail,
  DrawingEnabledDetail,
  FrameChangeDetail,
  GraphRangeChangeDetail,
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
// The decoded-chunk tier counters carried as `ChunkStreamDetail.decoded`
export type { DecodedChunkStats } from './volume/decodedChunkCache'
// Core types used in the public API
export type {
  AffineMatrix,
  AffineTransform,
  AnnotationConfig,
  AnnotationPoint,
  AnnotationScreenShape,
  AnnotationStats,
  AnnotationTool,
  BackendType,
  CanvasViewport,
  ColorMap,
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
  VectorAnnotation,
  ViewHitTest,
  VolumeChunkExplode,
  VolumeChunkSource,
  VolumeChunkSourceRequest,
  VolumeUpdate,
} from './NVTypes'
// Signal load options
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
export type { DziDescriptor } from './slide/dziSource'
export {
  buildDziManifest,
  DziSource,
  parseDziDescriptor,
} from './slide/dziSource'
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
export { SlideDrawing } from './slide/slideDrawing'
export type { SlidePlaneTile } from './slide/slidePlane'
export { axialPlaneTransform, slidePlaneTiles } from './slide/slidePlane'
export type { SlideVectorKind, SlideVectorShape } from './slide/slideVector'
export { SlideVectorLayer } from './slide/slideVector'
export type {
  VolumeSliceAxis,
  VolumeSliceSourceOptions,
} from './slide/volumeSliceSource'
export { VolumeSliceSource } from './slide/volumeSliceSource'
export { buildDrawingLut, drawingBitmapToRGBA } from './view/NVDrawingTexture'
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
// UIKit overlay lifecycle hook — the seam @niivue/uikit widgets draw into
export type {
  UIKitBackendHandle,
  UIKitOverlayBounds,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './view/NVOverlayHook'
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
// Exploded-block picking: resolve a click on an exploded brick, then copy that
// brick out as a standalone volume that keeps the parent's anatomical frame.
export type { ExplodedBlockPick } from './control/interactions'
export { pickExplodedBlock } from './control/interactions'
export type { ExtractedSubVolume } from './volume/ChunkExtract'
export {
  extractChunkBlock,
  extractSubVolume,
  subVolumeAffine,
} from './volume/ChunkExtract'
// MRSI (spatial spectroscopic imaging) volume helpers
export { buildDerivedScalarVolume, isMrsiVolume } from './volume/mrsi'
// Budget plans: the policy that shapes a streamed volume's octree
export {
  type BudgetPlan,
  type BudgetPlanName,
  type BudgetPlanOptions,
  type BudgetPlanSpec,
  BUDGET_PLANS,
  resolveBudgetPlan,
} from './volume/budgetPlans'
export {
  type ChunkedVolumeOptions,
  NVChunkedVolume,
} from './volume/NVChunkedVolume'
// Volume construction/serialization for extensions building derived volumes
// (e.g. wrapping segmentation labels into an overlay NVImage)
export { nii2volume, writeVolume } from './volume/NVVolume'
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
// OME-Zarr chunk-streaming adapter for nv.loadChunkedVolume
export { fetchOmeZarrChunkedSource } from './volume/fetchOmeZarrChunkedSource'
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
export { SlideRendererGPU } from './wgpu/slide'
// Worker bridge for external transform packages
export { NVWorker } from './workers/NVWorker'
