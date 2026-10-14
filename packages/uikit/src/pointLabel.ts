// The UIKit point label: a text callout tied to a screen point by a leader
// line, with a small diamond marking the point itself. It annotates a location
// the viewer computes (an atlas region's centroid on the 3D render, say) without
// covering it: the text sits at the far end of the leader, underlined, and by
// default the leader points away from the frame centre so labels on a rotating
// volume swing outward instead of across it. `buildPointLabel` is pure and
// unit-testable; the overlay (pointLabelOverlay.ts) projects the world point
// each frame and draws the result.

import { buildLine, type LineData } from './line'
import type { RGBA, Vec2 } from './ruler'
import type { UIKitFontMetrics } from './text/font'
import { measureWidth } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

export interface PointLabelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PointLabelSpec {
  /** The labelled point in screen pixels. */
  target: Vec2
  text: string
  /**
   * Where the leader ends and the text starts, in screen pixels. Omit to place
   * it `leaderLength` from the target, pointing away from the centre of
   * `bounds` (or up and to the right without bounds).
   */
  anchor?: Vec2
  /**
   * The drawable area. Used to choose the automatic anchor direction and to
   * keep the text inside the frame: the text flips to the other side of the
   * anchor when it would run off an edge.
   */
  bounds?: PointLabelBounds
  /**
   * The eight projected corners of a box to outline around the target (a
   * volume brick, say), in screen pixels. Corner `c` sits at the box's
   * minimum on each axis whose bit of `c` is clear and at its maximum where
   * it is set, so the twelve edges join corners whose indices differ in one
   * bit. Omit for no box.
   */
  box?: readonly Vec2[]
  /** Colour of the box edges. Defaults to `lineColor`. */
  boxColor?: RGBA
  /** Thickness of the box edges in pixels. Defaults to `thickness`. */
  boxThickness?: number
  /** Leader length for the automatic anchor, in pixels. Default 110. */
  leaderLength?: number
  /** Text height in pixels. Default 28. */
  sizePx?: number
  lineColor?: RGBA
  textColor?: RGBA
  /** Line thickness in pixels. Default 3. */
  thickness?: number
  /** Half-size of the diamond marking the target, in pixels. Default 6. */
  markerSize?: number
  /** Text outline width in pixels, 0 for none. Default 2. */
  textOutlineWidthPx?: number
  /**
   * Multiplies every pixel size above (given or default), so one spec reads
   * the same on a 1x and a 2x display. The overlay passes the frame's device
   * pixel ratio. Default 1.
   */
  scale?: number
}

export interface PointLabelGeometry {
  lines: LineData[]
  text: UIKitTextItem[]
  /** The resolved anchor (useful for tests and for chaining labels). */
  anchor: Vec2
}

const YELLOW: RGBA = [1, 1, 0, 1]
const WHITE: RGBA = [1, 1, 1, 1]
const ROOT_HALF = Math.SQRT1_2

function autoAnchor(
  target: Vec2,
  bounds: PointLabelBounds | undefined,
  leaderLength: number,
): Vec2 {
  let dx = ROOT_HALF
  let dy = -ROOT_HALF
  if (bounds) {
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    const vx = target[0] - cx
    const vy = target[1] - cy
    const len = Math.hypot(vx, vy)
    if (len > 1e-6) {
      dx = vx / len
      dy = vy / len
    }
  }
  return [target[0] + dx * leaderLength, target[1] + dy * leaderLength]
}

/**
 * Build the line + text draw data for a point label. Pure geometry; the font
 * metrics are only used to measure the text so it can be kept in frame.
 */
export function buildPointLabel(
  metrics: UIKitFontMetrics,
  spec: PointLabelSpec,
): PointLabelGeometry {
  const { target, text, bounds, lineColor = YELLOW, textColor = WHITE } = spec
  const scale = spec.scale ?? 1
  const leaderLength = (spec.leaderLength ?? 110) * scale
  const sizePx = (spec.sizePx ?? 28) * scale
  const thickness = (spec.thickness ?? 3) * scale
  const markerSize = (spec.markerSize ?? 6) * scale
  const textOutlineWidthPx = (spec.textOutlineWidthPx ?? 2) * scale
  const boxColor = spec.boxColor ?? lineColor
  const boxThickness = (spec.boxThickness ?? spec.thickness ?? 3) * scale
  const anchor = spec.anchor ?? autoAnchor(target, bounds, leaderLength)
  const lines: LineData[] = []
  const items: UIKitTextItem[] = []

  // The box around the target's brick: twelve edges between corners that
  // differ in one index bit, so any projection of a hexahedron outlines it.
  if (spec.box && spec.box.length === 8) {
    const box = spec.box
    for (let a = 0; a < 8; a++) {
      for (const bit of [1, 2, 4]) {
        const b = a | bit
        if (b === a) continue
        const p = box[a]
        const q = box[b]
        lines.push(buildLine(p[0], p[1], q[0], q[1], boxThickness, boxColor))
      }
    }
  }

  // Diamond marker on the point itself, so the leader's origin is unambiguous
  // even when the label is far away.
  if (markerSize > 0) {
    const m = markerSize
    const [tx, ty] = target
    const corners: Vec2[] = [
      [tx, ty - m],
      [tx + m, ty],
      [tx, ty + m],
      [tx - m, ty],
    ]
    for (let i = 0; i < 4; i++) {
      const a = corners[i]
      const b = corners[(i + 1) % 4]
      lines.push(buildLine(a[0], a[1], b[0], b[1], thickness, lineColor))
    }
  }

  // Leader from the marker to the anchor.
  if (anchor[0] !== target[0] || anchor[1] !== target[1]) {
    lines.push(
      buildLine(
        target[0],
        target[1],
        anchor[0],
        anchor[1],
        thickness,
        lineColor,
      ),
    )
  }

  // The text runs away from the target along the underline, so the leader
  // never crosses it. Flip it back when that would leave the frame.
  const width = measureWidth(metrics, text, sizePx)
  const gap = sizePx * 0.3
  let rightward = anchor[0] >= target[0]
  if (bounds) {
    const right = bounds.x + bounds.width
    if (rightward && anchor[0] + gap + width > right) rightward = false
    else if (!rightward && anchor[0] - gap - width < bounds.x) rightward = true
  }
  const dir = rightward ? 1 : -1
  const endX = anchor[0] + dir * (gap + width)
  lines.push(
    buildLine(anchor[0], anchor[1], endX, anchor[1], thickness, lineColor),
  )
  items.push({
    str: text,
    x: anchor[0] + dir * gap,
    y: anchor[1] - sizePx * 0.25,
    sizePx,
    align: rightward ? 0 : 1,
    color: textColor,
    outlineWidthPx: textOutlineWidthPx,
  })

  return { lines, text: items, anchor }
}
