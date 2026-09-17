import { panFollowCrosshair2D } from '@/math/NVTransforms'
import type NiiVueGPU from '@/NVControlBase'
import { everyTileWindowMM } from '@/view/NVSliceLayout'

/**
 * Event emitters for interaction-driven camera changes (mouse/keyboard rotate,
 * wheel zoom, 2D pan/zoom). These mirror what the `azimuth`/`elevation`/
 * `scaleMultiplier`/`pan2Dxyzmm` setters emit, so a listener sees the same
 * `azimuthElevationChange` / `change` events whether the camera moved via the
 * public API or via direct user interaction.
 *
 * Kept in a leaf module (type-only controller import) so they are unit-testable
 * under the bun test runner, unlike the controller itself.
 */

/** Emit orientation events after an interaction rotated the 3D camera. */
export function emitOrientationChange(ctrl: NiiVueGPU): void {
  const { azimuth, elevation } = ctrl.model.scene
  ctrl.emit('azimuthElevationChange', { azimuth, elevation })
  ctrl.emit('change', { property: 'azimuth', value: azimuth })
  ctrl.emit('change', { property: 'elevation', value: elevation })
}

/** Emit a change event after an interaction changed the 3D zoom. */
export function emitScaleMultiplierChange(ctrl: NiiVueGPU): void {
  ctrl.emit('change', {
    property: 'scaleMultiplier',
    value: ctrl.model.scene.scaleMultiplier,
  })
}

/** Emit a change event after an interaction panned/zoomed the 2D views. */
export function emitPan2DChange(ctrl: NiiVueGPU): void {
  ctrl.emit('change', {
    property: 'pan2Dxyzmm',
    value: ctrl.model.scene.pan2Dxyzmm,
  })
}

/**
 * Opt-in "pan follows crosshair": after the crosshair moved ON ITS OWN
 * (keyboard, API, linked instance -- not by an explicit pan/zoom gesture), pan
 * the zoomed-in 2D views just enough that the crosshair stays inside every
 * tile's visible mm window. See `NVTransforms.panFollowCrosshair2D` for the
 * minimal-move semantics; this wrapper adds the opt-in gate, reads the window
 * off the tiles, mutates the scene, and emits the same `pan2Dxyzmm` change
 * event as every other pan mutation.
 *
 * The window is `everyTileWindowMM` over `view.screenSlices`: the tiles of the
 * last rendered layout, each with the current pan and zoom applied, reduced to
 * the interval every tile agrees on. Reading the tiles rather than the scene
 * extents is what makes "visible" mean visible: a filled single view or
 * equal-size multiplanar shows more world than the data, and the crosshair is
 * not off-window merely for being past the data edge. Before the first render
 * there are no tiles, so nothing moves; the next crosshair move after a layout
 * exists catches up.
 *
 * Only crosshair-move paths may call this — pan and zoom handlers must not, so
 * the user's explicit pan is never fought (same split as the signal graph's
 * `panViewWindowTo`).
 *
 * @returns true when the pan moved (the caller owes a redraw)
 */
export function applyPanFollowsCrosshair(ctrl: NiiVueGPU): boolean {
  const model = ctrl.model
  if (!model.interaction.isPanFollowingCrosshair) return false
  const pan = model.scene.pan2Dxyzmm
  if (!(pan[3] > 1)) return false
  const mm = model.scene2mm(model.scene.crosshairPos)
  const window = everyTileWindowMM(ctrl.view?.screenSlices ?? [], pan)
  const next = panFollowCrosshair2D(pan, mm, window)
  if (next[0] === pan[0] && next[1] === pan[1] && next[2] === pan[2]) {
    return false
  }
  pan[0] = next[0]
  pan[1] = next[1]
  pan[2] = next[2]
  emitPan2DChange(ctrl)
  return true
}
