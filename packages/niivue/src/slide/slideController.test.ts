import { describe, expect, test } from 'bun:test'
import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide, NVSlideViewport } from './NVSlide'
import { NVSlideController, windowDragStep } from './slideController'

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
  const hovers: Array<number[] | null> = []
  const drags: Array<[number, number, number, number, boolean]> = []
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
    onHover: (p) => hovers.push(p && [p.x, p.y]),
    onDrag: (dx, dy, x, y, done) => drags.push([dx, dy, x, y, done]),
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
  const touch = (type: string, x: number, y: number, pointerId: number) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type), {
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
        pointerId,
        pointerType: 'touch',
      }),
    )
  return {
    ctl,
    canvas,
    fire,
    touch,
    drags,
    pans,
    zooms,
    crosshairs,
    windows,
    boxes,
    hovers,
    viewports,
    clamps: () => clamps,
    captures: () => captures,
  }
}

const frame = () => new Promise((r) => setTimeout(r, 5))

describe('NVSlideController', () => {
  test('hover reports moves without a gesture, and null on leave', async () => {
    const r = rig()
    r.fire('pointermove', 3, 4, 0, undefined, 0)
    await frame()
    r.fire('pointerdown', 3, 4)
    r.fire('pointermove', 30, 4)
    r.fire('pointerup', 30, 4)
    r.fire('pointermove', 7, 8, 0, undefined, 0)
    await frame()
    r.fire('pointerleave', 7, 8, 0, undefined, 0)
    expect(r.hovers).toEqual([[3, 4], [7, 8], null])
  })

  test('hover reports once per frame, the latest point', async () => {
    const r = rig()
    for (let x = 1; x <= 5; x++) r.fire('pointermove', x, 0, 0, undefined, 0)
    await frame()
    expect(r.hovers).toEqual([[5, 0]])
  })

  test('a leave is not overtaken by a pending hover frame', async () => {
    const r = rig()
    r.fire('pointermove', 3, 4, 0, undefined, 0)
    r.fire('pointerleave', 3, 4, 0, undefined, 0)
    await frame()
    expect(r.hovers).toEqual([null])
  })

  test('a second finger pinches: zoom by the spread, pan by the midpoint', () => {
    const r = rig()
    r.touch('pointerdown', 40, 50, 1)
    r.touch('pointerdown', 60, 50, 2)
    r.touch('pointermove', 70, 50, 2)
    expect(r.zooms).toEqual([1.5])
    expect(r.pans).toEqual([[5, 0]])
    r.touch('pointerup', 70, 50, 2)
    // The finger left down starts nothing.
    r.touch('pointermove', 90, 50, 1)
    expect(r.pans).toEqual([[5, 0]])
  })

  test('a third finger lifting does not end the pinch', () => {
    const r = rig()
    r.touch('pointerdown', 40, 50, 1)
    r.touch('pointerdown', 60, 50, 2)
    r.touch('pointerdown', 80, 50, 3)
    r.touch('pointerup', 80, 50, 3)
    r.touch('pointermove', 70, 50, 2)
    expect(r.zooms).toEqual([1.5])
  })

  test('a pan then a second finger pinches from where the first finger is', () => {
    const r = rig({ primary: DRAG_MODE.pan })
    r.touch('pointerdown', 20, 50, 1)
    r.touch('pointermove', 40, 50, 1)
    expect(r.pans).toEqual([[20, 0]])
    r.touch('pointerdown', 60, 50, 2)
    r.touch('pointermove', 41, 50, 1)
    // Spread 20 -> 19, midpoint 50 -> 50.5: no jump to the first press.
    expect(r.pans.at(-1)?.[0]).toBeCloseTo(0.5)
    expect(r.zooms).toEqual([19 / 20])
  })

  test('a double-click zooms in about the pointer; shift zooms out', () => {
    const r = rig({ primary: DRAG_MODE.pan })
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 10, 10)
    r.fire('dblclick', 10, 10)
    r.canvas.dispatchEvent(
      Object.assign(new Event('dblclick'), {
        clientX: 10,
        clientY: 10,
        shiftKey: true,
      }),
    )
    expect(r.zooms).toEqual([2, 0.5])
  })

  test('a double-click on a widget over the canvas (no press here) does not zoom', () => {
    const r = rig({ primary: DRAG_MODE.pan })
    r.fire('dblclick', 10, 10)
    // A press here, then a widget (minimap) takes the double-click's presses.
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 10, 10)
    r.fire('dblclick', 80, 80)
    // Only a pan primary zooms: clicks mean something in the other modes.
    const off = rig({ primary: DRAG_MODE.crosshairPan })
    off.fire('pointerdown', 10, 10)
    off.fire('pointerup', 10, 10)
    off.fire('dblclick', 10, 10)
    expect([...r.zooms, ...off.zooms]).toEqual([])
  })

  test('other buttons, pinch, wheel scaling and cancel are settable', () => {
    const r = rig({ primary: DRAG_MODE.pan })
    r.ctl.otherButtonDragMode = DRAG_MODE.callbackOnly
    r.fire('pointerdown', 10, 10, 3)
    r.fire('pointermove', 20, 10, 3, undefined, 8)
    r.fire('pointerup', 20, 10, 3)
    expect(r.drags[0]).toEqual([10, 0, 20, 10, false])
    // No pinch: the second finger is ignored, the first keeps panning.
    r.ctl.isPinchZoom = false
    r.touch('pointerdown', 40, 50, 11)
    r.touch('pointerdown', 60, 50, 12)
    r.touch('pointermove', 50, 50, 11)
    expect(r.zooms).toEqual([])
    expect(r.pans.at(-1)).toEqual([10, 0])
    r.touch('pointerup', 50, 50, 11)
    r.touch('pointerup', 60, 50, 12)
    // A line-mode notch, unscaled: the raw delta, as nv-ohif had it.
    r.ctl.isWheelDeltaModeScaled = false
    r.ctl.wheelZoomRate = 0.001
    r.fire('wheel', 0, 0, 0, { deltaY: -3, deltaMode: 1 })
    expect(r.zooms.at(-1)).toBeCloseTo(Math.exp(0.003))
    // A ruler drag cancelled mid-way adds no ruler.
    const m = rig({ primary: DRAG_MODE.measurement })
    m.fire('pointerdown', 10, 10)
    m.fire('pointermove', 40, 10)
    m.ctl.cancelGesture()
    m.fire('pointerup', 40, 10)
    expect(m.ctl.measurements).toEqual([])
    expect(m.ctl.activeMeasurement).toBeNull()
  })

  test('middle button mode, context menu and wheel rate are settable', () => {
    const r = rig({ primary: DRAG_MODE.pan })
    r.ctl.middleDragMode = DRAG_MODE.callbackOnly
    r.fire('pointerdown', 10, 10, 1)
    r.fire('pointermove', 20, 10, 1, undefined, 4)
    r.fire('pointerup', 20, 10, 1)
    expect(r.drags[0]).toEqual([10, 0, 20, 10, false])
    const menu = new Event('contextmenu', { cancelable: true })
    r.canvas.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    r.ctl.isContextMenuBlocked = false
    const free = new Event('contextmenu', { cancelable: true })
    r.canvas.dispatchEvent(free)
    expect(free.defaultPrevented).toBe(false)
    r.ctl.wheelZoomRate = 0.001
    r.fire('wheel', 0, 0, 0, { deltaY: -100, deltaMode: 0 })
    expect(r.zooms.at(-1)).toBeCloseTo(Math.exp(0.1))
  })

  test('a callbackOnly drag reports its steps and the release', () => {
    const r = rig({ primary: DRAG_MODE.callbackOnly })
    r.fire('pointerdown', 10, 10)
    r.fire('pointermove', 20, 10)
    r.fire('pointerup', 20, 10)
    expect(r.drags).toEqual([
      [10, 0, 20, 10, false],
      [0, 0, 20, 10, true],
    ])
  })

  test('cancelGesture ends a windowing or callbackOnly drag with no done call', () => {
    for (const primary of [DRAG_MODE.windowing, DRAG_MODE.callbackOnly]) {
      const r = rig({ primary })
      r.fire('pointerdown', 10, 10)
      r.fire('pointermove', 20, 10)
      r.ctl.cancelGesture()
      r.fire('pointerup', 20, 10)
      expect([...r.windows, ...r.drags].map((c) => c.at(-1))).toEqual([false])
    }
  })

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

  test('a zoom box dragged back to its start, or a click, does not zoom', () => {
    const r = rig({ primary: DRAG_MODE.roiSelection })
    r.fire('pointerdown', 50, 50)
    r.fire('pointermove', 70, 70)
    r.fire('pointermove', 50, 50)
    r.fire('pointerup', 50, 50)
    r.fire('pointerdown', 10, 10)
    r.fire('pointerup', 11, 10)
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

  test('the middle button pans whatever the drag modes', () => {
    const r = rig({ primary: DRAG_MODE.none, secondary: DRAG_MODE.none })
    r.fire('pointerdown', 10, 10, 1)
    r.fire('pointermove', 20, 15, 1)
    expect(r.pans).toEqual([[10, 5]])
  })

  test('a line-mode wheel notch zooms as far as its pixel equivalent', () => {
    const r = rig()
    r.fire('wheel', 0, 0, 0, { deltaY: -3, deltaMode: 1 })
    r.fire('wheel', 0, 0, 0, { deltaY: -48, deltaMode: 0 })
    expect(r.zooms[0]).toBeGreaterThan(1)
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

describe('default windowing and contrast', () => {
  function windowRig(window: [number, number] = [Number.NaN, Number.NaN]) {
    const canvas = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
    }) as unknown as HTMLCanvasElement
    const sets: Array<[number, number, number]> = []
    const channels = [
      { calMin: window[0], calMax: window[1] },
      { calMin: 0, calMax: 1 },
    ]
    const slide = {
      viewport: { centerX: 0, centerY: 0, scale: 1 },
      manifest: {
        channelInfo: [{ name: 'a' }, { name: 'b' }],
        levels: [{ codec: 'raw-gray', bitsStored: 8 }],
      },
      channels,
      screenToSlide: (x: number, y: number) => ({ x, y }),
      setChannel: (c: number, w: { calMin: number; calMax: number }) =>
        sets.push([c, w.calMin, w.calMax]),
      // Channel 1 reads x + y, so a box's samples span its corners.
      sampleAt: (x: number, y: number) => [
        { stored: null },
        { stored: Math.floor(x) + Math.floor(y) },
      ],
    } as unknown as NVSlide
    const ctl = new NVSlideController(canvas, {
      slide: () => slide,
      screen: () => ({ widthCss: 100, heightCss: 100 }),
      primaryDragMode: DRAG_MODE.windowing,
      secondaryDragMode: DRAG_MODE.contrast,
    })
    const fire = (type: string, x: number, y: number, button = 0) =>
      canvas.dispatchEvent(
        Object.assign(new Event(type), {
          clientX: x,
          clientY: y,
          button,
          buttons: 1,
          pointerId: 1,
        }),
      )
    return { ctl, fire, sets }
  }

  test('windowDragStep widens on x and lowers the centre on y', () => {
    expect(windowDragStep([0, 200], [0, 200], 10, 0)).toEqual([-5, 205])
    expect(windowDragStep([0, 200], [0, 200], 0, 10)).toEqual([-10, 190])
  })

  test('a windowing drag sets the channel window live, from its bit range', () => {
    const r = windowRig()
    r.fire('pointerdown', 0, 0)
    r.fire('pointermove', 10, 0)
    r.fire('pointermove', 20, 0)
    r.fire('pointerup', 20, 0)
    const [first, second] = r.sets
    expect(first?.[0]).toBe(0)
    expect(first?.[1]).toBeCloseTo(-6.375)
    expect(first?.[2]).toBeCloseTo(261.375)
    expect(second?.[1]).toBeCloseTo(-12.75)
  })

  test('the drag starts from the window in force and follows windowChannel', () => {
    const r = windowRig()
    r.ctl.windowChannel = 1
    r.fire('pointerdown', 0, 0)
    r.fire('pointermove', 0, 10)
    expect(r.sets[0]?.[0]).toBe(1)
    expect(r.sets[0]?.[1]).toBeCloseTo(-0.05)
    expect(r.sets[0]?.[2]).toBeCloseTo(0.95)
  })

  test('a windowChannel past the slide (after a swap) windows channel 0', () => {
    const r = windowRig()
    r.ctl.windowChannel = 5
    r.fire('pointerdown', 0, 0)
    r.fire('pointermove', 10, 0)
    expect(r.sets[0]?.[0]).toBe(0)
  })

  test('a contrast box sets the window to its resident sample range', () => {
    const r = windowRig([0, 255])
    r.ctl.windowChannel = 1
    r.fire('pointerdown', 0, 0, 2)
    r.fire('pointermove', 32, 32, 2)
    r.fire('pointerup', 32, 32, 2)
    expect(r.sets).toEqual([[1, 0, 62]])
  })
})
