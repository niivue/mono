/**
 * Whether a volume contributes to a draw. `visible` is the explicit toggle
 * (`setVolume(i, { visible: false })`), symmetric with meshes (`isMeshDrawn`)
 * and slides; zero opacity is the same thing reached through the opacity
 * control. Hiding never touches `opacity`, so a hide/show round trip restores
 * the value the user had set. Both gates also apply to PICKING, or a hidden
 * background still answers a double-click.
 *
 * Overlays are FILTERED with `isVolumeDrawn` before the overlay bake: in the
 * orient shaders an overlayOpacity of 0 selects background semantics rather
 * than transparency, so a hidden overlay cannot be expressed as opacity 0
 * there. The background volume's opacity is a live uniform (2D `opacity`, 3D
 * `backOpacity`), so it reads `drawnOpacity` instead. Modulator lookups read
 * the unfiltered list on purpose: a hidden volume can still modulate another.
 */
export function isVolumeDrawn(vol: {
  opacity?: number
  visible?: boolean
}): boolean {
  return vol.visible !== false && (vol.opacity ?? 1.0) > 0.0
}

/** The opacity a volume is drawn with: its own, or 0 when hidden. */
export function drawnOpacity(vol: {
  opacity?: number
  visible?: boolean
}): number {
  return vol.visible === false ? 0 : (vol.opacity ?? 1.0)
}

/**
 * The CPU pick sampler of a channel stack: the strongest window-visible value
 * of any drawn channel's `pickSampler`, so a pick lands on whichever channel
 * is on screen there, not only volumes[0]'s (#370). Null when none has one.
 */
export function stackPickSampler(
  volumes: readonly {
    visible?: boolean
    opacity?: number
    pickSampler?: (x: number, y: number, z: number) => number
  }[],
): ((x: number, y: number, z: number) => number) | undefined {
  const samplers = volumes
    .filter(isVolumeDrawn)
    .flatMap((v) => (v.pickSampler ? [v.pickSampler] : []))
  if (!samplers.length) return undefined
  return (x, y, z) => {
    let best = 0
    for (const s of samplers) best = Math.max(best, s(x, y, z))
    return best
  }
}

/**
 * Whether the channel stack (VolumeRenderConfig.isChannelStack) applies to
 * this volume list: the option is on, there is more than one volume, and
 * volumes[0] is either not chunked or every volume is streamed (a
 * `chunkSource`), whose bricks the renderers fuse per base chunk. When it
 * applies, volumes[0] joins the overlay blend and its own draw opacity is 0,
 * so every channel is weighted alike.
 */
export function isChannelStackActive(
  isChannelStack: boolean,
  volumes: readonly { chunkPlan?: unknown; chunkSource?: unknown }[],
): boolean {
  return (
    isChannelStack &&
    volumes.length > 1 &&
    (!volumes[0].chunkPlan || volumes.every((v) => !!v.chunkSource))
  )
}
