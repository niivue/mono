import type {
  AnnotationPoint,
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
 * 32-bit FNV-1a hash of everything the geometry + labels depend on: projected
 * points truncated to px, plus the label text (a label edit changes nothing
 * geometric, so it must be hashed too). Runs every frame, so no string building.
 * ponytail: a collision (~1 in 4e9 per change) skips one relayout until the next
 * change; a core-side annotation revision counter would remove it.
 */
export function shapesSignature(
  shapes: readonly AnnotationScreenShape[],
): number {
  let h = 0x811c9dc5
  const mix = (v: number) => {
    h = Math.imul(h ^ v, 0x01000193)
  }
  const str = (t: string) => {
    mix(t.length)
    for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i))
  }
  // Tag each optional point so a missing one cannot alias a present one.
  const pt = (tag: number, p: AnnotationPoint | undefined) => {
    if (!p) return
    mix(tag)
    mix(p.x | 0)
    mix(p.y | 0)
  }
  const ring = (r: readonly AnnotationPoint[]) => {
    mix(r.length)
    for (const p of r) {
      mix(p.x | 0)
      mix(p.y | 0)
    }
  }
  mix(shapes.length)
  for (const s of shapes) {
    str(s.id)
    mix(s.polygons.length)
    for (const poly of s.polygons) {
      mix(poly.holes.length)
      ring(poly.outer)
      for (const hole of poly.holes) ring(hole)
    }
    pt(1, s.start)
    pt(2, s.end)
    pt(3, s.start2)
    pt(4, s.end2)
    // The ruler label reads length to 0.1 mm, which a sub-pixel move can change.
    if (s.length !== undefined) mix(Math.round(s.length * 10))
    if (s.label) for (const line of s.label.lines) str(line)
  }
  return h
}

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
  private lastSig = 0
  private lastDpr = 0

  constructor(
    font: UIKitFont,
    private readonly getShapes: () => readonly AnnotationScreenShape[],
  ) {
    this.labels = new UIKitTextOverlay(font)
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const dpr = frame.dpr
    const shapes = this.getShapes()
    const sig = shapesSignature(shapes)
    if (sig !== this.lastSig || dpr !== this.lastDpr) {
      this.lastSig = sig
      this.lastDpr = dpr
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
