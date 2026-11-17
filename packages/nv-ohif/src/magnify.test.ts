import { afterEach, expect, spyOn, test } from 'bun:test'
import { UIKitMagnifierOverlay } from '@niivue/uikit'
import { createMagnifyBinding } from './magnify'

const pointer = (type: string, button = 0) =>
  Object.assign(new Event(type), { button, clientX: 5, clientY: 5 })

function host() {
  const canvas = new EventTarget()
  // Stands in for core's bubble-phase canvas handlers (initInteraction),
  // which register before the binding.
  const core: string[] = []
  for (const t of ['pointerdown', 'pointermove', 'pointerup'])
    canvas.addEventListener(t, (e) =>
      core.push(`${t}:${(e as PointerEvent).button}`),
    )
  const nv = {
    canvas,
    registerOverlayRenderer: () => () => {},
    clientToCanvas: (x: number, y: number) => [x, y],
    drawScene() {},
  }
  return {
    canvas,
    core,
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
