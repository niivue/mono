import type NiiVueGPU from '@niivue/niivue'
import type { OhifServicesManager } from './ohif-types'

// Live NiiVue instances by OHIF viewportId. The viewport registers itself on
// attach and unregisters on teardown; OHIF commands / toolbar evaluators (which
// live outside React) resolve the instance they should act on through this map.
const instances = new Map<string, NiiVueGPU>()

export function registerNiivue(viewportId: string, nv: NiiVueGPU): void {
  instances.set(viewportId, nv)
}

export function unregisterNiivue(viewportId: string): void {
  instances.delete(viewportId)
}

export function getNiivue(
  viewportId: string | undefined,
): NiiVueGPU | undefined {
  return viewportId === undefined ? undefined : instances.get(viewportId)
}

// OHIF exposes its services on the manager in some builds and only on
// `window.services` in others (e.g. the current 3.x app), so read from either.
export function ohifServices(
  servicesManager: OhifServicesManager | undefined,
): Record<string, unknown> | undefined {
  if (servicesManager?.services) return servicesManager.services
  const g = globalThis as unknown as { services?: Record<string, unknown> }
  return g.services
}

interface ViewportGridServiceLike {
  getActiveViewportId?: () => string | undefined
}

/**
 * The instance for a viewport id, falling back to the sole registered instance
 * (covers layouts where a non-NiiVue viewport holds focus next to a single
 * NiiVue viewport).
 */
export function getNiivueForViewport(
  viewportId: string | undefined,
): NiiVueGPU | undefined {
  const exact = getNiivue(viewportId)
  if (exact) return exact
  if (instances.size === 1) {
    for (const nv of instances.values()) return nv
  }
  return undefined
}

/** The NiiVue instance a toolbar command should act on: the active viewport's. */
export function getActiveNiivue(
  servicesManager: OhifServicesManager | undefined,
): NiiVueGPU | undefined {
  const grid = ohifServices(servicesManager)?.viewportGridService as
    | ViewportGridServiceLike
    | undefined
  return getNiivueForViewport(grid?.getActiveViewportId?.())
}
