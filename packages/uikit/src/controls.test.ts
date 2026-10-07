import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import {
  UIKitControls,
  type UIKitInteractive,
  type UIKitKeyEvent,
  type UIKitRedrawSource,
} from './controls'

// A scripted widget: it claims the pointer inside its box, records every
// call, and can be made modal. Enough to pin down the layer's routing rules
// without any real widget.
class FakeWidget implements UIKitInteractive {
  readonly log: string[] = []
  modal = false
  layer: UIKitRedrawSource | null = null
  readonly hoverCursor: string
  drawn: string[] = []

  constructor(
    readonly name: string,
    private readonly box: { x: number; y: number; w: number; h: number },
    cursor = 'pointer',
  ) {
    this.hoverCursor = cursor
  }

  hitTest(x: number, y: number): boolean {
    const b = this.box
    return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
  }
  pointerDown(x: number, y: number): boolean {
    const hit = this.modal || this.hitTest(x, y)
    this.log.push(`down ${x},${y} ${hit}`)
    return hit
  }
  pointerMove(x: number, y: number): boolean {
    this.log.push(`move ${x},${y}`)
    return false
  }
  pointerUp(x: number, y: number): boolean {
    this.log.push(`up ${x},${y}`)
    return true
  }
  pointerCancel(): void {
    this.log.push('cancel')
  }
  keyDown(e: UIKitKeyEvent): boolean {
    this.log.push(`key ${e.key}`)
    return e.key !== 'ignored'
  }
  wheel(x: number, y: number, dx: number, dy: number): boolean {
    this.log.push(`wheel ${x},${y} ${dx},${dy}`)
    return true
  }
  blur(): void {
    this.log.push('blur')
  }
  isModal(): boolean {
    return this.modal
  }
  dismiss(): void {
    this.log.push('dismiss')
    this.modal = false
  }
  bindLayer(layer: UIKitRedrawSource): void {
    this.layer = layer
  }
  drawOverlay(_frame: UIKitOverlayFrame): void {
    this.drawn.push('overlay')
  }
  drawPopup(_frame: UIKitOverlayFrame): void {
    this.drawn.push('popup')
  }
  destroy(): void {
    this.log.push('destroy')
  }
}

function key(k: string): UIKitKeyEvent {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  }
}

function make(withRedraw = true) {
  let redraws = 0
  const layer = new UIKitControls(
    withRedraw ? { requestRedraw: () => redraws++ } : {},
  )
  // 'lo' is under 'hi' where they overlap (hi was added last).
  const lo = new FakeWidget('lo', { x: 0, y: 0, w: 100, h: 100 })
  const hi = new FakeWidget('hi', { x: 50, y: 50, w: 100, h: 100 }, 'grab')
  layer.add(lo).add(hi)
  const clear = () => {
    lo.log.length = 0
    hi.log.length = 0
  }
  return { layer, lo, hi, clear, redraws: () => redraws }
}

