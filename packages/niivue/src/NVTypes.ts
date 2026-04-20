import type { mat4, vec3, vec4 } from "gl-matrix";
import type { LogLevel } from "@/logger";
import type { FontMetrics } from "@/view/NVFont";

export type TypedVoxelArray =
  | Float32Array
  | Uint8Array
  | Int16Array
  | Float64Array
  | Uint16Array
  | Uint32Array
  | Int32Array
  | Int8Array;

export type TypedNumberArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int32Array
  | Int16Array
  | Int8Array;

export type NIFTIHeader = {
  littleEndian: boolean;
  dim_info: number;
  dims: number[];
  pixDims: number[];
  intent_p1: number;
  intent_p2: number;
  intent_p3: number;
  intent_code: number;
  datatypeCode: number;
  numBitsPerVoxel: number;
  slice_start: number;
  vox_offset: number;
  scl_slope: number;
  scl_inter: number;
  slice_end: number;
  slice_code: number;
  xyzt_units: number;
  cal_max: number;
  cal_min: number;
  slice_duration: number;
  toffset: number;
  description: string;
  aux_file: string;
  qform_code: number;
  sform_code: number;
  quatern_b: number;
  quatern_c: number;
  quatern_d: number;
  qoffset_x: number;
  qoffset_y: number;
  qoffset_z: number;
  affine: number[][];
  intent_name: string;
  magic: string;
};

export type NIFTI1 = NIFTIHeader;
export type NIFTI2 = NIFTIHeader;

// ============================================================
// Per-Volume Data (NVImage)
// ============================================================
export type NVImage = {
  name: string;
  url?: string;
  hdr: NIFTI1 | NIFTI2;
  img: TypedVoxelArray | null;
  dims: number[];
  nVox3D: number;
  extentsMin: vec3;
  extentsMax: vec3;
  calMin: number;
  calMax: number;
  robustMin: number;
  robustMax: number;
  globalMin: number;
  globalMax: number;
  pixDimsRAS?: number[];
  dimsRAS?: number[];
  permRAS?: number[];
  matRAS?: mat4;
  obliqueRAS?: mat4;
  frac2mm?: mat4;
  frac2mmOrtho?: mat4;
  extentsMinOrtho?: number[];
  extentsMaxOrtho?: number[];
  mm2ortho?: mat4;
  img2RASstep?: number[];
  img2RASstart?: number[];
  toRAS?: mat4;
  toRASvox?: mat4;
  mm000?: vec3;
  mm100?: vec3;
  mm010?: vec3;
  mm001?: vec3;
  oblique_angle?: number;
  maxShearDeg?: number;
  colormap?: string;
  colormapNegative?: string;
  calMinNeg?: number;
  calMaxNeg?: number;
  colormapType?: number;
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean;
  opacity?: number;
  modulateAlpha?: number;
  /** Whether to show colorbar for this volume (default: true) */
  isColorbarVisible?: boolean;
  /** Whether to show legend for label colormaps (default: false) */
  isLegendVisible?: boolean;
  v1?: Float32Array;
  gpu?: Record<string, unknown>;
  volScale?: number[];
  /** Current 4D frame index (0-based) */
  frame4D?: number;
  /** Number of 4D frames loaded (1 for single-frame volumes) */
  nFrame4D?: number;
  /** Total number of 4D frames in the source file (may exceed nFrame4D when limitFrames4D was used) */
  nTotalFrame4D?: number;
  /** Unique identifier for this volume */
  id?: string;
  /** Label colormap for atlas/parcellation volumes (compiled LUT with optional text labels) */
  colormapLabel?: LUT | null;
  /** Whether this volume has imaginary data (complex) */
  isImaginary?: boolean;
  /** ID of the volume used to modulate this volume's brightness/opacity (empty = no modulation) */
  modulationImage?: string;
  /** @internal Pre-computed modulation data in RAS order (Float32Array of [0,1] values) */
  _modulationData?: Float32Array | null;
  [key: string]: unknown;
};

export type MZ3 = {
  positions?: Float32Array | null;
  indices?: Uint32Array | null;
  colors?: Float32Array | null;
  scalars?: Float32Array;
  colormapLabel?: unknown;
};

export type ColorMap = {
  R: number[];
  G: number[];
  B: number[];
  A: number[];
  I: number[];
  min?: number;
  max?: number;
  labels?: string[];
};

