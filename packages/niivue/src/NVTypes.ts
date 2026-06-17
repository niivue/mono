import type { mat4, vec2, vec3, vec4 } from 'gl-matrix'
import type { LogLevel } from '@/logger'
import type { FontMetrics } from '@/view/NVFont'
import type { ChunkPlan, VolumeChunkDesc } from '@/volume/chunking'

export type TypedVoxelArray =
  | Float32Array
  | Uint8Array
  | Int16Array
  | Float64Array
  | Uint16Array
  | Uint32Array
  | Int32Array
  | Int8Array

export type TypedNumberArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int32Array
  | Int16Array
  | Int8Array

export interface VolumeChunkSourceRequest {
  chunkIndex: number
  desc: VolumeChunkDesc
  plan: ChunkPlan
  datatypeCode: number
  bytesPerVoxel: number
}

export type VolumeChunkSource = (
  request: VolumeChunkSourceRequest,
) =>
  | ArrayBuffer
  | Uint8Array
  | TypedVoxelArray
  | Promise<ArrayBuffer | Uint8Array | TypedVoxelArray>

export interface VolumeChunkExplode {
  /** Enable draw-time spacing between streamed chunk cubes. */
  enabled?: boolean
  /** Per-axis spacing multiplier. 1 is compact, 1.5 leaves half-cell gaps. */
  scale?: [number, number, number]
}

export type NIFTIHeader = {
  littleEndian: boolean
  dim_info: number
  dims: number[]
  pixDims: number[]
  intent_p1: number
  intent_p2: number
  intent_p3: number
  intent_code: number
  datatypeCode: number
  numBitsPerVoxel: number
  slice_start: number
  vox_offset: number
  scl_slope: number
  scl_inter: number
  slice_end: number
  slice_code: number
  xyzt_units: number
  cal_max: number
  cal_min: number
  slice_duration: number
  toffset: number
  description: string
  aux_file: string
  qform_code: number
  sform_code: number
  quatern_b: number
  quatern_c: number
  quatern_d: number
  qoffset_x: number
  qoffset_y: number
  qoffset_z: number
  affine: number[][]
  intent_name: string
  magic: string
}

export type NIFTI1 = NIFTIHeader
export type NIFTI2 = NIFTIHeader

export type AffineMatrix = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
]

export type AffineTransform = {
  /** Translation in world millimeters. */
  translation: [number, number, number]
  /** Euler rotation angles in degrees, applied X then Y then Z. */
  rotation: [number, number, number]
  /** Scale factors. */
  scale: [number, number, number]
}

// ============================================================
// Per-Volume Data (NVImage)
// ============================================================
/** Spectral metadata retained alongside a complex MRSI volume's FID buffer. */
export type MrsVolumeMeta = {
  /** MHz; null means only a Hz spectral axis can be derived */
  spectrometerFreq: number | null
  /** resonant nucleus, e.g. '1H', '31P' */
  nucleus: string
  /** seconds (spectral dwell time, NIfTI pixDim[4]) */
  dwell: number
  /** spectral samples per voxel (dim4) */
  nPoints: number
  /** transients/averages per voxel (product of dims 5..7) */
  nTransients: number
}

