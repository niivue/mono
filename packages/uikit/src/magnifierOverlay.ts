// A magnifying glass: a circular lens following the pointer that shows the
// frame under it enlarged. Register it after the overlays it should magnify
// (on WebGPU its capture ends the overlay pass and continues in a new one),
// then `attach(host)` so it sees pointer moves. It never takes a press, so
// the scene keeps its own drag, click and wheel handling underneath.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import {
  UIKitControls,
  type UIKitHost,
  type UIKitInteractive,
  type UIKitRedrawSource,
} from './controls'
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
}

export class UIKitMagnifierOverlay implements UIKitInteractive {
  radiusCss: number
  zoom: number
  borderCss: number
  borderColor: readonly number[]
  fillColor: readonly number[]
  private x = -1
  private y = -1
  private layer: UIKitRedrawSource | null = null
  private readonly ring = new UIKitRectOverlay()
  private readonly gl = new GlLensRenderer()
  private readonly wgpu = new WgpuLensRenderer()

  constructor(options: UIKitMagnifierOverlayOptions = {}) {
    this.radiusCss = options.radiusCss ?? 80
    this.zoom = options.zoom ?? 3
    this.borderCss = options.borderCss ?? 2
    this.borderColor = options.borderColor ?? [1, 1, 1, 0.9]
    this.fillColor = options.fillColor ?? [0, 0, 0, 1]
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.layer = layer
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

  /** Every on-canvas point: the lens must see each move (but no press). */
  hitTest(x: number, y: number): boolean {
    return x >= 0 && y >= 0
  }

  pointerDown(_x: number, _y: number): boolean {
    return false
  }

  pointerMove(x: number, y: number): boolean {
    if (x === this.x && y === this.y) return false
    const wasShown = this.x >= 0 && this.y >= 0
    this.x = x
    this.y = y
    if (wasShown || this.hitTest(x, y)) this.layer?.requestRedraw()
    return false
  }

  pointerUp(_x: number, _y: number): boolean {
    return false
  }

  pointerCancel(): void {}

  /** Wire the host canvas's pointer moves; returns the unwire function. */
  attach(host: UIKitHost): () => void {
    return new UIKitControls().add(this).attach(host)
  }

  destroy(): void {
    this.ring.destroy()
    this.gl.destroy()
    this.wgpu.destroy()
  }
}
