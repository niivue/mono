import { NIIVUE_SLICE_TYPES } from './commands'
import {
  getNiivueEntryForViewport,
  getNiivueForViewport,
} from './niivueRegistry'
import type { OhifToolbarButton, OhifToolbarModuleEntry } from './ohif-types'

// Toolbar button + section ids (referenced from a mode's toolbar sections).
export const NIIVUE_VIEWS_SECTION = 'NiivueViews'
export const NIIVUE_CLIP_SECTION = 'NiivueClip'
export const NIIVUE_RESET_BUTTON = 'NiivueReset'
export const NIIVUE_OVERLAY_BUTTON = 'NiivueOverlay'

const SLICE_TYPE_EVALUATOR = 'evaluate.niivue.sliceType'
const CLIP_PLANE_EVALUATOR = 'evaluate.niivue.clipPlane'
const OVERLAY_EVALUATOR = 'evaluate.niivue.overlay'
const NIIVUE_EVALUATOR = 'evaluate.niivue'

function sliceTypeButton(
  id: string,
  sliceType: string,
  icon: string,
  label: string,
): OhifToolbarButton {
  return {
    id,
    uiType: 'ohif.toolButton',
    props: {
      icon,
      label,
      tooltip: `${label} (NiiVue)`,
      commands: {
        commandName: 'niivueSetSliceType',
        commandOptions: { sliceType },
      },
      evaluate: SLICE_TYPE_EVALUATOR,
    },
  }
}

function clipPlaneButton(
  id: string,
  plane: string,
  icon: string,
  label: string,
): OhifToolbarButton {
  return {
    id,
    uiType: 'ohif.toolButton',
    props: {
      icon,
      label,
      tooltip: `${label} (NiiVue clip plane)`,
      commands: {
        commandName: 'niivueSetClipPlane',
        commandOptions: { plane },
      },
      evaluate: CLIP_PLANE_EVALUATOR,
    },
  }
}

/**
 * Toolbar button definitions: a "Views" dropdown (axial / coronal / sagittal /
 * multiplanar / 3D render), a clip-plane dropdown, an overlay toggle, and a
 * reset-view button, all running the commands in commands.ts. Registered with
 * the toolbar service via the `niivue.toolbarButtons` customization (see
 * below) or directly.
 */
export const NIIVUE_TOOLBAR_BUTTONS: OhifToolbarButton[] = [
  {
    id: NIIVUE_VIEWS_SECTION,
    uiType: 'ohif.toolButtonList',
    props: { buttonSection: true },
  },
  sliceTypeButton(
    'NiivueMultiplanar',
    'multiplanar',
    'icon-mpr',
    'Multiplanar',
  ),
  sliceTypeButton('NiivueAxial', 'axial', 'OrientationSwitchA', 'Axial'),
  sliceTypeButton('NiivueCoronal', 'coronal', 'OrientationSwitchC', 'Coronal'),
  sliceTypeButton(
    'NiivueSagittal',
    'sagittal',
    'OrientationSwitchS',
    'Sagittal',
  ),
  sliceTypeButton('NiivueRender', 'render', 'tool-3d-rotate', '3D Render'),
  {
    id: NIIVUE_CLIP_SECTION,
    uiType: 'ohif.toolButtonList',
    props: { buttonSection: true },
  },
  clipPlaneButton('NiivueClipNone', 'none', 'icon-clear', 'No Clip'),
  clipPlaneButton(
    'NiivueClipRight',
    'right',
    'OrientationSwitchS',
    'Clip Right',
  ),
  clipPlaneButton('NiivueClipLeft', 'left', 'OrientationSwitchS', 'Clip Left'),
  clipPlaneButton(
    'NiivueClipAnterior',
    'anterior',
    'OrientationSwitchC',
    'Clip Anterior',
  ),
  clipPlaneButton(
    'NiivueClipPosterior',
    'posterior',
    'OrientationSwitchC',
    'Clip Posterior',
  ),
  clipPlaneButton(
    'NiivueClipSuperior',
    'superior',
    'OrientationSwitchA',
    'Clip Superior',
  ),
  clipPlaneButton(
    'NiivueClipInferior',
    'inferior',
    'OrientationSwitchA',
    'Clip Inferior',
  ),
  {
    id: NIIVUE_OVERLAY_BUTTON,
    uiType: 'ohif.toolButton',
    props: {
      icon: 'toggle-dicom-overlay',
      label: 'Overlay',
      tooltip:
        'Toggle a colormapped overlay of the next series in this study (NiiVue)',
      commands: 'niivueToggleOverlay',
      evaluate: OVERLAY_EVALUATOR,
    },
  },
  {
    id: NIIVUE_RESET_BUTTON,
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-reset',
      label: 'Reset View',
      tooltip: 'Reset View (NiiVue)',
      commands: 'niivueResetView',
      evaluate: NIIVUE_EVALUATOR,
    },
  },
]

