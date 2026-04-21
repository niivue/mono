import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'

const OUT_OF_RANGE = 1e9

/**
 * Compute crosscut uniform vec4 for a given tile orientation.
 * xyz = crosshair position in mm (masked to OUT_OF_RANGE for 2D axes that shouldn't render)
 * w = distance threshold in mm
 */
export function crosscutMM(md: NVModel, axCorSag: number): number[] {
  const mm = md.scene2mm(md.scene.crosshairPos)
  const is2D = axCorSag !== NVConstants.SLICE_TYPE.RENDER
  if (is2D) {
    if (axCorSag === NVConstants.SLICE_TYPE.SAGITTAL) {
      mm[1] = OUT_OF_RANGE
      mm[2] = OUT_OF_RANGE
    } else if (axCorSag === NVConstants.SLICE_TYPE.CORONAL) {
      mm[0] = OUT_OF_RANGE
      mm[2] = OUT_OF_RANGE
    } else {
      mm[0] = OUT_OF_RANGE
      mm[1] = OUT_OF_RANGE
    }
  }
  return [mm[0], mm[1], mm[2], 2.0]
}
