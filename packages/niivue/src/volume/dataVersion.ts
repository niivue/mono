// Change detection for voxel values edited in place.
//
// The GPU and CPU caches built from a volume's `img` (orient textures, the
// per-volume texture cache, modulation weights, the extension RAS copy, legend
// centroids, the graph layout) key on the buffer's identity, which an in-place
// edit keeps. They also compare `_dataVersion`, so bumping it is the one signal
// that the values changed. Both ways of reporting an edit end here:
// `updateVolumeData` calls markVolumeDataChanged directly, and every GPU update
// (`updateGLVolume`, `setVolume`, ...) first converts `isDirty` flags with
// commitDirtyVolumes.

import type { NVImage } from '@/NVTypes'

/**
 * Record that `vol.img` holds new values: bump `_dataVersion` so every cache
 * re-reads it, and clear `isDirty`, which this bump has now taken care of.
 */
export function markVolumeDataChanged(vol: NVImage): void {
  vol._dataVersion = (vol._dataVersion ?? 0) + 1
  vol.isDirty = false
}

/**
 * Turn each volume's `isDirty` flag into a data-version bump and clear the
 * flag. Runs synchronously when a GPU update is requested, before any await, so
 * a flag set during an in-flight upload is not lost: it bumps the version again
 * and the queued follow-up uploads it. Returns the volumes that were dirty, so a
 * scoped update can add them to its rebuild.
 */
export function commitDirtyVolumes(volumes: readonly NVImage[]): NVImage[] {
  const dirty: NVImage[] = []
  for (const vol of volumes) {
    if (!vol.isDirty) continue
    markVolumeDataChanged(vol)
    dirty.push(vol)
  }
  return dirty
}