// Section membership for the dropdowns. A mode merges this into its toolbar
// sections and adds the section/button ids to its primary bar.
export const NIIVUE_TOOLBAR_SECTIONS: Record<string, string[]> = {
  [NIIVUE_VIEWS_SECTION]: [
    'NiivueMultiplanar',
    'NiivueAxial',
    'NiivueCoronal',
    'NiivueSagittal',
    'NiivueRender',
  ],
  [NIIVUE_CLIP_SECTION]: [
    'NiivueClipNone',
    'NiivueClipRight',
    'NiivueClipLeft',
    'NiivueClipAnterior',
    'NiivueClipPosterior',
    'NiivueClipSuperior',
    'NiivueClipInferior',
  ],
}

/**
 * Customization pack (auto-registered at default scope via the extension's
 * customizationModule). A mode composes it by reference:
 *   toolbarButtons:  [..., { $reference: 'niivue.toolbarButtons' }]
 *   toolbarSections: [..., { $reference: 'niivue.toolbarSections' },
 *                     { primary: [...ids, 'NiivueViews', 'NiivueClip',
 *                                 'NiivueOverlay', 'NiivueReset'] }]
 */
export const niivueToolbarCustomization = {
  'niivue.toolbarButtons': NIIVUE_TOOLBAR_BUTTONS,
  'niivue.toolbarSections': NIIVUE_TOOLBAR_SECTIONS,
}

// A named command option a button def would send, read back out of its props.
function buttonCommandOption(
  button: OhifToolbarButton | undefined,
  option: string,
): string | undefined {
  const commands = button?.props?.commands
  const options =
    commands && typeof commands === 'object' && !Array.isArray(commands)
      ? commands.commandOptions
      : undefined
  const value = options?.[option]
  return typeof value === 'string' ? value : undefined
}

const DISABLED = {
  disabled: true,
  disabledText: 'Available on NiiVue viewports',
}

/**
 * getToolbarModule: evaluators the buttons above reference. OHIF calls these
 * against the active viewport to derive enabled/active state.
 */
export function getNiivueToolbarModule(): OhifToolbarModuleEntry[] {
  return [
    {
      name: NIIVUE_EVALUATOR,
      evaluate: ({ viewportId }) =>
        getNiivueForViewport(viewportId) ? { disabled: false } : DISABLED,
    },
    {
      name: SLICE_TYPE_EVALUATOR,
      evaluate: ({ viewportId, button }) => {
        const nv = getNiivueForViewport(viewportId)
        if (!nv) return DISABLED
        const name = buttonCommandOption(button, 'sliceType')
        const target = name === undefined ? undefined : NIIVUE_SLICE_TYPES[name]
        return {
          disabled: false,
          isActive: target !== undefined && nv.sliceType === target,
        }
      },
    },
    {
      name: CLIP_PLANE_EVALUATOR,
      evaluate: ({ viewportId, button }) => {
        const entry = getNiivueEntryForViewport(viewportId)
        if (!entry) return DISABLED
        const plane = buttonCommandOption(button, 'plane')
        return {
          disabled: false,
          isActive:
            plane !== undefined &&
            plane !== 'none' &&
            entry.clipPlane === plane,
        }
      },
    },
    {
      name: OVERLAY_EVALUATOR,
      evaluate: ({ viewportId }) => {
        const entry = getNiivueEntryForViewport(viewportId)
        if (!entry) return DISABLED
        return { disabled: false, isActive: entry.overlayUIDs.length > 0 }
      },
    },
  ]
}
