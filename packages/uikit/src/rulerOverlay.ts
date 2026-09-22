// A UIKit overlay that draws a ruler (buildRuler) through the niivue overlay hook.
// It composes the line and text draw paths: set a ruler spec, and each frame it
// draws the arrowed baseline + ticks and the rotated label on the live backend.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { UIKitLineOverlay } from './lineOverlay'
import { buildRuler, type RulerSpec } from './ruler'
import type { UIKitFont } from './text/font'
import { UIKitTextOverlay } from './textOverlay'

export class UIKitRulerOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private hasRuler = false

  constructor(font: UIKitFont, spec?: RulerSpec) {
    this.labels = new UIKitTextOverlay(font)
    if (spec) this.setRuler(spec)
  }

  /** Set (or update) the ruler. Trigger a redraw via the controller. */
  setRuler(spec: RulerSpec): void {
    const geo = buildRuler(spec)
    this.lines.setLines(geo.lines)
    this.labels.setItems(geo.text)
    this.hasRuler = true
  }

  /** Clear the ruler so nothing draws. */
  clear(): void {
    this.lines.setLines([])
    this.labels.setItems([])
    this.hasRuler = false
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (!this.hasRuler) return
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}
