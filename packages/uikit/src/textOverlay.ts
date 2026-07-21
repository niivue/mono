// A UIKit overlay that draws rotatable MSDF text through the niivue overlay hook,
// on whichever backend is live. Each item is laid out on the CPU (rotation baked
// in) and drawn as a textured triangle run. This is the transformed-text base the
// ruler widget's label builds on.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { GlTextRenderer } from './render/glTextRenderer'
import { WgpuTextRenderer } from './render/wgpuTextRenderer'
import { screenPxRange, type UIKitFont } from './text/font'
import {
  autoOutlineColor,
  layoutText,
  type TextLayoutOptions,
} from './text/layout'

/** One piece of text to draw: the string plus its layout pose. */
export type UIKitTextItem = TextLayoutOptions & { str: string }

export class UIKitTextOverlay implements UIKitOverlayRenderer {
  private font: UIKitFont
  private items: UIKitTextItem[]
  private readonly gl = new GlTextRenderer()
  private readonly wgpu = new WgpuTextRenderer()

  constructor(font: UIKitFont, items: UIKitTextItem[] = []) {
    this.font = font
    this.items = items
  }

  /** Swap the font atlas (metrics + image). Trigger a redraw via the controller. */
  setFont(font: UIKitFont): void {
    this.font = font
  }

  /** Replace the text items drawn each frame. Trigger a redraw via the controller. */
  setItems(items: UIKitTextItem[]): void {
    this.items = items
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.items.length === 0) return
    const { handle, bounds } = frame
    const metrics = this.font.metrics
    for (const item of this.items) {
      const { vertices, count } = layoutText(metrics, item.str, item)
      if (count === 0) continue
      const spr = screenPxRange(metrics, item.sizePx)
      const outlineWidthPx = item.outlineWidthPx ?? 0
      // Auto-pick a contrasting outline color from the fill when none is given.
      const outlineColor =
        outlineWidthPx > 0
          ? (item.outlineColor ?? autoOutlineColor(item.color ?? [1, 1, 1, 1]))
          : [0, 0, 0, 0]
      if (handle.backend === 'webgl2') {
        this.gl.draw(
          handle.gl,
          this.font.image,
          vertices,
          count,
          spr,
          bounds.width,
          bounds.height,
          outlineColor,
          outlineWidthPx,
        )
      } else {
        this.wgpu.draw(
          handle.device,
          handle.pass,
          handle.colorFormat,
          handle.sampleCount,
          handle.depthFormat,
          this.font.image,
          vertices,
          count,
          spr,
          bounds.width,
          bounds.height,
          outlineColor,
          outlineWidthPx,
        )
      }
    }
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.gl.destroy()
    this.wgpu.destroy()
  }
}
