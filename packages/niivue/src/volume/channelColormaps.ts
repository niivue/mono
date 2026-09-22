/**
 * Colormap assignment for the channels of a multi-channel acquisition.
 *
 * Shared by every microscopy loader (Allen JSON+PNG atlas, OME-TIFF) so two
 * datasets of the same specimen colour their channels the same way.
 */

/**
 * Ramps to saturated primary and secondary hues, in assignment order. Several
 * channels shown at once stay distinguishable.
 */
export const CHANNEL_COLORMAPS: ReadonlyArray<{
  name: string
  rgb: readonly [number, number, number]
}> = [
  { name: 'green', rgb: [0, 255, 0] },
  { name: 'violet', rgb: [255, 0, 255] },
  { name: 'blue2cyan', rgb: [0, 255, 255] },
  { name: 'red', rgb: [255, 0, 0] },
  { name: 'redyell', rgb: [255, 255, 0] },
  { name: 'blue', rgb: [0, 0, 255] },
]

/**
 * The colormap for one channel: the closest hue to the file's stated channel
 * colour when it has one, else the next colour in the palette so that channels
 * loaded together do not collide.
 *
 * `order` is the channel's position in the requested list, not its index in
 * the file, so loading channels 3 and 7 of a 32-channel dataset still yields
 * the first two palette entries.
 */
export function channelColormapFor(
  rgb: readonly number[] | null | undefined,
  order: number,
): string {
  if (!rgb || rgb.length < 3) {
    return CHANNEL_COLORMAPS[order % CHANNEL_COLORMAPS.length].name
  }
  let best = CHANNEL_COLORMAPS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const entry of CHANNEL_COLORMAPS) {
    const distance =
      (entry.rgb[0] - rgb[0]) ** 2 +
      (entry.rgb[1] - rgb[1]) ** 2 +
      (entry.rgb[2] - rgb[2]) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry
    }
  }
  return best.name
}
