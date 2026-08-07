// A minimal UIKit overlay that draws a fixed set of screen-space lines every
// frame, on whichever backend is live. This is the base-module proof that the
// niivue overlay lifecycle hook works end to end, and the drawing foundation the
// ruler widget builds on. Register it with `nv.registerOverlayRenderer(overlay)`.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type { LineData } from './line'
import { GlLineRenderer } from './render/glLineRenderer'
import { WgpuLineRenderer } from './render/wgpuLineRenderer'

export class UIKitLineOverlay implements UIKitOverlayRenderer {
  private lines: LineData[]
  private readonly gl = new GlLineRenderer()
  private readonly wgpu = new WgpuLineRenderer()

  constructor(lines: LineData[] = []) {
    this.lines = lines
  }

  /** Replace the lines drawn each frame. Trigger a redraw via the controller. */
  setLines(lines: LineData[]): void {
    this.lines = lines
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.lines.length === 0) return
    const { handle, bounds } = frame
    if (handle.backend === 'webgl2') {
      this.gl.draw(handle.gl, this.lines, bounds.width, bounds.height)
    } else {
      this.wgpu.draw(
        handle.device,
        handle.pass,
        handle.colorFormat,
        handle.sampleCount,
        handle.depthFormat,
        this.lines,
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
