import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { UIKitControls, type UIKitInteractive } from './controls'
import { UIKitMagnifierOverlay } from './magnifierOverlay'

function pointer(type: string, x: number, y: number, pointerId = 1): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: 0,
    clientX: x,
    clientY: y,
    pointerId,
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

  it('touch drags the lens, pinches its zoom and exits on a tap', () => {
    const canvas = new EventTarget()
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => {},
    }
    const scene: string[] = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click'])
      canvas.addEventListener(type, () => scene.push(type))
    let exits = 0
    const lens = new UIKitMagnifierOverlay({ onExit: () => exits++ })
    lens.attach(host)
    const touch = (type: string, x: number, id: number, at: number): void => {
      const e = pointer(type, x, 50, id)
      Object.defineProperty(e, 'pointerType', { value: 'touch' })
      Object.defineProperty(e, 'timeStamp', { value: at })
      canvas.dispatchEvent(e)
    }
    touch('pointerdown', 40, 1, 0)
    touch('pointermove', 70, 1, 50)
    expect((lens as unknown as { x: number }).x).toBe(70) // the lens follows the finger
    touch('pointerdown', 110, 2, 60)
    touch('pointermove', 150, 2, 70) // span 40 -> 80: zoom 3 -> 6
    expect(lens.zoom).toBe(6)
    touch('pointermove', 1000, 2, 80)
    expect(lens.zoom).toBe(10) // clamped
    touch('pointerup', 1000, 2, 90)
    touch('pointerup', 70, 1, 100)
    expect(exits).toBe(0) // a drag and a pinch are not taps
    touch('pointerdown', 70, 3, 500)
    touch('pointerup', 72, 3, 600)
    canvas.dispatchEvent(pointer('click', 72, 50, 3))
    expect(exits).toBe(1)
    expect(scene).toEqual([])
  })

  it('the wheel zooms the lens, never the scene', () => {
    const canvas = new EventTarget()
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => {},
    }
    let scrolled = 0
    canvas.addEventListener('wheel', () => scrolled++)
    const lens = new UIKitMagnifierOverlay()
    const detach = lens.attach(host)
    const wheel = (deltaY: number) =>
      canvas.dispatchEvent(
        Object.assign(new Event('wheel', { cancelable: true }), { deltaY }),
      )
    wheel(-100)
    expect(lens.zoom).toBeCloseTo(3 * Math.exp(0.2))
    wheel(10000)
    expect(lens.zoom).toBe(1.5)
    expect(scrolled).toBe(0)
    detach()
    wheel(-100)
    expect(scrolled).toBe(1)
  })

  // Review of #841: a press released off the canvas does not swallow the next.
  it('a press released off the canvas leaves the next press to the scene', () => {
    const listening: string[] = []
    class Doc extends EventTarget {
      override addEventListener(
        ...args: Parameters<EventTarget['addEventListener']>
      ): void {
        listening.push(args[0])
        super.addEventListener(...args)
      }
      override removeEventListener(
        ...args: Parameters<EventTarget['removeEventListener']>
      ): void {
        listening.splice(listening.indexOf(args[0]), 1)
        super.removeEventListener(...args)
      }
    }
    const doc = new Doc()
    const canvas = Object.assign(new EventTarget(), { ownerDocument: doc })
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => {},
    }
    const scene: string[] = []
    canvas.addEventListener('pointerdown', () => scene.push('down'))
    new UIKitMagnifierOverlay().attach(host)
    canvas.dispatchEvent(pointer('pointerdown', 40, 50))
    doc.dispatchEvent(pointer('pointerup', 900, 50))
    expect(listening).toEqual([]) // the swallow ended with the release
    canvas.dispatchEvent(pointer('pointerdown', 40, 50))
    expect(scene).toEqual(['down'])
  })

  // Review of #841: a second touch during the exiting press is swallowed too.
  it('a second touch during the exiting press never reaches the scene', () => {
    const canvas = new EventTarget()
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      clientToCanvas: (x: number, y: number): [number, number] => [x, y],
      drawScene: () => {},
    }
    const scene: string[] = []
    for (const type of ['pointerdown', 'pointerup', 'pointercancel'])
      canvas.addEventListener(type, (e) =>
        scene.push(`${type}:${(e as PointerEvent).pointerId}`),
      )
    new UIKitMagnifierOverlay().attach(host)
    canvas.dispatchEvent(pointer('pointerdown', 40, 50, 1))
    canvas.dispatchEvent(pointer('pointerdown', 60, 50, 2))
    canvas.dispatchEvent(pointer('pointercancel', 40, 50, 1))
    canvas.dispatchEvent(pointer('pointerup', 60, 50, 2))
    expect(scene).toEqual([])
    // No click followed: the next press, with both up, is the scene's.
    canvas.dispatchEvent(pointer('pointerdown', 40, 50, 3))
    expect(scene).toEqual(['pointerdown:3'])
  })
})