export type NVImage = {
  name: string
  url?: string
  hdr: NIFTI1 | NIFTI2
  originalAffine?: number[][]
  img: TypedVoxelArray | null
  dims: number[]
  nVox3D: number
  extentsMin: vec3
  extentsMax: vec3
  calMin: number
  calMax: number
  robustMin: number
  robustMax: number
  globalMin: number
  globalMax: number
  pixDimsRAS?: number[]
  dimsRAS?: number[]
  permRAS?: number[]
  matRAS?: mat4
  obliqueRAS?: mat4
  frac2mm?: mat4
  frac2mmOrtho?: mat4
  extentsMinOrtho?: number[]
  extentsMaxOrtho?: number[]
  mm2ortho?: mat4
  img2RASstep?: number[]
  img2RASstart?: number[]
  toRAS?: mat4
  toRASvox?: mat4
  mm000?: vec3
  mm100?: vec3
  mm010?: vec3
  mm001?: vec3
  oblique_angle?: number
  maxShearDeg?: number
  colormap?: string
  colormapNegative?: string
  calMinNeg?: number
  calMaxNeg?: number
  colormapType?: number
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean
  opacity?: number
  modulateAlpha?: number
  /** Whether to show colorbar for this volume (default: true) */
  isColorbarVisible?: boolean
  /** Whether to show legend for label colormaps (default: false) */
  isLegendVisible?: boolean
  v1?: Float32Array
  gpu?: Record<string, unknown>
  volScale?: number[]
  /** Current 4D frame index (0-based) */
  frame4D?: number
  /** Number of 4D frames loaded (1 for single-frame volumes) */
  nFrame4D?: number
  /** Total number of 4D frames in the source file (may exceed nFrame4D when limitFrames4D was used) */
  nTotalFrame4D?: number
  /** Unique identifier for this volume */
  id?: string
  /** Label colormap for atlas/parcellation volumes (compiled LUT with optional text labels) */
  colormapLabel?: LUT | null
  /** Whether this volume has imaginary data (complex) */
  isImaginary?: boolean
  /**
   * Raw complex FID buffer for a spatial spectroscopic image (MRSI/CSI),
   * interleaved re/im in NIfTI native order. Retained on the CPU only (never
   * uploaded to the GPU — the GPU shows the derived scalar `img` instead) so
   * the graph/extension can extract any voxel's spectrum. See {@link mrsMeta}.
   */
  complexFID?: Float32Array
  /** Spectral/MRS metadata describing {@link complexFID}. */
  mrsMeta?: MrsVolumeMeta
  /** ID of the volume used to modulate this volume's brightness/opacity (empty = no modulation) */
  modulationImage?: string
  /** @internal Pre-computed modulation data in RAS order (Float32Array of [0,1] values) */
  _modulationData?: Float32Array | null
  /** Tiling plan for volumes whose dims exceed maxTextureDimension3D. Absent ⇒ legacy single-texture path. */
  chunkPlan?: ChunkPlan
  /** Optional source-backed chunk loader for volumes whose full voxel array is not resident in browser memory. */
  chunkSource?: VolumeChunkSource
  /** Optional draw-time spacing for chunked 3D rendering. Sampling remains in original voxel coordinates. */
  chunkExplode?: VolumeChunkExplode
  /**
   * Optional CPU value lookup in world mm, used by the 3D depth-pick to find the
   * first visible voxel along the view ray for a chunked/streamed volume (which
   * has no single GPU texture to sample). Return the window-visible value at the
   * point (0 / non-positive = transparent, skip). Supplied by the app from a
   * resident coarse representation; absent ⇒ depth-pick falls back to the
   * bounding-box surface.
   */
  pickSampler?: (x: number, y: number, z: number) => number
  /**
   * Marks this volume as an independently-streamed hi-res overlay layer that
   * composites over a chunked base volume. The value is the cache-key of the
   * base volume it sits on. When set, the renderer streams this volume in its
   * own ChunkResidencyManager working set and draws it as translucent chunk
   * cubes over the base, instead of reslicing it onto the base grid. Absent ⇒
   * legacy overlay path (resliced to the base grid).
   */
  chunkOverlayOf?: string
  /** Layer opacity for an independently-streamed chunked overlay ([0,1], default 1). */
  chunkOverlayOpacity?: number
  /**
   * @internal Pre-computed modulation weight in the MODULATOR's native voxel
   * order (Float32Array of [0,1] values, already windowed by the modulator's
   * calMin/calMax and raised to the modulateAlpha exponent). Used by the scalar
   * overlay colormap prepass, which samples it through the modulator's overlay
   * transform matrix (the same way the intensity texture is sampled), so it
   * works for any co-registered grid. Distinct from {@link _modulationData},
   * which is the RAS-order array consumed by the RGB/RGBA (V1) CPU path.
   */
  _modulationWeight?: Float32Array | null
  /** @internal Cache key for {@link _modulationWeight} (modulator id/buffer/window/exponent). */
  _modulationWeightKey?: string
  /**
   * @internal Original dropped/loaded `File` for this volume, kept so a deferred
   * 4D re-read (`loadDeferred4DVolumes`) can re-open it — a `File` has no URL to
   * re-fetch. Runtime-only: the serializer (NVDocument) uses an explicit field
   * allowlist, so this is never written to a saved document.
   */
  _sourceFile?: File
  [key: string]: unknown
}

export type MZ3 = {
  positions?: Float32Array | null
  indices?: Uint32Array | null
  colors?: Float32Array | null
  scalars?: Float32Array
  colormapLabel?: unknown
}

export type ColorMap = {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  min?: number
  max?: number
  labels?: string[]
}

export type LUT = {
  lut: Uint8ClampedArray
  min?: number
  max?: number
  labels?: string[]
  /** Label name → center-of-mass in mm (precomputed, not serialized) */
  centroids?: Record<string, [number, number, number]>
}

export type ColorbarInfo = {
  colormapName: string
  min: number
  max: number
  thresholdMin?: number
  isNegative?: boolean
}

// ============================================================
// Per-Layer Data (NVMeshLayer)
// ============================================================
export type NVMeshLayer = {
  /** Scalar values per vertex (length = nVert * nFrame4D) */
  values: Float32Array
  /** Number of time-series frames (1 for single-frame) */
  nFrame4D: number
  /** Current frame index (0-based) */
  frame4D: number
  /** Global minimum across all frames */
  globalMin: number
  /** Global maximum across all frames */
  globalMax: number
  /** Minimum intensity for color mapping */
  calMin: number
  /** Maximum intensity for color mapping */
  calMax: number
  /**
   * Negative colormap threshold (less extreme end, closer to zero).
   * Values between 0 and calMinNeg are transparent.
   * Can be specified as negative (e.g. -1.5) or positive (1.5) — absolute value is used.
   * Default: mirrors calMin when colormapNegative is set.
   */
  calMinNeg: number
  /**
   * Negative colormap maximum (more extreme end, further from zero).
   * Values beyond calMaxNeg are clamped to the max colormap color.
   * Can be specified as negative (e.g. -5) or positive (5) — absolute value is used.
   * Default: mirrors calMax when colormapNegative is set.
   */
  calMaxNeg: number
  /** Layer opacity 0-1 */
  opacity: number
  /** Colormap name (default: 'warm') */
  colormap: string
  /**
   * Colormap for negative intensities.
   * When non-empty, negative scalar values use this colormap.
   * Default: '' (no negative colormap).
   */
  colormapNegative: string
  /** Whether colormap lookup should be inverted */
  isColormapInverted: boolean
  /**
   * Colormap type controlling intensity-to-color mapping range and below-threshold alpha.
   * 0 = MIN_TO_MAX: lookup [calMin, calMax], values below calMin transparent (unless isTransparentBelowCalMin is false).
   * 1 = ZERO_TO_MAX_TRANSPARENT_BELOW_MIN: lookup [0, calMax], below calMin fully transparent.
   * 2 = ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN: lookup [0, calMax], below calMin alpha = pow(f/calMin, 2).
   * Default: 1.
   */
  colormapType: number
  /**
   * Whether values below calMin are transparent (true) or clamped to the min LUT color (false).
   * Only affects MIN_TO_MAX (colormapType 0); types 1 and 2 always control their own below-threshold behavior.
   * Default: true.
   */
  isTransparentBelowCalMin: boolean
  /** Whether to use additive blending instead of alpha blending */
  isAdditiveBlend: boolean
  /** Whether to show colorbar for this layer */
  isColorbarVisible: boolean
  /** Label colormap (for atlas/parcellation overlays) */
  colormapLabel: LUT | null
  /** Outline width (0 = filled, >0 = outline only) */
  outlineWidth: number
  /** Source URL or filename */
  url?: string
  /** Display name */
  name?: string
}