export type LUT = {
  lut: Uint8ClampedArray;
  min?: number;
  max?: number;
  labels?: string[];
  /** Label name → center-of-mass in mm (precomputed, not serialized) */
  centroids?: Record<string, [number, number, number]>;
};

export type ColorbarInfo = {
  colormapName: string;
  min: number;
  max: number;
  thresholdMin?: number;
  isNegative?: boolean;
};

// ============================================================
// Per-Layer Data (NVMeshLayer)
// ============================================================
export type NVMeshLayer = {
  /** Scalar values per vertex (length = nVert * nFrame4D) */
  values: Float32Array;
  /** Number of time-series frames (1 for single-frame) */
  nFrame4D: number;
  /** Current frame index (0-based) */
  frame4D: number;
  /** Global minimum across all frames */
  globalMin: number;
  /** Global maximum across all frames */
  globalMax: number;
  /** Minimum intensity for color mapping */
  calMin: number;
  /** Maximum intensity for color mapping */
  calMax: number;
  /**
   * Negative colormap threshold (less extreme end, closer to zero).
   * Values between 0 and calMinNeg are transparent.
   * Can be specified as negative (e.g. -1.5) or positive (1.5) — absolute value is used.
   * Default: mirrors calMin when colormapNegative is set.
   */
  calMinNeg: number;
  /**
   * Negative colormap maximum (more extreme end, further from zero).
   * Values beyond calMaxNeg are clamped to the max colormap color.
   * Can be specified as negative (e.g. -5) or positive (5) — absolute value is used.
   * Default: mirrors calMax when colormapNegative is set.
   */
  calMaxNeg: number;
  /** Layer opacity 0-1 */
  opacity: number;
  /** Colormap name (default: 'warm') */
  colormap: string;
  /**
   * Colormap for negative intensities.
   * When non-empty, negative scalar values use this colormap.
   * Default: '' (no negative colormap).
   */
  colormapNegative: string;
  /** Whether colormap lookup should be inverted */
  isColormapInverted: boolean;
  /**
   * Colormap type controlling intensity-to-color mapping range and below-threshold alpha.
   * 0 = MIN_TO_MAX: lookup [calMin, calMax], values below calMin transparent (unless isTransparentBelowCalMin is false).
   * 1 = ZERO_TO_MAX_TRANSPARENT_BELOW_MIN: lookup [0, calMax], below calMin fully transparent.
   * 2 = ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN: lookup [0, calMax], below calMin alpha = pow(f/calMin, 2).
   * Default: 1.
   */
  colormapType: number;
  /**
   * Whether values below calMin are transparent (true) or clamped to the min LUT color (false).
   * Only affects MIN_TO_MAX (colormapType 0); types 1 and 2 always control their own below-threshold behavior.
   * Default: true.
   */
  isTransparentBelowCalMin: boolean;
  /** Whether to use additive blending instead of alpha blending */
  isAdditiveBlend: boolean;
  /** Whether to show colorbar for this layer */
  isColorbarVisible: boolean;
  /** Label colormap (for atlas/parcellation overlays) */
  colormapLabel: LUT | null;
  /** Outline width (0 = filled, >0 = outline only) */
  outlineWidth: number;
  /** Source URL or filename */
  url?: string;
  /** Display name */
  name?: string;
};

// ============================================================
// Mesh species discriminator
// ============================================================
export type MeshKind = "mesh" | "tract" | "connectome";

// ============================================================
// Source data: Triangulated Meshes
// ============================================================
/** Minimal geometry source for triangulated meshes. Shares array refs with top-level positions/indices. */
export type NVMeshData = {
  positions: Float32Array;
  indices: Uint32Array;
};

// ============================================================
// Source data: Tracts (Streamlines)
// ============================================================
/** Range metadata for a tract scalar overlay. */
export type TractScalarMeta = {
  globalMin: number;
  globalMax: number;
};

/** Source data for tract/streamline meshes, in the canonical TRX representation. */
export type NVTractData = {
  /** Flat array of streamline vertices [x,y,z, x,y,z, ...] in mm space */
  vertices: Float32Array;
  /** Fence-post offsets: streamline i spans vertices[offsets[i]*3 .. offsets[i+1]*3) */
  offsets: Uint32Array;
  /** Per-vertex scalar arrays keyed by name */
  dpv: Record<string, Float32Array>;
  /** Per-streamline scalar arrays keyed by name */
  dps: Record<string, Float32Array>;
  /** Group membership arrays: group name -> array of streamline indices */
  groups: Record<string, Uint32Array>;
  /** Range metadata for per-vertex scalars */
  dpvMeta: Record<string, TractScalarMeta>;
  /** Range metadata for per-streamline scalars */
  dpsMeta: Record<string, TractScalarMeta>;
};

