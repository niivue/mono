import type NiiVue from '@niivue/niivue'
import {
  type AnnotationChangedDetail,
  type AnnotationTool,
  computeAnnotationStats,
  DRAG_MODE,
  type SlideAnnotationTool,
  type VectorAnnotation,
} from '@niivue/niivue'

// OHIF value types (literals, so we do not depend on measurementService.VALUE_TYPES
// being present at runtime).
const POLYLINE_VALUE_TYPE = 'value_type::polyline'
const ELLIPSE_VALUE_TYPE = 'value_type::ellipse'
const CIRCLE_VALUE_TYPE = 'value_type::circle'
const POINT_VALUE_TYPE = 'value_type::point'
const BIDIRECTIONAL_VALUE_TYPE = 'value_type::bidirectional'

export interface AnnotationToolDescriptor {
  /** OHIF measurement tool. */
  toolName: string
  valueType: string
  minPoints?: number
  /** Registered point count, when OHIF's mapping matches on it. */
  points?: number
  /** Default label noun: an arrow is not an ROI, and a Length/Bidirectional is
   * a line, not a region (round-3 R3-3). */
  labelPrefix: string
  /** Panel row content: none (label only), length / bidirectional (mm), or
   * area + intensity. */
  readout:
    | 'none'
    | 'length'
    | 'bidirectional'
    | 'area'
    | 'areaOnly'
    | 'value'
    | 'angle'
  /** Points come from the single polygon ring, not shape endpoints. */
  contour?: true
}

/**
 * The tool registry: NiiVue annotation tool -> OHIF measurement tool and how
 * its row is labelled and displayed. Only the tools nv-ohif activates are
 * listed; measureLine doubles as OHIF's Length.
 */
export const ANNOTATION_TO_OHIF: Record<string, AnnotationToolDescriptor> = {
  measureEllipse: {
    toolName: 'EllipticalROI',
    valueType: ELLIPSE_VALUE_TYPE,
    minPoints: 4,
    labelPrefix: 'ROI',
    readout: 'area',
  },
  // OHIF's Rectangle mapping uses the polyline value type.
  measureRect: {
    toolName: 'RectangleROI',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 4,
    labelPrefix: 'ROI',
    readout: 'area',
  },
  measureCircle: {
    toolName: 'CircleROI',
    valueType: CIRCLE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'area',
  },
  // A two-point measured line (in-plane mm length), on the same annotation
  // system as the ROI tools.
  measureLine: {
    toolName: 'Length',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    points: 2,
    labelPrefix: 'Length',
    readout: 'length',
  },
  // Multi-click closed spline contour with area/mean stats.
  measureSpline: {
    toolName: 'SplineROI',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'areaOnly',
    contour: true,
  },
  // Multi-click edge-snapping contour with area/mean stats.
  measureLivewire: {
    toolName: 'LivewireContour',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'areaOnly',
    contour: true,
  },
  // Two perpendicular measured axes (long + short diameters).
  measureBidirectional: {
    toolName: 'Bidirectional',
    valueType: BIDIRECTIONAL_VALUE_TYPE,
    minPoints: 4,
    labelPrefix: 'Bidirectional',
    readout: 'bidirectional',
  },
  // freehand has no measure variant: measureFreehand gives it ROI stats.
  freehand: {
    toolName: 'PlanarFreehandROI',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'area',
    contour: true,
  },
  // A click reads the base value at that voxel.
  measurePoint: {
    toolName: 'Probe',
    valueType: POINT_VALUE_TYPE,
    minPoints: 1,
    points: 1,
    labelPrefix: 'Probe',
    readout: 'value',
  },
  // Three clicks: the angle at the middle one.
  measureAngle: {
    toolName: 'Angle',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 3,
    points: 3,
    labelPrefix: 'Angle',
    readout: 'angle',
  },
  // Four clicks, two lines: the acute angle between them.
  measureCobbAngle: {
    toolName: 'CobbAngle',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 4,
    points: 4,
    labelPrefix: 'Cobb Angle',
    readout: 'angle',
  },
  arrow: {
    toolName: 'ArrowAnnotate',
    valueType: POINT_VALUE_TYPE,
    minPoints: 2,
    // ArrowAnnotate carries two handles (arrowhead + text tail); the registered
    // count must match the 2-point payload annotationPointsLps emits.
    points: 2,
    labelPrefix: 'Arrow',
    readout: 'none',
  },
}

/** OHIF brush tool -> pen mode (Sphere variants: 3D ball pen). */
export const OHIF_BRUSHES: Record<string, 'paint' | 'erase' | 'threshold'> = {
  CircularBrush: 'paint',
  SphereBrush: 'paint',
  CircularEraser: 'erase',
  SphereEraser: 'erase',
  ThresholdCircularBrush: 'threshold',
  ThresholdSphereBrush: 'threshold',
}

