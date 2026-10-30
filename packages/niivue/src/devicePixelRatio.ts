/**
 * The device pixel ratio a canvas renders at: `forced` when it is above 0
 * (the `devicePixelRatio` option; -1 means auto), else the window's ratio, else
 * 1 outside a window.
 */
export function effectiveDevicePixelRatio(forced = -1): number {
  if (forced > 0) return forced
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}
