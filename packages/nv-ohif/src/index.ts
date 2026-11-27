import { version } from '../package.json'
import { resetCalibration } from './calibration'
import {
  getNiivueCommandsModule,
  NIIVUE_CLIP_PLANES,
  NIIVUE_COLORMAPS,
  NIIVUE_SLICE_TYPES,
  resetReleasedRows,
} from './commands'
import { resetParkedContours } from './contourSeg'
import { displaySetToNiivue } from './displaySetToNiivue'
import { getNiivuePanelModule } from './dynamicPanel'
import {
  getNiivueViewportModule,
  NIIVUE_VIEWPORT_NAME,
} from './getNiivueViewportModule'
import { NiivueViewport } from './NiivueViewport'
import {
  NIIVUE_SUPPORTED_TOOLS,
  NIIVUE_UNSUPPORTED_EVALUATOR,
  withNiivueSupport,
} from './niivueSupport'
import type {
  OhifCommandsManager,
  OhifCustomizationModuleEntry,
  OhifDisplaySet,
  OhifExtension,
  OhifExtensionManager,
  OhifSopClassHandlerEntry,
  OhifToolbarButton,
  OhifViewportModuleEntry,
  OhifViewportProps,
} from './ohif-types'
import { resetQuant } from './petQuant'
import {
  getNiivueSopClassHandlerModule,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
} from './sopClassHandler'
import { NIIVUE_STANDARD_COMMANDS } from './standardCommands'
import {
  getNiivueToolbarModule,
  NIIVUE_CAPTURE_BUTTON,
  NIIVUE_CLIP_SECTION,
  NIIVUE_COLORMAP_SECTION,
  NIIVUE_CROSSHAIR_BUTTON,
  NIIVUE_INTERPOLATION_BUTTON,
  NIIVUE_OVERLAY_MENU_BUTTON,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_WL_SECTION,
  niivueToolbarCustomization,
} from './toolbar'
export const NIIVUE_OHIF_EXTENSION_ID = '@niivue/nv-ohif'

// The OHIF extension object. OHIF apps register this (via pluginConfig / addExtension)
// to make the NiiVue viewport available to modes. Default-exported to match OHIF's
// extension-loading convention.
const niivueOhifExtension: OhifExtension = {
  id: NIIVUE_OHIF_EXTENSION_ID,
  version,
  getViewportModule: (params) => getNiivueViewportModule(params),
  getSopClassHandlerModule: () => getNiivueSopClassHandlerModule(),
  getCommandsModule: (params) => getNiivueCommandsModule(params),
  getToolbarModule: (params) => getNiivueToolbarModule(params),
  getPanelModule: (params) => getNiivuePanelModule(params),
  // State that lives for a study: the next mode entry starts clean. Pane
  // state goes with each pane (unmount).
  onModeExit: () => {
    resetQuant()
    resetCalibration()
    resetParkedContours()
    resetReleasedRows()
  },
  // Auto-registered at default scope; modes pull the packs in by reference
  // ('niivue.toolbarButtons' / 'niivue.toolbarSections').
  getCustomizationModule: () => [
    { name: 'default', value: niivueToolbarCustomization },
  ],
}

export default niivueOhifExtension

export type {
  OhifCommandsManager,
  OhifCustomizationModuleEntry,
  OhifDisplaySet,
  OhifExtension,
  OhifExtensionManager,
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
  NIIVUE_CAPTURE_BUTTON,
  NIIVUE_CLIP_PLANES,
  NIIVUE_CLIP_SECTION,
  NIIVUE_COLORMAP_SECTION,
  NIIVUE_COLORMAPS,
  NIIVUE_CROSSHAIR_BUTTON,
  NIIVUE_INTERPOLATION_BUTTON,
  NIIVUE_OVERLAY_MENU_BUTTON,
  NIIVUE_SLICE_TYPES,
  NIIVUE_SOP_CLASS_HANDLER_NAME,
  NIIVUE_STANDARD_COMMANDS,
  NIIVUE_SUPPORTED_TOOLS,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_UNSUPPORTED_EVALUATOR,
  NIIVUE_VIEWPORT_NAME,
  NIIVUE_WL_SECTION,
  NiivueViewport,
  niivueToolbarCustomization,
  withNiivueSupport,
}