/** Every slide row's uid starts with this. */
export const SLIDE_UID_PREFIX = 'niivue-slide-'

/** OHIF measurement tool -> the slide annotation tool it draws with. */
export const OHIF_TO_SLIDE_TOOL: Record<string, SlideAnnotationTool> = {
  Length: 'line',
  Bidirectional: 'bidirectional',
  ArrowAnnotate: 'arrow',
  Probe: 'point',
  RectangleROI: 'rectangle',
  EllipticalROI: 'ellipse',
  CircleROI: 'circle',
  PlanarFreehandROI: 'freehand',
  SplineROI: 'polygon',
  LivewireContour: 'polygon',
}

const OHIF_TO_ANNOTATION = new Map(
  Object.entries(ANNOTATION_TO_OHIF).map(([tool, { toolName }]) => [
    toolName,
    tool as AnnotationTool,
  ]),
)

/**
 * Map an OHIF measurement tool to a NiiVue vector-annotation tool. Returns null
 * for tools that are not annotation-backed (handled as drag modes instead).
 * Setting `nv.annotationTool` to the result + `nv.annotationIsEnabled = true`
 * makes a left-drag on a 2D slice draw the shape; the measure* variants also
 * compute ROI stats (area/mean) and fire `annotationAdded` with them.
 */
export function ohifToolToAnnotationTool(
  tool: string | undefined,
): AnnotationTool | null {
  // TMTV's threshold ROI is a rectangle; its slab and threshold live in petQuant.
  if (tool === 'RectangleROIStartEndThreshold') return 'measureRect'
  return (tool && OHIF_TO_ANNOTATION.get(tool)) || null
}

/** Map an OHIF primary tool name to NiiVue's matching left-drag mode. */
export function ohifToolToDragMode(tool: string | undefined): number {
  switch (tool) {
    case 'WindowLevel':
      return DRAG_MODE.windowing
    case 'Pan':
      return DRAG_MODE.pan
    case 'Zoom':
      return DRAG_MODE.slicer3D
    case 'StackScroll':
      return DRAG_MODE.slice
    // NiiVue's contrast box: window from the enclosed voxels' min/max (shown
    // frame, scaled values), as OHIF's region W/L does.
    case 'WindowLevelRegion':
      return DRAG_MODE.contrast
    default:
      // NiiVue's render tile rotates on primary drag independently of the 2D
      // drag mode. Unknown OHIF tools retain safe crosshair navigation in 2D.
      return DRAG_MODE.crosshair
  }
}

/**
 * OHIF's PlanarFreehandROI reports area and intensity stats; a NiiVue freehand
 * annotation (no measure variant) has none: measure its polygons as an ROI.
 */
export function measureFreehand(nv: NiiVue, a: VectorAnnotation): void {
  const vol = nv.volumes[0]
  const p = a.polygons[0]?.outer[0]
  if (a.shape || !vol || !p) return
  a.stats =
    computeAnnotationStats(
      { ...a, shape: { type: 'freehand', start: p, end: p } },
      vol,
      nv.annotationAreaIsGeometric,
    ) ?? undefined
}

/**
 * Call `fn` with each annotation the user just drew (core's 'draw' action, not
 * a host's addAnnotation), as stored: a merge may have changed its polygons.
 * Returns the unsubscribe.
 */
export function onAnnotationsDrawn(
  nv: NiiVue,
  fn: (annotation: VectorAnnotation) => void,
): () => void {
  const listener = (e: Event) => {
    const { action, added } = (e as CustomEvent<AnnotationChangedDetail>).detail
    if (action !== 'draw') return
    for (const id of added) {
      const a = nv.annotations.find((x) => x.id === id)
      if (a) fn(a)
    }
  }
  nv.addEventListener('annotationChanged', listener)
  return () => nv.removeEventListener('annotationChanged', listener)
}

/**
 * An OHIF row's points for a rectangle or ellipse spanning corners `a` and
 * `b`: a rectangle's four corners; an ellipse's two axes as consecutive pairs,
 * vertical then horizontal (cornerstone's EllipticalROI reads point pairs as
 * axes, so interleaved points would make the box diagonals its axes).
 */
export function boxRowPoints(
  kind: 'rectangle' | 'ellipse',
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number }[] {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2]
  return kind === 'rectangle'
    ? [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ]
    : [
        { x: cx, y: y0 },
        { x: cx, y: y1 },
        { x: x0, y: cy },
        { x: x1, y: cy },
      ]
}