// ============================================================
// Mesh species discriminator
// ============================================================
export type MeshKind = 'mesh' | 'tract' | 'connectome'

// ============================================================
// Source data: Triangulated Meshes
// ============================================================
/** Minimal geometry source for triangulated meshes. Shares array refs with top-level positions/indices. */
export type NVMeshData = {
  positions: Float32Array
  indices: Uint32Array
}

// ============================================================
// Source data: Tracts (Streamlines)
// ============================================================
/** Range metadata for a tract scalar overlay. */
export type TractScalarMeta = {
  globalMin: number
  globalMax: number
}

/** Source data for tract/streamline meshes, in the canonical TRX representation. */
export type NVTractData = {
  /** Flat array of streamline vertices [x,y,z, x,y,z, ...] in mm space */
  vertices: Float32Array
  /** Fence-post offsets: streamline i spans vertices[offsets[i]*3 .. offsets[i+1]*3) */
  offsets: Uint32Array
  /** Per-vertex scalar arrays keyed by name */
  dpv: Record<string, Float32Array>
  /** Per-streamline scalar arrays keyed by name */
  dps: Record<string, Float32Array>
  /** Group membership arrays: group name -> array of streamline indices */
  groups: Record<string, Uint32Array>
  /** Range metadata for per-vertex scalars */
  dpvMeta: Record<string, TractScalarMeta>
  /** Range metadata for per-streamline scalars */
  dpsMeta: Record<string, TractScalarMeta>
}

/** Display and tessellation options for tract meshes. */
export type NVTractOptions = {
  /** Cylinder radius in mm (default: 0.5) */
  fiberRadius: number
  /** Number of polygon sides per cylinder ring (default: 7) */
  fiberSides: number
  /** Skip streamlines shorter than this length in mm (default: 0) */
  minLength: number
  /** Show every Nth streamline; 1 = all (default: 1) */
  decimation: number
  /** Colormap for scalar coloring (default: 'warm') */
  colormap: string
  /** Colormap for negative scalar values */
  colormapNegative: string
  /** Color mode: '' = local direction, 'global' = start-to-end direction,
   *  'fixed' = use fixedColor, 'dpv:name' = per-vertex scalar, 'dps:name' = per-streamline scalar */
  colorBy: string
  /** Minimum intensity for scalar color mapping */
  calMin: number
  /** Maximum intensity for scalar color mapping */
  calMax: number
  /** Negative colormap threshold (absolute value used) */
  calMinNeg: number
  /** Negative colormap maximum (absolute value used) */
  calMaxNeg: number
  /** Fixed RGBA color [0-255] used when colorBy='fixed' (default: [255,255,255,255]) */
  fixedColor: [number, number, number, number]
  /** Map of group name -> RGBA [0-255]. When non-null, only streamlines in listed
   *  groups are shown, each colored by their group's color. Overrides colorBy. */
  groupColors: Record<string, [number, number, number, number]> | null
}

// ============================================================
// Source data: Connectomes (Nodes + Edges)
// ============================================================
export type NVConnectomeNode = {
  name: string
  x: number
  y: number
  z: number
  colorValue: number
  sizeValue: number
}

export type NVConnectomeEdge = {
  first: number
  second: number
  colorValue: number
}

/** Source data for connectome meshes, in the canonical JCON representation. */
export type NVConnectomeData = {
  nodes: NVConnectomeNode[]
  edges: NVConnectomeEdge[]
}

/** Display and extrusion options for connectome meshes. */
export type NVConnectomeOptions = {
  /** Colormap for node colorValues (default: 'warm') */
  nodeColormap: string
  /** Colormap for negative node colorValues */
  nodeColormapNegative: string
  /** Min colorValue for node color mapping */
  nodeMinColor: number
  /** Max colorValue for node color mapping */
  nodeMaxColor: number
  /** Sphere radius multiplier (default: 3) */
  nodeScale: number
  /** Colormap for edge colorValues (default: 'warm') */
  edgeColormap: string
  /** Colormap for negative edge colorValues */
  edgeColormapNegative: string
  /** Min |colorValue| to display an edge */
  edgeMin: number
  /** Max |colorValue| for edge color mapping */
  edgeMax: number
  /** Cylinder radius multiplier (default: 1) */
  edgeScale: number
}

// ============================================================
// NVMesh — supports three species via `kind` discriminator
// ============================================================
export type NVMesh = {
  /** Species discriminator: 'mesh' (triangulated), 'tract' (streamlines), 'connectome' (nodes+edges) */
  kind: MeshKind
  // --- Derived GPU-ready data (always present for all species) ---
  positions: Float32Array
  indices: Uint32Array
  colors: Uint32Array
  extentsMin: vec3
  extentsMax: vec3
  clipPlane: Float32Array
  // --- Display properties (shared across all species) ---
  opacity: number
  shaderType: string
  /** RGBA color 0-1 range (default: [1,1,1,1]) */
  color: [number, number, number, number]
  /** Whether to show colorbar (default: true) */
  isColorbarVisible: boolean
  /** Whether to show legend for label layers (default: false) */
  isLegendVisible?: boolean
  /** Source URL or filename */
  url?: string
  /** Display name */
  name?: string
  // --- Source data (exactly one is non-null, determined by kind) ---
  /** Triangulated mesh source. Shares positions/indices refs with top-level fields. Null for tracts/connectomes. */
  mz3: NVMeshData | null
  /** Tract/streamline source data. Null for meshes/connectomes. */
  trx: NVTractData | null
  /** Connectome source data. Null for meshes/tracts. */
  jcon: NVConnectomeData | null
  // --- Species-specific options ---
  /** Tessellation options for tracts (null for other species) */
  tractOptions: NVTractOptions | null
  /** Extrusion options for connectomes (null for other species) */
  connectomeOptions: NVConnectomeOptions | null
  // --- Mesh-only properties (layers only meaningful for kind === 'mesh') ---
  /** Scalar overlay layers (default: []) */
  layers: NVMeshLayer[]
  /** Per-vertex colors from the mesh file (packed ABGR Uint32). Null when mesh uses uniform color. */
  perVertexColors: Uint32Array | null
  /** @internal Index signature allows createMesh to assign defaults */
  [key: string]: unknown
}

