import { type AnnotationTool, DRAG_MODE } from '@niivue/niivue'

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
  readout: 'none' | 'length' | 'bidirectional' | 'area'
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
    readout: 'area',
    contour: true,
  },
  // Multi-click edge-snapping contour with area/mean stats.
  measureLivewire: {
    toolName: 'LivewireContour',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'area',
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
  // freehand has no measure variant; any stats NiiVue attaches still show.
  freehand: {
    toolName: 'PlanarFreehandROI',
    valueType: POLYLINE_VALUE_TYPE,
    minPoints: 2,
    labelPrefix: 'ROI',
    readout: 'area',
    contour: true,
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
    case 'Angle':
    case 'CobbAngle':
      return DRAG_MODE.angle
    default:
      // NiiVue's render tile rotates on primary drag independently of the 2D
      // drag mode. Unknown OHIF tools retain safe crosshair navigation in 2D.
      return DRAG_MODE.crosshair
  }
}
