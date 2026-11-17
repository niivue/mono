import { afterEach, expect, spyOn, test } from 'bun:test'
import { UIKitMagnifierOverlay } from '@niivue/uikit'
import { createMagnifyBinding } from './magnify'

const pointer = (type: string, button = 0, more = {}) =>
  Object.assign(new Event(type), { button, clientX: 5, clientY: 5, ...more })

function host() {
  const canvas = new EventTarget()
  // Stands in for core's bubble-phase canvas handlers (initInteraction),
  // which register before the binding.
  const core: string[] = []
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'dblclick'])
    canvas.addEventListener(t, (e) =>
      core.push(`${t}:${(e as PointerEvent).button}`),
    )
  const overlays: unknown[] = []
  const nv = {
    canvas,
    overlays,
    registerOverlayRenderer: (r: unknown) => {
      overlays.push(r)
      return () => overlays.splice(overlays.indexOf(r), 1)
    },
    clientToCanvas: (x: number, y: number) => [x, y],
    drawScene() {},
  }
  return {
    canvas,
    core,
    overlays,
    nv: nv as unknown as Parameters<typeof createMagnifyBinding>[0],
  }
}

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

for (const tool of ['Magnify', 'AdvancedMagnify'])
  test(`${tool} claims the left-button drag from core, not other buttons`, () => {
    const { canvas, core, nv } = host()
    const binding = createMagnifyBinding(nv)
    binding.setTool(tool)
    for (const t of ['pointerdown', 'pointermove', 'pointerup'])
      canvas.dispatchEvent(pointer(t))
    canvas.dispatchEvent(pointer('pointerdown', 2))
    binding.dispose()
    expect(core).toEqual(['pointerdown:2'])
  })

test('switching tools destroys the lens', () => {
  const destroy = spyOn(UIKitMagnifierOverlay.prototype, 'destroy')
  spies.push(destroy)
  const binding = createMagnifyBinding(host().nv)
  binding.setTool('Magnify')
  binding.setTool('Zoom')
  expect(destroy).toHaveBeenCalledTimes(1)
})

test('AdvancedMagnify follows the pointer after a click; leaving hides it', () => {
  const moves: number[][] = []
  spies.push(
    spyOn(UIKitMagnifierOverlay.prototype, 'pointerMove').mockImplementation(
      (x: number, y: number) => {
        moves.push([x, y])
      },
    ),
  )
  const { canvas, nv } = host()
  const binding = createMagnifyBinding(nv)
  binding.setTool('AdvancedMagnify')
  for (const t of ['pointerdown', 'pointerup']) canvas.dispatchEvent(pointer(t))
  moves.length = 0
  canvas.dispatchEvent(pointer('pointermove'))
  canvas.dispatchEvent(pointer('pointerleave'))
  binding.dispose()
  expect(moves).toEqual([
    [5, 5],
    [-1, -1],
  ])
})

test('a second finger hands both touches to core (pinch)', () => {
  const { canvas, core, nv } = host()
  const binding = createMagnifyBinding(nv)
  binding.setTool('Magnify')
  const touch = (pointerId: number) =>
    pointer('pointerdown', 0, { pointerId, pointerType: 'touch' })
  canvas.dispatchEvent(touch(1))
  canvas.dispatchEvent(touch(2))
  binding.dispose()
  expect(core).toEqual(['pointerdown:0', 'pointerdown:0'])
})

test('a double-click on the lens does not reach core', () => {
  const { canvas, core, nv } = host()
  const binding = createMagnifyBinding(nv)
  binding.setTool('Magnify')
  canvas.dispatchEvent(pointer('dblclick'))
  binding.dispose()
  canvas.dispatchEvent(pointer('dblclick'))
  expect(core).toEqual(['dblclick:0'])
})

test('raise puts the lens above an overlay registered after it', () => {
  const { nv, overlays } = host()
  const binding = createMagnifyBinding(nv)
  binding.setTool('Magnify')
  const annotations = {}
  ;(
    nv as unknown as { registerOverlayRenderer(r: unknown): void }
  ).registerOverlayRenderer(annotations)
  binding.raise()
  expect(overlays[0]).toBe(annotations)
  expect(overlays[1]).toBeInstanceOf(UIKitMagnifierOverlay)
  expect(overlays).toHaveLength(2)
})
