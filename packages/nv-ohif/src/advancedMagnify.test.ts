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
  const events = new EventTarget()
  const nv = {
    canvas,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
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
    // Core's dispatch: one pass over the live renderer list.
    drawScene: () => {
      for (const r of overlays) r.drawOverlay({ dpr: 1 } as UIKitOverlayFrame)
    },
  } as unknown as Parameters<typeof createAdvancedMagnifyBinding>[0]
  const at = (type: string, x: number, y: number, more = {}) =>
    (nv.canvas as unknown as EventTarget).dispatchEvent(
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

  return {
    at,
    core,
    overlays,
    lenses,
    centre,
    glasses,
    plane,
    pointerMove,
    nv,
    events,
  }
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
  at('pointerdown', 90, 90, { ...touch, pointerId: 2 })
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
  at('pointerdown', 150, 150, { ...touch, pointerId: 7 })
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

test('glasses: a series swap drops them without skipping the next renderer that frame', async () => {
  const { at, overlays, glasses, nv } = setup()
  glasses.setMode('Active')
  at('pointerdown', 100, 100)
  at('pointerup', 100, 100)
  let drawn = 0
  overlays.push({ drawOverlay: () => drawn++ })
  ;(nv.volumes as unknown[])[0] = { ...nv.volumes[0] }
  nv.drawScene()
  expect(drawn).toBe(1)
  await Promise.resolve()
  expect(overlays).toHaveLength(1)
  glasses.dispose()
})

test('glasses: input follows a canvas core swaps in (viewAttached)', () => {
  const { at, lenses, glasses, nv, events } = setup()
  glasses.setMode('Active')
  const old = nv.canvas as unknown as EventTarget
  ;(nv as { canvas: unknown }).canvas = new EventTarget()
  events.dispatchEvent(new Event('viewAttached'))
  at('pointerdown', 100, 100)
  at('pointerup', 100, 100)
  expect(lenses).toHaveLength(1)
  // The old canvas no longer places.
  old.dispatchEvent(
    Object.assign(new Event('pointerdown'), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 20,
    }),
  )
  expect(lenses).toHaveLength(1)
  glasses.dispose()
})

test('glasses: a touch down on a swapped-out canvas does not block a tap on the new one', () => {
  const { at, lenses, glasses, nv, events } = setup()
  glasses.setMode('Active')
  const touch = { pointerType: 'touch' }
  at('pointerdown', 50, 50, { ...touch, pointerId: 7 })
  ;(nv as { canvas: unknown }).canvas = new EventTarget()
  events.dispatchEvent(new Event('viewAttached'))
  at('pointerdown', 100, 100, { ...touch, pointerId: 8 })
  at('pointerup', 100, 100, { ...touch, pointerId: 8 })
  expect(lenses).toHaveLength(1)
  glasses.dispose()
})

test('glasses: a mouse drag released off the canvas ends at the next press', () => {
  const { at, centre, lenses, glasses } = setup()
  glasses.setMode('Active')
  at('pointerdown', 100, 100)
  at('pointerup', 100, 100)
  // Grab the rim; the release lands off the canvas.
  at('pointerdown', 188, 188)
  // Passive, so the next press places nothing; it and a move must not move the glass.
  glasses.setMode('Passive')
  // Inside the glass, so not a grab (a mouse grabs the rim only).
  at('pointerdown', 100, 100)
  at('pointermove', 190, 188)
  expect(centre()).toEqual([100, 100])
  expect(lenses[0]?.radiusCss).toBeCloseTo(125, 4)
  glasses.dispose()
})

test('glasses: a zoom list open on a swapped-out canvas closes (viewAttached)', () => {
  const { at, glasses, nv, events } = setup()
  const lists: Array<{ removed: boolean }> = []
  const parent = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    appendChild: (s: { removed: boolean }) => lists.push(s),
  }
  Object.assign(nv.canvas as object, { parentElement: parent })
  const { document: priorDocument, Option: priorOption } = globalThis
  globalThis.document = {
    createElement: () => ({
      style: {},
      add() {},
      addEventListener() {},
      focus() {},
      remove() {
        this.removed = true
      },
      removed: false,
      onblur: null,
    }),
  } as unknown as Document
  globalThis.Option = class {
    title = ''
  } as unknown as typeof Option
  try {
    glasses.setMode('Active')
    at('pointerdown', 100, 100)
    at('pointerup', 100, 100)
    at('pointerdown', 225, 100, { button: 2, shiftKey: true })
    expect(lists).toHaveLength(1)
    ;(nv as { canvas: unknown }).canvas = Object.assign(new EventTarget(), {
      parentElement: parent,
    })
    events.dispatchEvent(new Event('viewAttached'))
    expect(lists[0]?.removed).toBe(true)
  } finally {
    glasses.dispose()
    globalThis.document = priorDocument
    globalThis.Option = priorOption
  }
})
