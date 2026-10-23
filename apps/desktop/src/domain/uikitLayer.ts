import type {
  AnnotationScreenShape,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from '@niivue/niivue'
import {
  buildAnnotationGeometry,
  loadDefaultFont,
  type UIKitFont,
  UIKitLineOverlay,
  UIKitTextOverlay,
} from '@niivue/uikit'

// Stats-label size for closed shapes, in CSS px (uikit scales by dpr). A
// measured line draws as a graduated ruler with its own, larger label.
const LABEL_CSS_PX = 14

let fontPromise: Promise<UIKitFont> | null = null

/**
 * The bundled UIKit font, fetched once for the app's lifetime and shared by
 * every NiiVue instance. A failed load is not cached, so the next attach
 * retries.
 */
export function loadUIKitFont(): Promise<UIKitFont> {
  if (!fontPromise) {
    fontPromise = loadDefaultFont().catch((error: unknown) => {
      fontPromise = null
      throw error
    })
  }
  return fontPromise
}

/**
 * Draws NiiVue's vector annotations (the measure tool's rulers, plus any ROI
 * shapes) with @niivue/uikit through the controller's overlay hook. Pair with
 * `nv.isAnnotationDrawn = false` so core doesn't draw them too.
 *
 * NiiVue recomputes the screen projection every frame, so this pulls it in
 * `drawOverlay` rather than having it pushed (uikit's own
 * `UIKitAnnotationOverlay` is push-only), and rebuilds geometry only when the
 * projection, labels or dpr change.
 */
export class AnnotationLayer implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private lastSignature = ''

  constructor(
    font: UIKitFont,
    private readonly getShapes: () => readonly AnnotationScreenShape[],
  ) {
    this.labels = new UIKitTextOverlay(font)
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const shapes = this.getShapes()
    const signature = shapeSignature(shapes, frame.dpr)
    if (signature !== this.lastSignature) {
      this.lastSignature = signature
      const geometry = buildAnnotationGeometry(shapes, {
        dpr: frame.dpr,
        labelCssPx: LABEL_CSS_PX,
      })
      this.lines.setLines(geometry.lines)
      this.labels.setItems(geometry.text)
    }
    if (shapes.length === 0) return
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}

// Everything the geometry depends on, with points rounded to whole pixels. The
// label text is included because editing a label changes nothing geometric.
function shapeSignature(
  shapes: readonly AnnotationScreenShape[],
  dpr: number,
): string {
  let signature = `${dpr}`
  for (const shape of shapes) {
    signature += `|${shape.id};`
    for (const point of shape.outer)
      signature += `${point.x | 0},${point.y | 0};`
    if (shape.start) signature += `s${shape.start.x | 0},${shape.start.y | 0};`
    if (shape.end) signature += `e${shape.end.x | 0},${shape.end.y | 0};`
    if (shape.start2) {
      signature += `S${shape.start2.x | 0},${shape.start2.y | 0};`
    }
    if (shape.end2) signature += `E${shape.end2.x | 0},${shape.end2.y | 0};`
    if (shape.label) signature += `t${shape.label.lines.join('\n')};`
  }
  return signature
}
