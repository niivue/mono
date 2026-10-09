// Which parts of the volume stack a data-only update must rebuild. Shared by
// both backends' updateBindGroups so a scoped update (updateVolumeData) skips
// the same work on WebGL2 and WebGPU.

import type { NVImage } from '@/NVTypes'

/** Options for a view's updateBindGroups (both backends). */
export type UpdateBindGroupsOptions = {
  /** false skips the mesh rebuild. */
  meshes?: boolean
  /**
   * Only these volumes' voxel data changed (updateVolumeData). The rebuild is
   * then scoped by volumeUpdateScope and skips the colorbars. Omitted: rebuild
   * every volume.
   */
  volumes?: readonly NVImage[]
}

export type VolumeUpdateScope = {
  /** Re-run the background (volumes[0]) orient pass and its gradient. */
  background: boolean
  /** Re-run the overlay pass (volumes[1..], resliced/blended together). */
  overlays: boolean
}

/**
 * Decide what to rebuild when only the voxel data of `changed` volumes moved.
 * `changed` undefined means a full rebuild. A volume modulated by a changed
 * volume is affected too (its prepass bakes the modulator's weights), followed
 * transitively. Background masking clips the overlay texture by the
 * background, so a changed background also redoes the overlays.
 */
export function volumeUpdateScope(
  volumes: readonly NVImage[],
  changed: readonly NVImage[] | undefined,
  isBackgroundMasking: boolean,
): VolumeUpdateScope {
  if (!changed) return { background: true, overlays: true }
  const affected = new Set<NVImage>(changed)
  let grew = true
  while (grew) {
    grew = false
    for (const v of volumes) {
      if (affected.has(v) || !v.modulationImage) continue
      const modulator = volumes.find((m) => m.id === v.modulationImage)
      if (modulator && affected.has(modulator)) {
        affected.add(v)
        grew = true
      }
    }
  }
  const background = volumes.length > 0 && affected.has(volumes[0])
  const overlays =
    volumes.slice(1).some((v) => affected.has(v)) ||
    (background && isBackgroundMasking)
  return { background, overlays }
}
