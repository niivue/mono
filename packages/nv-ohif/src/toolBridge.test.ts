import { describe, expect, it } from 'bun:test'
import { DRAG_MODE } from '@niivue/niivue'
import { ohifToolToAnnotationTool, ohifToolToDragMode } from './toolBridge'

describe('ohifToolToDragMode', () => {
  it.each([
    ['WindowLevel', DRAG_MODE.windowing],
    ['Pan', DRAG_MODE.pan],
    ['Zoom', DRAG_MODE.slicer3D],
    ['Angle', DRAG_MODE.angle],
    ['CobbAngle', DRAG_MODE.angle],
    ['Crosshairs', DRAG_MODE.crosshair],
    ['TrackballRotate', DRAG_MODE.crosshair],
  ] as const)('maps %s to the matching NiiVue drag mode', (tool, expected) => {
    expect(ohifToolToDragMode(tool)).toBe(expected)
  })

  it('uses crosshair navigation for unknown or inactive tools', () => {
    expect(ohifToolToDragMode(undefined)).toBe(DRAG_MODE.crosshair)
    expect(ohifToolToDragMode('ArrowAnnotate')).toBe(DRAG_MODE.crosshair)
  })

  it.each([
    'Length',
    'EllipticalROI',
    'RectangleROI',
    'CircleROI',
    'PlanarFreehandROI',
    'SplineROI',
    'LivewireContour',
    'Bidirectional',
    'ArrowAnnotate',
  ])('leaves annotation-backed %s to the annotation gate', (tool) => {
    expect(ohifToolToDragMode(tool)).toBe(DRAG_MODE.crosshair)
  })
})

describe('ohifToolToAnnotationTool', () => {
  it.each([
    ['Length', 'measureLine'],
    ['EllipticalROI', 'measureEllipse'],
    ['RectangleROI', 'measureRect'],
    ['CircleROI', 'measureCircle'],
    ['PlanarFreehandROI', 'freehand'],
    ['SplineROI', 'measureSpline'],
    ['LivewireContour', 'measureLivewire'],
    ['Bidirectional', 'measureBidirectional'],
    ['ArrowAnnotate', 'arrow'],
  ] as const)('maps %s to the NiiVue annotation tool %s', (tool, expected) => {
    expect(ohifToolToAnnotationTool(tool)).toBe(expected)
  })

  it('returns null for non-annotation tools', () => {
    expect(ohifToolToAnnotationTool('Pan')).toBeNull()
    expect(ohifToolToAnnotationTool(undefined)).toBeNull()
  })
})
