// A magnifying glass: a circular lens following the pointer that shows the
// frame under it enlarged. Register it after the overlays it should magnify
// (on WebGPU its capture ends the overlay pass and continues in a new one),
// then `attach(host)` so it sees pointer moves. It is not a control-layer
// widget: it never claims hover or the cursor. A press on the canvas exits
// it: the lens hides, stops following the pointer, and the press (through
// its click) never reaches the scene. Touch has no hover, so there a one-finger
// drag moves the lens, a pinch zooms it and a tap exits; the wheel zooms it
// too. A UIKit layer attached before it still gets presses on its own widgets.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import { type UIKitHost, wheelPxPerUnit } from './controls'
import { layoutMagnifier } from './magnifier'
import { buildRect } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { GlLensRenderer } from './render/glLensRenderer'
import { WgpuLensRenderer } from './render/wgpuLensRenderer'

export interface UIKitMagnifierOverlayOptions {
  /** Lens radius, CSS px. Default 80. */
  radiusCss?: number
  /** Enlargement. Default 3. */
  zoom?: number
  /** Ring width, CSS px (0 for none). Default 2. */
  borderCss?: number
  borderColor?: readonly number[]
  /** Shown where the lens reaches past the frame. Default opaque black. */
  fillColor?: readonly number[]
  /** Called when a press exits the lens, e.g. to untick the host's toggle. */
  onExit?: () => void
}

// Pinch and wheel zoom limits.
const MIN_ZOOM = 1.5
const MAX_ZOOM = 10
// A touch shorter and stiller than this is a tap, which exits the lens.
const TAP_MS = 300
const TAP_SLOP_CSS = 10

// The rest of a press gesture, swallowed after the press exits the lens.
const PRESS_REST = [
  'pointerdown',
  'pointermove',
  'mousedown',
  'pointerup',
  'pointercancel',
  'mouseup',
  'click',
  'dblclick',
] as const

/** Swallow the gesture of the pointers still `down`, and any pointer pressed while it lasts. */
function swallowPressRest(canvas: HTMLCanvasElement, held: number[]): void {
  const down = new Set(held)
  const stop = (e: Event): void => {
    const id = (e as PointerEvent).pointerId
    // Only the swallowed pointers' moves: another pointer's hover is the scene's.
    if (e.type === 'pointermove' && !down.has(id)) return
    // A press once every swallowed pointer is up is the scene's: a cancelled
    // or multi-touch gesture has no click to end the swallow.
    if (e.type === 'pointerdown' && !down.size) {
      end()
      return
    }
    if (e.type === 'pointerdown') down.add(id)
    else if (e.type === 'pointerup' || e.type === 'pointercancel')
      down.delete(id)
    e.stopImmediatePropagation()
    // Another pointer's click mid-gesture: the swallowed press is still down.
    if (e.type === 'click' && !down.size) {
      end()
      swallowDoubleClick(canvas, (e as MouseEvent).detail)
    }
  }
  // A mouse can release off the canvas: the document still sees it.
  const doc = canvas.ownerDocument as Document | undefined
  const release = (e: Event): void => {
    down.delete((e as PointerEvent).pointerId)
    // Off the canvas no click follows: nothing is left to swallow.
    if (!e.composedPath().includes(canvas) && !down.size) end()
  }
  const end = (): void => {
    for (const type of PRESS_REST)
      canvas.removeEventListener(type, stop, { capture: true })
    doc?.removeEventListener('pointerup', release, { capture: true })
    doc?.removeEventListener('pointercancel', release, { capture: true })
  }
  for (const type of PRESS_REST)
    canvas.addEventListener(type, stop, { capture: true })
  doc?.addEventListener('pointerup', release, { capture: true })
  doc?.addEventListener('pointercancel', release, { capture: true })
}

/**
 * Only a click with `detail` 2 is followed by a dblclick, which would
 * depth-pick in the scene: the exiting click's own (a held touch then a tap)
 * or the next click's (the exiting click starts a double click). A third
 * click has none, so no blocker may stay armed for a later double tap.
 */
function swallowDoubleClick(canvas: HTMLCanvasElement, detail: number): void {
  if (detail === 2) {
    swallowNextDoubleClick(canvas)
    return
  }
  const onClick = (e: Event): void => {
    canvas.removeEventListener('click', onClick, { capture: true })
    if ((e as MouseEvent).detail === 2) swallowNextDoubleClick(canvas)
  }
  canvas.addEventListener('click', onClick, { capture: true })
}

function swallowNextDoubleClick(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('dblclick', (d) => d.stopImmediatePropagation(), {
    capture: true,
    once: true,
  })
}

export class UIKitMagnifierOverlay {
  radiusCss: number
  zoom: number
  borderCss: number
  borderColor: readonly number[]
  fillColor: readonly number[]
  onExit: (() => void) | undefined
  private x = -1
  private y = -1
  private redraw: (() => void) | null = null
  private readonly ring = new UIKitRectOverlay()
  private readonly gl = new GlLensRenderer()
  private readonly wgpu = new WgpuLensRenderer()

