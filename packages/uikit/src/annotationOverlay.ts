// A UIKit overlay that draws NiiVue vector annotations (ellipse / rectangle /
// circle / line / arrow) + their stats labels through the niivue overlay hook,
// from the screen-projected geometry NiiVue exposes as `annotationScreenShapes`
// (paired with `isAnnotationDrawn = false` so core does not also draw them).
//
// Like the ruler, UIKit carries its own rendering during the bake-in phase: it
// composes a line overlay (shape outlines + arrowheads) and a text overlay (the
// stats labels). Geometry is in canvas/device pixels, matching the seam.

import type {
  AnnotationScreenShape,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from '@niivue/niivue'
import {
  buildLine,
  buildTerminatedLine,
  type LineData,
  LineTerminator,
} from './line'
import { UIKitLineOverlay } from './lineOverlay'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface AnnotationGeometryOptions {
  /** Device-pixel ratio; scales stroke width + label size for crisp output. */
  dpr?: number
  /** Label em size in CSS pixels (multiplied by dpr). */
  labelCssPx?: number
}

// Close an outline by drawing a segment between each consecutive pair of points
// (and back to the first). Points are canvas px.
function outlineLoop(
  points: readonly { x: number; y: number }[],
  thickness: number,
  color: readonly number[],
  out: LineData[],
): void {
  const n = points.length
  if (n < 2) return
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (a && b) out.push(buildLine(a.x, a.y, b.x, b.y, thickness, color))
  }
}

/**
 * Build the line + text geometry for a set of projected annotation shapes.
 * Closed shapes (ellipse/rect/circle/freehand) draw as outline loops; line/arrow
 * draw start->end (arrow gets an arrowhead). Pure, so it is unit-testable.
 */
export function buildAnnotationGeometry(
  shapes: readonly AnnotationScreenShape[],
  opts: AnnotationGeometryOptions = {},
): { lines: LineData[]; text: UIKitTextItem[] } {
  const dpr = opts.dpr ?? 1
  const labelPx = (opts.labelCssPx ?? 14) * dpr
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []

  for (const shape of shapes) {
    const [sr, sg, sb, sa] = shape.style.strokeColor
    const stroke = [sr, sg, sb, sa] as const
    const thickness = Math.max(1, shape.style.strokeWidth * dpr)

    if (shape.isClosed) {
      outlineLoop(shape.outer, thickness, stroke, lines)
      for (const hole of shape.holes)
        outlineLoop(hole, thickness, stroke, lines)
    } else if (shape.start && shape.end) {
      const { start, end } = shape
      if (shape.tool === 'arrow') {
        lines.push(
          ...buildTerminatedLine(
            start.x,
            start.y,
            end.x,
            end.y,
            thickness,
            stroke,
            { end: LineTerminator.ARROW },
          ),
        )
      } else {
        lines.push(buildLine(start.x, start.y, end.x, end.y, thickness, stroke))
      }
    }

    if (shape.label) {
      text.push({
        str: shape.label.lines.join('\n'),
        x: shape.label.x,
        y: shape.label.y,
        sizePx: labelPx,
        align: shape.label.align === 'center' ? 0.5 : 0,
        color: [sr, sg, sb, 1],
        outlineWidthPx: dpr,
      })
    }
  }

  return { lines, text }
}

export class UIKitAnnotationOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private shapes: readonly AnnotationScreenShape[] = []
  private options: AnnotationGeometryOptions = {}

  constructor(font: UIKitFont, options?: AnnotationGeometryOptions) {
    this.labels = new UIKitTextOverlay(font)
    if (options) this.options = options
  }

  /** Set the shapes to draw next frame. Trigger a redraw via the controller. */
  setShapes(
    shapes: readonly AnnotationScreenShape[],
    options?: AnnotationGeometryOptions,
  ): void {
    this.shapes = shapes
    if (options) this.options = options
    const geo = buildAnnotationGeometry(shapes, this.options)
    this.lines.setLines(geo.lines)
    this.labels.setItems(geo.text)
  }

  clear(): void {
    this.shapes = []
    this.lines.setLines([])
    this.labels.setItems([])
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.shapes.length === 0) return
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}
