import { SLICE_TYPE } from '@niivue/niivue'
import { getActiveNiivue } from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'

// Toolbar-facing slice type names -> NiiVue SLICE_TYPE values. String keys keep
// the toolbar button definitions plain JSON (commandOptions survive OHIF's
// customization-service cloning).
export const NIIVUE_SLICE_TYPES: Record<string, number> = {
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  render: SLICE_TYPE.RENDER,
}

// Matches NiiVue's SCENE_DEFAULTS (NVConstants.ts), which the public API does
// not export — restated here.
const VIEW_DEFAULTS = {
  azimuth: 110,
  elevation: 10,
  scaleMultiplier: 1.0,
  pan2Dxyzmm: [0, 0, 0, 1] as [number, number, number, number],
  renderPan: [0, 0] as [number, number],
  crosshairPos: [0.5, 0.5, 0.5] as [number, number, number],
}

/**
 * getCommandsModule: OHIF commands operating on the active NiiVue viewport.
 * Toolbar buttons (see toolbar.ts) reference these by name; they are also
 * runnable from any OHIF surface via `commandsManager.runCommand(...)`.
 */
export function getNiivueCommandsModule({
  servicesManager,
}: OhifExtensionParams) {
  const actions = {
    /** Switch the view: axial / coronal / sagittal / multiplanar / render. */
    niivueSetSliceType: ({ sliceType }: { sliceType?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      const mapped = sliceType ? NIIVUE_SLICE_TYPES[sliceType] : undefined
      if (!nv || mapped === undefined) return
      nv.sliceType = mapped
    },

    /** Reset camera, pan, zoom, and crosshair to their defaults. */
    niivueResetView: () => {
      const nv = getActiveNiivue(servicesManager)
      if (!nv) return
      nv.azimuth = VIEW_DEFAULTS.azimuth
      nv.elevation = VIEW_DEFAULTS.elevation
      nv.scaleMultiplier = VIEW_DEFAULTS.scaleMultiplier
      nv.pan2Dxyzmm = [...VIEW_DEFAULTS.pan2Dxyzmm]
      nv.renderPan = [...VIEW_DEFAULTS.renderPan]
      nv.crosshairPos = [...VIEW_DEFAULTS.crosshairPos]
    },
  }

  return {
    actions,
    definitions: {
      niivueSetSliceType: actions.niivueSetSliceType,
      niivueResetView: actions.niivueResetView,
    },
    defaultContext: 'NIIVUE',
  }
}
