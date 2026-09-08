export const NUM_CLIP_PLANE = 6
export const DEFAULT_CLIP_PLANE = [0, 0, 0, 2] as const

export enum COLORMAP_TYPE {
  MIN_TO_MAX = 0,
  ZERO_TO_MAX_TRANSPARENT_BELOW_MIN = 1,
  ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN = 2,
}

export enum DRAG_MODE {
  none = 0,
  contrast = 1,
  measurement = 2,
  pan = 3,
  slicer3D = 4,
  callbackOnly = 5,
  roiSelection = 6,
  angle = 7,
  crosshair = 8,
  windowing = 9,
}

/**
 * How the 3D volume ray-march combines the samples along a ray.
 *
 * COMPOSITE is the classic emission-absorption OVER accumulation: nearer
 * samples occlude farther ones, so the result reads as a solid, depth-ordered
 * object. MAXIMUM keeps the single brightest sample per ray instead (maximum-
 * intensity projection) — depth ordering is discarded, which is what makes a
 * sparse bright structure (vessels in an angiogram, labelled structures in a
 * fluorescence stack) visible through everything in front of it.
 *
 * Applies to the 3D render only; a 2D slice draws one plane, where the two
 * modes are identical.
 *
 * MAXIMUM on a CHUNKED (streamed) volume additionally assumes a black
 * background. The per-chunk cube draws are merged with a component-wise MAX
 * blend so the result is independent of chunk draw order, and that max also
 * applies against whatever the tile was cleared to — so a non-black
 * `backColor` is itself a lower bound on every pixel of the cube and washes
 * the projection out. Non-chunked MAXIMUM composites normally and is
 * unaffected. See `_drawChunkedVolume` in gl/render.ts and the
 * `pipelineChunkedMip` variant in wgpu/render.ts.
 */
export enum VOLUME_RENDER_MODE {
  COMPOSITE = 0,
  MAXIMUM = 1,
}

/**
 * Which stencil estimates the in-shader LAYER gradient, used by the overlay and
 * drawing ray-march passes to light a layer from its own normals. This is NOT
 * the background volume's gradient: that one is precomputed into a texture, so
 * it is unaffected by this setting.
 *
 * Mean angular error against an analytic sphere (4000 near-uniform directions):
 * CENTRAL 0.80 deg, SOBEL8 0.68, BLOB 0.20. All three are exact on the axes,
 * face diagonals, and body diagonals alike -- those are symmetry directions of
 * both the stencils and the sphere -- so the error lives in the generic
 * directions between them and shows as a smooth angular ripple, not as facets.
 *
 * CENTRAL is the default because it is what NiiVue has always drawn. The
 * accuracy difference is real but sub-degree, which does not survive a matcap
 * lookup on smooth overlays; reach for BLOB on thin or high-curvature
 * structure, where a half-degree of normal error lands a specular highlight
 * next to a feature instead of on it.
 */
export enum LAYER_GRADIENT_MODE {
  /** Legacy 6-tap central difference at a hand-tuned 1.5-voxel offset: 3 axes, no diagonals. */
  CENTRAL = 0,
  /** Derivative of a Gaussian blob reconstruction: folded axis taps plus a body-diagonal shell. */
  BLOB = 1,
  /** The 8-corner Sobel the old niivue (niivue/niivue) precomputes with: 4 body diagonals, no axes. */
  SOBEL8 = 2,
}

export enum SHOW_RENDER {
  NEVER = 0,
  ALWAYS = 1,
  AUTO = 2,
}

export const NiiIntentCode = Object.freeze({
  NIFTI_INTENT_NONE: 0,
  NIFTI_INTENT_CORREL: 2,
  NIFTI_INTENT_TTEST: 3,
  NIFTI_INTENT_FTEST: 4,
  NIFTI_INTENT_ZSCORE: 5,
  NIFTI_INTENT_LABEL: 1002,
  NIFTI_INTENT_NEURONAMES: 1005,
  NIFTI_INTENT_RGB_VECTOR: 2003,
} as const)

export const NiiDataType = Object.freeze({
  DT_NONE: 0,
  DT_BINARY: 1,
  DT_UINT8: 2,
  DT_INT16: 4,
  DT_INT32: 8,
  DT_FLOAT32: 16,
  DT_COMPLEX64: 32,
  DT_FLOAT64: 64,
  DT_RGB24: 128,
  DT_INT8: 256,
  DT_UINT16: 512,
  DT_UINT32: 768,
  DT_INT64: 1024,
  DT_UINT64: 1280,
  DT_FLOAT128: 1536,
  DT_COMPLEX128: 1792,
  DT_COMPLEX256: 2048,
  DT_RGBA32: 2304,
} as const)

