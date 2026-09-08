import type NiiVue from '@/NVControl'
import type { ViewHitTest } from '@/NVTypes'
import * as NVSliceLayout from '@/view/NVSliceLayout'

/**
 * Resolve the mm-space anchor point for a 2D wheel zoom.
 *
 * With `interaction.wheelZoomAnchor === 'crosshair'` (the default) the anchor
 * is the crosshair position, preserving the behavior pinned by issue #68 and
 * relied on by the DICOM-WSI integration contract (docs/dicom-wsi.md section 7).
 *
 * With `'pointer'` the anchor is the pointer's pick on the hovered slice tile
 * (OpenSeadragon-style zoom-to-cursor). When the pick misses — pointer off any
 * slice, no volumes, or the first frame before the tile cache is populated —
 * it falls back to the crosshair anchor.
 */
export function resolveWheelZoomAnchorMM(
  ctrl: NiiVue,
  canvasX: number,
  canvasY: number,
  hit: ViewHitTest,
): ArrayLike<number> {
  if (ctrl.model.interaction.wheelZoomAnchor === 'pointer') {
    const mm = NVSliceLayout.screenSlicePick(
      ctrl.view?.screenSlices ?? [],
      ctrl.model,
      canvasX,
      canvasY,
      hit,
    )
    if (mm) return mm
  }
  return ctrl.model.scene2mm(ctrl.model.scene.crosshairPos)
}
