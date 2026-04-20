export const NUM_CLIP_PLANE = 6;
export const DEFAULT_CLIP_PLANE = [0, 0, 0, 2] as const;

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
} as const);

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
} as const);

/** Check whether a volume is PAQD (Probabilistic Atlas Quad Datatype) */
export function isPaqd(hdr: {
  intent_code: number;
  datatypeCode: number;
}): boolean {
  return (
    hdr.intent_code === NiiIntentCode.NIFTI_INTENT_LABEL &&
    hdr.datatypeCode === NiiDataType.DT_RGBA32
  );
}

export const MULTIPLANAR_TYPE = {
  0: "AUTO",
  1: "COLUMN",
  2: "GRID",
  3: "ROW",
  AUTO: 0,
  COLUMN: 1,
  GRID: 2,
  ROW: 3,
} as const;

export const SLICE_TYPE = Object.freeze({
  AXIAL: 0,
  CORONAL: 1,
  SAGITTAL: 2,
  MULTIPLANAR: 3,
  RENDER: 4,
} as const);

/** Maps AXIAL→2, CORONAL→1, SAGITTAL→0 (the RAS dimension perpendicular to the slice). */
export function sliceTypeDim(sliceType: number): number {
  if (sliceType === SLICE_TYPE.CORONAL) return 1;
  if (sliceType === SLICE_TYPE.SAGITTAL) return 0;
  return 2;
}

import type {
  AnnotationConfig,
  DrawConfig,
  InteractionConfig,
  LayoutConfig,
  MeshRenderConfig,
  UIConfig,
  VolumeRenderConfig,
} from "@/NVTypes";

export const LAYOUT_DEFAULTS: LayoutConfig = {
  sliceType: SLICE_TYPE.MULTIPLANAR,
  mosaicString: "",
  showRender: SHOW_RENDER.AUTO,
  multiplanarType: MULTIPLANAR_TYPE.AUTO,
  heroFraction: 0,
  heroSliceType: SLICE_TYPE.RENDER as number,
  isEqualSize: false,
  isMosaicCentered: true,
  margin: 0,
  isRadiological: false,
};

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
  isThumbnailVisible: false,
  thumbnailUrl: "",
  placeholderText: "No image loaded",
  crosshairColor: [1.0, 0, 0, 1.0],
  crosshairGap: 10,
  crosshairWidth: 1,
  fontColor: [0.5, 0.5, 0.5, 1],
  fontScale: 0.4,
  fontMinSize: 13,
  selectionBoxColor: [1, 1, 1, 0.5],
  measureLineColor: [1, 0, 0, 1],
  measureTextColor: [1, 0, 0, 1],
  rulerWidth: 2,
  graph: { normalizeValues: false, isRangeCalMinMax: false },
};

export const VOLUME_DEFAULTS: VolumeRenderConfig = {
  illumination: 0.0,
  outlineWidth: 0,
  alphaShader: 1,
  isBackgroundMasking: false,
  isAlphaClipDark: false,
  isNearestInterpolation: false,
  isV1SliceShader: false,
  matcap: "",
  paqdUniforms: [0.01, 0.5, 0.25, 0.4] as [number, number, number, number],
};

export const MESH_DEFAULTS: MeshRenderConfig = {
  xRay: 0,
  thicknessOn2D: Infinity,
};

export const DRAW_DEFAULTS: DrawConfig = {
  isEnabled: false,
  penValue: 1,
  penSize: 1,
  isFillOverwriting: true,
  opacity: 0.8,
  rimOpacity: -1,
  colormap: "_draw",
};

export const INTERACTION_DEFAULTS: InteractionConfig = {
  primaryDragMode: DRAG_MODE.crosshair,
  secondaryDragMode: DRAG_MODE.contrast,
  isSnapToVoxelCenters: false,
  isDragDropEnabled: true,
  isYoked3DTo2DZoom: false,
};

export const ANNOTATION_DEFAULTS: AnnotationConfig = {
  isEnabled: false,
  activeLabel: 1,
  activeGroup: "default",
  brushRadius: 2.0,
  isErasing: false,
  isVisibleIn3D: false,
  tool: "freehand",
  style: {
    fillColor: [1, 0, 0, 0.3],
    strokeColor: [1, 0, 0, 1],
    strokeWidth: 2,
  },
};
