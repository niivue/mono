import {
  getNiivueCommandsModule,
  NIIVUE_CLIP_PLANES,
  NIIVUE_SLICE_TYPES,
} from './commands'
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
  OhifToolbarButton,
  OhifViewportModuleEntry,
  OhifViewportProps,
} from './ohif-types'
import {
  getNiivueSopClassHandlerModule,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
} from './sopClassHandler'
import {
  getNiivueToolbarModule,
  NIIVUE_CLIP_SECTION,
  NIIVUE_OVERLAY_BUTTON,
  NIIVUE_RESET_BUTTON,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_VIEWS_SECTION,
  NIIVUE_WL_SECTION,
  niivueToolbarCustomization,
} from './toolbar'

export const NIIVUE_OHIF_EXTENSION_ID = '@niivue/nv-ohif'

// The OHIF extension object. OHIF apps register this (via pluginConfig / addExtension)
// to make the NiiVue viewport available to modes. Default-exported to match OHIF's
// extension-loading convention.
const niivueOhifExtension: OhifExtension = {
  id: NIIVUE_OHIF_EXTENSION_ID,
  version: '0.0.0',
  getViewportModule: () => getNiivueViewportModule(),
  getSopClassHandlerModule: () => getNiivueSopClassHandlerModule(),
  getCommandsModule: (params) => getNiivueCommandsModule(params),
  getToolbarModule: () => getNiivueToolbarModule(),
  // Auto-registered at default scope; modes pull the packs in by reference
  // ('niivue.toolbarButtons' / 'niivue.toolbarSections').
  getCustomizationModule: () => [
    { name: 'default', value: niivueToolbarCustomization },
  ],
}

export default niivueOhifExtension

export type {
  OhifDisplaySet,
  OhifExtension,
  OhifSopClassHandlerEntry,
  OhifToolbarButton,
  OhifViewportModuleEntry,
  OhifViewportProps,
}
// Public named API (for consumers that want the parts directly).
export {
  displaySetToNiivue,
  getNiivueCommandsModule,
  getNiivueSopClassHandlerModule,
  getNiivueToolbarModule,
  getNiivueViewportModule,
  NIIVUE_CLIP_PLANES,
  NIIVUE_CLIP_SECTION,
  NIIVUE_OVERLAY_BUTTON,
  NIIVUE_RESET_BUTTON,
  NIIVUE_SLICE_TYPES,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_VIEWPORT_NAME,
  NIIVUE_VIEWS_SECTION,
  NIIVUE_WL_SECTION,
  NiivueViewport,
  niivueToolbarCustomization,
}
