import { NIIVUE_SLICE_TYPES } from './commands'
import { getNiivueForViewport } from './niivueRegistry'
import type { OhifToolbarButton, OhifToolbarModuleEntry } from './ohif-types'

// Toolbar button + section ids (referenced from a mode's toolbar sections).
export const NIIVUE_VIEWS_SECTION = 'NiivueViews'
export const NIIVUE_RESET_BUTTON = 'NiivueReset'

const SLICE_TYPE_EVALUATOR = 'evaluate.niivue.sliceType'
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

/**
 * Toolbar button definitions: a "Views" dropdown (axial / coronal / sagittal /
 * multiplanar / 3D render) plus a reset-view button, all running the commands
 * in commands.ts. Registered with the toolbar service via the
 * `niivue.toolbarButtons` customization (see below) or directly.
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

// Section membership for the views dropdown. A mode merges this into its
// toolbar sections and adds 'NiivueViews' / 'NiivueReset' to its primary bar.
export const NIIVUE_TOOLBAR_SECTIONS: Record<string, string[]> = {
  [NIIVUE_VIEWS_SECTION]: [
    'NiivueMultiplanar',
    'NiivueAxial',
    'NiivueCoronal',
    'NiivueSagittal',
    'NiivueRender',
  ],
}

/**
 * Customization pack (auto-registered at default scope via the extension's
 * customizationModule). A mode composes it by reference:
 *   toolbarButtons:  [..., { $reference: 'niivue.toolbarButtons' }]
 *   toolbarSections: [..., { $reference: 'niivue.toolbarSections' },
 *                     { primary: [...ids, 'NiivueViews', 'NiivueReset'] }]
 */
export const niivueToolbarCustomization = {
  'niivue.toolbarButtons': NIIVUE_TOOLBAR_BUTTONS,
  'niivue.toolbarSections': NIIVUE_TOOLBAR_SECTIONS,
}

// The sliceType a button def would set, read back out of its commandOptions.
function buttonSliceType(
  button: OhifToolbarButton | undefined,
): number | undefined {
  const commands = button?.props?.commands
  const options =
    commands && typeof commands === 'object' && !Array.isArray(commands)
      ? (commands.commandOptions as { sliceType?: string } | undefined)
      : undefined
  return options?.sliceType !== undefined
    ? NIIVUE_SLICE_TYPES[options.sliceType]
    : undefined
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
        const target = buttonSliceType(button)
        return {
          disabled: false,
          isActive: target !== undefined && nv.sliceType === target,
        }
      },
    },
  ]
}