/** Display and tessellation options for tract meshes. */
export type NVTractOptions = {
  /** Cylinder radius in mm (default: 0.5) */
  fiberRadius: number;
  /** Number of polygon sides per cylinder ring (default: 7) */
  fiberSides: number;
  /** Skip streamlines shorter than this length in mm (default: 0) */
  minLength: number;
  /** Show every Nth streamline; 1 = all (default: 1) */
  decimation: number;
  /** Colormap for scalar coloring (default: 'warm') */
  colormap: string;
  /** Colormap for negative scalar values */
  colormapNegative: string;
  /** Color mode: '' = local direction, 'global' = start-to-end direction,
   *  'fixed' = use fixedColor, 'dpv:name' = per-vertex scalar, 'dps:name' = per-streamline scalar */
  colorBy: string;
  /** Minimum intensity for scalar color mapping */
  calMin: number;
  /** Maximum intensity for scalar color mapping */
  calMax: number;
  /** Negative colormap threshold (absolute value used) */
  calMinNeg: number;
  /** Negative colormap maximum (absolute value used) */
  calMaxNeg: number;
  /** Fixed RGBA color [0-255] used when colorBy='fixed' (default: [255,255,255,255]) */
  fixedColor: [number, number, number, number];
  /** Map of group name -> RGBA [0-255]. When non-null, only streamlines in listed
   *  groups are shown, each colored by their group's color. Overrides colorBy. */
  groupColors: Record<string, [number, number, number, number]> | null;
};

// ============================================================
// Source data: Connectomes (Nodes + Edges)
// ============================================================
export type NVConnectomeNode = {
  name: string;
  x: number;
  y: number;
  z: number;
  colorValue: number;
  sizeValue: number;
};

export type NVConnectomeEdge = {
  first: number;
  second: number;
  colorValue: number;
};

/** Source data for connectome meshes, in the canonical JCON representation. */
export type NVConnectomeData = {
  nodes: NVConnectomeNode[];
  edges: NVConnectomeEdge[];
};

/** Display and extrusion options for connectome meshes. */
export type NVConnectomeOptions = {
  /** Colormap for node colorValues (default: 'warm') */
  nodeColormap: string;
  /** Colormap for negative node colorValues */
  nodeColormapNegative: string;
  /** Min colorValue for node color mapping */
  nodeMinColor: number;
  /** Max colorValue for node color mapping */
  nodeMaxColor: number;
  /** Sphere radius multiplier (default: 3) */
  nodeScale: number;
  /** Colormap for edge colorValues (default: 'warm') */
  edgeColormap: string;
  /** Colormap for negative edge colorValues */
  edgeColormapNegative: string;
  /** Min |colorValue| to display an edge */
  edgeMin: number;
  /** Max |colorValue| for edge color mapping */
  edgeMax: number;
  /** Cylinder radius multiplier (default: 1) */
  edgeScale: number;
};

// ============================================================
// NVMesh — supports three species via `kind` discriminator
// ============================================================
export type NVMesh = {
  /** Species discriminator: 'mesh' (triangulated), 'tract' (streamlines), 'connectome' (nodes+edges) */
  kind: MeshKind;
  // --- Derived GPU-ready data (always present for all species) ---
  positions: Float32Array;
  indices: Uint32Array;
  colors: Uint32Array;
  extentsMin: vec3;
  extentsMax: vec3;
  clipPlane: Float32Array;
  // --- Display properties (shared across all species) ---
  opacity: number;
  shaderType: string;
  /** RGBA color 0-1 range (default: [1,1,1,1]) */
  color: [number, number, number, number];
  /** Whether to show colorbar (default: true) */
  isColorbarVisible: boolean;
  /** Whether to show legend for label layers (default: false) */
  isLegendVisible?: boolean;
  /** Source URL or filename */
  url?: string;
  /** Display name */
  name?: string;
  // --- Source data (exactly one is non-null, determined by kind) ---
  /** Triangulated mesh source. Shares positions/indices refs with top-level fields. Null for tracts/connectomes. */
  mz3: NVMeshData | null;
  /** Tract/streamline source data. Null for meshes/connectomes. */
  trx: NVTractData | null;
  /** Connectome source data. Null for meshes/tracts. */
  jcon: NVConnectomeData | null;
  // --- Species-specific options ---
  /** Tessellation options for tracts (null for other species) */
  tractOptions: NVTractOptions | null;
  /** Extrusion options for connectomes (null for other species) */
  connectomeOptions: NVConnectomeOptions | null;
  // --- Mesh-only properties (layers only meaningful for kind === 'mesh') ---
  /** Scalar overlay layers (default: []) */
  layers: NVMeshLayer[];
  /** Per-vertex colors from the mesh file (packed ABGR Uint32). Null when mesh uses uniform color. */
  perVertexColors: Uint32Array | null;
  /** @internal Index signature allows createMesh to assign defaults */
  [key: string]: unknown;
};

