import { mat4 } from 'gl-matrix'
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
 * `data` (on `grid`'s RAS voxels) as seen at each of `target`'s RAS voxel
 * centres: the nearest grid voxel, or NaN outside the grid. Nearest
 * neighbour keeps label values exact. Unchanged when the grids match; null
 * when they differ and an affine is missing.
 */
function onTargetGrid(
  data: ArrayLike<number>,
  grid: NVImage,
  target: NVImage,
): ArrayLike<number> | null {
  const t = target.dimsRAS
  const g = grid.dimsRAS
  if (!t || !g || data.length !== g[1] * g[2] * g[3]) return null
  const sameDims = t[1] === g[1] && t[2] === g[2] && t[3] === g[3]
  const tm = target.matRAS
  const gm = grid.matRAS
  if (sameDims && (tm === gm || (tm && gm && mat4.equals(tm, gm)))) return data
  if (!tm || !gm) return null
  // matRAS is row-major voxel-to-mm (voxel centres at integer indices);
  // compose target voxel -> mm -> grid voxel.
  const toGrid = mat4.transpose(mat4.create(), gm)
  if (!mat4.invert(toGrid, toGrid)) return null
  const m = mat4.multiply(toGrid, toGrid, mat4.transpose(mat4.create(), tm))
  const [gx, gy, gz] = [g[1], g[2], g[3]]
  const out = new Float32Array(t[1] * t[2] * t[3])
  let i = 0
  for (let z = 0; z < t[3]; z++) {
    for (let y = 0; y < t[2]; y++) {
      for (let x = 0; x < t[1]; x++) {
        const ix = Math.round(m[0] * x + m[4] * y + m[8] * z + m[12])
        const iy = Math.round(m[1] * x + m[5] * y + m[9] * z + m[13])
        const iz = Math.round(m[2] * x + m[6] * y + m[10] * z + m[14])
        const inside =
          ix >= 0 && iy >= 0 && iz >= 0 && ix < gx && iy < gy && iz < gz
        out[i++] = inside ? data[ix + gx * (iy + gy * iz)] : Number.NaN
      }
    }
  }
  return out
}

/**
 * Region-of-interest statistics; see NiiVue.getDescriptives. The target's own
 * (un-resliced) samples are measured on its own grid; a mask or the drawing on
 * another grid is looked up at each target voxel centre (nearest neighbour),
 * and target voxels outside it are excluded. `drawing` reads the drawing
 * bitmap (RAS order) and the volume whose grid it is on (null when there is
 * none); it is called only for a drawing mask, after the volumes and masks
 * are checked.
 */
export function regionDescriptives(
  volumes: NVImage[],
  drawing: () => { bitmap: ArrayLike<number>; grid: NVImage } | null,
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
    const native = getImageDataRAS(maskVol)
    const maskData = native && onTargetGrid(native, maskVol, vol)
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
        // NaN (outside the mask) matches no label.
        if (!keep.has(maskData[i] * maskSlope + maskInter)) m[i] = 0
      }
    } else {
      for (let i = 0; i < nVox; i++) {
        if (maskData[i] === 0 || Number.isNaN(maskData[i])) m[i] = 0
      }
    }
  }
  if (options.isDrawingMask) {
    // The drawing keeps the grid it was created on, even after the volumes
    // are reordered, so it is mapped from its own grid, not volumes[0]'s.
    const d = drawing()
    const bitmap = d && onTargetGrid(d.bitmap, d.grid, vol)
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
      // NaN: outside the drawing's grid.
      const keep = pens ? pens.includes(v) : v !== 0 && !Number.isNaN(v)
      if (!keep) m[i] = 0
    }
  }
  const voxelVolumeMM3 =
    vol.pixDimsRAS[1] * vol.pixDimsRAS[2] * vol.pixDimsRAS[3]
  return computeDescriptiveStats(values, voxelVolumeMM3, mask)
}
