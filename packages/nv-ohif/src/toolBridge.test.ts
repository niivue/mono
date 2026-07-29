import { describe, expect, it } from 'bun:test'
import { DRAG_MODE } from '@niivue/niivue'
import {
  ohifToolToAnnotationTool,
  ohifToolToDragMode,
  UNSUPPORTED_MEASUREMENT_TOOLS,
} from './toolBridge'

describe('ohifToolToDragMode', () => {
  it.each([
    ['WindowLevel', DRAG_MODE.windowing],
    ['Pan', DRAG_MODE.pan],
    ['Zoom', DRAG_MODE.slicer3D],
    ['Length', DRAG_MODE.measurement],
    ['Bidirectional', DRAG_MODE.measurement],
    ['Angle', DRAG_MODE.angle],
    ['CobbAngle', DRAG_MODE.angle],
    ['RectangleROI', DRAG_MODE.roiSelection],
    ['EllipticalROI', DRAG_MODE.roiSelection],
    ['CircleROI', DRAG_MODE.roiSelection],
    ['Crosshairs', DRAG_MODE.crosshair],
    ['TrackballRotate', DRAG_MODE.crosshair],
  ] as const)('maps %s to the matching NiiVue drag mode', (tool, expected) => {
    expect(ohifToolToDragMode(tool)).toBe(expected)
  })

  it('uses crosshair navigation for unknown or inactive tools', () => {
    expect(ohifToolToDragMode(undefined)).toBe(DRAG_MODE.crosshair)
    expect(ohifToolToDragMode('ArrowAnnotate')).toBe(DRAG_MODE.crosshair)
  })
})

describe('ohifToolToAnnotationTool', () => {
  it.each([
    ['EllipticalROI', 'measureEllipse'],
    ['RectangleROI', 'measureRect'],
    ['CircleROI', 'measureCircle'],
    ['PlanarFreehandROI', 'freehand'],
    ['SplineROI', 'measureSpline'],
    ['LivewireContour', 'measureLivewire'],
    ['ArrowAnnotate', 'arrow'],
  ] as const)('maps %s to the NiiVue annotation tool %s', (tool, expected) => {
    expect(ohifToolToAnnotationTool(tool)).toBe(expected)
  })

  it('returns null for non-annotation tools', () => {
    expect(ohifToolToAnnotationTool('Length')).toBeNull()
    expect(ohifToolToAnnotationTool('Pan')).toBeNull()
    expect(ohifToolToAnnotationTool(undefined)).toBeNull()
  })

  it('lists the tools NiiVue cannot back yet as unsupported', () => {
    // Only Bidirectional remains unbacked.
    expect(UNSUPPORTED_MEASUREMENT_TOOLS.has('Bidirectional')).toBe(true)
    expect(UNSUPPORTED_MEASUREMENT_TOOLS.has('SplineROI')).toBe(false)
    expect(UNSUPPORTED_MEASUREMENT_TOOLS.has('LivewireContour')).toBe(false)
    expect(UNSUPPORTED_MEASUREMENT_TOOLS.has('EllipticalROI')).toBe(false)
  })
})