export type WebGLMeshGPU = {
  vao: WebGLVertexArrayObject | null;
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  indexCount: number;
};

export type WebGPUMeshGPU = {
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  indexCount: number;
  bindGroup: GPUBindGroup | null;
  alignedMeshSize?: number;
};

export type MeshGPU = WebGLMeshGPU | WebGPUMeshGPU;

export type MeshGPUResource = { destroy?: () => void };

export type ClipPlane = [number, number, number, number];

// ============================================================
// Model Config Groups
// ============================================================

/** Scene config: camera, crosshair position, clip planes, background */
export type SceneConfig = {
  azimuth: number;
  elevation: number;
  crosshairPos: vec3;
  pan2Dxyzmm: vec4;
  scaleMultiplier: number;
  gamma: number;
  backgroundColor: [number, number, number, number];
  clipPlaneColor: number[];
  isClipPlaneCutaway: boolean;
};

/** Layout config: slice type, mosaic, multiplanar, hero, tiling */
export type LayoutConfig = {
  sliceType: number;
  mosaicString: string;
  showRender: number;
  multiplanarType: number;
  heroFraction: number;
  heroSliceType: number;
  isEqualSize: boolean;
  isMosaicCentered: boolean;
  margin: number;
  isRadiological: boolean;
};

/** UI config: visual chrome (colorbars, orient, fonts, crosshair appearance, measurements) */
export type UIConfig = {
  isColorbarVisible: boolean;
  isOrientCubeVisible: boolean;
  isOrientationTextVisible: boolean;
  is3DCrosshairVisible: boolean;
  isGraphVisible: boolean;
  isRulerVisible: boolean;
  isCrossLinesVisible: boolean;
  isLegendVisible: boolean;
  isPositionInMM: boolean;
  isMeasureUnitsVisible: boolean;
  isThumbnailVisible: boolean;
  thumbnailUrl: string;
  placeholderText: string;
  crosshairColor: number[];
  crosshairGap: number;
  crosshairWidth: number;
  fontColor: number[];
  fontScale: number;
  fontMinSize: number;
  selectionBoxColor: number[];
  measureLineColor: number[];
  measureTextColor: number[];
  rulerWidth: number;
  graph: GraphConfig;
};

/** Volume rendering config: global settings for volume display */
export type VolumeRenderConfig = {
  illumination: number;
  outlineWidth: number;
  alphaShader: number;
  isBackgroundMasking: boolean;
  isAlphaClipDark: boolean;
  isNearestInterpolation: boolean;
  isV1SliceShader: boolean;
  matcap: string;
  paqdUniforms: [number, number, number, number];
};

/** Mesh rendering config: global settings for mesh display */
export type MeshRenderConfig = {
  xRay: number;
  thicknessOn2D: number;
};

/** Drawing/annotation config */
export type DrawConfig = {
  isEnabled: boolean;
  penValue: number;
  penSize: number;
  isFillOverwriting: boolean;
  opacity: number;
  rimOpacity: number;
  colormap: string;
};

/** Interaction config: drag modes, mouse behavior */
export type InteractionConfig = {
  primaryDragMode: number;
  secondaryDragMode: number;
  isSnapToVoxelCenters: boolean;
  isDragDropEnabled: boolean;
  isYoked3DTo2DZoom: boolean;
};

// ============================================================
// Sync, Navigation, Hit Test
// ============================================================