/** Check whether a volume is PAQD (Probabilistic Atlas Quad Datatype) */
export function isPaqd(hdr: {
  intent_code: number
  datatypeCode: number
}): boolean {
  return (
    hdr.intent_code === NiiIntentCode.NIFTI_INTENT_LABEL &&
    hdr.datatypeCode === NiiDataType.DT_RGBA32
  )
}

export const MULTIPLANAR_TYPE = {
  0: 'AUTO',
  1: 'COLUMN',
  2: 'GRID',
  3: 'ROW',
  AUTO: 0,
  COLUMN: 1,
  GRID: 2,
  ROW: 3,
} as const

export const SLICE_TYPE = Object.freeze({
  AXIAL: 0,
  CORONAL: 1,
  SAGITTAL: 2,
  MULTIPLANAR: 3,
  RENDER: 4,
  // No spatial view: skip the slice/render pass entirely and hand the whole
  // canvas to the signal graph (or leave it blank if no graph is shown). Lets a
  // signal+volume scene (e.g. a 4D BOLD time-course) use all screen real-estate
  // for the plot without unloading the volume. See NVModel.isSpatialViewHidden().
  NONE: 5,
} as const)

/** Accepted range for scene.gamma. 1 is the neutral no-op. */
export const GAMMA_RANGE: [number, number] = [0.1, 10]

/**
 * Shader exponent for a user-facing display gamma: the shaders raise the
 * classified RGB to this power, so gamma > 1 brightens (pow(rgb, 1/gamma) on a
 * value in [0,1] moves it toward 1). Clamped away from 0 so a slider dragged to
 * its floor cannot produce a division by zero or an infinite exponent.
 */
export function invGamma(gamma: number): number {
  if (!Number.isFinite(gamma)) return 1
  return 1 / Math.min(Math.max(gamma, GAMMA_RANGE[0]), GAMMA_RANGE[1])
}

/**
 * Accepted range for volume.lodBrightnessCompensation. 0 disables it. Shares
 * the range of LOD_OPACITY_RANGE so the two settings obey one rule.
 */
export const LOD_BRIGHTNESS_RANGE: [number, number] = [0, 1]

/**
 * COARSE BRICKS LOOK TOO DARK -> raise the coefficient. That is the whole rule;
 * the rest is why.
 *
 * Shader exponent that compensates the brightness a coarse pyramid brick loses
 * relative to the finest level, for a brick whose linear downsample factor is
 * `downsample` (see `chunkLodDownsample`).
 *
 * Downsampling averages voxels, which destroys the correlation between a
 * sample's colour and its opacity; since front-to-back compositing weights
 * colour by opacity, the coarse brick integrates darker than the fine data it
 * stands in for. Each pyramid level averages a fixed 2x2x2 neighbourhood, so
 * the correlation is lost one comparable step PER LEVEL: the exponent falls
 * below 1 (which brightens) in proportion to `log2(downsample)`.
 *
 * Growing it with `downsample - 1` instead - as this did until the deep-level
 * measurements below - assumes level 4 loses eight times what level 1 does.
 * Nothing about averaging works that way, and on a seven-level pyramid it ran
 * away: the level-4 bricks and the whole-volume coarse floor both hit the 0.25
 * clamp at the default coefficient, so a LOD boundary that should have been
 * invisible read as a hard step with the COARSE side far too BRIGHT, and the
 * floor flashed pale every time a refocus swapped the plan.
 *
 * This is still an EMPIRICAL heuristic, not a derivation: the true deficit
 * depends on the intensity variance inside each coarse voxel, which is
 * data-dependent, and no single global exponent nulls it everywhere. What the
 * per-level form buys is that the correction stays monotonic and gentle over
 * the whole useful range instead of saturating, so the coefficient is safe to
 * turn up on data that needs more. Set it to 0 to disable it.
 *
 * Useful magnitudes are SMALL: the default is 0.08 per level and 0.2 is already
 * strong. The returned exponent is floored at 0.25 so a deep level cannot blow
 * out, which is why the accepted range runs to 1 without the top end being
 * useful.
 * Applies only to a multi-LOD chunked volume; on anything else it is an exact
 * no-op (ask `nv.lodCompensation()` whether it is doing anything).
 */
