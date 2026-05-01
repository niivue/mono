import * as NVTransforms from '@/math/NVTransforms'
import type { NVImage } from '@/NVTypes'
import { buildPaqdLut256, paqdResampleRaw, reorientRGBA } from '@/volume/utils'

export function isRgbaDatatype(datatypeCode: number): boolean {
  return datatypeCode === 128 || datatypeCode === 2304
}

export function preparePaqdOverlayData(
  baseVol: NVImage,
  vol: NVImage,
  dimsOut: number[],
): { paqdData: Uint8Array; lut256: Uint8Array } | null {
  if (
    !vol.img ||
    !vol.dimsRAS ||
    !vol.img2RASstep ||
    !vol.img2RASstart ||
    !vol.colormapLabel
  ) {
    return null
  }

  const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
  const isRAS =
    vol.img2RASstep[0] === 1 &&
    vol.img2RASstep[1] === vol.dimsRAS[1] &&
    vol.img2RASstep[2] === vol.dimsRAS[1] * vol.dimsRAS[2]
  let raw = new Uint8Array(
    vol.img.buffer,
    vol.img.byteOffset,
    vol.img.byteLength,
  )
  if (!isRAS) {
    raw = reorientRGBA(raw, 4, vol.dimsRAS, vol.img2RASstart, vol.img2RASstep)
  }
  const ovDims = [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
  const paqdData = paqdResampleRaw(raw, dimsOut, ovDims, mtx as Float32Array)
  const lutMin = vol.colormapLabel.min ?? 0
  return { paqdData, lut256: buildPaqdLut256(vol.colormapLabel.lut, lutMin) }
}