export type SyncOpts = {
  "3d"?: boolean;
  "2d"?: boolean;
  crosshair?: boolean;
  clipPlane?: boolean;
  sliceType?: boolean;
  calMin?: boolean;
  calMax?: boolean;
};

export type BackendType = "webgpu" | "webgl2";

export type ViewHitTest = {
  isRender: boolean;
  sliceType: number;
  normalizedX: number;
  normalizedY: number;
  tileIndex: number;
};

/** Normalized bounds [[x1,y1],[x2,y2]] where y=0 is bottom, y=1 is top */
export type NVBounds = [[number, number], [number, number]];

export type NVViewOptions = {
  isAntiAlias?: boolean;
  devicePixelRatio?: number;
  font?: NVFontData;
  matcaps?: Record<string, string>;
  bounds?: NVBounds;
  showBoundsBorder?: boolean;
  boundsBorderColor?: [number, number, number, number];
  boundsBorderThickness?: number;
  [key: string]: unknown;
};

export type GraphConfig = {
  /** Whether to normalize values to 0..1 across all plotted frames */
  normalizeValues: boolean;
  /** Whether vertical axis range is calMin..calMax (true) or data-driven (false) */
  isRangeCalMinMax: boolean;
};

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
  backend?: BackendType;
  isAntiAlias?: boolean;
  devicePixelRatio?: number;
  bounds?: NVBounds;
  showBoundsBorder?: boolean;
  boundsBorderColor?: [number, number, number, number];
  boundsBorderThickness?: number;
  font?: NVFontData;
  matcaps?: Record<string, string>;
  isDragDropEnabled?: boolean;
  logLevel?: LogLevel;
  thumbnail?: string;

  // Scene
  azimuth?: number;
  elevation?: number;
  crosshairPos?: [number, number, number];
  pan2Dxyzmm?: [number, number, number, number];
  scaleMultiplier?: number;
  gamma?: number;
  backgroundColor?: [number, number, number, number];
  clipPlaneColor?: number[];
  isClipPlaneCutaway?: boolean;

  // Layout
  sliceType?: number;
  mosaicString?: string;
  showRender?: number;
  multiplanarType?: number;
  heroFraction?: number;
  heroSliceType?: number;
  isEqualSize?: boolean;
  isMosaicCentered?: boolean;
  tileMargin?: number;
  isRadiological?: boolean;

  // UI
  isColorbarVisible?: boolean;
  isOrientCubeVisible?: boolean;
  isOrientationTextVisible?: boolean;
  is3DCrosshairVisible?: boolean;
  isGraphVisible?: boolean;
  isRulerVisible?: boolean;
  isCrossLinesVisible?: boolean;
  isLegendVisible?: boolean;
  isPositionInMM?: boolean;
  isMeasureUnitsVisible?: boolean;
  isThumbnailVisible?: boolean;
  thumbnailUrl?: string;
  placeholderText?: string;
  crosshairColor?: number[];
  crosshairGap?: number;
  crosshairWidth?: number;
  fontColor?: number[];
  fontScale?: number;
  fontMinSize?: number;
  selectionBoxColor?: number[];
  measureLineColor?: number[];
  measureTextColor?: number[];
  rulerWidth?: number;
  graphNormalizeValues?: boolean;
  graphIsRangeCalMinMax?: boolean;

  // Volume (prefixed)
  volumeIllumination?: number;
  volumeOutlineWidth?: number;
  volumeAlphaShader?: number;
  volumeIsBackgroundMasking?: boolean;
  volumeIsAlphaClipDark?: boolean;
  volumeIsNearestInterpolation?: boolean;
  volumeIsV1SliceShader?: boolean;
  volumeMatcap?: string;
  volumePaqdUniforms?: [number, number, number, number];

  // Mesh (prefixed)
  meshXRay?: number;
  meshThicknessOn2D?: number;

  // Draw (prefixed)
  drawIsEnabled?: boolean;
  drawPenValue?: number;
  drawPenSize?: number;
  drawIsFillOverwriting?: boolean;
  drawOpacity?: number;
  drawRimOpacity?: number;
  drawColormap?: string;

  // Interaction
  primaryDragMode?: number;
  secondaryDragMode?: number;
  isSnapToVoxelCenters?: boolean;
  isYoked3DTo2DZoom?: boolean;

  // Annotation (prefixed)
  annotationIsEnabled?: boolean;
  annotationActiveLabel?: number;
  annotationActiveGroup?: string;
  annotationBrushRadius?: number;
  annotationIsErasing?: boolean;
  annotationIsVisibleIn3D?: boolean;
  annotationStyle?: AnnotationStyle;
  annotationTool?: AnnotationTool;
};