export type WebGLMeshGPU = {
  vao: WebGLVertexArrayObject | null
  vertexBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer | null
  indexCount: number
}

export type WebGPUMeshGPU = {
  vertexBuffer: GPUBuffer | null
  indexBuffer: GPUBuffer | null
  uniformBuffer: GPUBuffer | null
  indexCount: number
  bindGroup: GPUBindGroup | null
  alignedMeshSize?: number
}

export type MeshGPU = WebGLMeshGPU | WebGPUMeshGPU

export type MeshGPUResource = { destroy?: () => void }

export type ClipPlane = [number, number, number, number]

// ============================================================
// Model Config Groups
// ============================================================

/** Scene config: camera, crosshair position, clip planes, background */
export type SceneConfig = {
  azimuth: number
  elevation: number
  crosshairPos: vec3
  pan2Dxyzmm: vec4
  scaleMultiplier: number
  // Clip-space translation applied after projection in 3D render mode
  // (sliceType === RENDER). Each component is in NDC units, so renderPan = [0.5, 0.5]
  // shifts the volume half the viewport right and up. Ignored in 2D / mosaic.
  renderPan: vec2
  gamma: number
  backgroundColor: [number, number, number, number]
  clipPlaneColor: number[]
  isClipPlaneCutaway: boolean
  /** Clip the overlay/PAQD/drawing layers along with the base volume in the 3D
   * render. Default false: overlays ignore the clip plane (show through). */
  clipPlaneOverlay: boolean
}

/** Layout config: slice type, mosaic, multiplanar, hero, tiling */
/** A single tile in a custom layout: slice orientation + normalized position. */
export type CustomLayoutTile = {
  sliceType: number // SLICE_TYPE.AXIAL | CORONAL | SAGITTAL | RENDER
  position: [number, number, number, number] // [left, top, width, height] normalized 0–1
  sliceMM?: number // optional fixed mm position for the slice
}

export type LayoutConfig = {
  sliceType: number
  mosaicString: string
  showRender: number
  multiplanarType: number
  heroFraction: number
  heroSliceType: number
  isEqualSize: boolean
  isMosaicCentered: boolean
  margin: number
  isRadiological: boolean
  customLayout: CustomLayoutTile[] | null
}

/** UI config: visual chrome (colorbars, orient, fonts, crosshair appearance, measurements) */
export type UIConfig = {
  isColorbarVisible: boolean
  isOrientCubeVisible: boolean
  isOrientationTextVisible: boolean
  is3DCrosshairVisible: boolean
  isGraphVisible: boolean
  isRulerVisible: boolean
  isCrossLinesVisible: boolean
  isLegendVisible: boolean
  isPositionInMM: boolean
  isMeasureUnitsVisible: boolean
  isThumbnailVisible: boolean
  thumbnailUrl: string
  placeholderText: string
  crosshairColor: number[]
  crosshairGap: number
  crosshairWidth: number
  fontColor: number[]
  fontScale: number
  fontMinSize: number
  selectionBoxColor: number[]
  measureLineColor: number[]
  measureTextColor: number[]
  rulerWidth: number
  graph: GraphConfig
}

/** Volume rendering config: global settings for volume display */
export type VolumeRenderConfig = {
  illumination: number
  outlineWidth: number
  alphaShader: number
  isBackgroundMasking: boolean
  isAlphaClipDark: boolean
  isNearestInterpolation: boolean
  isV1SliceShader: boolean
  matcap: string
  paqdUniforms: [number, number, number, number]
  transmittanceCutoff: number
}

/** Mesh rendering config: global settings for mesh display */
export type MeshRenderConfig = {
  xRay: number
  thicknessOn2D: number
}

/** Drawing/annotation config */
export type DrawConfig = {
  isEnabled: boolean
  penValue: number
  penSize: number
  isFillOverwriting: boolean
  opacity: number
  rimOpacity: number
  colormap: string
}

/** Interaction config: drag modes, mouse behavior */
export type InteractionConfig = {
  primaryDragMode: number
  secondaryDragMode: number
  isSnapToVoxelCenters: boolean
  isDragDropEnabled: boolean
  isYoked3DTo2DZoom: boolean
}

// ============================================================
// Sync, Navigation, Hit Test
// ============================================================

export type SyncOpts = {
  '3d'?: boolean
  '2d'?: boolean
  crosshair?: boolean
  clipPlane?: boolean
  sliceType?: boolean
  calMin?: boolean
  calMax?: boolean
  viewport?: boolean
}

export type BackendType = 'webgpu' | 'webgl2'

export type ViewHitTest = {
  isRender: boolean
  sliceType: number
  normalizedX: number
  normalizedY: number
  tileIndex: number
}

/** Normalized bounds [[x1,y1],[x2,y2]] where y=0 is bottom, y=1 is top */
export type NVBounds = [[number, number], [number, number]]

