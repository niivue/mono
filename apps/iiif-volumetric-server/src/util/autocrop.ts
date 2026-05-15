// Tight-bbox autocrop for volume pyramid levels. Strips background-only
// borders from a downsampled volume and shifts the affine so world
// coordinates of any retained voxel are unchanged.

import type {
  Affine4x4,
  Shape3,
  VoxelArray,
} from '../adapters/volumeHandle.ts'
import { VolumeHandle } from '../adapters/volumeHandle.ts'

export type Bbox6 = readonly [number, number, number, number, number, number]

export function autocropBackground(volume: VolumeHandle): number {
  if (
    volume.dtype === 'uint8' ||
    volume.dtype === 'int8' ||
    volume.dtype === 'rgb24' ||
    volume.dtype === 'rgba32'
  ) {
    return 0
  }
  const { min } = volume.intensityRange()
  if (volume.dtype === 'float32' || volume.dtype === 'float64') return min
  return Math.round(min)
}

export function computeTightBbox(
  volume: VolumeHandle,
  background: number,
): Bbox6 | null {
  const [sx, sy, sz] = volume.shape
  const data = volume.data
  const colorBytes =
    volume.dtype === 'rgb24' ? 3 : volume.dtype === 'rgba32' ? 4 : 0

  let x0 = sx
  let y0 = sy
  let z0 = sz
  let x1 = -1
  let y1 = -1
  let z1 = -1

  if (colorBytes === 0) {
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        const rowBase = y * sx + z * sx * sy
        for (let x = 0; x < sx; x++) {
          if ((data[rowBase + x] as number) !== background) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
            if (z < z0) z0 = z
            if (z > z1) z1 = z
          }
        }
      }
    }
  } else {
    const bpcv = colorBytes
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          const off = (x + y * sx + z * sx * sy) * bpcv
          let fg = false
          for (let c = 0; c < bpcv; c++) {
            if ((data[off + c] as number) !== background) {
              fg = true
              break
            }
          }
          if (fg) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
            if (z < z0) z0 = z
            if (z > z1) z1 = z
          }
        }
      }
    }
  }

  if (x1 < 0) return null
  return [x0, y0, z0, x1 + 1, y1 + 1, z1 + 1]
}

export function cropVolume(volume: VolumeHandle, bbox: Bbox6): VolumeHandle {
  const [x0, y0, z0, x1, y1, z1] = bbox
  const cw = x1 - x0
  const ch = y1 - y0
  const cd = z1 - z0
  const [sx, sy] = volume.shape
  const colorBytes =
    volume.dtype === 'rgb24' ? 3 : volume.dtype === 'rgba32' ? 4 : 0
  const elemsPerVoxel = colorBytes || 1
  const TypedArrayCtor = volume.data.constructor as {
    new (length: number): VoxelArray
  }
  const out = new TypedArrayCtor(cw * ch * cd * elemsPerVoxel)
  for (let z = 0; z < cd; z++) {
    for (let y = 0; y < ch; y++) {
      const srcVox = x0 + (y0 + y) * sx + (z0 + z) * sx * sy
      const dstVox = y * cw + z * cw * ch
      const srcStart = srcVox * elemsPerVoxel
      const dstStart = dstVox * elemsPerVoxel
      const len = cw * elemsPerVoxel
      ;(out as { set: (src: VoxelArray, off: number) => void }).set(
        volume.data.subarray(srcStart, srcStart + len) as VoxelArray,
        dstStart,
      )
    }
  }
  const newShape: Shape3 = [cw, ch, cd]
  return new VolumeHandle({
    shape: newShape,
    spacing: volume.spacing,
    dtype: volume.dtype,
    data: out,
    affine: shiftAffineTranslation(volume.affine, x0, y0, z0),
    units: volume.units,
    sclSlope: volume.sclSlope,
    sclInter: volume.sclInter,
    metadata: volume.metadata,
  })
}

export function shiftAffineTranslation(
  affine: Affine4x4 | null,
  x0: number,
  y0: number,
  z0: number,
): Affine4x4 | null {
  if (!affine) return null
  const out = affine.map((row) => [...row]) as [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ]
  out[0][3] += affine[0][0] * x0 + affine[0][1] * y0 + affine[0][2] * z0
  out[1][3] += affine[1][0] * x0 + affine[1][1] * y0 + affine[1][2] * z0
  out[2][3] += affine[2][0] * x0 + affine[2][1] * y0 + affine[2][2] * z0
  return out
}
