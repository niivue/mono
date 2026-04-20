export type LineData = { data: Float32Array };

export type BuildLineFn = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  color: number[],
) => LineData;

export const FLOATS_PER_LINE = 12;

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
  ]);
  return { data };
}