/**
 * Canvas-level virtual camera applied to all instances sharing a canvas.
 * Each instance's `bounds` define its position in *world space*; the viewport
 * pans (in normalized canvas units, GL convention y-up) and zooms (scalar
 * around the canvas centre) the world before bounds are projected to pixels.
 * Identity `{pan: [0, 0], zoom: 1}` reproduces the pre-viewport behavior.
 */
export type CanvasViewport = {
  pan: [number, number]
  zoom: number
}

export type NVGlobalCamera = {
  position: [number, number, number]
  yaw?: number
  pitch?: number
  fov?: number
  near?: number
  far?: number
}

export type NVInstance = {
  id: string
  /** Screen-space canvas bounds for classic OSD-style tiled instances. */
  bounds?: NVBounds
  /** Set to `global3d` to draw this volume in one shared 3D scene. */
  space?: 'canvas' | 'global3d'
  /** Global scene position used when `space` is `global3d`. */
  position?: [number, number, number]
  /** Global scene scale in world units, or xyz scale. */
  scale?: number | [number, number, number]
  /** Global scene Euler rotation in radians: [x, y, z]. */
  orientation?: [number, number, number]
  viewport?: CanvasViewport
  rotation?: [number, number, number, number]
  volumeId?: string
}

export type NVViewOptions = {
  isAntiAlias?: boolean
  devicePixelRatio?: number
  font?: NVFontData
  matcaps?: Record<string, string>
  bounds?: NVBounds
  showBoundsBorder?: boolean
  boundsBorderColor?: [number, number, number, number]
  boundsBorderThickness?: number
  maxTextureDimension3D?: number
  [key: string]: unknown
}

export type GraphConfig = {
  /** Whether to normalize values to 0..1 across all plotted frames */
  normalizeValues: boolean
  /** Whether vertical axis range is calMin..calMax (true) or data-driven (false) */
  isRangeCalMinMax: boolean
  /**
   * Volume+physio association view only: include the crosshair BOLD/volume
   * time-course as a series. Default true. Set false to plot only the attached
   * physio traces (e.g. a "show fMRI trace" toggle).
   */
  showVolumeTimecourse?: boolean
  /**
   * Data-line thickness multiplier (relative to the default), default 1. The
   * base is DPI-scaled, so this stays consistent across displays. <1 thins the
   * lines (e.g. to stop dense traces overlapping); grid/axis lines are unaffected.
   */
  lineWidth?: number
  /**
   * Opacity (0..1) applied to the multi-series data lines, default 1. Values
   * below 1 make overlapping traces translucent so intersections are visible.
   */
  lineAlpha?: number
  /**
   * When an explicit-range display change (ppm window, ppm<->Hz, ppm reference)
   * moves the x-domain, reset the transient pan/zoom view window so the new range
   * is shown in full. Default true. Set false for a host that drives the range
   * reactively (listening to `graphRangeChange` and setting it via
   * `setGraphRange`) and so wants to keep the window across range changes.
   */
  autoResetView?: boolean
}

// ============================================================
// Constructor and Model Options
// ============================================================

/**
 * Options for constructing a NiiVue instance.
 * Uses flat property names matching the controller getter/setter API.
 * All properties are optional with sensible defaults.
 */
export type NiiVueOptions = {
  // Infrastructure (set once at construction)
  instances?: NVInstance[]
  globalCamera?: NVGlobalCamera
  backend?: BackendType
  isAntiAlias?: boolean
  devicePixelRatio?: number
  bounds?: NVBounds
  showBoundsBorder?: boolean
  boundsBorderColor?: [number, number, number, number]
  boundsBorderThickness?: number
  font?: NVFontData
  matcaps?: Record<string, string>
  isDragDropEnabled?: boolean
  isInteractionEnabled?: boolean
  logLevel?: LogLevel
  thumbnail?: string
  /**
   * Debug/testing override: caps the effective `maxTextureDimension3D` used to
   * decide when a volume must be tiled into chunks. GPUs rarely report a limit
   * low enough to exercise the tiled-volume path on ordinary data; setting a
   * small value here (e.g. 256) forces normally-sized volumes to chunk. Does
   * not raise the limit beyond what the device actually supports.
   */
  maxTextureDimension3D?: number
  /**
   * GPU memory budget, in bytes, for a chunked (tiled) volume's resident chunk
   * set (scalar + RGBA + gradient across resident chunks). When a chunked
   * volume's chunks exceed this budget, the least-recently-visible chunks are
   * evicted and stream back in on demand as the view changes. Unset leaves a
   * conservative default that fits comfortably below typical discrete-GPU
   * memory.
   */
  maxChunkResidencyBytes?: number

  // Scene
  azimuth?: number
  elevation?: number
  crosshairPos?: [number, number, number]
  pan2Dxyzmm?: [number, number, number, number]
  scaleMultiplier?: number
  renderPan?: [number, number]
  gamma?: number
  backgroundColor?: [number, number, number, number]
  clipPlaneColor?: number[]
  isClipPlaneCutaway?: boolean
  clipPlaneOverlay?: boolean

  // Layout
  sliceType?: number
  mosaicString?: string
  showRender?: number
  multiplanarType?: number
  heroFraction?: number
  heroSliceType?: number
  isEqualSize?: boolean
  isMosaicCentered?: boolean
  tileMargin?: number
  isRadiological?: boolean
  customLayout?: CustomLayoutTile[] | null

  // UI
  isColorbarVisible?: boolean
  isOrientCubeVisible?: boolean
  isOrientationTextVisible?: boolean
  is3DCrosshairVisible?: boolean
  isGraphVisible?: boolean
  isRulerVisible?: boolean
  isCrossLinesVisible?: boolean
  isLegendVisible?: boolean
  isPositionInMM?: boolean
  isMeasureUnitsVisible?: boolean
  isThumbnailVisible?: boolean
  thumbnailUrl?: string
  placeholderText?: string
  crosshairColor?: number[]
  crosshairGap?: number
  crosshairWidth?: number
  fontColor?: number[]
  fontScale?: number
  fontMinSize?: number
  selectionBoxColor?: number[]
  measureLineColor?: number[]
  measureTextColor?: number[]
  rulerWidth?: number
  graphNormalizeValues?: boolean
  graphIsRangeCalMinMax?: boolean
  graphShowVolumeTimecourse?: boolean
  graphLineWidth?: number
  graphLineAlpha?: number
  graphAutoResetView?: boolean

  // Volume (prefixed)
  volumeIllumination?: number
  volumeOutlineWidth?: number
  volumeAlphaShader?: number
  volumeIsBackgroundMasking?: boolean
  volumeIsAlphaClipDark?: boolean
  volumeIsNearestInterpolation?: boolean
  volumeIsV1SliceShader?: boolean
  volumeMatcap?: string
  volumePaqdUniforms?: [number, number, number, number]
  volumeTransmittanceCutoff?: number

  // Mesh (prefixed)
  meshXRay?: number
  meshThicknessOn2D?: number

  // Draw (prefixed)
  drawIsEnabled?: boolean
  drawPenValue?: number
  drawPenSize?: number
  drawIsFillOverwriting?: boolean
  drawOpacity?: number
  drawRimOpacity?: number
  drawColormap?: string

  // Interaction
  primaryDragMode?: number
  secondaryDragMode?: number
  isSnapToVoxelCenters?: boolean
  isYoked3DTo2DZoom?: boolean

  // Annotation (prefixed)
  annotationIsEnabled?: boolean
  annotationActiveLabel?: number
  annotationActiveGroup?: string
  annotationBrushRadius?: number
  annotationIsErasing?: boolean
  annotationIsVisibleIn3D?: boolean
  annotationStyle?: AnnotationStyle
  annotationTool?: AnnotationTool
}

