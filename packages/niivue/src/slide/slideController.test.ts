import { describe, expect, test } from 'bun:test'
import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide } from './NVSlide'
import { NVSlideController } from './slideController'

// No DOM in bun tests: an EventTarget canvas and a slide whose screen and
// slide coordinates coincide.
function rig(options: { primary?: DRAG_MODE; secondary?: DRAG_MODE } = {}) {
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }) as unknown as HTMLCanvasElement
  const pans: number[][] = []
  const zooms: number[] = []
  const slide = {
    screenToSlide: (x: number, y: number) => ({ x, y }),
    panByScreenDelta: (dx: number, dy: number) => pans.push([dx, dy]),
    zoomBy: (factor: number) => zooms.push(factor),
  } as unknown as NVSlide
  const crosshairs: number[][] = []
  const windows: Array<[number, number, boolean]> = []
  const boxes: unknown[] = []
  const ctl = new NVSlideController(canvas, {
    slide: () => slide,
    screen: () => ({ widthCss: 100, heightCss: 100 }),
    primaryDragMode: options.primary,
    secondaryDragMode: options.secondary,
    onCrosshair: (p) => crosshairs.push([p.x, p.y]),
    onWindow: (dx, dy, done) => windows.push([dx, dy, done]),
    onContrast: (box) => boxes.push(box),
  })
  const fire = (type: string, x: number, y: number, button = 0) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type), {
        clientX: x,
        clientY: y,
        button,
        pointerId: 1,
        deltaY: -100,
      }),
    )
  return { ctl, fire, pans, zooms, crosshairs, windows, boxes }
}

describe('NVSlideController', () => {
  test('crosshairPan: a click places the crosshair, a drag pans', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 11, 10)
    expect(r.crosshairs).toEqual([[10, 10]])
    r.fire('pointerdown', 10, 10)
    r.fire('pointermove', 20, 10)
    r.fire('pointermove', 25, 12)
    r.fire('pointerup', 25, 12)
    expect(r.pans).toEqual([
      [10, 0],
      [5, 2],
    ])
    expect(r.crosshairs).toHaveLength(1)
  })

  test('the secondary button has its own mode', () => {
    const r = rig({ secondary: DRAG_MODE.windowing })
    r.fire('pointerdown', 0, 0, 2)
    r.fire('pointermove', 10, -5, 2)
    r.fire('pointerup', 10, -5, 2)
    expect(r.windows).toEqual([
      [10, -5, false],
      [0, 0, true],
    ])
    expect(r.pans).toEqual([])
  })

  test('crosshair follows a drag; an unsupported mode does nothing', () => {
    const r = rig({ primary: DRAG_MODE.crosshair })
    r.fire('pointerdown', 1, 1)
    r.fire('pointermove', 9, 9)
    r.fire('pointerup', 9, 9)
    expect(r.crosshairs).toEqual([
      [1, 1],
      [9, 9],
    ])
    r.ctl.primaryDragMode = DRAG_MODE.slicer3D
    r.fire('pointerdown', 1, 1)
    r.fire('pointermove', 30, 30)
    r.fire('pointerup', 30, 30)
    expect(r.crosshairs).toHaveLength(2)
    expect(r.pans).toEqual([])
  })

  test('measurement keeps a ruler in slide pixels; a click adds none', () => {
    const r = rig({ primary: DRAG_MODE.measurement })
    r.fire('pointerdown', 5, 5)
    r.fire('pointerup', 5, 5)
    r.fire('pointerdown', 5, 5)
    r.fire('pointermove', 40, 5)
    expect(r.ctl.activeMeasurement).toEqual({
      start: { x: 5, y: 5 },
      end: { x: 40, y: 5 },
    })
    r.fire('pointerup', 40, 5)
    expect(r.ctl.measurements).toEqual([
      { start: { x: 5, y: 5 }, end: { x: 40, y: 5 } },
    ])
    expect(r.ctl.activeMeasurement).toBeNull()
  })

  test('contrast selects a box and reports it on release', () => {
    const r = rig({ primary: DRAG_MODE.contrast })
    r.fire('pointerdown', 2, 3)
    r.fire('pointermove', 20, 30)
    expect(r.ctl.selection).toEqual({
      start: { x: 2, y: 3 },
      end: { x: 20, y: 30 },
    })
    r.fire('pointerup', 20, 30)
    expect(r.boxes).toEqual([{ start: { x: 2, y: 3 }, end: { x: 20, y: 30 } }])
    expect(r.ctl.selection).toBeNull()
  })

  test('the wheel zooms', () => {
    const r = rig()
    r.fire('wheel', 0, 0)
    expect(r.zooms[0]).toBeGreaterThan(1)
  })
})