// ============================================================
// Drag / Measurement Types
// ============================================================

export type DragReleaseInfo = {
  tileIdx: number;
  axCorSag: number;
  mmLength: number;
  voxStart: [number, number, number];
  voxEnd: [number, number, number];
  mmStart: [number, number, number];
  mmEnd: [number, number, number];
};

export type DragOverlay = {
  rect?: { ltwh: [number, number, number, number]; color: number[] };
  lines?: Array<{
    startXY: [number, number];
    endXY: [number, number];
    color: number[];
    thickness: number;
  }>;
  text?: Array<{
    str: string;
    x: number;
    y: number;
    scale: number;
    color: number[];
    anchorX: number;
    anchorY: number;
    backColor?: number[];
  }>;
};

export type CompletedMeasurement = {
  startMM: [number, number, number];
  endMM: [number, number, number];
  distance: number;
  sliceIndex: number;
  sliceType: number;
  slicePosition: number;
};

export type CompletedAngle = {
  firstLine: {
    startMM: [number, number, number];
    endMM: [number, number, number];
  };
  secondLine: {
    startMM: [number, number, number];
    endMM: [number, number, number];
  };
  angle: number;
  sliceIndex: number;
  sliceType: number;
  slicePosition: number;
};

// ============================================================
// Load / Update Option Types
// ============================================================

/**
 * Options for loading a volume from a URL or File.
 * Supports any NVImage display properties as optional overrides.
 */
export type ImageFromUrlOptions = {
  /** URL or File pointing to the volume */
  url: string | File;
  /** URL or File for detached image data (e.g., AFNI .HEAD/.BRIK) */
  urlImageData?: string | File;
  /** Display name for this volume */
  name?: string;
  /** Colormap name (default: 'Gray') */
  colormap?: string;
  /** Colormap for negative intensities */
  colormapNegative?: string;
  /** Minimum intensity for negative color mapping (default: NaN = symmetric) */
  calMinNeg?: number;
  /** Maximum intensity for negative color mapping (default: NaN = symmetric) */
  calMaxNeg?: number;
  /** Colormap type: 0=min-to-max, 1=zero-to-max (transparent below), 2=zero-to-max (translucent below) */
  colormapType?: number;
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean;
  /** Maximum number of 4D frames to load (default: Infinity = load all). Remaining frames can be loaded later via loadDeferred4DVolumes(). */
  limitFrames4D?: number;
  /** Volume opacity 0-1 (default: 1) */
  opacity?: number;
  /** Minimum intensity for color mapping */
  calMin?: number;
  /** Maximum intensity for color mapping */
  calMax?: number;
  /** Alpha modulation amount */
  modulateAlpha?: number;
  /** Whether to show colorbar for this volume (default: true) */
  isColorbarVisible?: boolean;
};

/**
 * Options for loading a scalar overlay layer onto a mesh.
 */
export type MeshLayerFromUrlOptions = {
  /** URL or File pointing to the layer data */
  url: string | File;
  /** Display name for this layer */
  name?: string;
  /** Colormap name (default: 'warm') */
  colormap?: string;
  /** Colormap for negative intensities (set to enable negative colormap) */
  colormapNegative?: string;
  /** Minimum intensity for color mapping */
  calMin?: number;
  /** Maximum intensity for color mapping */
  calMax?: number;
  /** Negative colormap threshold (absolute value used; defaults to calMin) */
  calMinNeg?: number;
  /** Negative colormap maximum (absolute value used; defaults to calMax) */
  calMaxNeg?: number;
  /** Layer opacity 0-1 (default: 0.5) */
  opacity?: number;
  /** Whether to show colorbar for this layer (default: true) */
  isColorbarVisible?: boolean;
  /** Whether colormap lookup should be inverted */
  isColormapInverted?: boolean;
  /** Colormap type: 0=min-to-max, 1=zero-to-max (transparent below), 2=zero-to-max (translucent below). Default: 1. */
  colormapType?: number;
  /** Whether values below calMin are transparent (true) or clamped to min color (false). Only affects MIN_TO_MAX. Default: true. */
  isTransparentBelowCalMin?: boolean;
  /** Whether to use additive blending */
  isAdditiveBlend?: boolean;
  /** Outline width */
  outlineWidth?: number;
};