// ============================================================
// Drag / Measurement Types
// ============================================================

export type DragReleaseInfo = {
  tileIdx: number
  axCorSag: number
  mmLength: number
  voxStart: [number, number, number]
  voxEnd: [number, number, number]
  mmStart: [number, number, number]
  mmEnd: [number, number, number]
}

export type DragOverlay = {
  rect?: { ltwh: [number, number, number, number]; color: number[] }
  lines?: Array<{
    startXY: [number, number]
    endXY: [number, number]
    color: number[]
    thickness: number
  }>
  text?: Array<{
    str: string
    x: number
    y: number
    scale: number
    color: number[]
    anchorX: number
    anchorY: number
    backColor?: number[]
  }>
}

export type CompletedMeasurement = {
  startMM: [number, number, number]
  endMM: [number, number, number]
  distance: number
  sliceIndex: number
  sliceType: number
  slicePosition: number
}

/**
 * Transient world-space axis-aligned bounding box drawn as 12 edges on the 3D
 * render tile(s) — e.g. to outline a focused subvolume. `min`/`max` are in the
 * same world-mm space as the scene extents. Controller-owned, not serialized.
 */
export type FocusBox = {
  min: [number, number, number]
  max: [number, number, number]
  color: number[]
  thickness: number
}

export type CompletedAngle = {
  firstLine: {
    startMM: [number, number, number]
    endMM: [number, number, number]
  }
  secondLine: {
    startMM: [number, number, number]
    endMM: [number, number, number]
  }
  angle: number
  sliceIndex: number
  sliceType: number
  slicePosition: number
}

// ============================================================
// Load / Update Option Types
// ============================================================

/**
 * Options for loading a volume from a URL or File.
 * Supports any NVImage display properties as optional overrides.
 */
export type ImageFromUrlOptions = {
  /** URL or File pointing to the volume */
  url: string | File
  /** URL or File for detached image data (e.g., AFNI .HEAD/.BRIK) */
  urlImageData?: string | File
  /** Display name for this volume */
  name?: string
  /** Colormap name (default: 'Gray') */
  colormap?: string
  /** Colormap for negative intensities */
  colormapNegative?: string
  /** Minimum intensity for negative color mapping (default: NaN = symmetric) */
  calMinNeg?: number
  /** Maximum intensity for negative color mapping (default: NaN = symmetric) */
  calMaxNeg?: number
  /** Colormap type: 0=min-to-max, 1=zero-to-max (transparent below), 2=zero-to-max (translucent below) */
  colormapType?: number
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean
  /**
   * Maximum number of 4D frames to load (default: Infinity = load all). The
   * optimized partial path reads only the header + first N frames; it covers a
   * gzip NIfTI-1 (any source) and an uncompressed NIfTI-1 from a local `File`
   * (other formats fall back to a full load). It is also the only way to open a
   * 4D volume larger than the browser's ~2 GiB ArrayBuffer cap — such a volume
   * auto-caps to as-many-frames-as-fit even without this option. Remaining frames
   * can be loaded later via `loadDeferred4DVolumes()` (not yet supported for a
   * dropped local `File` whose remaining frames exceed the cap). Note: the generic
   * `loadImage()` still sniffs signal-vs-volume by reading the whole file unless
   * `limitFrames4D` (or `asSignal: false`) makes the volume intent explicit; pass
   * volumes through `loadVolumes([{ url, limitFrames4D }])` to skip the sniff.
   */
  limitFrames4D?: number
  /** Volume opacity 0-1 (default: 1) */
  opacity?: number
  /** Minimum intensity for color mapping */
  calMin?: number
  /** Maximum intensity for color mapping */
  calMax?: number
  /** Alpha modulation amount */
  modulateAlpha?: number
  /** Whether to show colorbar for this volume (default: true) */
  isColorbarVisible?: boolean
}

/**
 * Options for loading a scalar overlay layer onto a mesh.
 */
