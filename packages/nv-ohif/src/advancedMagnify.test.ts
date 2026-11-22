import { afterEach, expect, spyOn, test } from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import { UIKitMagnifierOverlay } from '@niivue/uikit'
import { createAdvancedMagnifyBinding } from './advancedMagnify'

// One axial tile where canvas (x, y) shows world (x, y, 0).
const tile = () => ({
  axCorSag: 0,
  leftTopWidthHeight: [0, 0, 200, 200],
  planeNormal: [0, 0, 1],
  planePoint: [0, 0, 0],
  mvpMatrix: new Float32Array([
    0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1,
  ]),
})

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

function setup() {
  const plane = tile()
  spies.push(
    spyOn(UIKitMagnifierOverlay.prototype, 'drawOverlay').mockImplementation(
      () => {},
    ),
  )
  const canvas = new EventTarget()
  const core: string[] = []
  canvas.addEventListener('pointerdown', () => core.push('down'))
  const overlays: Array<{ drawOverlay(f: UIKitOverlayFrame): void }> = []
  const nv = {
    canvas,
    // 1 mm voxels, RAS = voxel index.
    volumes: [
      {
        dimsRAS: [3, 200, 200, 10],
        img2RASstep: [1, 200, 40000],
        img2RASstart: [0, 0, 0],
        matRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    effectiveDevicePixelRatio: 1,
    clientToCanvas: (x: number, y: number) => [x, y],
    canvasToMM: (x: number, y: number) => [x, y, 0],
    hitTest: () => ({ isRender: false, sliceType: 0, tileIndex: 0 }),
    getScreenTiles: () => [plane],
    registerOverlayRenderer: (r: (typeof overlays)[0]) => {
      overlays.push(r)
      return () => overlays.splice(overlays.indexOf(r), 1)
    },
    drawScene: () => overlays[0]?.drawOverlay({ dpr: 1 } as UIKitOverlayFrame),
  } as unknown as Parameters<typeof createAdvancedMagnifyBinding>[0]
  const at = (type: string, x: number, y: number, more = {}) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type), {
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
        ...more,
      }),
    )
  const lenses: UIKitMagnifierOverlay[] = []
  const pointerMove = spyOn(UIKitMagnifierOverlay.prototype, 'pointerMove')
  spies.push(pointerMove)
  pointerMove.mockImplementation(function (this: UIKitMagnifierOverlay) {
    if (!lenses.includes(this)) lenses.push(this)
  })
  const glasses = createAdvancedMagnifyBinding(nv)
  const centre = () => pointerMove.mock.calls.at(-1)?.map(Math.round)

  return { at, core, overlays, lenses, centre, glasses, plane, pointerMove }
}

test('glasses: Active places, rim drags resize and move, Passive keeps, Disabled removes', () => {
  const { at, core, overlays, lenses, centre, glasses } = setup()
  glasses.setMode('Active')
  at('pointerdown', 100, 100)
  at('pointerup', 100, 100)
  expect(core).toEqual([])
  expect(lenses[0]?.radiusCss).toBeCloseTo(125, 4)
  expect(centre()).toEqual([100, 100])

  // The right handle resizes to the pointer's distance from the centre.
  at('pointerdown', 225, 100)
  at('pointermove', 150, 100)
  at('pointerup', 150, 100)
  expect(lenses[0]?.radiusCss).toBeCloseTo(50, 4)
  // The rim between handles moves the glass.
  at('pointerdown', 135, 135)
  at('pointermove', 145, 135)
  at('pointerup', 145, 135)
  expect(centre()).toEqual([110, 100])

  // Passive: glasses stay, a click elsewhere is core's.
  glasses.setMode('Passive')
  at('pointerdown', 20, 20)
  expect(core).toEqual(['down'])
  expect(overlays).toHaveLength(1)

  const destroy = spyOn(UIKitMagnifierOverlay.prototype, 'destroy')
  spies.push(destroy)
  glasses.setMode('Disabled')
  expect(overlays).toHaveLength(0)
  expect(destroy).toHaveBeenCalledTimes(1)
  glasses.dispose()
})

test('glasses: a touch places on a still lift; two fingers are core pinch; own slice only', () => {
  const { at, core, overlays, glasses, plane } = setup()
  glasses.setMode('Active')
  const touch = { pointerType: 'touch' }
  at('pointerdown', 50, 50, { ...touch, pointerId: 1 })
  at('pointerdown', 90, 90, { ...touch, pointerId: 2 })
  at('pointerup', 90, 90, { ...touch, pointerId: 2 })
  at('pointerup', 50, 50, { ...touch, pointerId: 1 })
  expect(overlays).toHaveLength(0)
  expect(core).toEqual(['down', 'down'])
  at('pointerdown', 50, 50, { ...touch, pointerId: 3 })
  at('pointerup', 50, 50, { ...touch, pointerId: 3 })
  expect(overlays).toHaveLength(1)
  // The tap's press reached core (it may still become a pinch).
  expect(core).toEqual(['down', 'down', 'down'])
  // The crosshair moving within slice 0 keeps the glass grabbable; slice 1 hides it.
  plane.planePoint = [0, 0, 0.4]
  overlays[0]?.drawOverlay({ dpr: 1 } as UIKitOverlayFrame)
  at('pointerdown', 50, 175, { pointerId: 4 })
  at('pointerup', 50, 175, { pointerId: 4 })
  expect(core).toHaveLength(3)
  plane.planePoint = [0, 0, 1]
  overlays[0]?.drawOverlay({ dpr: 1 } as UIKitOverlayFrame)
  glasses.setMode('Passive')
  at('pointerdown', 50, 175, { pointerId: 5 })
  expect(core).toHaveLength(4)
  glasses.dispose()
})
