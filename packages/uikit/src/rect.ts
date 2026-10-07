// Filled rounded-rectangle drawing for UIKit. Lines and text cover strokes and
// labels; this is the first FILLED primitive, the surface a button (and later a
// panel or slider track) sits on. Like `LineData`, a rect is a flat float record
// that both backend renderers consume unchanged: an instanced quad expanded in
// the vertex stage, with the rounded corners, the border ring and the 1px edge
// antialiasing resolved by a signed-distance function in the fragment stage.

// A drawable rect record, in canvas-pixel coordinates (y-down):
//   [x, y, width, height, cornerRadius, borderWidth, 0, 0,
//    fillR, fillG, fillB, fillA, borderR, borderG, borderB, borderA]
// The two zeros pad the header to a 16-byte boundary for the WebGPU storage
// layout; the WebGL2 attribute layout mirrors it so the record is shared.
export type RectData = { data: Float32Array }

export const FLOATS_PER_RECT = 16

export interface RectSpec {
  /** Top-left corner in canvas pixels. */
  x: number
  y: number
  width: number
  height: number
  /** Corner radius in pixels; clamped to half the shorter side. Default 0. */
  radius?: number
  /** Border ring width in pixels, drawn inside the rect edge. Default 0. */
  borderWidth?: number
  /** Interior color. Default an opaque mid grey. */
  fill?: readonly number[]
  /** Border ring color. Default the fill color (an invisible border). */
  border?: readonly number[]
}

export function buildRect(spec: RectSpec): RectData {
  const radius = Math.max(
    0,
    Math.min(spec.radius ?? 0, spec.width / 2, spec.height / 2),
  )
  const fill = spec.fill ?? [0.5, 0.5, 0.5, 1]
  const border = spec.border ?? fill
  const data = new Float32Array(FLOATS_PER_RECT)
  data[0] = spec.x
  data[1] = spec.y
  data[2] = spec.width
  data[3] = spec.height
  data[4] = radius
  data[5] = Math.max(0, spec.borderWidth ?? 0)
  data.set(fill.slice(0, 4), 8)
  data.set(border.slice(0, 4), 12)
  return { data }
}

/** True when canvas point (px, py) lies inside the rect's axis-aligned box. */
export function rectContains(
  rect: { x: number; y: number; width: number; height: number },
  px: number,
  py: number,
): boolean {
  return (
    px >= rect.x &&
    px < rect.x + rect.width &&
    py >= rect.y &&
    py < rect.y + rect.height
  )
}
