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
  for (const type of ['pointerdown', 'pointermove', 'pointerup'])
    canvas.addEventListener(type, (e) =>
      core.push(`${type.slice(7)}${(e as PointerEvent).pointerId}`),
    )
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
        isPrimary: true,
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
  expect(core).toEqual(['up1'])
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
  expect(core.at(-1)).toEqual('down1')
  expect(overlays).toHaveLength(1)

  const destroy = spyOn(UIKitMagnifierOverlay.prototype, 'destroy')
  spies.push(destroy)
  glasses.setMode('Disabled')
  expect(overlays).toHaveLength(0)
  expect(destroy).toHaveBeenCalledTimes(1)
  glasses.dispose()
})

test('glasses: core gets whole touch gestures: taps and pinches off a glass, none of one on it; own slice only', () => {
  const { at, core, overlays, centre, glasses, plane } = setup()
  glasses.setMode('Active')
  const touch = { pointerType: 'touch' }
  // A pinch places nothing, even when the first finger moved before the second
  // came down and the second lifts still.
  at('pointerdown', 50, 50, { ...touch, pointerId: 1 })
  at('pointermove', 70, 50, { ...touch, pointerId: 1 })
  at('pointerdown', 90, 90, { ...touch, pointerId: 2, isPrimary: false })
  at('pointerup', 90, 90, { ...touch, pointerId: 2 })
  at('pointerup', 70, 50, { ...touch, pointerId: 1 })
  expect(overlays).toHaveLength(0)
  // A still tap places, and core sees its press and release.
  at('pointerdown', 50, 50, { ...touch, pointerId: 3 })
  at('pointerup', 50, 50, { ...touch, pointerId: 3 })
  expect(overlays).toHaveLength(1)
  expect(core).toEqual([
    'down1',
    'move1',
    'down2',
    'up2',
    'up1',
    'down3',
    'up3',
  ])
  core.length = 0
  // A pinch starting inside the glass is the glass's: core sees none of it.
  at('pointerdown', 60, 60, { ...touch, pointerId: 6 })
  at('pointerdown', 150, 150, { ...touch, pointerId: 7, isPrimary: false })
  at('pointermove', 70, 60, { ...touch, pointerId: 6 })
  at('pointermove', 160, 150, { ...touch, pointerId: 7 })
  at('pointerup', 160, 150, { ...touch, pointerId: 7 })
  at('pointerup', 70, 60, { ...touch, pointerId: 6 })
  expect(core).toEqual([])
  expect(centre()).toEqual([60, 50])
  // The crosshair moving within slice 0 keeps the glass grabbable; slice 1 hides it.
  plane.planePoint = [0, 0, 0.4]
  overlays[0]?.drawOverlay({ dpr: 1 } as UIKitOverlayFrame)
  at('pointerdown', 60, 175, { pointerId: 4 })
  at('pointerup', 60, 175, { pointerId: 4 })
  expect(core).toEqual([])
  plane.planePoint = [0, 0, 1]
  overlays[0]?.drawOverlay({ dpr: 1 } as UIKitOverlayFrame)
  glasses.setMode('Passive')
  at('pointerdown', 60, 175, { pointerId: 5 })
  expect(core).toEqual(['down5'])
  glasses.dispose()
})
