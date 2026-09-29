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
