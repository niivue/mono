import type NiiVueGPU from '@/NVControlBase'
import type { NVInstance } from '@/NVTypes'

/**
 * The body of `setInstances`, kept in a leaf module (type-only controller
 * import) so it is unit-testable under the bun test runner, unlike the
 * controller itself.
 *
 * `null` or an empty list leaves instance mode: the view takes any list, even
 * an empty one, as instance mode and would draw no tiles. Entering or leaving
 * instance mode rebuilds the GPU resources, since the two modes keep volume
 * textures differently (a per-volume cache vs. a background + overlay stack).
 */
export async function applyInstances(
  ctrl: NiiVueGPU,
  instances: NVInstance[] | null,
): Promise<void> {
  const wasOn = Boolean(ctrl.opts.instances)
  ctrl.opts.instances = instances?.length ? instances : undefined
  if (!ctrl.view) return
  if (wasOn !== Boolean(ctrl.opts.instances)) await ctrl.updateGLVolume()
  ctrl.updateTilesFromInstances()
  ctrl.drawScene()
}