/**
 * Options for loading a mesh from a URL or File.
 */
export type MeshFromUrlOptions = {
  /** URL or File pointing to the mesh */
  url: string | File;
  /** Display name for this mesh */
  name?: string;
  /** Mesh opacity 0-1 (default: 1) */
  opacity?: number;
  /** RGBA color in 0-1 range (default: [1,1,1,1]) */
  color?: [number, number, number, number];
  /** @deprecated Use `color` instead. RGBA color in 0-255 range (converted internally). */
  rgba255?: [number, number, number, number];
  /** Whether to show colorbar (default: true) */
  isColorbarVisible?: boolean;
  /** Whether to show legend (default: false) */
  isLegendVisible?: boolean;
  /** Shader type (default: 'phong') */
  shaderType?: string;
  /** Whether mesh is visible (default: true) */
  visible?: boolean;
  /** Scalar overlay layers to load onto this mesh */
  layers?: MeshLayerFromUrlOptions[];
  /** Tract tessellation options (only used for tract file formats) */
  tractOptions?: Partial<NVTractOptions>;
  /** Connectome extrusion options (only used for connectome file formats) */
  connectomeOptions?: Partial<NVConnectomeOptions>;
};

/**
 * Display properties for updating a loaded volume.
 * Same shape as ImageFromUrlOptions minus load-only fields, plus frame4D.
 */
export type VolumeUpdate = Omit<
  ImageFromUrlOptions,
  "url" | "urlImageData" | "limitFrames4D"
> & {
  /** Set the current 4D frame index (0-based, clamped to valid range) */
  frame4D?: number;
};

/**
 * Display properties for updating a loaded mesh.
 * Same shape as MeshFromUrlOptions minus load-only fields.
 */
export type MeshUpdate = Omit<MeshFromUrlOptions, "url">;

// ============================================================
// Location / Callback Types
// ============================================================

export type NiiVueLocationValue = {
  name: string;
  value: number;
  id: string;
  mm: number[];
  vox: number[];
  /** Label name for atlas/parcellation volumes (when colormapLabel is set) */
  label?: string;
};

export type NiiVueLocation = {
  mm: number[];
  axCorSag: number;
  vox: number[];
  frac: number[];
  xy: [number, number];
  values: NiiVueLocationValue[];
  string: string;
};

export type NVFontData = {
  metrics: FontMetrics;
  atlasUrl: string;
};

export type SaveVolumeOptions = {
  /** Name of the output file (e.g. 'myimage.nii.gz'). If empty, returns data only. */
  filename?: string;
  /** Whether to save the drawing layer instead of the volume */
  isSaveDrawing?: boolean;
  /** Which volume layer to save (0 = background) */
  volumeByIndex?: number;
};

// ============================================================
// Vector Annotations
// ============================================================

export type AnnotationTool =
  | "freehand"
  | "ellipse"
  | "rectangle"
  | "line"
  | "arrow"
  | "measureEllipse"
  | "measureRect"
  | "measureLine"
  | "circle"
  | "measureCircle";

export type AnnotationStats = {
  area: number;
  min: number;
  mean: number;
  max: number;
  stdDev: number;
  length?: number;
};

export type AnnotationPoint = { x: number; y: number };

export type AnnotationStyle = {
  fillColor: [number, number, number, number];
  strokeColor: [number, number, number, number];
  strokeWidth: number;
};

export type PolygonWithHoles = {
  outer: AnnotationPoint[];
  holes: AnnotationPoint[][];
};

export type VectorAnnotation = {
  id: string;
  label: number;
  group: string;
  sliceType: number;
  slicePosition: number;
  anchorMM?: [number, number, number];
  polygons: PolygonWithHoles[];
  style: AnnotationStyle;
  stats?: AnnotationStats;
  shape?: {
    type: AnnotationTool;
    start: AnnotationPoint;
    end: AnnotationPoint;
    width?: number;
  };
};

export type AnnotationConfig = {
  isEnabled: boolean;
  activeLabel: number;
  activeGroup: string;
  brushRadius: number;
  isErasing: boolean;
  isVisibleIn3D: boolean;
  tool: AnnotationTool;
  style: AnnotationStyle;
};
