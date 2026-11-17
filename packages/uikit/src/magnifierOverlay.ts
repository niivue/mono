// A magnifying glass: a circular lens following the pointer that shows the
// frame under it enlarged. Register it after the overlays it should magnify
// (on WebGPU its capture ends the overlay pass and continues in a new one),
// then `attach(host)` so it sees pointer moves. It is not a control-layer
// widget: it never claims hover or the cursor. A press on the canvas exits
// it: the lens hides, stops following the pointer, and the press (through
// its click) never reaches the scene. A UIKit layer attached before it still
// gets presses on its own widgets.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitHost } from './controls'
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

// The rest of a press gesture, swallowed after the press exits the lens.
const PRESS_REST = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'pointercancel',
  'mouseup',
  'click',
] as const

/** Swallow the gesture begun by `pointerId`, and any pointer pressed while it lasts. */
function swallowPressRest(canvas: HTMLCanvasElement, pointerId: number): void {
  const down = new Set([pointerId])
  const stop = (e: Event): void => {
    const id = (e as PointerEvent).pointerId
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
    if (e.type === 'click') end()
  }
  const end = (): void => {
    for (const type of PRESS_REST)
      canvas.removeEventListener(type, stop, { capture: true })
  }
  for (const type of PRESS_REST)
    canvas.addEventListener(type, stop, { capture: true })
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

  /**
   * Follow the host canvas's pointer until a press exits the lens; returns
   * the unwire function.
   */
  attach(host: UIKitHost): () => void {
    const canvas = host.canvas
    if (!canvas) throw new Error('UIKit: host has no canvas to attach to')
    this.redraw = () => host.drawScene()
    const onMove = (e: PointerEvent): void => {
      const p = host.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
      this.pointerMove(p[0], p[1])
    }
    const onLeave = (): void => this.pointerMove(-1, -1)
    const onDown = (e: PointerEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      this.pointerMove(-1, -1)
      unwire()
      swallowPressRest(canvas, e.pointerId)
      this.onExit?.()
    }
    // Capture phase, so a host or layer handler that stops the move still
    // moves the lens when it was attached later, and the lens sees a press
    // before the scene's own (bubble-phase) handlers.
    const opts = { capture: true }
    canvas.addEventListener('pointermove', onMove, opts)
    canvas.addEventListener('pointerleave', onLeave, opts)
    canvas.addEventListener('pointerdown', onDown, opts)
    const unwire = (): void => {
      canvas.removeEventListener('pointermove', onMove, opts)
      canvas.removeEventListener('pointerleave', onLeave, opts)
      canvas.removeEventListener('pointerdown', onDown, opts)
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
