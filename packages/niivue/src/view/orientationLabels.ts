import * as NVConstants from '@/NVConstants'
import {
  type SliceOrientationSettings,
  sagittalNoseLeft,
} from './NVSliceLayout'

/**
 * The anatomical direction at each edge of a 2D slice tile, as the single
 * letters the orientation text draws (`L`/`R`, `A`/`P`, `S`/`I`).
 */
export type SliceEdgeLabels = {
  left: string
  right: string
  top: string
  bottom: string
}

/**
 * Which anatomical direction lies at each edge of a 2D slice tile.
 *
 * Shared by both backends so the letters cannot drift from the geometry: axial
 * and coronal follow `isRadiological` (radiological puts the subject's right on
 * the left of the screen), sagittal follows {@link sagittalNoseLeft}. Returns
 * null for tiles that are not a 2D slice (render tiles).
 *
 * The backends currently draw `left` and `top`; `right` and `bottom` are here
 * so other text (corner or edge labels) can use the same source of truth.
 */
export function sliceEdgeLabels(
  axCorSag: number,
  layout: SliceOrientationSettings,
): SliceEdgeLabels | null {
  const isRadiological = layout.isRadiological
  switch (axCorSag) {
    case NVConstants.SLICE_TYPE.AXIAL:
      return isRadiological
        ? { left: 'R', right: 'L', top: 'A', bottom: 'P' }
        : { left: 'L', right: 'R', top: 'A', bottom: 'P' }
    case NVConstants.SLICE_TYPE.CORONAL:
      return isRadiological
        ? { left: 'R', right: 'L', top: 'S', bottom: 'I' }
        : { left: 'L', right: 'R', top: 'S', bottom: 'I' }
    case NVConstants.SLICE_TYPE.SAGITTAL:
      return sagittalNoseLeft(layout)
        ? { left: 'A', right: 'P', top: 'S', bottom: 'I' }
        : { left: 'P', right: 'A', top: 'S', bottom: 'I' }
    default:
      return null
  }
}
