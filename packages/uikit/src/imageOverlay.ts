// A UIKit overlay that draws one image (a bitmap or canvas) stretched over a
// box every frame: the image counterpart of UIKitRectOverlay.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from './hook'
import type { UIKitBox } from './rect'
import {
  GlImageRenderer,
  type UIKitImageSource,
} from './render/glImageRenderer'
import { WgpuImageRenderer } from './render/wgpuImageRenderer'

export type { UIKitImageSource }

export class UIKitImageOverlay implements UIKitOverlayRenderer {
  private source: UIKitImageSource | null = null
  private version = 0
  private box: UIKitBox | null = null
  private readonly gl = new GlImageRenderer()
  private readonly wgpu = new WgpuImageRenderer()

  /**
   * Draw `source` over `box` (canvas px); null hides it. Bump `version` when
   * the source's pixels change, so the texture is re-uploaded.
   */
  setImage(
    source: UIKitImageSource | null,
    version: number,
    box: UIKitBox | null,
  ): void {
    this.source = source
    this.version = version
    this.box = box
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const source = this.source
    const box = this.box
    if (!source || !box) return
    const { handle, bounds } = frame
    if (handle.backend === 'webgl2') {
      this.gl.draw(
        handle.gl,
        source,
        this.version,
        box,
        bounds.width,
        bounds.height,
      )
    } else {
      this.wgpu.draw(
        handle.device,
        handle.pass,
        handle.colorFormat,
        handle.sampleCount,
        handle.depthFormat,
        source,
        this.version,
        box,
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
