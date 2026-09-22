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
 * A contour belongs to one exact slice, not merely one slice orientation.
 */
export function shouldStartFreshMultiClickContour(
  hasPoints: boolean,
  previousSliceType: number,
  previousSlicePosition: number,
  sliceType: number,
  slicePosition: number,
): boolean {
  return (
    !hasPoints ||
    previousSliceType !== sliceType ||
    Math.abs(previousSlicePosition - slicePosition) > 1e-3
  )
}
