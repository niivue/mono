import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { UIKitControls, type UIKitInteractive } from './controls'
import { UIKitMagnifierOverlay } from './magnifierOverlay'

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
  })
}

describe('UIKitMagnifierOverlay.attach', () => {
  const g = globalThis as { window?: EventTarget }
  let savedWindow: EventTarget | undefined
  beforeEach(() => {
    savedWindow = g.window
    g.window = new EventTarget()
  })
  afterEach(() => {
    g.window = savedWindow
  })

  it('leaves hover and the cursor to another layer on the same canvas', () => {
    const canvas = Object.assign(new EventTarget(), {
      style: { cursor: '' },
      setPointerCapture() {},
    })
    let draws = 0
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => draws++,
    }
    const moves: string[] = []
    const button: UIKitInteractive = {
      hoverCursor: 'pointer',
      hitTest: (x, y) => x < 100 && y < 100,
      pointerDown: () => false,
      pointerMove: (x, y) => {
        moves.push(`${x},${y}`)
        return false
      },
      pointerUp: () => false,
      pointerCancel: () => {},
      drawOverlay: () => {},
    }
    const detachButton = new UIKitControls().add(button).attach(host)
    const lens = new UIKitMagnifierOverlay()
    const detachLens = lens.attach(host)
    canvas.dispatchEvent(pointer('pointermove', 40, 50))
    expect(moves.at(-1)).toBe('40,50')
    expect(canvas.style.cursor).toBe('pointer')
    expect(draws).toBe(1) // the lens appeared
    canvas.dispatchEvent(pointer('pointerleave', 40, 50))
    expect(draws).toBe(2) // and went
    detachLens()
    detachButton()
  })

  it('a press exits the lens and never reaches the scene', () => {
    const canvas = Object.assign(new EventTarget(), {
      style: { cursor: '' },
    })
    let draws = 0
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => draws++,
    }
    // The scene listens in the bubble phase, registered first as NiiVue is.
    const scene: string[] = []
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click'])
      canvas.addEventListener(type, () => scene.push(type))
    let exits = 0
    const lens = new UIKitMagnifierOverlay({ onExit: () => exits++ })
    const detach = lens.attach(host)
    canvas.dispatchEvent(pointer('pointermove', 40, 50))
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click'])
      canvas.dispatchEvent(pointer(type, 40, 50))
    expect(scene).toEqual([])
    expect(exits).toBe(1)
    expect(draws).toBe(2) // shown, then hidden by the press
    // Exited: moves no longer show the lens and the next press is the scene's.
    canvas.dispatchEvent(pointer('pointermove', 60, 50))
    canvas.dispatchEvent(pointer('pointerdown', 60, 50))
    canvas.dispatchEvent(pointer('pointerup', 60, 50))
    expect(draws).toBe(2)
    expect(scene).toEqual(['pointerdown', 'pointerup'])
    detach()
  })
})