export function lodGammaExponent(
  downsample: number,
  coefficient: number,
): number {
  if (!Number.isFinite(downsample) || !Number.isFinite(coefficient)) return 1
  if (downsample <= 1 || coefficient <= 0) return 1
  const beta = Math.min(coefficient, LOD_BRIGHTNESS_RANGE[1])
  // Floored so a brick from a very deep pyramid level cannot be blown out.
  return Math.max(0.25, 1 - beta * Math.log2(downsample))
}

/** Accepted range for volume.lodOpacityCompensation. 0 disables it. */
export const LOD_OPACITY_RANGE: [number, number] = [0, 1]

/** Ceiling on the returned scale, so a deep pyramid level cannot go fully opaque. */
const LOD_OPACITY_MAX_SCALE = 8

/**
 * COARSE BRICKS LOOK TOO TRANSPARENT (not too dark) -> raise the coefficient.
 * If they look too dark, use `lodGammaExponent` instead. That is the whole
 * rule; the rest is why.
 *
 * Multiplier on a coarse brick's step-size opacity exponent, for a brick whose
 * linear downsample factor is `downsample` (see `chunkLodDownsample`).
 *
 * The ray-march already corrects for a coarse brick taking fewer, longer steps:
 * each sample's alpha is raised to the number of reference steps it stands for,
 * `a' = 1 - (1-a)^k`. That is exact only if the coarse voxel is HOMOGENEOUS.
 * It is not: the true transmittance through the k fine voxels it replaces is
 * `prod(1-a_i)`, and since `log(1-a)` is concave that product is SMALLER than
 * `(1-mean(a))^k`. So a coarse brick is systematically too see-through, by an
 * amount set by the intensity variance inside the coarse voxel. This scales the
 * exponent by `1 + c*(k-1)` to push it back.
 *
 * DEFAULT 0 (off), and that is a measured choice, not an oversight. Simulating
 * the march over a real OME-Zarr pyramid says the variance term is ~0 wherever
 * the structure is dense enough to saturate the ray: those regions already
 * integrate the right alpha, and inflating it only front-loads the march onto
 * the nearer, dimmer samples, which makes the accumulated COLOUR worse. Over
 * four probe regions, raising `c` from 0 to 0.5 cut mean alpha error from 6.7%
 * to 5.1% while driving colour error from 15.3% to 25.7%. Only sparse, thin
 * material has a real alpha deficit, and no single global scale recovers much
 * of it (a -30% deficit improves to -30.6% at c=0.5) because the correction
 * needs the per-voxel variance that mean-downsampling threw away.
 *
 * It is exposed because the trade is data-dependent: a volume that is mostly
 * thin structure gets more from the alpha than it loses on the colour. Use
 * `volumeLodBrightnessCompensation` first; reach for this only if coarse bricks
 * still look too transparent rather than too dark.
 *
 * Ray-march only. A 2D slice tile shows ONE sample with no accumulation, so
 * there is no aggregated alpha to correct there. Applies only to a multi-LOD
 * chunked volume; on anything else it is an exact no-op (ask
 * `nv.lodCompensation()` whether it is doing anything).
 */
export function lodOpacityScale(
  downsample: number,
  coefficient: number,
): number {
  if (!Number.isFinite(downsample) || !Number.isFinite(coefficient)) return 1
  if (downsample <= 1 || coefficient <= 0) return 1
  const c = Math.min(coefficient, LOD_OPACITY_RANGE[1])
  return Math.min(LOD_OPACITY_MAX_SCALE, 1 + c * (downsample - 1))
}

/** Maps AXIAL→2, CORONAL→1, SAGITTAL→0 (the RAS dimension perpendicular to the slice). */
export function sliceTypeDim(sliceType: number): number {
  if (sliceType === SLICE_TYPE.CORONAL) return 1
  if (sliceType === SLICE_TYPE.SAGITTAL) return 0
  return 2
}

import type {
  AnnotationConfig,
  DrawConfig,
  InteractionConfig,
  LayoutConfig,
  MeshRenderConfig,
  UIConfig,
  VolumeRenderConfig,
} from '@/NVTypes'

// NVD document format version. Lives here (pure, importable everywhere) so the
// legacy converter can stamp it without importing NVDocument's Vite module graph.
// See NVDocument for the version history / migration notes.
export const NVD_DOCUMENT_VERSION = 9

