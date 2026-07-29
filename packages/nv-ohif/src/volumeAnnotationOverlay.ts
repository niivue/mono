import type {
  AnnotationScreenShape,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from '@niivue/niivue'
import {
  buildAnnotationGeometry,
  type UIKitFont,
  UIKitLineOverlay,
  UIKitTextOverlay,
} from '@niivue/uikit'

const LABEL_CSS_PX = 14

/**
 * Draws NiiVue's vector annotations (ellipse / rectangle / circle / line / arrow
 * ROIs) as @niivue/uikit shapes through the controller's overlay hook, so the
 * ROIs render in UIKit instead of NiiVue's built-in on-canvas annotation drawing
 * (which the caller disables with `nv.isAnnotationDrawn = false`). Reads the
 * current screen projection from `nv.annotationScreenShapes` each frame so the
 * shapes track pan / zoom / slice changes, rebuilding geometry only when the
 * projection or dpr changes.
 */
export class VolumeAnnotationOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private lastSig = ''

  constructor(
    font: UIKitFont,
    private readonly getShapes: () => readonly AnnotationScreenShape[],
  ) {
    this.labels = new UIKitTextOverlay(font)
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const dpr = frame.dpr
    const shapes = this.getShapes()
    // Cheap signature of everything the shape geometry depends on (projected
    // outer points + endpoints, rounded to px), so we relayout only on change.
    let sig = `${dpr}`
    for (const s of shapes) {
      sig += `|${s.id};`
      for (const p of s.outer) sig += `${p.x | 0},${p.y | 0};`
      if (s.start) sig += `s${s.start.x | 0},${s.start.y | 0};`
      if (s.end) sig += `e${s.end.x | 0},${s.end.y | 0};`
    }
    if (sig !== this.lastSig) {
      this.lastSig = sig
      const geo = buildAnnotationGeometry(shapes, {
        dpr,
        labelCssPx: LABEL_CSS_PX,
      })
      this.lines.setLines(geo.lines)
      this.labels.setItems(geo.text)
    }
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}
