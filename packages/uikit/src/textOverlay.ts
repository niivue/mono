// A UIKit overlay that draws rotatable MSDF text through the niivue overlay hook,
// on whichever backend is live. Each item is laid out on the CPU (rotation baked
// in) and drawn as a textured triangle run. This is the transformed-text base the
// ruler widget's label builds on.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { GlTextRenderer } from './render/glTextRenderer'
import { type TextRun, WgpuTextRenderer } from './render/wgpuTextRenderer'
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
  // Laid-out runs, cached so a static overlay doesn't re-run text layout (9x per
  // item for the halo outline) every frame. Rebuilt when the items or font change.
  private runs: TextRun[] | null = null

  constructor(font: UIKitFont, items: UIKitTextItem[] = []) {
    this.font = font
    this.items = items
  }

  /** Swap the font atlas (metrics + image). Trigger a redraw via the controller. */
  setFont(font: UIKitFont): void {
    this.font = font
    this.runs = null
  }

  /** Replace the text items drawn each frame. Trigger a redraw via the controller. */
  setItems(items: UIKitTextItem[]): void {
    this.items = items
    this.runs = null
  }

  private layoutRuns(): TextRun[] {
    const metrics = this.font.metrics
    const runs: TextRun[] = []
    for (const item of this.items) {
      const { vertices, count } = buildTextRun(metrics, item)
      if (count === 0) continue
      runs.push({
        vertices,
        count,
        screenPxRange: screenPxRange(metrics, item.sizePx),
      })
    }
    return runs
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.items.length === 0) return
    const { handle, bounds } = frame
    // Lay out on the first draw after a change; reuse the cache otherwise. The
    // vertices are in absolute screen pixels (the canvas size is applied via the
    // shader uniform), so they stay valid across pan/zoom of the same items.
    this.runs ??= this.layoutRuns()
    const runs = this.runs
    if (runs.length === 0) return

    if (handle.backend === 'webgl2') {
      for (const r of runs) {
        this.gl.draw(
          handle.gl,
          this.font.image,
          r.vertices,
          r.count,
          r.screenPxRange,
          bounds.width,
          bounds.height,
        )
      }
    } else {
      this.wgpu.drawAll(
        handle.device,
        handle.pass,
        handle.colorFormat,
        handle.sampleCount,
        handle.depthFormat,
        this.font.image,
        runs,
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
