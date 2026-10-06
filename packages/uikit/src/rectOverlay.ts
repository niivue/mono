// A UIKit overlay that draws a set of filled rounded rectangles every frame, on
// whichever backend is live: the filled-shape counterpart of UIKitLineOverlay,
// and the surface the button widget (and later panels) build on.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type { RectData } from './rect'
import { GlRectRenderer } from './render/glRectRenderer'
import { WgpuRectRenderer } from './render/wgpuRectRenderer'

export class UIKitRectOverlay implements UIKitOverlayRenderer {
  private rects: RectData[]
  private readonly gl = new GlRectRenderer()
  private readonly wgpu = new WgpuRectRenderer()

  constructor(rects: RectData[] = []) {
    this.rects = rects
  }

  /** Replace the rects drawn each frame. Trigger a redraw via the host. */
  setRects(rects: RectData[]): void {
    this.rects = rects
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.rects.length === 0) return
    const { handle, bounds } = frame
    if (handle.backend === 'webgl2') {
      this.gl.draw(handle.gl, this.rects, bounds.width, bounds.height)
    } else {
      this.wgpu.draw(
        handle.device,
        handle.pass,
        handle.colorFormat,
        handle.sampleCount,
        handle.depthFormat,
        this.rects,
        bounds.width,
        bounds.height,
      )
    }
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.gl.destroy()
    this.wgpu.destroy()
  }
}
