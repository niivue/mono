import type NiiVueGPU from '@/NVControlBase'
import type { NVInstance } from '@/NVTypes'

/**
 * The body of `setInstances`, kept in a leaf module (type-only controller
 * import) so it is unit-testable under the bun test runner, unlike the
 * controller itself.
 *
 * `null` leaves instance mode. An empty list stays in it and draws no tiles,
 * which a scene that has nothing in range for a moment relies on. Entering or
 * leaving instance mode rebuilds the GPU resources, since the two modes keep volume
 * textures differently (a per-volume cache vs. a background + overlay stack).
 */
export async function applyInstances(
  ctrl: NiiVueGPU,
  instances: NVInstance[] | null,
): Promise<void> {
  const wasOn = Boolean(ctrl.opts.instances)
  ctrl.opts.instances = instances ?? undefined
  if (!ctrl.view) return
  if (wasOn !== Boolean(ctrl.opts.instances)) await ctrl.updateGLVolume()
  ctrl.updateTilesFromInstances()
  ctrl.drawScene()
}
