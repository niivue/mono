/**
 * Per-axis crosshair color resolution.
 *
 * Kept in its own dependency-free module so it can be shared by the WebGL2 and
 * WebGPU crosshair renderers, the mosaic cross-line builder, and unit tests
 * without pulling in mesh/GPU code.
 */

/**
 * Resolve the crosshair color for a given world axis.
 *
 * @param axisIndex - 0 = X (left-right), 1 = Y (anterior-posterior),
 *   2 = Z (superior-inferior). For the 3D crosshair, cylinder index `i` maps to
 *   its axis via `Math.floor(i / 2)`.
 * @param crosshairColor - fallback RGBA used when no per-axis color applies.
 * @param perAxisColors - optional `[xColor, yColor, zColor]`. Used only when it
 *   contains exactly 3 entries and the requested axis holds a valid color with
 *   at least 3 channels. Otherwise `crosshairColor` is returned.
 * @returns the RGBA array to use for that axis.
 */
export function getAxisColor(
  axisIndex: number,
  crosshairColor: number[],
  perAxisColors?: number[][],
): number[] {
  if (
    perAxisColors &&
    perAxisColors.length === 3 &&
    axisIndex >= 0 &&
    axisIndex < 3
  ) {
    const c = perAxisColors[axisIndex]
    if (Array.isArray(c) && c.length >= 3) {
      return c
    }
  }
  return crosshairColor
}
