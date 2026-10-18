import { type AnnotationTool, DRAG_MODE } from '@niivue/niivue'

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
  switch (tool) {
    case 'Length':
      // A two-point measured line (in-plane mm length). Unifies OHIF's ruler
      // onto the same annotation system as the ROI tools (was a separate
      // measurement drag mode).
      return 'measureLine'
    case 'EllipticalROI':
      return 'measureEllipse'
    case 'RectangleROI':
      return 'measureRect'
    case 'CircleROI':
      return 'measureCircle'
    case 'PlanarFreehandROI':
      // freehand has no measure variant (no area/mean); draws the contour only.
      return 'freehand'
    case 'SplineROI':
      // Multi-click closed spline contour with area/mean stats.
      return 'measureSpline'
    case 'LivewireContour':
      // Multi-click edge-snapping contour with area/mean stats.
      return 'measureLivewire'
    case 'Bidirectional':
      // Two perpendicular measured axes (long + short diameters).
      return 'measureBidirectional'
    case 'ArrowAnnotate':
      return 'arrow'
    default:
      return null
  }
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
