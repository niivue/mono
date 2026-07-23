import { DRAG_MODE } from '@niivue/niivue'

/** Map an OHIF primary tool name to NiiVue's matching left-drag mode. */
export function ohifToolToDragMode(tool: string | undefined): number {
  switch (tool) {
    case 'WindowLevel':
      return DRAG_MODE.windowing
    case 'Pan':
      return DRAG_MODE.pan
    case 'Zoom':
      return DRAG_MODE.slicer3D
    case 'Length':
    case 'Bidirectional':
      return DRAG_MODE.measurement
    case 'Angle':
    case 'CobbAngle':
      return DRAG_MODE.angle
    case 'RectangleROI':
    case 'EllipticalROI':
    case 'CircleROI':
      return DRAG_MODE.roiSelection
    default:
      // NiiVue's render tile rotates on primary drag independently of the 2D
      // drag mode. Unknown OHIF tools retain safe crosshair navigation in 2D.
      return DRAG_MODE.crosshair
  }
}
