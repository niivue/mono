import * as NVTransforms from '@/math/NVTransforms'

/** A two-finger pinch, captured when the second finger lands. */
export type Pinch = {
  /** Finger distance at the start, in CSS px. */
  distance: number
  /** pan2Dxyzmm at the start. */
  pan: number[]
  /** scaleMultiplier at the start. */
  scale: number
  /** The 2D zoom anchor (as the wheel's), or null for a pinch on the 3D render. */
  anchorMM: ArrayLike<number> | null
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v))

/**
 * A yoked 2D zoom after the 3D zoom moved from `scaleBefore` to `scaleAfter`:
 * scaled by the same ratio, not set equal, so a 2D zoom past the 3D range (0.5-2)
 * does not snap back into it.
 */
export const yokedZoom2D = (
  zoom2D: number,
  scaleBefore: number,
  scaleAfter: number,
): number =>
  clamp(
    (zoom2D * scaleAfter) / scaleBefore,
    NVTransforms.ZOOM_2D_MIN,
    NVTransforms.ZOOM_2D_MAX,
  )

/**
 * The camera once the fingers are `distance` apart: a 2D tile zooms about the
 * anchor within the wheel's limits; the 3D render scales within the wheel's
 * 0.5-2 range. Yoked, each follows the other.
 */
export function pinchCamera(
  pinch: Pinch,
  distance: number,
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
  isYoked3DTo2DZoom: boolean,
): { pan2Dxyzmm?: number[]; scaleMultiplier?: number } {
  const ratio = distance / pinch.distance
  if (!pinch.anchorMM) {
    const scale = clamp(pinch.scale * ratio, 0.5, 2)
    // Yoked, the slices zoom by the same ratio and keep their pan.
    return isYoked3DTo2DZoom
      ? {
          pan2Dxyzmm: [
            ...pinch.pan.slice(0, 3),
            yokedZoom2D(pinch.pan[3], pinch.scale, scale),
          ],
          scaleMultiplier: scale,
        }
      : { scaleMultiplier: scale }
  }
  const zoom = clamp(
    pinch.pan[3] * ratio,
    NVTransforms.ZOOM_2D_MIN,
    NVTransforms.ZOOM_2D_MAX,
  )
  const pan = NVTransforms.zoomPan2DAbout(
    pinch.pan,
    zoom,
    pinch.anchorMM,
    extentsMin,
    extentsMax,
  )
  return isYoked3DTo2DZoom
    ? { pan2Dxyzmm: [...pan, zoom], scaleMultiplier: zoom }
    : { pan2Dxyzmm: [...pan, zoom] }
}