describe('UIKitControls routing', () => {
  it('binds added widgets to the layer and keeps z-order', () => {
    const { layer, lo, hi } = make()
    expect(layer.widgets).toEqual([lo, hi])
    expect(lo.layer).toBe(layer)
    layer.add(lo) // no duplicates
    expect(layer.widgets.length).toBe(2)
  })

  it('gives a press to the topmost widget under it, which then owns the pointer', () => {
    const { layer, lo, hi, clear } = make()
    expect(layer.pointerDown(75, 75)).toBe(true)
    expect(layer.capturedWidget).toBe(hi)
    expect(layer.focusedWidget).toBe(hi)
    expect(lo.log).toEqual([]) // never consulted
    clear()
    expect(layer.pointerMove(10, 10)).toBe(true) // consumed while captured
    expect(hi.log).toEqual(['move 10,10'])
    expect(lo.log).toEqual([])
    clear()
    expect(layer.pointerUp(10, 10)).toBe(true)
    expect(layer.capturedWidget).toBeNull()
    expect(hi.log[0]).toBe('up 10,10')
    // Hover is re-evaluated after release: 'lo' is now under the pointer.
    expect(lo.log).toEqual(['move 10,10'])
    expect(hi.log[1]).toBe('move -1,-1')
  })

  it('falls through to a lower widget when the top one declines', () => {
    const { layer, lo, hi } = make()
    expect(layer.pointerDown(10, 10)).toBe(true)
    expect(layer.capturedWidget).toBe(lo)
    expect(hi.log).toEqual(['down 10,10 false'])
  })

  it('clears focus on a press nobody claims, and reports it unconsumed', () => {
    const { layer, hi, clear } = make()
    layer.pointerDown(75, 75)
    layer.pointerUp(75, 75)
    clear()
    expect(layer.pointerDown(500, 500)).toBe(false)
    expect(layer.focusedWidget).toBeNull()
    expect(hi.log).toContain('blur')
    expect(layer.pointerUp(500, 500)).toBe(false)
  })

  it('hovers exactly one widget and tells the others the pointer is away', () => {
    const { layer, lo, hi } = make()
    expect(layer.pointerMove(75, 75)).toBe(false)
    expect(hi.log).toEqual(['move 75,75'])
    expect(lo.log).toEqual(['move -1,-1'])
    expect(layer.hoverCursor).toBe('grab')
    layer.pointerMove(10, 10)
    expect(lo.log[1]).toBe('move 10,10')
    expect(hi.log[1]).toBe('move -1,-1')
    expect(layer.hoverCursor).toBe('pointer')
    layer.pointerMove(500, 500)
    expect(layer.hoverCursor).toBeNull()
  })

  it('reports the captured widget cursor while it holds the pointer', () => {
    const { layer } = make()
    layer.pointerDown(75, 75)
    layer.pointerMove(500, 500)
    expect(layer.hoverCursor).toBe('grab')
  })

  it('routes everything to a modal widget first', () => {
    const { layer, lo, hi, clear } = make()
    lo.modal = true
    expect(layer.modalWidget).toBe(lo)
    // A press over 'hi' still goes to the modal 'lo', which claims it.
    expect(layer.pointerDown(75, 75)).toBe(true)
    expect(layer.capturedWidget).toBe(lo)
    expect(hi.log).toEqual([])
    layer.pointerUp(75, 75)
    clear()
    // Moves: the modal sees the real point, others are told it is away.
    expect(layer.pointerMove(75, 75)).toBe(true)
    expect(lo.log).toEqual(['move 75,75'])
    expect(hi.log).toEqual(['move -1,-1'])
    clear()
    // Keys go to the modal even when another widget has focus.
    layer.focus(hi)
    clear()
    expect(layer.keyDown(key('Escape'))).toBe(true)
    expect(lo.log).toEqual(['key Escape'])
    expect(hi.log).toEqual([])
    lo.modal = false
    expect(layer.keyDown(key('a'))).toBe(true)
    expect(hi.log).toEqual(['key a'])
  })

  it('cancels the captured widget when a second pointer presses another', () => {
    const { layer, lo, hi, clear } = make()
    expect(layer.pointerDown(25, 25)).toBe(true)
    expect(layer.capturedWidget).toBe(lo)
    clear()
    expect(layer.pointerDown(75, 75)).toBe(true)
    expect(layer.capturedWidget).toBe(hi)
    expect(lo.log).toEqual(['cancel', 'blur'])
    layer.pointerUp(75, 75)
    expect(layer.capturedWidget).toBeNull()
  })

  it('stops routing keys after deactivate even while a modal widget stays open', () => {
    const { layer, lo, hi, clear } = make()
    layer.pointerDown(75, 75)
    layer.pointerUp(75, 75)
    lo.modal = true
    clear()
    expect(layer.keyDown(key('a'))).toBe(true)
    expect(lo.log).toEqual(['key a'])
    clear()
    // The user pressed elsewhere in the page: the dialog stays open but the
    // page gets its keys back until the canvas is pressed again.
    layer.deactivate()
    expect(lo.log).toEqual(['dismiss']) // 'hi' took the press and the focus
    lo.modal = true // a dialog stays open through dismiss; the fake does not
    clear()
    expect(layer.keyDown(key('a'))).toBe(false)
    expect(lo.log).toEqual([])
    layer.pointerDown(75, 75)
    layer.pointerUp(75, 75)
    clear()
    expect(layer.keyDown(key('a'))).toBe(true)
    expect(lo.log).toEqual(['key a'])
    expect(hi.log).toEqual([])
  })

  it('sends keys to the focused widget and reports whether it consumed them', () => {
    const { layer, hi } = make()
    expect(layer.keyDown(key('a'))).toBe(false)
    layer.focus(hi)
    expect(layer.keyDown(key('a'))).toBe(true)
    expect(layer.keyDown(key('ignored'))).toBe(false)
    layer.blur()
    expect(layer.focusedWidget).toBeNull()
    expect(hi.log).toContain('blur')
  })

  it('moves focus between widgets, blurring the previous one', () => {
    const { layer, lo, hi } = make()
    layer.focus(lo)
    layer.focus(hi)
    expect(lo.log).toEqual(['blur'])
    expect(hi.log).toEqual([])
    layer.focus(hi)
    expect(hi.log).toEqual([])
  })

  it('cancels a held press', () => {
    const { layer, hi } = make()
    layer.pointerDown(75, 75)
    layer.pointerCancel()
    expect(layer.capturedWidget).toBeNull()
    expect(hi.log).toContain('cancel')
    expect(layer.pointerUp(75, 75)).toBe(false)
  })

  it('removing a widget releases its capture, focus and hover', () => {
    const { layer, hi } = make()
    layer.pointerDown(75, 75)
    layer.remove(hi)
    expect(hi.log).toContain('cancel')
    expect(layer.capturedWidget).toBeNull()
    expect(layer.focusedWidget).toBeNull()
    expect(layer.widgets.length).toBe(1)
  })

  it('draws widgets in order, then every popup, and forwards redraws', () => {
    const { layer, lo, hi, redraws } = make()
    const frame = {} as UIKitOverlayFrame
    const order: string[] = []
    lo.drawOverlay = () => order.push('lo')
    hi.drawOverlay = () => order.push('hi')
    lo.drawPopup = () => order.push('lo-popup')
    hi.drawPopup = () => order.push('hi-popup')
    layer.drawOverlay(frame)
    expect(order).toEqual(['lo', 'hi', 'lo-popup', 'hi-popup'])
    lo.layer?.requestRedraw()
    expect(redraws()).toBe(1)
    layer.destroy()
    expect(lo.log).toContain('destroy')
  })
})

