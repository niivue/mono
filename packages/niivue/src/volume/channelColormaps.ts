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
 * The ramp for a white or near-white channel colour. Not part of the
 * fallback cycle: a channel only gets gray when the file asks for it.
 */
export const CHANNEL_GRAY_COLORMAP = {
  name: 'gray',
  rgb: [255, 255, 255],
} as const

const CHANNEL_CANDIDATES = [...CHANNEL_COLORMAPS, CHANNEL_GRAY_COLORMAP]

/** Squared RGB distance from a palette entry to a stated colour. */
function hueDistance(
  entry: { rgb: readonly [number, number, number] },
  rgb: readonly number[],
): number {
  return (
    (entry.rgb[0] - rgb[0]) ** 2 +
    (entry.rgb[1] - rgb[1]) ** 2 +
    (entry.rgb[2] - rgb[2]) ** 2
  )
}

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
  let best: { name: string } = CHANNEL_CANDIDATES[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const entry of CHANNEL_CANDIDATES) {
    const distance = hueDistance(entry, rgb)
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry
    }
  }
  return best.name
}

/**
 * Colormaps for channels loaded together, in load order.
 *
 * Each channel gets {@link channelColormapFor}'s choice unless an earlier
 * channel already took it; then it gets the closest unused entry (to its
 * stated colour, or the next unused one in palette order when it has none).
 * Two white channels therefore come out gray and violet rather than both
 * gray. Only when every entry is taken do colours repeat.
 */
export function channelColormapsFor(
  colors: ReadonlyArray<readonly number[] | null | undefined>,
): string[] {
  const taken = new Set<string>()
  return colors.map((rgb, order) => {
    let name = channelColormapFor(rgb, order)
    if (taken.has(name)) {
      const free = CHANNEL_CANDIDATES.filter((entry) => !taken.has(entry.name))
      if (free.length > 0) {
        if (rgb && rgb.length >= 3) {
          free.sort((a, b) => hueDistance(a, rgb) - hueDistance(b, rgb))
          name = free[0].name
        } else {
          name = (
            free.find((entry) => entry !== CHANNEL_GRAY_COLORMAP) ?? free[0]
          ).name
        }
      }
    }
    taken.add(name)
    return name
  })
}