export type MeshLayerFromUrlOptions = {
  /** URL or File pointing to the layer data */
  url: string | File
  /** Display name for this layer */
  name?: string
  /** Colormap name (default: 'warm') */
  colormap?: string
  /** Colormap for negative intensities (set to enable negative colormap) */
  colormapNegative?: string
  /** Minimum intensity for color mapping */
  calMin?: number
  /** Maximum intensity for color mapping */
  calMax?: number
  /** Negative colormap threshold (absolute value used; defaults to calMin) */
  calMinNeg?: number
  /** Negative colormap maximum (absolute value used; defaults to calMax) */
  calMaxNeg?: number
  /** Layer opacity 0-1 (default: 0.5) */
  opacity?: number
  /** Whether to show colorbar for this layer (default: true) */
  isColorbarVisible?: boolean
  /** Whether colormap lookup should be inverted */
  isColormapInverted?: boolean
  /** Colormap type: 0=min-to-max, 1=zero-to-max (transparent below), 2=zero-to-max (translucent below). Default: 1. */
  colormapType?: number
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean
  /** Whether to use additive blending */
  isAdditiveBlend?: boolean
  /** Outline width */
  outlineWidth?: number
}

/**
 * Options for loading a mesh from a URL or File.
 */
export type MeshFromUrlOptions = {
  /** URL or File pointing to the mesh */
  url: string | File
  /** Display name for this mesh */
  name?: string
  /** Mesh opacity 0-1 (default: 1) */
  opacity?: number
  /** RGBA color in 0-1 range (default: [1,1,1,1]) */
  color?: [number, number, number, number]
  /** @deprecated Use `color` instead. RGBA color in 0-255 range (converted internally). */
  rgba255?: [number, number, number, number]
  /** Whether to show colorbar (default: true) */
  isColorbarVisible?: boolean
  /** Whether to show legend (default: false) */
  isLegendVisible?: boolean
  /** Shader type (default: 'phong') */
  shaderType?: string
  /** Whether mesh is visible (default: true) */
  visible?: boolean
  /** Scalar overlay layers to load onto this mesh */
  layers?: MeshLayerFromUrlOptions[]
  /** Tract tessellation options (only used for tract file formats) */
  tractOptions?: Partial<NVTractOptions>
  /** Connectome extrusion options (only used for connectome file formats) */
  connectomeOptions?: Partial<NVConnectomeOptions>
}

/**
 * Display properties for updating a loaded volume.
 * Same shape as ImageFromUrlOptions minus load-only fields, plus frame4D.
 */
export type VolumeUpdate = Omit<
  ImageFromUrlOptions,
  'url' | 'urlImageData' | 'limitFrames4D'
> & {
  /** Set the current 4D frame index (0-based, clamped to valid range) */
  frame4D?: number
}

/**
 * Display properties for updating a loaded mesh.
 * Same shape as MeshFromUrlOptions minus load-only fields.
 */
export type MeshUpdate = Omit<MeshFromUrlOptions, 'url'>

// ============================================================
// Location / Callback Types
// ============================================================

export type NiiVueLocationValue = {
  name: string
  value: number
  id: string
  mm: number[]
  vox: number[]
  /** Label name for atlas/parcellation volumes (when colormapLabel is set) */
  label?: string
}

export type NiiVueLocation = {
  mm: number[]
  axCorSag: number
  vox: number[]
  frac: number[]
  xy: [number, number]
  values: NiiVueLocationValue[]
  string: string
}

export type NVFontData = {
  metrics: FontMetrics
  atlasUrl: string
}

export type SaveVolumeOptions = {
  /** Name of the output file (e.g. 'myimage.nii.gz'). If empty, returns data only. */
  filename?: string
  /** Whether to save the drawing layer instead of the volume */
  isSaveDrawing?: boolean
  /** Which volume layer to save (0 = background) */
  volumeByIndex?: number
}

// ============================================================
// Vector Annotations
// ============================================================

export type AnnotationTool =
  | 'freehand'
  | 'ellipse'
  | 'rectangle'
  | 'line'
  | 'arrow'
  | 'measureEllipse'
  | 'measureRect'
  | 'measureLine'
  | 'circle'
  | 'measureCircle'

export type AnnotationStats = {
  area: number
  min: number
  mean: number
  max: number
  stdDev: number
  length?: number
}

export type AnnotationPoint = { x: number; y: number }

export type AnnotationStyle = {
  fillColor: [number, number, number, number]
  strokeColor: [number, number, number, number]
  strokeWidth: number
}

export type PolygonWithHoles = {
  outer: AnnotationPoint[]
  holes: AnnotationPoint[][]
}

export type VectorAnnotation = {
  id: string
  label: number
  group: string
  sliceType: number
  slicePosition: number
  anchorMM?: [number, number, number]
  polygons: PolygonWithHoles[]
  style: AnnotationStyle
  stats?: AnnotationStats
  shape?: {
    type: AnnotationTool
    start: AnnotationPoint
    end: AnnotationPoint
    width?: number
  }
}

export type AnnotationConfig = {
  isEnabled: boolean
  activeLabel: number
  activeGroup: string
  brushRadius: number
  isErasing: boolean
  isVisibleIn3D: boolean
  tool: AnnotationTool
  style: AnnotationStyle
}

// ============================================================
// Signal data (NVSignal) — non-spatial datasets shown as 2D plots
// ============================================================

/** Two species of signal: physiological time-series and MR spectroscopy. */
export type SignalKind = 'physio' | 'spectroscopy'

/**
 * BIDS-style sidecar metadata, parsed and normalized from a `.json` companion
 * (or, for MRS, a NIfTI header extension). All fields optional: a signal can
 * load without a sidecar and degrade to a sample-index x-axis.
 */