// `attach` needs a canvas and a window: fake both with EventTargets.
interface FakeCanvas extends EventTarget {
  style: { cursor: string }
  captured: number[]
  setPointerCapture(id: number): void
}

function fakeCanvas(): FakeCanvas {
  const target = new EventTarget() as FakeCanvas
  target.style = { cursor: '' }
  target.captured = []
  target.setPointerCapture = (id: number) => {
    target.captured.push(id)
  }
  return target
}

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 7,
  })
}

describe('UIKitControls.attach', () => {
  const g = globalThis as { window?: EventTarget }
  let savedWindow: EventTarget | undefined
  beforeEach(() => {
    savedWindow = g.window
    g.window = new EventTarget()
  })
  afterEach(() => {
    g.window = savedWindow
  })

  function attach() {
    // No requestRedraw of its own: attach must route redraws to drawScene.
    const { layer, hi, lo } = make(false)
    const canvas = fakeCanvas()
    const scene: string[] = []
    const host = {
      canvas: canvas as unknown as HTMLCanvasElement,
      // Client to canvas: double (a DPR-2 canvas).
      clientToCanvas: (cx: number, cy: number): [number, number] | null =>
        cx < 0 ? null : [cx * 2, cy * 2],
      drawScene: () => scene.push('draw'),
    }
    // What NiiVue would see: bubble-phase listeners on the same canvas.
    const seen: string[] = []
    canvas.addEventListener('pointerdown', () => seen.push('down'))
    canvas.addEventListener('pointermove', () => seen.push('move'))
    canvas.addEventListener('pointerup', () => seen.push('up'))
    g.window?.addEventListener('keydown', () => seen.push('key'))
    const detach = layer.attach(host)
    return { layer, hi, lo, canvas, seen, scene, detach }
  }

  it('stops consumed pointer events before the host sees them', () => {
    const { hi, canvas, seen, detach } = attach()
    // Client (37,37) is canvas (74,74): over 'hi'.
    const down = pointer('pointerdown', 37, 37)
    canvas.dispatchEvent(down)
    expect(hi.log).toEqual(['down 74,74 true'])
    expect(down.defaultPrevented).toBe(true)
    expect(seen).toEqual([])
    expect(canvas.captured).toEqual([7])
    expect(canvas.style.cursor).toBe('grab')
    canvas.dispatchEvent(pointer('pointermove', 10, 10))
    expect(seen).toEqual([]) // captured: moves are consumed too
    canvas.dispatchEvent(pointer('pointerup', 10, 10))
    expect(seen).toEqual([])
    // Nothing held now: a move over empty canvas reaches the host.
    canvas.dispatchEvent(pointer('pointermove', 300, 300))
    expect(seen).toEqual(['move'])
    expect(canvas.style.cursor).toBe('')
    detach()
  })

  it('ends a capture from the window when pointer capture was refused', () => {
    const { layer, hi, canvas, detach } = attach()
    canvas.setPointerCapture = () => {
      throw new DOMException('no such pointer', 'NotFoundError')
    }
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    expect(layer.capturedWidget).toBe(hi)
    // The release happens over another element: it reaches the window only,
    // with a client point the host cannot map onto the canvas.
    g.window?.dispatchEvent(pointer('pointerup', -1, -1))
    expect(layer.capturedWidget).toBeNull()
    expect(hi.log).toContain('up -1,-1')
    // A canvas-targeted release (capture granted) is left to the canvas
    // handler: the window listener does not double-handle it.
    hi.log.length = 0
    canvas.setPointerCapture = () => {}
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    canvas.dispatchEvent(pointer('pointerup', 37, 37))
    expect(hi.log.filter((l) => l.startsWith('up'))).toEqual(['up 74,74'])
    // And a cancel outside the canvas cancels the captured widget.
    canvas.setPointerCapture = () => {
      throw new DOMException('no such pointer', 'NotFoundError')
    }
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    g.window?.dispatchEvent(pointer('pointercancel', -1, -1))
    expect(layer.capturedWidget).toBeNull()
    expect(hi.log).toContain('cancel')
    detach()
  })

  it('lets unclaimed presses and keys through, and consumes focused keys', () => {
    const { hi, canvas, seen, detach } = attach()
    canvas.dispatchEvent(pointer('pointerdown', 300, 300))
    expect(seen).toEqual(['down'])
    const key = new Event('keydown', { cancelable: true })
    Object.assign(key, {
      key: 'a',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })
    g.window?.dispatchEvent(key)
    expect(seen).toEqual(['down', 'key'])
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    canvas.dispatchEvent(pointer('pointerup', 37, 37))
    const key2 = new Event('keydown', { cancelable: true })
    Object.assign(key2, {
      key: 'a',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })
    g.window?.dispatchEvent(key2)
    expect(seen).toEqual(['down', 'key'])
    expect(hi.log).toContain('key a')
    expect(key2.defaultPrevented).toBe(true)
    detach()
  })

  function keyEvent(k: string): Event {
    const e = new Event('keydown', { cancelable: true })
    Object.assign(e, {
      key: k,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })
    return e
  }

  it('drops focus and keys when the user presses elsewhere in the page', () => {
    const { layer, hi, canvas, seen, detach } = attach()
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    canvas.dispatchEvent(pointer('pointerup', 37, 37))
    expect(layer.focusedWidget).toBe(hi)
    // A press on another element: dispatched on the window, as a page press
    // bubbles there, with a target that is not the canvas.
    const elsewhere = new EventTarget()
    const outside = pointer('pointerdown', 500, 500)
    Object.defineProperty(outside, 'target', { value: elsewhere })
    g.window?.dispatchEvent(outside)
    expect(layer.focusedWidget).toBeNull()
    expect(hi.log).toContain('blur')
    // Keys now reach the page untouched.
    const k = keyEvent('ArrowLeft')
    g.window?.dispatchEvent(k)
    expect(seen).toEqual(['key'])
    expect(k.defaultPrevented).toBe(false)
    expect(hi.log).not.toContain('key ArrowLeft')
    // A press on the canvas itself must not deactivate (the canvas hook handles it).
    const own = pointer('pointerdown', 37, 37)
    Object.defineProperty(own, 'target', { value: canvas })
    g.window?.dispatchEvent(own)
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    expect(layer.focusedWidget).toBe(hi)
    detach()
  })

  it('dismisses an open popup and cancels a press when focus leaves', () => {
    const { layer, hi, canvas, seen, detach } = attach()
    hi.modal = true
    expect(layer.modalWidget).toBe(hi)
    const focusin = new Event('focusin')
    Object.defineProperty(focusin, 'target', { value: new EventTarget() })
    g.window?.dispatchEvent(focusin)
    expect(hi.log).toContain('dismiss')
    expect(layer.modalWidget).toBeNull()
    const k = keyEvent('Escape')
    g.window?.dispatchEvent(k)
    expect(seen).toEqual(['key'])
    expect(k.defaultPrevented).toBe(false)
    // A held press is abandoned when the window loses focus.
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    expect(layer.capturedWidget).toBe(hi)
    hi.log.length = 0
    g.window?.dispatchEvent(new Event('blur'))
    expect(hi.log).toEqual(['cancel', 'blur'])
    expect(layer.capturedWidget).toBeNull()
    expect(canvas.style.cursor).toBe('')
    detach()
  })

  it('requests scene redraws through the host and unwires on detach', () => {
    const { layer, hi, canvas, seen, scene, detach } = attach()
    layer.requestRedraw()
    expect(scene).toEqual(['draw'])
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    detach()
    expect(hi.log).toContain('cancel')
    expect(layer.focusedWidget).toBeNull()
    canvas.dispatchEvent(pointer('pointerdown', 37, 37))
    expect(seen).toEqual(['down'])
  })

  it('routes the wheel to the modal widget, else the widget under it', () => {
    const { layer, hi, lo } = make()
    expect(layer.wheel(300, 300, 0, 10)).toBe(false)
    expect(layer.wheel(75, 75, 0, 10)).toBe(true) // hi is on top of lo there
    expect(hi.log).toEqual(['wheel 75,75 0,10'])
    expect(lo.log).toEqual([])
    lo.modal = true
    expect(layer.wheel(300, 300, 5, -10)).toBe(true)
    expect(lo.log).toEqual(['wheel 300,300 5,-10'])
  })

  it('consumes a wheel turn a widget handles and scales line deltas', () => {
    const { hi, canvas, seen, detach } = attach()
    canvas.addEventListener('wheel', () => seen.push('wheel'))
    const turn = (x: number, deltaMode: number): Event =>
      Object.assign(new Event('wheel', { cancelable: true }), {
        clientX: x,
        clientY: 37,
        deltaX: 0,
        deltaY: 3,
        deltaMode,
      })
    const inside = turn(37, 1) // client 37 is canvas 74: over hi; 3 lines = 48 px
    canvas.dispatchEvent(inside)
    expect(hi.log).toEqual(['wheel 74,74 0,48'])
    expect(inside.defaultPrevented).toBe(true)
    expect(seen).toEqual([])
    const outside = turn(200, 0) // canvas 400: over nothing
    canvas.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
    expect(seen).toEqual(['wheel'])
    detach()
    canvas.dispatchEvent(turn(37, 0))
    expect(hi.log).toHaveLength(1)
  })
})
