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