  constructor(options: UIKitMagnifierOverlayOptions = {}) {
    this.radiusCss = options.radiusCss ?? 80
    this.zoom = options.zoom ?? 3
    this.borderCss = options.borderCss ?? 2
    this.borderColor = options.borderColor ?? [1, 1, 1, 0.9]
    this.fillColor = options.fillColor ?? [0, 0, 0, 1]
    this.onExit = options.onExit
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const { handle, bounds, dpr } = frame
    const layout = layoutMagnifier({
      x: this.x,
      y: this.y,
      width: bounds.width,
      height: bounds.height,
      dpr,
      radiusCss: this.radiusCss,
      zoom: this.zoom,
    })
    if (!layout) return
    if (handle.backend === 'webgl2') {
      this.gl.draw(handle.gl, bounds, layout, this.fillColor)
    } else {
      this.wgpu.draw(
        handle,
        layout,
        this.fillColor,
        bounds.width,
        bounds.height,
      )
    }
    if (this.borderCss <= 0) return
    this.ring.setRects([
      buildRect({
        ...layout.lens,
        radius: layout.radius,
        borderWidth: this.borderCss * dpr,
        fill: [0, 0, 0, 0],
        border: this.borderColor,
      }),
    ])
    this.ring.drawOverlay(frame)
  }

  /** Move the lens to canvas (x, y); (-1, -1) hides it. */
  pointerMove(x: number, y: number): void {
    if (x === this.x && y === this.y) return
    const wasShown = this.x >= 0 && this.y >= 0
    this.x = x
    this.y = y
    if (wasShown || (x >= 0 && y >= 0)) this.redraw?.()
  }

  /** Set the enlargement, clamped to the pinch range, and redraw. */
  private zoomTo(zoom: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    this.redraw?.()
  }

  /**
   * Follow the host canvas's pointer until a press (on touch, a tap) exits
   * the lens; returns the unwire function.
   */
  attach(host: UIKitHost): () => void {
    const canvas = host.canvas
    if (!canvas) throw new Error('UIKit: host has no canvas to attach to')
    this.redraw = () => host.drawScene()
    const follow = (e: PointerEvent): void => {
      const p = host.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
      this.pointerMove(p[0], p[1])
    }
    const exit = (held: number[]): void => {
      this.pointerMove(-1, -1)
      unwire()
      swallowPressRest(canvas, held)
      this.onExit?.()
    }
    // Touch gesture: client positions by pointer, and what a tap must stay.
    const touches = new Map<number, [number, number]>()
    let tap: { at: number; x: number; y: number } | null = null
    let pinch: { span: number; zoom: number } | null = null
    const span = (): number => {
      const [a, b] = [...touches.values()] as [number, number][]
      return Math.hypot(a[0] - b[0], a[1] - b[1])
    }
    // A new press or wheel outside a bounded host is a sibling viewer's.
    const outside = (e: MouseEvent): boolean =>
      !host.clientToCanvas(e.clientX, e.clientY)
    const moved = (e: PointerEvent): boolean =>
      !tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_CSS
    const onDown = (e: PointerEvent): void => {
      if (!touches.size && outside(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.pointerType !== 'touch') {
        // A finger held on the lens is part of the exiting gesture too.
        exit([e.pointerId, ...touches.keys()])
        return
      }
      touches.set(e.pointerId, [e.clientX, e.clientY])
      if (touches.size === 1) {
        tap = { at: e.timeStamp, x: e.clientX, y: e.clientY }
        follow(e)
      } else {
        tap = null
        pinch = touches.size === 2 ? { span: span(), zoom: this.zoom } : null
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (!touches.has(e.pointerId)) {
        if (e.pointerType !== 'touch') follow(e)
        return
      }
      e.stopImmediatePropagation()
      touches.set(e.pointerId, [e.clientX, e.clientY])
      if (moved(e)) tap = null
      if (touches.size === 1) follow(e)
      else if (pinch && touches.size === 2 && pinch.span > 0)
        this.zoomTo((pinch.zoom * span()) / pinch.span)
    }
    const onUp = (e: PointerEvent): void => {
      if (!touches.delete(e.pointerId)) return
      e.stopImmediatePropagation()
      pinch = touches.size === 2 ? { span: span(), zoom: this.zoom } : null
      if (
        e.type === 'pointerup' &&
        !touches.size &&
        tap &&
        e.timeStamp - tap.at < TAP_MS &&
        // A drag reported only at release is not a tap either.
        !moved(e)
      )
        exit([])
      if (!touches.size) tap = null
    }
    const onLeave = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') this.pointerMove(-1, -1)
    }
    // A mouse or pen press exits first, so a click (or dblclick) here ends a
    // touch gesture (a held touch or a drag), never meant for the scene.
    const onClick = (e: MouseEvent): void => {
      if (!outside(e)) e.stopImmediatePropagation()
    }
    const onWheel = (e: WheelEvent): void => {
      if (outside(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const px = e.deltaY * wheelPxPerUnit(e, canvas.clientHeight || 1)
      this.zoomTo(this.zoom * Math.exp(-px * 0.002))
    }
    // Capture phase, so a host or layer handler that stops the move still
    // moves the lens when it was attached later, and the lens sees a press
    // before the scene's own (bubble-phase) handlers.
    const opts = { capture: true, passive: false }
    const listeners = [
      ['pointermove', onMove],
      ['pointerleave', onLeave],
      ['pointerdown', onDown],
      ['pointerup', onUp],
      ['pointercancel', onUp],
      ['click', onClick],
      ['dblclick', onClick],
      ['wheel', onWheel],
    ] as [string, EventListener][]
    for (const [type, fn] of listeners) canvas.addEventListener(type, fn, opts)
    const unwire = (): void => {
      for (const [type, fn] of listeners)
        canvas.removeEventListener(type, fn, opts)
      this.redraw = null
    }
    return unwire
  }

  destroy(): void {
    this.ring.destroy()
    this.gl.destroy()
    this.wgpu.destroy()
  }
}
