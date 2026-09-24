import { isPaqd, NiiIntentCode } from '@/NVConstants'
import type { NVImage } from '@/NVTypes'

/** 2D slice filtering for the background texture and the combined overlay texture. */
export type SliceInterpolation = { background: boolean; overlay: boolean }

/**
 * Whether 2D slices should sample this volume nearest-neighbour. An explicit
 * `isNearestInterpolation` wins; otherwise categorical data (a
 * NIFTI_INTENT_LABEL header or a label colormap) is nearest, because blending
 * neighbouring label colours shows colours no label has, and continuous data
 * is linear.
 */
export function isNearestVolume(
  vol: Pick<NVImage, 'hdr' | 'colormapLabel' | 'isNearestInterpolation'>,
): boolean {
  return (
    vol.isNearestInterpolation ??
    (vol.hdr.intent_code === NiiIntentCode.NIFTI_INTENT_LABEL ||
      !!vol.colormapLabel)
  )
}

/**
 * Resolve the 2D filters for one frame. Overlays share a single blended
 * texture, so it is nearest when any visible overlay is: nearest never shows a
 * value absent from the data. PAQD volumes have their own texture and are
 * skipped. `forceNearest` is the scene-wide `volumeIsNearestInterpolation`.
 */
export function sliceInterpolation(
  volumes: readonly NVImage[],
  forceNearest: boolean,
): SliceInterpolation {
  if (forceNearest) return { background: true, overlay: true }
  const [background, ...overlays] = volumes
  return {
    background: !!background && isNearestVolume(background),
    overlay: overlays.some(
      (v) => (v.opacity ?? 1) > 0 && !isPaqd(v.hdr) && isNearestVolume(v),
    ),
  }
}
