// Which parts of the volume stack a data-only update must rebuild. Shared by
// both backends' updateBindGroups so a scoped update (updateVolumeData) skips
// the same work on WebGL2 and WebGPU.

import type { NVImage } from '@/NVTypes'
import type { MeshRebuild } from '@/view/meshGpuSync'

/** Options for a view's updateBindGroups (both backends). */
export type UpdateBindGroupsOptions = {
  /** Which mesh GPU resources to rebuild (see MeshRebuild). Default 'all'. */
  meshes?: MeshRebuild
  /**
   * Only these volumes' voxel data changed (updateVolumeData; [] for a
   * mesh-only update). The rebuild is then scoped by volumeUpdateScope.
   * Omitted: rebuild every volume.
   */
  volumes?: readonly NVImage[]
  /**
   * Rebuild the colorbars. Defaults to true for a full volume rebuild
   * (`volumes` omitted) and false for a scoped one; mesh updates, which pass
   * `volumes: []`, set it because mesh layers carry colorbars.
   */
  colorbars?: boolean
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
