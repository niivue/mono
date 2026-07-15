import { baseModality, NIIVUE_COLORMAPS, NIIVUE_SLICE_TYPES } from './commands'
import {
  getNiivueEntryForViewport,
  getNiivueForViewport,
} from './niivueRegistry'
import type { OhifToolbarButton, OhifToolbarModuleEntry } from './ohif-types'

// Toolbar button + section ids (referenced from a mode's toolbar sections).
export const NIIVUE_VIEWS_SECTION = 'NiivueViews'
export const NIIVUE_CLIP_SECTION = 'NiivueClip'
export const NIIVUE_WL_SECTION = 'NiivueWindowLevel'
export const NIIVUE_COLORMAP_SECTION = 'NiivueColormap'
export const NIIVUE_RESET_BUTTON = 'NiivueReset'
export const NIIVUE_OVERLAY_BUTTON = 'NiivueOverlay'
export const NIIVUE_COLORBAR_BUTTON = 'NiivueColorbar'

const SLICE_TYPE_EVALUATOR = 'evaluate.niivue.sliceType'
const CLIP_PLANE_EVALUATOR = 'evaluate.niivue.clipPlane'
const OVERLAY_EVALUATOR = 'evaluate.niivue.overlay'
const WL_PRESET_EVALUATOR = 'evaluate.niivue.windowLevelPreset'
const COLORMAP_EVALUATOR = 'evaluate.niivue.colormap'
const COLORBAR_EVALUATOR = 'evaluate.niivue.colorbar'
const NIIVUE_EVALUATOR = 'evaluate.niivue'

// Capitalized id suffix for a colormap name ('viridis' -> 'Viridis').
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
const colormapButtonId = (name: string) => `NiivueCmap${capitalize(name)}`

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

// A window/level preset button. `modality` gates it (the base series must
// match); `presetId` / `presetIndex` resolve against OHIF's presets.
function wlPresetButton(
  id: string,
  modality: string,
  presetId: string,
  presetIndex: number,
  label: string,
): OhifToolbarButton {
  return {
    id,
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-window-level',
      label,
      tooltip: `${label} window (${modality}, NiiVue)`,
      commands: {
        commandName: 'niivueSetWindowLevelPreset',
        commandOptions: { modality, presetId, presetIndex },
      },
      evaluate: WL_PRESET_EVALUATOR,
    },
  }
}

function colormapButton(name: string, label: string): OhifToolbarButton {
  return {
    id: colormapButtonId(name),
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-color-lut',
      label,
      tooltip: `${label} colormap (NiiVue)`,
      commands: {
        commandName: 'niivueSetColormap',
        commandOptions: { colormap: name },
      },
      evaluate: COLORMAP_EVALUATOR,
    },
  }
}

/**
 * Toolbar button definitions: a "Views" dropdown (axial / coronal / sagittal /
 * multiplanar / 3D render), a clip-plane dropdown, a window/level dropdown
 * (auto + OHIF's modality presets), an overlay toggle, and a reset-view button,
 * all running the commands in commands.ts. Registered with the toolbar service
 * via the `niivue.toolbarButtons` customization (see below) or directly.
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
    id: NIIVUE_WL_SECTION,
    uiType: 'ohif.toolButtonList',
    props: { buttonSection: true },
  },
  {
    id: 'NiivueWLAuto',
    uiType: 'ohif.toolButton',
    props: {
      icon: 'tool-window-level',
      label: 'Auto Window',
      tooltip: 'Auto window/level (robust 2-98%, NiiVue)',
      commands: 'niivueAutoWindowLevel',
      evaluate: NIIVUE_EVALUATOR,
    },
  },
  wlPresetButton('NiivueWLCtSoft', 'CT', 'ct-soft-tissue', 0, 'Soft Tissue'),
  wlPresetButton('NiivueWLCtLung', 'CT', 'ct-lung', 1, 'Lung'),
  wlPresetButton('NiivueWLCtLiver', 'CT', 'ct-liver', 2, 'Liver'),
  wlPresetButton('NiivueWLCtBone', 'CT', 'ct-bone', 3, 'Bone'),
  wlPresetButton('NiivueWLCtBrain', 'CT', 'ct-brain', 4, 'Brain'),
  wlPresetButton('NiivueWLPtDefault', 'PT', 'pt-default', 0, 'PET Default'),
  wlPresetButton('NiivueWLPtSuv5', 'PT', 'pt-suv-5', 1, 'SUV 5'),
  wlPresetButton('NiivueWLPtSuv10', 'PT', 'pt-suv-10', 2, 'SUV 10'),
  {
    id: NIIVUE_COLORMAP_SECTION,
    uiType: 'ohif.toolButtonList',
    props: { buttonSection: true },
  },
  ...NIIVUE_COLORMAPS.map((c) => colormapButton(c.name, c.label)),
  {
    id: NIIVUE_COLORBAR_BUTTON,
    uiType: 'ohif.toolButton',
    props: {
      icon: 'icon-color-lut',
      label: 'Colorbar',
      tooltip: 'Toggle the colormap legend (NiiVue)',
      commands: 'niivueToggleColorbar',
      evaluate: COLORBAR_EVALUATOR,
    },
  },
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
  [NIIVUE_WL_SECTION]: [
    'NiivueWLAuto',
    'NiivueWLCtSoft',
    'NiivueWLCtLung',
    'NiivueWLCtLiver',
    'NiivueWLCtBone',
    'NiivueWLCtBrain',
    'NiivueWLPtDefault',
    'NiivueWLPtSuv5',
    'NiivueWLPtSuv10',
  ],
  [NIIVUE_COLORMAP_SECTION]: NIIVUE_COLORMAPS.map((c) =>
    colormapButtonId(c.name),
  ),
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
    {
      name: WL_PRESET_EVALUATOR,
      evaluate: ({ viewportId, button }) => {
        const entry = getNiivueEntryForViewport(viewportId)
        if (!entry) return DISABLED
        // Gray out presets whose modality does not match the base series.
        const modality = buttonCommandOption(button, 'modality')
        if (modality !== undefined && modality !== baseModality(entry)) {
          return {
            disabled: true,
            disabledText: `Applies to ${modality} series`,
          }
        }
        return { disabled: false }
      },
    },
    {
      name: COLORMAP_EVALUATOR,
      evaluate: ({ viewportId, button }) => {
        const nv = getNiivueForViewport(viewportId)
        if (!nv) return DISABLED
        const name = buttonCommandOption(button, 'colormap')
        const current = nv.volumes[0]?.colormap
        return {
          disabled: false,
          isActive:
            name !== undefined &&
            typeof current === 'string' &&
            current.toLowerCase() === name.toLowerCase(),
        }
      },
    },
    {
      name: COLORBAR_EVALUATOR,
      evaluate: ({ viewportId }) => {
        const nv = getNiivueForViewport(viewportId)
        if (!nv) return DISABLED
        return { disabled: false, isActive: nv.isColorbarVisible === true }
      },
    },
  ]
}
