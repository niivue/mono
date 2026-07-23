import { describe, expect, it } from 'bun:test'
import { DRAG_MODE } from '@niivue/niivue'
import { ohifToolToDragMode } from './toolBridge'

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
