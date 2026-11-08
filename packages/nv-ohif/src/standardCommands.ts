import { SLICE_TYPE } from '@niivue/niivue'
import {
  applyWindowLevelPreset,
  NIIVUE_SLICE_TYPES,
  resetView,
} from './commands'
import {
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  ohifCommandsManager,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'

/**
 * OHIF's standard viewport commands, answered on a NiiVue viewport. The NIIVUE
 * context registers after CORNERSTONE, so these names shadow Cornerstone's
 * (CommandsManager searches newer contexts first); any other target is handed
 * back to the CORNERSTONE context explicitly, which cannot re-enter here.
 */
export const NIIVUE_STANDARD_COMMANDS = [
  'resetViewport',
  'setViewportOrientation',
  'scaleUpViewport',
  'scaleDownViewport',
  'fitViewportToWindow',
  'setWindowLevelPreset',
] as const

type StandardOptions = Record<string, unknown> & { viewportId?: string }

// Cornerstone scales parallelScale by 0.9 (up) / 1.1 (down); NiiVue's zoom is
// its inverse. Clamps match NiiVue's own wheel/pinch limits.
const ZOOM_IN = 1 / 0.9
const ZOOM_OUT = 1 / 1.1
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

function scale(entry: NiivueViewportEntry, direction: unknown): void {
  const factor =
    direction === 0 ? 0 : Number(direction) > 0 ? ZOOM_IN : ZOOM_OUT
  if (entry.slideView) {
    if (factor) entry.slideView.zoom(factor)
    else entry.slideView.fit()
    return
  }
  const { nv } = entry
  if (nv.sliceType === SLICE_TYPE.RENDER) {
    nv.scaleMultiplier = factor ? clamp(nv.scaleMultiplier * factor, 0.5, 2) : 1
    if (!factor) nv.renderPan = [0, 0]
    return
  }
  const [x, y, z, zoom] = nv.pan2Dxyzmm as [number, number, number, number]
  nv.pan2Dxyzmm = factor
    ? [x, y, z, clamp(zoom * factor, 0.1, 10)]
    : [0, 0, 0, 1]
}

// Cornerstone's 'acquisition' is the volume's native slice plane: the RAS axis
// voxel dimension 3 maps to (permRAS is signed and 1-based).
const ACQUISITION_SLICE_TYPES = [
  SLICE_TYPE.SAGITTAL,
  SLICE_TYPE.CORONAL,
  SLICE_TYPE.AXIAL,
]

function setOrientation(
  entry: NiivueViewportEntry,
  orientation: unknown,
): void {
  const { nv } = entry
  if (entry.slideView || nv.volumes.length === 0) return
  const sliceType =
    orientation === 'acquisition'
      ? ACQUISITION_SLICE_TYPES[
          nv.volumes[0]?.permRAS?.findIndex((p) => Math.abs(p) === 3) ?? -1
        ]
      : NIIVUE_SLICE_TYPES[String(orientation)]
  if (sliceType !== undefined) nv.sliceType = sliceType
}

/** Command definitions for {@link NIIVUE_STANDARD_COMMANDS}. */
export function getStandardCommandDefinitions({
  servicesManager,
  commandsManager,
}: OhifExtensionParams) {
  const route =
    (
      name: (typeof NIIVUE_STANDARD_COMMANDS)[number],
      act: (entry: NiivueViewportEntry, opts: StandardOptions) => void,
    ) =>
    (opts: StandardOptions = {}) => {
      const entry = getActiveNiivueEntry(servicesManager, opts.viewportId)
      if (entry) return act(entry, opts)
      return ohifCommandsManager(commandsManager)?.runCommand?.(
        name,
        opts,
        'CORNERSTONE',
      )
    }
  const scaleCommand = (
    name: (typeof NIIVUE_STANDARD_COMMANDS)[number],
    direction: number,
  ) => ({
    commandFn: route(name, (entry, opts) => scale(entry, opts.direction)),
    options: { direction },
  })

  return {
    resetViewport: { commandFn: route('resetViewport', resetView) },
    setViewportOrientation: {
      commandFn: route('setViewportOrientation', (entry, opts) =>
        setOrientation(entry, opts.orientation),
      ),
    },
    scaleUpViewport: scaleCommand('scaleUpViewport', 1),
    scaleDownViewport: scaleCommand('scaleDownViewport', -1),
    fitViewportToWindow: scaleCommand('fitViewportToWindow', 0),
    setWindowLevelPreset: {
      commandFn: route('setWindowLevelPreset', (entry, opts) =>
        applyWindowLevelPreset(
          entry,
          servicesManager,
          typeof opts.presetName === 'string' ? opts.presetName : undefined,
          typeof opts.presetIndex === 'number' ? opts.presetIndex : undefined,
        ),
      ),
    },
  }
}
