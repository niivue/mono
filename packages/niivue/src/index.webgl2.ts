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
