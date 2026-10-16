/**
 * Spreading a volume's bricks apart in the 3D render, as both a bound
 * control and set_volume's `spread` do it. A volume drawn as one texture
 * is tiled 3 by 3 by 3 first, and that waits for the bricks to upload, so
 * writes from either path can overlap: each claims a number for its
 * volume, and one that waited stands down if a later claim came in
 * meanwhile, so the latest write wins whichever path made it.
 */

import type { ShownVolume, View } from './view'

/** The number of the latest spread write claimed for each volume. */
const latest = new WeakMap<ShownVolume, number>()

/** Claims the next spread write to `volume`, before anything waits. */
export function claimSpread(volume: ShownVolume): number {
  const claim = (latest.get(volume) ?? 0) + 1
  latest.set(volume, claim)
  return claim
}

/** Whether the page's NiiVue can spread a volume's bricks; refused otherwise. */
export function requireSpread(view: View): void {
  if (!view.setVolumeChunkExplode || !view.setVolumeChunkGrid)
    throw new Error("This page's NiiVue cannot spread a volume's bricks.")
}

/**
 * Spreads volume `index`'s bricks by `spread` (1 closes them up), tiling it
 * first unless `tile` is false. False when a later write took over while
 * this one waited, and the volume is left as that write set it.
 */
export async function spreadVolume(
  view: View,
  index: number,
  volume: ShownVolume,
  spread: number,
  claim: number,
  tile = true,
): Promise<boolean> {
  requireSpread(view)
  if (tile && spread > 1 && !volume.chunkPlan)
    await view.setVolumeChunkGrid?.(index, [3, 3, 3])
  // The volume may have been replaced while it was tiled.
  if (view.volumes[index] !== volume)
    throw new Error(`Volume ${index} changed while it was tiled.`)
  if (claim !== latest.get(volume)) return false
  view.setVolumeChunkExplode?.(
    index,
    spread > 1 && volume.chunkPlan
      ? { enabled: true, scale: [spread, spread, spread] }
      : null,
  )
  return true
}