// Default scene values. The scene group is built with gl-matrix vec types in
// NVModel, so this holds the plain-value defaults (used both to construct the
// model and to decide which scene settings a sparse document omits).
export const SCENE_DEFAULTS = {
  azimuth: 110,
  elevation: 10,
  crosshairPos: [0.5, 0.5, 0.5] as [number, number, number],
  pan2Dxyzmm: [0, 0, 0, 1] as [number, number, number, number],
  scaleMultiplier: 1.0,
  renderPan: [0, 0] as [number, number],
  gamma: 1.0,
  backgroundColor: [0, 0, 0, 1] as [number, number, number, number],
  clipPlaneColor: [0.7, 0, 0.7, 0.4] as [number, number, number, number],
  isClipPlaneCutaway: false,
  clipPlaneOverlay: false,
}

export const LAYOUT_DEFAULTS: LayoutConfig = {
  sliceType: SLICE_TYPE.MULTIPLANAR,
  mosaicString: '',
  showRender: SHOW_RENDER.AUTO,
  multiplanarType: MULTIPLANAR_TYPE.AUTO,
  heroFraction: 0,
  heroSliceType: SLICE_TYPE.RENDER as number,
  isEqualSize: false,
  isMosaicCentered: true,
  margin: 0,
  isRadiological: false,
  isSingleViewFillCanvas: true,
  customLayout: null,
}

export const UI_DEFAULTS: UIConfig = {
  isColorbarVisible: false,
  isOrientCubeVisible: true,
  isOrientationTextVisible: true,
  is3DCrosshairVisible: true,
  isGraphVisible: false,
  isRulerVisible: false,
  isCrossLinesVisible: false,
  isLegendVisible: true,
  isPositionInMM: false,
  isMeasureUnitsVisible: true,
  isMeasurementDrawn: true,
  isAnnotationDrawn: true,
  isThumbnailVisible: false,
  thumbnailUrl: '',
  placeholderText: 'No image loaded',
  crosshairColor: [1.0, 0, 0, 1.0],
  crosshairGap: 10,
  crosshairWidth: 2,
  fontColor: [0.5, 0.5, 0.5, 1],
  fontScale: 0.4,
  fontMinSize: 13,
  selectionBoxColor: [1, 1, 1, 0.5],
  measureLineColor: [1, 0, 0, 1],
  measureTextColor: [1, 0, 0, 1],
  rulerWidth: 2,
  graph: {
    normalizeValues: false,
    isRangeCalMinMax: false,
    showVolumeTimecourse: true,
    lineWidth: 1,
    lineAlpha: 1,
    autoResetView: true,
  },
}

export const VOLUME_DEFAULTS: VolumeRenderConfig = {
  illumination: 0.0,
  outlineWidth: 0,
  alphaShader: 1,
  isBackgroundMasking: false,
  isAlphaClipDark: false,
  isColormapAlphaOn2D: false,
  isNearestInterpolation: false,
  isV1SliceShader: false,
  matcap: '',
  paqdUniforms: [0.01, 0.5, 0.25, 0.4] as [number, number, number, number],
  transmittanceCutoff: 0.95,
  renderMode: VOLUME_RENDER_MODE.COMPOSITE,
  layerGradientMode: LAYER_GRADIENT_MODE.CENTRAL,
  sampleRate: 2,
  isCubicInterpolation: false,
  lodBrightnessCompensation: 0.08,
  lodOpacityCompensation: 0,
  gradientOpacity: 0,
  silhouette: 0,
}

export const MESH_DEFAULTS: MeshRenderConfig = {
  xRay: 0,
  thicknessOn2D: Infinity,
}

export const DRAW_DEFAULTS: DrawConfig = {
  isEnabled: false,
  penValue: 1,
  penSize: 1,
  isFillOverwriting: true,
  opacity: 0.8,
  rimOpacity: -1,
  colormap: '_draw',
  isClickToSegment: false,
  clickToSegmentTolerance: 0.05,
  clickToSegmentIs2D: true,
}

export const INTERACTION_DEFAULTS: InteractionConfig = {
  primaryDragMode: DRAG_MODE.crosshair,
  secondaryDragMode: DRAG_MODE.contrast,
  isSnapToVoxelCenters: false,
  isDragDropEnabled: true,
  isYoked3DTo2DZoom: false,
  wheelZoomAnchor: 'crosshair',
}

export const ANNOTATION_DEFAULTS: AnnotationConfig = {
  isEnabled: false,
  activeLabel: 1,
  activeGroup: 'default',
  brushRadius: 2.0,
  mergesOverlaps: true,
  isErasing: false,
  isVisibleIn3D: false,
  tool: 'freehand',
  style: {
    fillColor: [1, 0, 0, 0.3],
    strokeColor: [1, 0, 0, 1],
    strokeWidth: 2,
  },
}
