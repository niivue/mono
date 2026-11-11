import { SLICE_TYPE } from '@niivue/niivue'
import {
  applyWindowLevelPreset,
  NIIVUE_SLICE_TYPES,
  resetView,
  setViewportColormap,
} from './commands'
import {
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  ohifCommandsManager,
  refreshToolbar,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'

/**
 * OHIF's standard viewport commands, answered on a NiiVue viewport. The NIIVUE
 * context registers after CORNERSTONE, so these names shadow Cornerstone's
 * (CommandsManager searches newer contexts first); any other target is handed
 * back to the CORNERSTONE context explicitly, which cannot re-enter here.
 */
/**
 * OHIF's rotate and flip commands. They act on 2D slice tiles only, so they
 * no-op (and the toolbar disables them) on an NVSlide (WSI), render or graph view.
 */
export const NIIVUE_ROTATE_FLIP_COMMANDS = [
  'rotateViewportCW',
  'rotateViewportCCW',
  'rotateViewportCWSet',
  'flipViewportHorizontal',
  'flipViewportVertical',
  'setViewportHorizontalFlip',
  'setViewportVerticalFlip',
] as const

export const NIIVUE_STANDARD_COMMANDS = [
  'resetViewport',
  'setViewportOrientation',
  'scaleUpViewport',
  'scaleDownViewport',
  'fitViewportToWindow',
  'setWindowLevelPreset',
  'setViewportColormap',
  ...NIIVUE_ROTATE_FLIP_COMMANDS,
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

/** No 2D tile to turn or flip: a slide, a render-only or a graph-only view. */
export function noTiles2D(entry: NiivueViewportEntry): boolean {
  const { sliceType } = entry.nv
  return (
    Boolean(entry.slideView) ||
    sliceType === SLICE_TYPE.RENDER ||
    sliceType === SLICE_TYPE.NONE
  )
}

// rotation: degrees clockwise on screen. 'set' is the turn as seen, so one flip
// negates the stored rotation (Cornerstone's set mode).
function turn(
  entry: NiivueViewportEntry,
  rotation: unknown,
  mode: 'apply' | 'set',
): void {
  const degrees = Number(rotation)
  if (noTiles2D(entry) || !Number.isFinite(degrees)) return
  const { nv } = entry
  if (mode === 'apply') nv.rotate2D(degrees / 90)
  else
    nv.rotation2D =
      nv.isFlipped2DHorizontal !== nv.isFlipped2DVertical ? -degrees : degrees
}

function flip(
  entry: NiivueViewportEntry,
  axis: 'horizontal' | 'vertical',
  value?: unknown,
): void {
  if (noTiles2D(entry)) return
  const { nv } = entry
  if (value === undefined) nv.flip2D(axis)
  else if (axis === 'horizontal') nv.isFlipped2DHorizontal = Boolean(value)
  else nv.isFlipped2DVertical = Boolean(value)
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
    setViewportColormap: {
      commandFn: route('setViewportColormap', (entry, opts) => {
        setViewportColormap(entry, opts)
        refreshToolbar(servicesManager, entry.viewportId)
      }),
    },
    rotateViewportCW: {
      commandFn: route('rotateViewportCW', (entry, opts) =>
        turn(entry, opts.rotation, 'apply'),
      ),
      options: { rotation: 90 },
    },
    rotateViewportCCW: {
      commandFn: route('rotateViewportCCW', (entry, opts) =>
        turn(entry, opts.rotation, 'apply'),
      ),
      options: { rotation: -90 },
    },
    rotateViewportCWSet: {
      commandFn: route('rotateViewportCWSet', (entry, opts) =>
        turn(entry, opts.rotation, 'set'),
      ),
      options: { rotation: 90 },
    },
    flipViewportHorizontal: {
      commandFn: route('flipViewportHorizontal', (entry) =>
        flip(entry, 'horizontal'),
      ),
    },
    flipViewportVertical: {
      commandFn: route('flipViewportVertical', (entry) =>
        flip(entry, 'vertical'),
      ),
    },
    setViewportHorizontalFlip: {
      commandFn: route('setViewportHorizontalFlip', (entry, opts) =>
        flip(entry, 'horizontal', opts.flipped),
      ),
      options: { flipped: true },
    },
    setViewportVerticalFlip: {
      commandFn: route('setViewportVerticalFlip', (entry, opts) =>
        flip(entry, 'vertical', opts.flipped),
      ),
      options: { flipped: true },
    },
  }
}
