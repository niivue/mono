import { NiivueViewport } from './NiivueViewport'
import type {
  OhifExtensionParams,
  OhifViewportModuleEntry,
  OhifViewportProps,
} from './ohif-types'

// The viewport name OHIF references in a mode's viewport config.
export const NIIVUE_VIEWPORT_NAME = 'niivue'

/**
 * getViewportModule: register the NiiVue viewport component with OHIF. The
 * grid passes no managers as props, so they come from the module getter's
 * params, as OHIF's own viewports do.
 */
export function getNiivueViewportModule({
  servicesManager,
  commandsManager,
}: OhifExtensionParams = {}): OhifViewportModuleEntry[] {
  function NiivueViewportWithManagers(props: OhifViewportProps) {
    return (
      <NiivueViewport
        servicesManager={servicesManager}
        commandsManager={commandsManager}
        {...props}
      />
    )
  }
  return [{ name: NIIVUE_VIEWPORT_NAME, component: NiivueViewportWithManagers }]
}
