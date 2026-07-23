import { NiivueViewport } from './NiivueViewport'
import type { OhifViewportModuleEntry } from './ohif-types'

// The viewport name OHIF references in a mode's viewport config.
export const NIIVUE_VIEWPORT_NAME = 'niivue'

/** getViewportModule: register the NiiVue viewport component with OHIF. */
export function getNiivueViewportModule(): OhifViewportModuleEntry[] {
  return [{ name: NIIVUE_VIEWPORT_NAME, component: NiivueViewport }]
}
