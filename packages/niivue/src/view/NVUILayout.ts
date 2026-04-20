// Backend-agnostic UI element sizing and positioning based on canvas/tile dimensions.

export function estimateFontSize(
  canvasWidth: number,
  canvasHeight: number,
): number {
  const refArea = 800 * 600;
  const area = canvasWidth * canvasHeight;
  return 13 * Math.max(area / refArea, 1) ** 0.4;
}

/**
 * Resolve negative colormap calibration range from cal_minNeg/cal_maxNeg.
 * Returns [threshold, maxColor] where threshold is the smaller absolute magnitude
 * (closer to zero) and maxColor is the larger (further from zero).
 * Falls back to [cal_min, cal_max] when negative range is not finite.
 */
export function resolveNegativeRange(
  calMin: number,
  calMax: number,
  calMinNeg: number,
  calMaxNeg: number,
): [number, number] {
  if (Number.isFinite(calMinNeg) && Number.isFinite(calMaxNeg)) {
    return [
      Math.min(Math.abs(calMinNeg), Math.abs(calMaxNeg)),
      Math.max(Math.abs(calMinNeg), Math.abs(calMaxNeg)),
    ];
  }
  return [calMin, calMax];
}

export function orientCubePosition(
  ltwh: number[],
): { x: number; y: number; sz: number } | null {
  const sz = 0.05 * Math.min(ltwh[2], ltwh[3]);
  if (sz < 5) return null;
  return { x: 1.8 * sz, y: 1.8 * sz, sz };
}
