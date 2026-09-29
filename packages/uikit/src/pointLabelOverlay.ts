// A UIKit overlay that draws point labels (buildPointLabel) through the niivue
// overlay hook. Labels are given in world mm; the host supplies the projection
// to canvas pixels (for the 3D render, NiiVue's `mmToRenderCanvas`, fed through
// `explodedMM` when the volume is exploded). The projection runs every frame,
// so the labels follow a rotating or panning render with no host bookkeeping.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import { buildPointLabel, type PointLabelSpec } from './pointLabel'
import type { Vec2 } from './ruler'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export type MMPoint = readonly [number, number, number]

/** Maps a world-mm point to canvas backing-store pixels, or null if off screen. */
export type MMProjector = (mm: MMPoint) => [number, number] | null

/**
 * A label pinned to a world-mm point; the rest styles the callout. Pixel
 * sizes are in CSS pixels: the overlay scales them by the frame's device
 * pixel ratio (times any `scale` given here).
 */
export type PointLabelPlacement = Omit<
  PointLabelSpec,
  'target' | 'bounds' | 'box'
> & {
  mm: MMPoint
  /**
   * The eight world-mm corners of a box to outline around the point (the
   * volume brick holding it, say), in the corner order `PointLabelSpec.box`
   * describes. The overlay projects them each frame.
   */
  boxMM?: readonly MMPoint[]
}

export class UIKitPointLabelOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly font: UIKitFont
  private placements: PointLabelPlacement[] = []

  constructor(
    font: UIKitFont,
    private project: MMProjector,
    labels?: PointLabelPlacement[],
  ) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    if (labels) this.setLabels(labels)
  }

  /** Replace the labels. Trigger a redraw via the host. */
  setLabels(labels: PointLabelPlacement[]): void {
    this.placements = labels.slice()
  }

  /** Swap the projection (after a view change, say). */
  setProjector(project: MMProjector): void {
    this.project = project
  }

  /** Remove every label so nothing draws. */
  clear(): void {
    this.placements = []
    this.lines.setLines([])
    this.labels.setItems([])
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.placements.length === 0) return
    const lines: LineData[] = []
    const text: UIKitTextItem[] = []
    for (const placement of this.placements) {
      const { mm, boxMM, ...style } = placement
      const target = this.project(mm)
      if (!target) continue
      const geo = buildPointLabel(this.font.metrics, {
        ...style,
        target,
        bounds: frame.bounds,
        box: this.projectBox(boxMM),
        scale: (style.scale ?? 1) * frame.dpr,
      })
      lines.push(...geo.lines)
      text.push(...geo.text)
    }
    if (lines.length === 0) return
    this.lines.setLines(lines)
    this.labels.setItems(text)
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** The box's corners on the canvas, or undefined when any is off screen. */
  private projectBox(boxMM?: readonly MMPoint[]): Vec2[] | undefined {
    if (!boxMM || boxMM.length !== 8) return undefined
    const corners: Vec2[] = []
    for (const mm of boxMM) {
      const p = this.project(mm)
      if (!p) return undefined
      corners.push(p)
    }
    return corners
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}
