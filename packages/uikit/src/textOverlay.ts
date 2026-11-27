// A UIKit overlay that draws rotatable MSDF text through the niivue overlay hook,
// on whichever backend is live. Items are laid out on the CPU as glyph records
// and drawn as instanced quads, every item in one draw. This is the
// transformed-text base the ruler widget's label builds on.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from './hook'
import { GlTextRenderer } from './render/glTextRenderer'
import { WgpuTextRenderer } from './render/wgpuTextRenderer'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import {
  autoOutlineColor,
  FLOATS_PER_GLYPH,
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

/** Every item's glyph records, each item's offset-halo outline first. */
function layoutItems(
  metrics: UIKitFontMetrics,
  items: readonly UIKitTextItem[],
): { glyphs: Float32Array; count: number } {
  const parts: Float32Array[] = []
  for (const item of items) {
    const w = item.outlineWidthPx ?? 0
    if (w > 0) {
      const color =
        item.outlineColor ?? autoOutlineColor(item.color ?? [1, 1, 1, 1])
      for (const [ox, oy] of OUTLINE_OFFSETS)
        parts.push(
          layoutText(metrics, item.str, {
            ...item,
            x: item.x + ox * w,
            y: item.y + oy * w,
            color,
          }).glyphs,
        )
    }
    parts.push(layoutText(metrics, item.str, item).glyphs) // fill on top
  }
  let total = 0
  for (const p of parts) total += p.length
  const glyphs = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    glyphs.set(p, off)
    off += p.length
  }
  return { glyphs, count: total / FLOATS_PER_GLYPH }
}

export class UIKitTextOverlay implements UIKitOverlayRenderer {
  private font: UIKitFont
  private items: UIKitTextItem[]
  private readonly gl = new GlTextRenderer()
  private readonly wgpu = new WgpuTextRenderer()
  // Laid-out glyphs, cached so a static overlay doesn't re-run text layout (9x
  // per item for the halo outline) every frame. Rebuilt when the items or font
  // change.
  private laidOut: { glyphs: Float32Array; count: number } | null = null

  constructor(font: UIKitFont, items: UIKitTextItem[] = []) {
    this.font = font
    this.items = items
  }

  /** Swap the font atlas (metrics + image). Trigger a redraw via the controller. */
  setFont(font: UIKitFont): void {
    this.font = font
    this.laidOut = null
  }

  /** Replace the text items drawn each frame. Trigger a redraw via the controller. */
  setItems(items: UIKitTextItem[]): void {
    this.items = items
    this.laidOut = null
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.items.length === 0) return
    const { handle, bounds } = frame
    // Lay out on the first draw after a change; reuse the cache otherwise. The
    // records are in absolute screen pixels (the canvas size is a shader
    // uniform), so they stay valid across pan/zoom of the same items.
    this.laidOut ??= layoutItems(this.font.metrics, this.items)
    const { glyphs, count } = this.laidOut
    if (count === 0) return
    if (handle.backend === 'webgl2') {
      this.gl.draw(
        handle.gl,
        this.font.image,
        glyphs,
        count,
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
        glyphs,
        count,
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
