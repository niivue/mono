// Line drawing for UIKit. Duplicated from niivue core (`view/NVLine.ts`) on
// purpose: during the UIKit bake-in phase, UIKit carries its own rendering so
// core stays untouched and unbroken. After UIKit is proven, core's overlays cut
// over onto this and the duplicate in core is removed. See docs/ruler-port.md in
// @niivue/niivue.

// A drawable line record: [sx, sy, ex, ey, thickness, 0, 0, 0, r, g, b, a] in
// canvas-pixel coordinates. The extra zeros mirror the core layout so the UIKit
// line renderer (added later) and the core one share a wire format.
export type LineData = { data: Float32Array }

export const FLOATS_PER_LINE = 12

export function buildLine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thickness = 2,
  color: number[] = [1, 1, 0, 1],
): LineData {
  const data = new Float32Array([
    startX,
    startY,
    endX,
    endY,
    thickness,
    0,
    0,
    0,
    ...color,
  ])
  return { data }
}

/**
 * Line-end decorations. Only NONE and ARROW are implemented; CIRCLE and RING are
 * reserved so callers and the enum can grow to the old uikit terminator set (they
 * need a filled-disc primitive that this line-segment builder does not provide).
 */
export enum LineTerminator {
  NONE = 0,
  ARROW = 1,
  CIRCLE = 2,
  RING = 3,
}

export interface LineTerminators {
  /** Decoration at the start point. Defaults to NONE. */
  start?: LineTerminator
  /** Decoration at the end point. Defaults to NONE. */
  end?: LineTerminator
}

// Arrowhead half-angle (the splay of each barb from the shaft), in radians.
const ARROW_HALF_ANGLE = (30 * Math.PI) / 180
// Arrowhead barb length in canvas pixels, scaled to line thickness.
function arrowLength(thickness: number): number {
  return Math.max(8, thickness * 4)
}

// Two barbs at `tip`, opening backward along `-dir` (dir points toward the tip).
function arrowBarbs(
  tipX: number,
  tipY: number,
  dirX: number,
  dirY: number,
  thickness: number,
  color: number[],
): LineData[] {
  const len = arrowLength(thickness)
  const bx = -dirX
  const by = -dirY
  const rotate = (x: number, y: number, a: number): [number, number] => [
    x * Math.cos(a) - y * Math.sin(a),
    x * Math.sin(a) + y * Math.cos(a),
  ]
  const [lx, ly] = rotate(bx, by, ARROW_HALF_ANGLE)
  const [rx, ry] = rotate(bx, by, -ARROW_HALF_ANGLE)
  return [
    buildLine(tipX, tipY, tipX + lx * len, tipY + ly * len, thickness, color),
    buildLine(tipX, tipY, tipX + rx * len, tipY + ry * len, thickness, color),
  ]
}

/**
 * A line plus optional end/start terminators, returned as plain {@link LineData}
 * segments (the shaft first, then any terminator barbs). Terminators are composed
 * from short line segments, so a plain line renderer draws them unchanged and both
 * backends render them identically. Mirrors the old uikit `drawLine({ terminator })`
 * in this data-emitting model.
 *
 * ARROW shortens the shaft by half a barb length at the terminated end so it does
 * not poke through the arrowhead. A zero-length line has no direction, so it is
 * returned as the bare shaft with no terminators.
 */
export function buildTerminatedLine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thickness = 2,
  color: number[] = [1, 1, 0, 1],
  terminators: LineTerminators = {},
): LineData[] {
  const { start = LineTerminator.NONE, end = LineTerminator.NONE } = terminators
  for (const t of [start, end]) {
    if (t === LineTerminator.CIRCLE || t === LineTerminator.RING) {
      throw new Error(
        `buildTerminatedLine: terminator ${LineTerminator[t]} is not implemented`,
      )
    }
  }

  const dx = endX - startX
  const dy = endY - startY
  const len = Math.hypot(dx, dy)
  if (len === 0) {
    return [buildLine(startX, startY, endX, endY, thickness, color)]
  }

  const ux = dx / len
  const uy = dy / len
  const inset = arrowLength(thickness) / 2

  // Shorten the shaft under any ARROW so it stops at the barb base, not the tip.
  let sx = startX
  let sy = startY
  let ex = endX
  let ey = endY
  if (end === LineTerminator.ARROW) {
    ex -= ux * inset
    ey -= uy * inset
  }
  if (start === LineTerminator.ARROW) {
    sx += ux * inset
    sy += uy * inset
  }

  const out: LineData[] = [buildLine(sx, sy, ex, ey, thickness, color)]
  if (end === LineTerminator.ARROW) {
    out.push(...arrowBarbs(endX, endY, ux, uy, thickness, color))
  }
  if (start === LineTerminator.ARROW) {
    out.push(...arrowBarbs(startX, startY, -ux, -uy, thickness, color))
  }
  return out
}
