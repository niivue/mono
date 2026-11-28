// The line record uikit's line renderers draw, for uikit's overlays and NiiVue
// core's lines alike.

// A drawable line record: [sx, sy, ex, ey, thickness, 0, 0, 0, r, g, b, a] in
// canvas-pixel coordinates (the zeros pad the colour to a 16-byte boundary).
export type LineData = { data: Float32Array }

export const FLOATS_PER_LINE = 12

export function buildLine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thickness = 2,
  color: readonly number[] = [1, 1, 0, 1],
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