export type SignalSidecar = {
  // physio
  columns?: string[]
  /** Hz */
  samplingFrequency?: number
  /** seconds (BIDS StartTime, often negative for a pre-scan lead-in) */
  startTime?: number
  // spectroscopy (MRS)
  /** MHz; authoritative MRS field */
  spectrometerFrequency?: number
  /**
   * MHz; ppm fallback only. Present in most MR sidecars (incl. plain fMRI), so
   * it is NOT an MRS marker and never drives signal-vs-volume routing — used to
   * derive the ppm axis only after a file is already known to be spectroscopy.
   */
  imagingFrequency?: number
  resonantNucleus?: string
  /** seconds */
  dwellTime?: number
}

/** Real-valued, multi-column physiological time-series (e.g. cardiac, respiratory). */
export type NVSignalPhysioRaw = {
  kind: 'physio'
  /** one entry per column; non-numeric cells are stored as NaN (gaps) */
  columns: Float32Array[]
  columnLabels: string[]
  /** Hz; null means the x-axis is a plain sample index */
  samplingFrequency: number | null
  /** seconds */
  startTime: number
}

/** Complex MR spectroscopy free-induction-decay (FID). */
export type NVSignalSpectroscopyRaw = {
  kind: 'spectroscopy'
  /**
   * Complex FID with real/imag interleaved: [re0, im0, re1, im1, ...].
   * Length is `nPoints * nTransients * 2`. Points are contiguous within a
   * transient (NIfTI column-major: dim4 spectral varies faster than dim5+),
   * so the complex sample for transient `t`, point `p` is at index
   * `2 * (t * nPoints + p)`.
   */
  fid: Float32Array
  nPoints: number
  nTransients: number
  /** seconds (NIfTI pixDim[4], the spectral dwell time) */
  dwell: number
  /** MHz; null means only a Hz axis can be derived */
  spectrometerFreq: number | null
  /** resonant nucleus, e.g. '1H', '31P' */
  nucleus: string
}

/** Reader output: raw signal data before any display transform. */
export type NVSignalRaw = NVSignalPhysioRaw | NVSignalSpectroscopyRaw

/** A single plotted trace produced by a display transform. */
export type SignalSeries = {
  label: string
  /** dependent values */
  y: Float32Array
  /** independent-axis values, same length as `y`; null means index 0..n-1 */
  x: Float32Array | null
  /** optional RGBA [0..1] override; otherwise the graph assigns a palette color */
  color?: [number, number, number, number]
  /**
   * x-axis positions of this measure's BIDS event triggers — the numeric,
   * non-zero cells of its "<label>_trigger" column (e.g. `cardiac_trigger` for a
   * `cardiac` series). Drawn as a tick rug along the TOP of the plot. The plain
   * scanner volume "trigger" column is intentionally NOT used. Carried per
   * plotted series; absent when the signal has no matching "<label>_trigger".
   */
  triggers?: number[]
}

/** Independent-axis description shared by all series of a signal. */
export type SignalAxis = {
  label: string
  /** draw high-to-low (MR ppm convention) */
  reversed: boolean
  /** optional fixed window; null autoscales to the data */
  min: number | null
  max: number | null
}

/** How a transformed component of a complex spectrum is projected to a real trace. */
export type SignalSpectrumMode = 'real' | 'imag' | 'magnitude' | 'phase'

/**
 * A text label anchored to a position in a signal graph's data space (e.g. a
 * peak assignment on a spectrum). The label is mapped through the same axis
 * window as the data, so it pans/zooms with the graph and is hidden when its x
 * falls outside the visible window.
 */
export type SignalAnnotation = {
  /** label text (e.g. 'NAA') */
  text: string
  /** x position in axis data units (e.g. ppm for spectroscopy, seconds for physio) */
  x: number
  /**
   * y position in data units. The sentinels `-Infinity` and `+Infinity` are
   * shorthand for "bottom of plot" and "top of plot" respectively, so a label
   * can be pinned to an axis edge regardless of the autoscaled y-range.
   */
  y: number
  /** optional RGBA [0..1] color override; otherwise the graph font color is used */
  color?: [number, number, number, number]
}

/** A loaded signal instance held by the model. */
export type NVSignal = {
  id: string
  name: string
  url?: string
  kind: SignalKind
  /** raw, undisplayed data (FID or physio columns) */
  raw: NVSignalRaw
  /** current display state (drives the on-demand transform) */
  display: NVSignalDisplay
  /** id of an associated volume/mesh this signal is bound to (optional) */
  attachedToId?: string
  /**
   * When true (spectroscopy only), the spectrum is extracted live from the
   * crosshair voxel of the complex MRSI volume named by {@link attachedToId},
   * re-derived on every crosshair move. The signal's own `raw.fid` is then a
   * placeholder used only as a fallback / metadata template.
   */
  followsCrosshair?: boolean
  /** text labels anchored to positions in the graph's data space (optional) */
  annotations?: SignalAnnotation[]
}

/** User-controllable display state for a signal (drives the on-demand transform). */
export type NVSignalDisplay = {
  // spectroscopy
  average: boolean
  mode: SignalSpectrumMode
  /** [low, high] ppm window; null autoscales */
  ppmRange: [number, number] | null
  /** ppm reference offset; null uses the nucleus default */
  ppmRef: number | null
  useHz: boolean
  // FSL-MRS spectral processing (optional; absent/false/0 leaves the spectrum
  // unprocessed, preserving the svs.html baseline)
  /** halve the first FID point before the FFT (FSL-MRS calcSpectrum) */
  halveFirstPoint?: boolean
  /** exponential apodization / line-broadening in Hz (0 = none) */
  apodizeHz?: number
  /** 0th-order phase correction, degrees */
  phase0?: number
  /** 1st-order phase correction, milliseconds */
  phase1Ms?: number
  // physio
  /** indices of columns to show; null shows all */
  selectedColumns: number[] | null
  // shared
  showLegend: boolean
}
