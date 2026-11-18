import { describe, expect, it } from 'bun:test'
import NiiVue, { DRAG_MODE, type VectorAnnotation } from '@niivue/niivue'
import {
  measureFreehand,
  ohifToolToAnnotationTool,
  ohifToolToDragMode,
} from './toolBridge'

describe('ohifToolToDragMode', () => {
  it.each([
    ['WindowLevel', DRAG_MODE.windowing],
    ['Pan', DRAG_MODE.pan],
    ['Zoom', DRAG_MODE.slicer3D],
    ['StackScroll', DRAG_MODE.slice],
    ['WindowLevelRegion', DRAG_MODE.contrast],
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
    ['Length', 'measureLine'],
    ['EllipticalROI', 'measureEllipse'],
    ['RectangleROI', 'measureRect'],
    ['RectangleROIStartEndThreshold', 'measureRect'],
    ['CircleROI', 'measureCircle'],
    ['PlanarFreehandROI', 'freehand'],
    ['SplineROI', 'measureSpline'],
    ['LivewireContour', 'measureLivewire'],
    ['Bidirectional', 'measureBidirectional'],
    ['ArrowAnnotate', 'arrow'],
    ['Angle', 'measureAngle'],
    ['CobbAngle', 'measureCobbAngle'],
  ] as const)('maps %s to the NiiVue annotation tool %s', (tool, expected) => {
    expect(ohifToolToAnnotationTool(tool)).toBe(expected)
  })

  it('returns null for non-annotation tools', () => {
    expect(ohifToolToAnnotationTool('Pan')).toBeNull()
    expect(ohifToolToAnnotationTool(undefined)).toBeNull()
  })
})

// PlanarFreehandROI rows need area and stats (cornerstone reports both).
it('measureFreehand gives a NiiVue freehand ROI area and mean', async () => {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [3, 8, 8, 1].entries()) hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 2, true)
  hdr.setInt16(72, 8, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true)
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  await nv.loadVolumes([
    { url: new File([hdr.buffer, new Uint8Array(64).fill(5)], 'f.nii') },
  ])
  const square = [
    { x: 1, y: 1 },
    { x: 5, y: 1 },
    { x: 5, y: 5 },
    { x: 1, y: 5 },
  ]
  const a = {
    id: 'f',
    label: 1,
    group: 'm',
    sliceType: 0,
    slicePosition: 0,
    polygons: [{ outer: square, holes: [] }],
    style: nv.annotationStyle,
  } as unknown as VectorAnnotation
  measureFreehand(nv, a)
  expect(a.stats?.mean).toBe(5)
  expect(a.stats?.area).toBeGreaterThan(0)
})
