// A UIKit overlay that draws a crosshair (buildCrosshair) through the niivue
// overlay hook. Set a position each time the tracked point moves and it redraws
// on the live backend, on a NiiVue canvas (`nv.registerOverlayRenderer`) or on a
// standalone slide pane (`renderer.overlayDraw`) alike.
//
// The spec is supplied WITHOUT the frame extent: the overlay fills that in from
// the frame it is handed, so a host that resizes its canvas does not have to
// re-set the crosshair to keep the arms reaching the new edges.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { buildCrosshair, type CrosshairSpec } from './crosshair'
import { UIKitLineOverlay } from './lineOverlay'
import type { UIKitFont } from './text/font'
import { UIKitTextOverlay } from './textOverlay'

export type CrosshairPlacement = Omit<CrosshairSpec, 'width' | 'height'>

export class UIKitCrosshairOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  // Graduation numbers need a font. Without one the widget still draws the cross
  // and its ticks, so a host that never numbers them pays for no atlas.
  private readonly labels: UIKitTextOverlay | null
  private placement: CrosshairPlacement | null = null
  // Extent the current geometry was built for. The arms are clipped to the frame
  // and the ticks stop at its edges, so a resize has to rebuild them.
  private builtFor: [number, number] = [0, 0]

  constructor(font?: UIKitFont, placement?: CrosshairPlacement) {
    this.labels = font ? new UIKitTextOverlay(font) : null
    if (placement) this.setCrosshair(placement)
  }

  /** Set (or move) the crosshair. Trigger a redraw via the host. */
  setCrosshair(placement: CrosshairPlacement): void {
    this.placement = placement
    this.builtFor = [0, 0]
  }

  /** Clear the crosshair so nothing draws. */
  clear(): void {
    this.placement = null
    this.builtFor = [0, 0]
    this.lines.setLines([])
    this.labels?.setItems([])
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const placement = this.placement
    if (!placement) return
    const { width, height } = frame.bounds
    if (width !== this.builtFor[0] || height !== this.builtFor[1]) {
      const geo = buildCrosshair({ ...placement, width, height })
      this.lines.setLines(geo.lines)
      this.labels?.setItems(geo.text)
      this.builtFor = [width, height]
    }
    this.lines.drawOverlay(frame)
    this.labels?.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.lines.destroy()
    this.labels?.destroy()
  }
}
