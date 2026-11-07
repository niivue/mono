import { type mat4, type vec3, vec4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type { SliceTile } from './NVSliceLayout'

// Scratch buffers to avoid per-call allocations
const _clip = vec4.create()
const _src = vec4.fromValues(0, 0, 0, 1)

/** Project a mm-space point to canvas pixels via a tile's cached MVP. */
export function projectMMToCanvas(
  mm: [number, number, number],
  mvpMatrix: mat4,
  ltwh: number[],
): [number, number] {
  _src[0] = mm[0]
  _src[1] = mm[1]
  _src[2] = mm[2]
  vec4.transformMat4(_clip, _src, mvpMatrix)
  return [
    ltwh[0] + (_clip[0] + 1) * 0.5 * ltwh[2],
    ltwh[1] + (1 - _clip[1]) * 0.5 * ltwh[3],
  ]
}

/** A 2D tile's cached picking matrices; null for the 3D render tile or one not yet drawn. */
export function tilePlane(
  tile: SliceTile,
): { mvp: mat4; ltwh: number[]; pn: vec3; pp: vec3 } | null {
  if (tile.axCorSag === SLICE_TYPE.RENDER) return null
  const { mvpMatrix, leftTopWidthHeight, planeNormal, planePoint } = tile
  if (!mvpMatrix || !leftTopWidthHeight || !planeNormal || !planePoint)
    return null
  return {
    mvp: mvpMatrix,
    ltwh: leftTopWidthHeight,
    pn: planeNormal,
    pp: planePoint,
  }
}
