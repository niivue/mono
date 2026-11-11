import { describe, expect, test } from 'bun:test'
import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide, NVSlideViewport } from './NVSlide'
import { NVSlideController } from './slideController'

// No DOM in bun tests: an EventTarget canvas and a slide whose screen and
// slide coordinates coincide.
let captures = 0
function rig(
  options: {
    primary?: DRAG_MODE
    secondary?: DRAG_MODE
    devicePixelRatio?: number
    scale?: number
  } = {},
) {
  captures = 0
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {
      captures++
    },
    releasePointerCapture: () => {},
    hasPointerCapture: () => captures > 0,
  }) as unknown as HTMLCanvasElement
  const pans: number[][] = []
  const zooms: number[] = []
  const viewports: NVSlideViewport[] = []
  let clamps = 0
  const slide = {
    viewport: { centerX: 0, centerY: 0, scale: options.scale ?? 0.1 },
    screenToSlide: (x: number, y: number) => ({ x, y }),
    panByScreenDelta: (dx: number, dy: number) => pans.push([dx, dy]),
    zoomBy: (factor: number) => zooms.push(factor),
    setViewport: (v: NVSlideViewport) => viewports.push(v),
    clampViewport: () => clamps++,
  } as unknown as NVSlide
  const crosshairs: number[][] = []
  const windows: Array<[number, number, boolean]> = []
  const boxes: unknown[] = []
  const ctl = new NVSlideController(canvas, {
    slide: () => slide,
    screen: () => ({
      widthCss: 100,
      heightCss: 100,
      devicePixelRatio: options.devicePixelRatio,
    }),
    primaryDragMode: options.primary,
    secondaryDragMode: options.secondary,
    onCrosshair: (p) => crosshairs.push([p.x, p.y]),
    onWindow: (dx, dy, done) => windows.push([dx, dy, done]),
    onContrast: (box) => boxes.push(box),
  })
  const fire = (
    type: string,
    x: number,
    y: number,
    button = 0,
    wheel = { deltaY: -100, deltaMode: 0 },
    buttons = 1,
    pointerId = 1,
  ) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type), {
        clientX: x,
        clientY: y,
        button,
        buttons,
        pointerId,
        ...wheel,
      }),
    )
  return {
    ctl,
    fire,
    pans,
    zooms,
    crosshairs,
    windows,
    boxes,
    viewports,
    clamps: () => clamps,
    captures: () => captures,
  }
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

  test('roiSelection zooms the view to the dragged box', () => {
    const r = rig({ secondary: DRAG_MODE.roiSelection })
    r.fire('pointerdown', 10, 20, 2)
    r.fire('pointermove', 60, 40, 2)
    r.fire('pointermove', 210, 120, 2)
    expect(r.ctl.selection).toEqual({
      start: { x: 10, y: 20 },
      end: { x: 210, y: 120 },
    })
    r.fire('pointerup', 210, 120, 2)
    // 200 x 100 px box in a 100 x 100 pane: the narrower fit (x0.5) wins.
    expect(r.viewports).toEqual([{ centerX: 110, centerY: 70, scale: 0.5 }])
    expect(r.clamps()).toBe(1)
    expect(r.ctl.selection).toBeNull()
  })

  test('a small zoom box stops at one slide pixel per device pixel', () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, 1],
      [2, 0.5],
    ]
    for (const [dpr, scale] of cases) {
      const r = rig({ primary: DRAG_MODE.roiSelection, devicePixelRatio: dpr })
      r.fire('pointerdown', 10, 20)
      r.fire('pointermove', 30, 30)
      r.fire('pointerup', 30, 30)
      expect(r.viewports[0]?.scale).toBe(scale)
    }
  })

  test('a zoom box never zooms out', () => {
    // Small box past native resolution, and a box larger than the pane.
    for (const end of [30, 600]) {
      const r = rig({ primary: DRAG_MODE.roiSelection, scale: 4 })
      r.fire('pointerdown', 10, 20)
      r.fire('pointermove', end, end)
      r.fire('pointerup', end, end)
      expect(r.viewports[0]?.scale).toBe(4)
    }
  })

  test('a press released outside the canvas ends at the next move', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    // Back over the canvas with no button held: no pan, gesture over.
    r.fire('pointermove', 40, 10, 0, undefined, 0)
    r.fire('pointermove', 60, 10, 0, undefined, 0)
    expect(r.pans).toEqual([])
    r.fire('pointerdown', 30, 30)
    r.fire('pointerup', 30, 30)
    expect(r.crosshairs).toEqual([[30, 30]])
  })

  test('a pen back in range with a new id is not locked out', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    r.fire('pointerdown', 50, 50, 0, undefined, 1, 2)
    r.fire('pointerup', 50, 50, 0, undefined, 0, 2)
    expect(r.crosshairs).toEqual([[50, 50]])
  })

  test('a new press after an outside release starts a new gesture', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    // Released outside; pressed again on the canvas before any move.
    r.fire('pointerdown', 50, 50)
    r.fire('pointerup', 50, 50)
    expect(r.crosshairs).toEqual([[50, 50]])
    expect(r.pans).toEqual([])
  })

  test('leaving before capture ends the gesture; a held button back in does not pan', () => {
    const r = rig()
    r.fire('pointerdown', 98, 50)
    r.fire('pointerleave', 100, 50)
    // Released outside, then back over the canvas with a button held.
    r.fire('pointermove', 60, 50)
    expect(r.pans).toEqual([])
    expect(r.captures()).toBe(0)
  })

  test('a zoom box dragged back to its start does not zoom', () => {
    const r = rig({ primary: DRAG_MODE.roiSelection })
    r.fire('pointerdown', 50, 50)
    r.fire('pointermove', 70, 70)
    r.fire('pointermove', 50, 50)
    r.fire('pointerup', 50, 50)
    expect(r.viewports).toEqual([])
  })

  test('a click takes no pointer capture', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 10, 10)
    expect(r.captures()).toBe(0)
    r.fire('pointerdown', 10, 10)
    r.fire('pointermove', 30, 10)
    expect(r.captures()).toBe(1)
  })

  test('a roiSelection click does not zoom', () => {
    const r = rig({ primary: DRAG_MODE.roiSelection })
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 11, 10)
    expect(r.viewports).toEqual([])
  })

  test('the middle button pans whatever the drag modes', () => {
    const r = rig({ primary: DRAG_MODE.none, secondary: DRAG_MODE.none })
    r.fire('pointerdown', 10, 10, 1)
    r.fire('pointermove', 20, 15, 1)
    expect(r.pans).toEqual([[10, 5]])
  })

  test('the wheel zooms', () => {
    const r = rig()
    r.fire('wheel', 0, 0)
    expect(r.zooms[0]).toBeGreaterThan(1)
  })

  test('a line-mode wheel notch zooms as far as its pixel equivalent', () => {
    const r = rig()
    r.fire('wheel', 0, 0, 0, { deltaY: -3, deltaMode: 1 })
    r.fire('wheel', 0, 0, 0, { deltaY: -48, deltaMode: 0 })
    expect(r.zooms[0]).toBeCloseTo(r.zooms[1], 10)
  })

  test('a windowing click reports no window change', () => {
    const r = rig({ primary: DRAG_MODE.windowing })
    r.fire('pointerdown', 5, 5)
    r.fire('pointerup', 5, 5)
    expect(r.windows).toEqual([])
  })

  test('losing pointer capture ends the gesture', () => {
    const r = rig()
    r.fire('pointerdown', 10, 10)
    r.fire('lostpointercapture', 10, 10)
    r.fire('pointerdown', 30, 30)
    r.fire('pointerup', 30, 30)
    expect(r.crosshairs).toEqual([[30, 30]])
  })
})
