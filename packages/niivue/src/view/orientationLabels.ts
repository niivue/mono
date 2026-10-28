import * as NVConstants from '@/NVConstants'
import type { OrientationTextPosition } from '@/NVTypes'
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
 * The backends draw `left` and `top` (see {@link orientationTextPlacements});
 * `right` and `bottom` are here so other text can use the same source of truth.
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

/** One orientation label to draw: its text, anchor point and anchor. */
export type OrientationTextPlacement = {
  text: string
  /** Canvas x of the anchor point, in pixels. */
  x: number
  /** Canvas y of the anchor point, in pixels (down from the top). */
  y: number
  /** 0 aligns the text's left edge with `x`, 0.5 centres it, 1 its right edge. */
  anchorX: number
  /** 0 hangs the text below `y`, 0.5 centres it, 1 sits it above. */
  anchorY: number
}

/**
 * Where the orientation text of one 2D tile goes, for both backends.
 *
 * - `'edges'`: the left letter at the middle of the left edge and the top
 *   letter at the middle of the top edge.
 * - `'corner'`: one label, the left letter then the top letter (`RS` for a
 *   radiological coronal tile, `AS` for a nose-left sagittal one), hanging
 *   from the tile's top-left corner, as the old package's
 *   `isCornerOrientationText` drew it.
 *
 * `ltwh` is the tile rectangle in canvas pixels (left, top, width, height) and
 * `margin` the gap kept from the tile's edges. Returns no labels for tiles that
 * are not a 2D slice. Whether to draw at all (`isOrientationTextVisible`, the
 * mosaic `L` tag) is the caller's decision.
 */
export function orientationTextPlacements(
  axCorSag: number,
  layout: SliceOrientationSettings,
  position: OrientationTextPosition,
  ltwh: ArrayLike<number>,
  margin = 4,
): OrientationTextPlacement[] {
  const edges = sliceEdgeLabels(axCorSag, layout)
  if (!edges) return []
  const [left, top, width, height] = [ltwh[0], ltwh[1], ltwh[2], ltwh[3]]
  if (position === 'corner') {
    return [
      {
        text: edges.left + edges.top,
        x: left + margin,
        y: top + margin,
        anchorX: 0,
        anchorY: 0,
      },
    ]
  }
  return [
    {
      text: edges.left,
      x: left + margin,
      y: top + height / 2,
      anchorX: 0,
      anchorY: 0.5,
    },
    {
      text: edges.top,
      x: left + width / 2,
      y: top + margin,
      anchorX: 0.5,
      anchorY: 0,
    },
  ]
}
