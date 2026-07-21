// A UIKit overlay that draws rotatable MSDF text through the niivue overlay hook,
// on whichever backend is live. Each item is laid out on the CPU (rotation baked
// in) and drawn as a textured triangle run. This is the transformed-text base the
// ruler widget's label builds on.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { GlTextRenderer } from './render/glTextRenderer'
import { WgpuTextRenderer } from './render/wgpuTextRenderer'
import {
  screenPxRange,
  type UIKitFont,
  type UIKitFontMetrics,
} from './text/font'
import {
  autoOutlineColor,
  FLOATS_PER_VERTEX,
  layoutText,
  type TextLayoutOptions,
} from './text/layout'

/** One piece of text to draw: the string plus its layout pose. */
export type UIKitTextItem = TextLayoutOptions & { str: string }

// Eight unit offsets for the halo outline. The bundled MSDF atlas has too small
// a distance range for an in-shader SDF outline (it saturates to a filled rect),
// so the outline is drawn as offset copies of the glyphs in the outline color
// behind the fill - works at any size, both backends, in a single draw.
const OUTLINE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/** Lay out one item's glyph run, baking an offset-halo outline in if requested. */
function buildTextRun(
  metrics: UIKitFontMetrics,
  item: UIKitTextItem,
): { vertices: Float32Array; count: number } {
  const fill = layoutText(metrics, item.str, item)
  const w = item.outlineWidthPx ?? 0
  if (w <= 0) return fill
  const outlineColor =
    item.outlineColor ?? autoOutlineColor(item.color ?? [1, 1, 1, 1])
  const parts: Float32Array[] = []
  for (const [ox, oy] of OUTLINE_OFFSETS) {
    parts.push(
      layoutText(metrics, item.str, {
        ...item,
        x: item.x + ox * w,
        y: item.y + oy * w,
        color: outlineColor,
      }).vertices,
    )
  }
  parts.push(fill.vertices) // fill drawn last, on top of the halo
  let total = 0
  for (const p of parts) total += p.length
  const vertices = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    vertices.set(p, off)
    off += p.length
  }
  return { vertices, count: total / FLOATS_PER_VERTEX }
}

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
      const { vertices, count } = buildTextRun(metrics, item)
      if (count === 0) continue
      const spr = screenPxRange(metrics, item.sizePx)
      if (handle.backend === 'webgl2') {
        this.gl.draw(
          handle.gl,
          this.font.image,
          vertices,
          count,
          spr,
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
          this.font.image,
          vertices,
          count,
          spr,
          bounds.width,
          bounds.height,
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
