import { displaySetToNiivue } from './displaySetToNiivue'
import {
  getNiivueViewportModule,
  NIIVUE_VIEWPORT_NAME,
} from './getNiivueViewportModule'
import { NiivueViewport } from './NiivueViewport'
import type {
  OhifDisplaySet,
  OhifExtension,
  OhifSopClassHandlerEntry,
  OhifViewportModuleEntry,
  OhifViewportProps,
} from './ohif-types'
import {
  getNiivueSopClassHandlerModule,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
} from './sopClassHandler'

export const NIIVUE_OHIF_EXTENSION_ID = '@niivue/nv-ohif'

// The OHIF extension object. OHIF apps register this (via pluginConfig / addExtension)
// to make the NiiVue viewport available to modes. Default-exported to match OHIF's
// extension-loading convention.
const niivueOhifExtension: OhifExtension = {
  id: NIIVUE_OHIF_EXTENSION_ID,
  version: '0.0.0',
  getViewportModule: () => getNiivueViewportModule(),
  getSopClassHandlerModule: () => getNiivueSopClassHandlerModule(),
}

export default niivueOhifExtension

export type {
  OhifDisplaySet,
  OhifExtension,
  OhifSopClassHandlerEntry,
  OhifViewportModuleEntry,
  OhifViewportProps,
}
// Public named API (for consumers that want the parts directly).
export {
  displaySetToNiivue,
  getNiivueSopClassHandlerModule,
  getNiivueViewportModule,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
  NIIVUE_VIEWPORT_NAME,
  NiivueViewport,
}
