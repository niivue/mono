import type NiiVueGPU from '@/NVControlBase'

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
