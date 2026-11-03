/**
 * Whether a pointerdown should append another control point to an in-progress
 * multi-click contour. The second press of a double-click (`evt.detail > 1`)
 * closes the contour rather than adding a point, and a press coincident with
 * the last placed point (within tolerance) would only duplicate it — a
 * coincident pair can pass the >= 3-point commit guard with a degenerate
 * near-zero-area contour and puts a Catmull-Rom cusp at the close point.
 */
export function shouldAppendMultiClickPoint(
  clickCount: number,
  lastPoint: { x: number; y: number } | undefined,
  nextPoint: { x: number; y: number },
  tolerance: number,
): boolean {
  if (clickCount > 1) return false
  if (!lastPoint) return true
  return (
    Math.hypot(nextPoint.x - lastPoint.x, nextPoint.y - lastPoint.y) > tolerance
  )
}

/**
 * Whether a multi-click contour must abandon its prior points and start again.
 * A contour belongs to one exact slice, not merely one slice orientation:
 * depths within `tolerance` are the same slice. The caller passes texture
 * depths and half a slice when it has a volume, since on an oblique volume the
 * mm depth varies across one slice.
 */
export function shouldStartFreshMultiClickContour(
  hasPoints: boolean,
  previousSliceType: number,
  previousDepth: number,
  sliceType: number,
  depth: number,
  tolerance = 1e-3,
): boolean {
  return (
    !hasPoints ||
    previousSliceType !== sliceType ||
    Math.abs(previousDepth - depth) > tolerance
  )
}
