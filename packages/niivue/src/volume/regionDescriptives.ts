import { log } from '@/logger'
import type { NVImage } from '@/NVTypes'
import {
  computeDescriptiveStats,
  type DescriptiveStats,
} from '@/volume/descriptives'
import { getImageDataRAS } from '@/volume/utils'

/**
 * One mask for getDescriptives: a volume index, whose non-zero voxels count,
 * or a volume index with the label values whose voxels count.
 */
type DescriptivesMask = number | { index: number; values: number[] }

export type DescriptivesOptions = {
  volumeIndex?: number
  masks?: DescriptivesMask[]
  isDrawingMask?: boolean
  drawPenValues?: number[]
}

function inBounds(length: number, index: number, name: string): boolean {
  if (index < 0 || index >= length) {
    log.warn(`${name} index ${index} out of bounds (${length} loaded).`)
    return false
  }
  return true
}

/**
 * Region-of-interest statistics; see NiiVue.getDescriptives. `drawing` reads
 * the drawing bitmap (null when there is none); it is called only for a
 * drawing mask, after the volumes and masks are checked.
 */
export function regionDescriptives(
  volumes: NVImage[],
  drawing: () => Uint8Array | null,
  options: DescriptivesOptions = {},
): DescriptiveStats | null {
  const volumeIndex = options.volumeIndex ?? 0
  if (!inBounds(volumes.length, volumeIndex, 'Volume')) return null
  const vol = volumes[volumeIndex]
  const raw = getImageDataRAS(vol)
  if (!raw || !vol.dimsRAS || !vol.pixDimsRAS) {
    log.warn('getDescriptives: volume has no resolvable RAS data')
    return null
  }
  const nVox = raw.length
  // getImageDataRAS returns unscaled samples; report calibrated intensities.
  const slope = vol.hdr?.scl_slope || 1
  const inter = vol.hdr?.scl_inter || 0
  let values: Float32Array = raw
  if (slope !== 1 || inter !== 0) {
    values = new Float32Array(nVox)
    for (let i = 0; i < nVox; i++) values[i] = raw[i] * slope + inter
  }
  // Intersect every requested mask into one inclusion array.
  let mask: Uint8Array | null = null
  const requireMask = (): Uint8Array => {
    if (!mask) mask = new Uint8Array(nVox).fill(1)
    return mask
  }
  for (const entry of options.masks ?? []) {
    const maskIndex = typeof entry === 'number' ? entry : entry.index
    const labels = typeof entry === 'number' ? null : entry.values
    if (!inBounds(volumes.length, maskIndex, 'Mask volume')) return null
    if (labels && labels.length === 0) {
      log.warn(
        `getDescriptives: mask volume ${maskIndex} has an empty label list`,
      )
      return null
    }
    const maskVol = volumes[maskIndex]
    const maskData = getImageDataRAS(maskVol)
    if (!maskData || maskData.length !== nVox) {
      log.warn(
        `getDescriptives: mask volume ${maskIndex} does not match the target grid`,
      )
      return null
    }
    const m = requireMask()
    if (labels) {
      // Labels name calibrated values, like the intensities reported.
      const keep = new Set(labels)
      const maskSlope = maskVol.hdr?.scl_slope || 1
      const maskInter = maskVol.hdr?.scl_inter || 0
      for (let i = 0; i < nVox; i++) {
        if (!keep.has(maskData[i] * maskSlope + maskInter)) m[i] = 0
      }
    } else {
      for (let i = 0; i < nVox; i++) {
        if (maskData[i] === 0 || Number.isNaN(maskData[i])) m[i] = 0
      }
    }
  }
  if (options.isDrawingMask) {
    const bitmap = drawing()
    if (!bitmap || bitmap.length !== nVox) {
      log.warn(
        'getDescriptives: no drawing, or the drawing does not match the target grid',
      )
      return null
    }
    const pens = options.drawPenValues
    const m = requireMask()
    for (let i = 0; i < nVox; i++) {
      const v = bitmap[i]
      const keep = pens ? pens.includes(v) : v !== 0
      if (!keep) m[i] = 0
    }
  }
  const voxelVolumeMM3 =
    vol.pixDimsRAS[1] * vol.pixDimsRAS[2] * vol.pixDimsRAS[3]
  return computeDescriptiveStats(values, voxelVolumeMM3, mask)
}
