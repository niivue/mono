import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'

/** Per-frame volume renderer settings both backends read from the model. */
export type VolumeFrameState = {
  gradientAmount: number
  renderMode: number
  sliceFrac: number[]
  isAlphaClipDark: boolean
  sampleRate: number
  isCubicInterpolation: boolean
  layerGradientMode: number
  isOverlayOpacityCorrected: boolean
  gradientOpacity: number
  silhouette: number
  gamma: number
  lodBrightnessCompensation: number
  lodOpacityCompensation: number
}

/** Per-frame slice renderer settings shared with the 3D render. */
export type SliceFrameState = {
  gamma: number
  lodBrightnessCompensation: number
}

/**
 * Copy this frame's volume settings from the model to the renderers. Returns
 * whether the scene asks for CINEMATIC, which the volume renderer marches as
 * COMPOSITE.
 */
export function syncVolumeFrameState(
  vr: VolumeFrameState,
  sr: SliceFrameState,
  md: NVModel,
): boolean {
  // Publish the current lighting to the volume renderer BEFORE any chunk work
  // (entry creation, request, pump) so chunk uploaders can skip the gradient
  // pass when unlit. Matches the gradientAmount passed to the volume draw.
  vr.gradientAmount = md.volume.illumination
  // Composite (OVER) vs maximum-intensity projection vs orthogonal slices, for
  // every volume pass this frame (base, overlay, PAQD, drawing, and the
  // independent hi-res overlay cube). CINEMATIC tiles skip the classic
  // march; where it falls back (chunked volume) it draws COMPOSITE.
  const isCinematicMode =
    md.volume.renderMode === NVConstants.VOLUME_RENDER_MODE.CINEMATIC
  vr.renderMode = isCinematicMode
    ? NVConstants.VOLUME_RENDER_MODE.COMPOSITE
    : md.volume.renderMode
  // The crosshair planes SLICES draws, in the base volume's texture fraction —
  // the same conversion the 2D tiles use, so sheared and oblique volumes line
  // up with them.
  vr.sliceFrac = [0, 1, 2].map((d) => md.getSliceTexFrac(d))
  // SLICES honours the same dark-voxel clip the 2D tiles do, so the two agree
  // on what a plane shows.
  vr.isAlphaClipDark = md.volume.isAlphaClipDark
  // Ray samples per voxel in the 3D fine march (anti-aliasing vs fragment cost).
  vr.sampleRate = md.volume.sampleRate
  // Tricubic B-spline reconstruction in the fine march (8 fetches vs 1).
  vr.isCubicInterpolation = md.volume.isCubicInterpolation
  // Stencil for the overlay/drawing passes' own gradient (the background's is
  // precomputed into a texture and unaffected).
  vr.layerGradientMode = md.volume.layerGradientMode
  vr.isOverlayOpacityCorrected = md.volume.isOverlayOpacityCorrected
  // Background-only alpha modulation from that precomputed gradient: suppress
  // homogeneous interior (gradientOpacity) and fade view-aligned material into
  // a rim (silhouette). Set before chunk work, like gradientAmount, because a
  // non-zero value means an unlit chunk still needs its gradient computed.
  vr.gradientOpacity = md.volume.gradientOpacity
  vr.silhouette = md.volume.silhouette
  // Display gamma for the classified RGB of every volume sample (alpha, and
  // therefore occlusion, is untouched).
  vr.gamma = md.scene.gamma
  // Per-level brightness compensation for coarse multi-LOD bricks. Folds into
  // the same shader exponent as `gamma`, but per chunk, so it is a no-op for
  // single-level and non-chunked volumes whatever the coefficient.
  vr.lodBrightnessCompensation = md.volume.lodBrightnessCompensation
  // Per-level opacity compensation. Ray-march only: the slice renderer shows
  // one sample per tile with no accumulation, so there is no aggregated alpha
  // to correct there.
  vr.lodOpacityCompensation = md.volume.lodOpacityCompensation
  // 2D slice tiles read the same two exponents so a slice and the 3D render
  // panel agree on brightness.
  sr.gamma = md.scene.gamma
  sr.lodBrightnessCompensation = md.volume.lodBrightnessCompensation
  return isCinematicMode
}
