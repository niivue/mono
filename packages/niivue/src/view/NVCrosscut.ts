import { slicePlaneEquation } from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { SliceTile } from '@/view/NVSliceLayout'

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

/**
 * Cut planes for the `crosscut2` shader, packed as a column-major mat4
 * uniform: columns 0-2 are planes `[nx, ny, nz, d]` (unit normal, points p
 * on the plane satisfy dot(n, p) = d); column 3 is
 * `[tileWidthPx, tileHeightPx, lineWidthPx, planeCount]`.
 *
 * A 2D tile cuts its own voxel plane (the cached `planeNormal`/`planePoint`,
 * oblique when the background volume is). The render tile cuts the three
 * voxel planes through the crosshair. Without a volume the planes are the
 * world axes through the crosshair.
 */
export function crosscutPlanes(
  md: NVModel,
  tile: SliceTile,
  widthPx: number,
): Float32Array {
  const out = new Float32Array(16)
  const ltwh = tile.leftTopWidthHeight ?? [0, 0, 1, 1]
  const mm = md.scene2mm(md.scene.crosshairPos)
  const setPlane = (i: number, n: ArrayLike<number>, p: ArrayLike<number>) => {
    out.set([n[0], n[1], n[2], n[0] * p[0] + n[1] * p[1] + n[2] * p[2]], i * 4)
  }
  const sliceTypes =
    tile.axCorSag === NVConstants.SLICE_TYPE.RENDER
      ? [
          NVConstants.SLICE_TYPE.AXIAL,
          NVConstants.SLICE_TYPE.CORONAL,
          NVConstants.SLICE_TYPE.SAGITTAL,
        ]
      : [tile.axCorSag]
  sliceTypes.forEach((st, i) => {
    if (i === 0 && tile.planeNormal && tile.planePoint) {
      setPlane(0, tile.planeNormal, tile.planePoint)
      return
    }
    const dim = NVConstants.sliceTypeDim(st)
    const plane = md.tex2mm
      ? slicePlaneEquation(md.tex2mm, st, md.getSliceTexFrac(dim))
      : null
    if (plane) {
      setPlane(i, plane.normal, plane.point)
      return
    }
    const n = [0, 0, 0]
    n[dim] = 1
    const p = [mm[0], mm[1], mm[2]]
    if (tile.sliceMM !== undefined) p[dim] = tile.sliceMM
    setPlane(i, n, p)
  })
  out.set([ltwh[2], ltwh[3], widthPx, sliceTypes.length], 12)
  return out
}
