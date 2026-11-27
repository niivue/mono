import { SLICE_TYPE } from '@niivue/niivue'
import { showCaptureForm } from './captureForm'
import {
  applyWindowLevelPreset,
  invertBase,
  NIIVUE_SLICE_TYPES,
  rasToLps,
  resetView,
  setViewportColormap,
} from './commands'
import {
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  niivueEntries,
  ohifCommandsManager,
  ohifServices,
  refreshToolbar,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'
import { refreshOverlayPlanes } from './overlayPlanes'
import {
  type FrameRef,
  frameAt,
  onSlicePlane,
  type SliceFrames,
  shownImages,
} from './sliceFrames'
import { toggleSliceSync } from './viewportSync'
import { CINEMATIC_LIGHTING } from './vrPresets'

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
  'invertViewport',
  'jumpToImage',
  'firstImage',
  'lastImage',
  'setViewportColormap',
  'deleteActiveAnnotation',
  'cancelActiveOperation',
  'cancelMeasurement',
  'nextImage',
  'previousImage',
  'showDownloadViewportModal',
  'setVolumeRenderingQulaity',
  'shiftVolumeOpacityPoints',
  'setVolumeLighting',
  ...NIIVUE_ROTATE_FLIP_COMMANDS,
] as const

type StandardOptions = Record<string, unknown> & {
  viewportId?: string
  viewport?: { id?: string }
}

// Cornerstone scales parallelScale by 0.9 (up) / 1.1 (down); NiiVue's zoom is
// its inverse. Clamps match NiiVue's own wheel/pinch limits.
const ZOOM_IN = 1 / 0.9
const ZOOM_OUT = 1 / 1.1
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

/**
 * A layer's display options as OHIF's addDisplaySetAsLayer sets them: the
 * modality's overlay colormap (customizable, default hsv) at 90% opacity; a
 * SEG none.
 */
function layerOptions(
  servicesManager: OhifExtensionParams['servicesManager'],
  uid: string,
): Record<string, unknown> {
  const services = ohifServices(servicesManager)
  const ds = (
    services?.displaySetService as
      | { getDisplaySetByUID?(uid: string): { Modality?: string } | undefined }
      | undefined
  )?.getDisplaySetByUID?.(uid)
  if (!ds || ds.Modality === 'SEG') return {}
  const maps = (
    services?.customizationService as
      | { getCustomization?(name: string): unknown }
      | undefined
  )?.getCustomization?.('cornerstone.modalityOverlayDefaultColorMaps') as
    | { defaultSettings?: Record<string, { colormap?: string }> }
    | undefined
  const name = maps?.defaultSettings?.[ds.Modality ?? '']?.colormap ?? 'hsv'
  return { colormap: { name, opacity: 0.9 } }
}

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

/**
 * The slice type of a volume's native slice plane (Cornerstone's
 * 'acquisition'): the DICOM frames' plane where the pane maps them, since
 * dcm2niix turns a 3D acquisition toward RAS (a sagittal T1 stored with axial
 * slices); else the NIfTI slice axis.
 */
export function acquisitionSliceType(nv: {
  volumes: ReadonlyArray<{ permRAS?: number[] }>
}): number | undefined {
  const sf = niivueEntries().find((e) => e.nv === nv)?.sliceFrames
  if (sf?.frames.some(Boolean)) {
    const n = sf.normal.map(Math.abs)
    return ACQUISITION_SLICE_TYPES[n.indexOf(Math.max(...n))]
  }
  return ACQUISITION_SLICE_TYPES[
    nv.volumes[0]?.permRAS?.findIndex((p) => Math.abs(p) === 3) ?? -1
  ]
}

function setOrientation(
  entry: NiivueViewportEntry,
  orientation: unknown,
): void {
  const { nv } = entry
  if (entry.slideView || nv.volumes.length === 0) return
  const sliceType =
    orientation === 'acquisition'
      ? acquisitionSliceType(nv)
      : NIIVUE_SLICE_TYPES[String(orientation)]
  if (sliceType !== undefined) nv.sliceType = sliceType
}

/** No 2D tile to turn or flip: a slide, a render-only or a graph-only view. */
/**
 * OHIF's jumpToImage: show the stack's `imageIndex`-th image (negative counts
 * from the end), keeping the crosshair's in-plane spot. A stack viewport counts
 * in display-set order, mapped to a slice through the slice -> frame map; a
 * volume viewport counts along the volume, as Cornerstone does; a non-DICOM
 * volume, or a viewport turned off its acquisition plane, counts its slices
 * along the viewport's axis.
 */
// jumpToImage's images: a split series (outputStack.ts) counts every output's.
function stackImages(
  entry: NiivueViewportEntry,
  instances: ReadonlyArray<{ SOPInstanceUID?: string }>,
  sf: SliceFrames,
): FrameRef[] {
  const outputs = entry.switchToInstance ? entry.outputFrames : undefined
  return shownImages(
    instances,
    outputs ? { ...sf, frames: outputs.flatMap((o) => o.frames) } : sf,
  )
}

export function jumpToImage(
  entry: NiivueViewportEntry,
  imageIndex: unknown,
): void {
  const sf = entry.sliceFrames
  const i = Number(imageIndex)
  if (!Number.isInteger(i) || !entry.crosshairMM) return
  const [x = 0, y = 0, z = 0] = entry.crosshairMM
  const { nv } = entry
  // A viewport turned off its acquisition plane counts along the view axis,
  // which the slice -> frame map does not span.
  const offAxis =
    ACQUISITION_SLICE_TYPES.some((t) => t === nv.sliceType) &&
    nv.sliceType !== acquisitionSliceType(nv)
  if (!sf || offAxis) {
    jumpToVoxelSlice(nv, [x, y, z], i)
    return
  }
  let k: number
  if (entry.isVolumeViewport) k = i < 0 ? sf.frames.length + i : i
  else {
    const instances = (entry.displaySets[0]?.instances ?? []) as Array<{
      SOPInstanceUID?: string
    }>
    // A series split into outputs counts its whole display set
    // (outputStack.ts): another output's image (a localizer of another
    // orientation), or one queued behind a switch still loading, shows centred.
    const image = stackImages(entry, instances, sf).at(i)
    if (!image) return
    const switching = entry.switchToInstance?.(
      image.SOPInstanceUID,
      image.frameNumber,
    )
    if (switching) {
      // The output shows centred; then select the frame, unless a later jump won.
      void switching.then((isLatest) => {
        if (isLatest) jumpToImage(entry, imageIndex)
      })
      return
    }
    k = sf.frames.findIndex(
      (f) =>
        f?.SOPInstanceUID === image.SOPInstanceUID &&
        f.frameNumber === image.frameNumber,
    )
  }
  if (k < 0 || k >= sf.frames.length) return
  nv.setCrosshairPos(rasToLps(onSlicePlane(sf, rasToLps([x, y, z]), k)))
}

type Vec3 = [number, number, number]

/**
 * Move RAS point `p` along the base volume's voxel axis onto slice `i` of that
 * axis: the 2D view's axis, else the acquisition (native slice) axis.
 */
function jumpToVoxelSlice(
  nv: NiivueViewportEntry['nv'],
  p: Vec3,
  i: number,
): void {
  const vol = nv.volumes[0]
  const twoD = ACQUISITION_SLICE_TYPES.findIndex((t) => t === nv.sliceType)
  const axis =
    twoD >= 0 ? twoD : (vol?.permRAS?.findIndex((d) => Math.abs(d) === 3) ?? -1)
  const n = vol?.dimsRAS?.[axis + 1]
  const o = nv.vox2mm([0, 0, 0])
  if (axis < 0 || !n || !o) return
  const k = i < 0 ? n + i : i
  if (k < 0 || k >= n) return
  // Voxel steps along each RAS axis (an oblique matRAS has off-diagonal terms).
  const steps = [0, 1, 2].map((a) => {
    const v = nv.vox2mm([a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0])
    return v ? v.map((c, j) => c - (o[j] ?? 0)) : [0, 0, 0]
  }) as Vec3[]
  const step = steps[axis] as Vec3
  const [u, w] = steps.filter((_, a) => a !== axis) as [Vec3, Vec3]
  // The slice planes' normal; depth along it counts slices from voxel 0.
  const normal: Vec3 = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const depth =
    dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], normal) / dot(step, normal)
  const t = k - depth
  nv.setCrosshairPos([
    p[0] + t * step[0],
    p[1] + t * step[1],
    p[2] + t * step[2],
  ])
}

// RAS voxel axis along each 2D plane's normal (axial z, coronal y, sagittal x).
const NORMAL_AXIS = [2, 1, 0]

/**
 * OHIF's nextImage / previousImage (up / down): step `delta` images in
 * jumpToImage's count (stack order, volume order on a volume viewport); off the
 * slice -> frame map (a reformat) one voxel along the view axis.
 */
/** True when it moved to another frame (false off the map or at an end). */
export function scrollImage(
  entry: NiivueViewportEntry,
  delta: number,
): boolean {
  const { nv, sliceFrames: sf, crosshairMM: p } = entry
  const frame =
    sf && p && nv.sliceType === acquisitionSliceType(nv)
      ? frameAt(sf, [rasToLps([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0])])
      : undefined
  if (sf && frame) {
    const instances = (entry.displaySets[0]?.instances ?? []) as Array<{
      SOPInstanceUID?: string
    }>
    // jumpToImage's count: a split series (outputStack.ts) counts its whole
    // display set, so a step can switch outputs.
    const order: ReadonlyArray<FrameRef | undefined> = entry.isVolumeViewport
      ? sf.frames
      : stackImages(entry, instances, sf)
    const i = order.findIndex(
      (f) =>
        f?.SOPInstanceUID === frame.SOPInstanceUID &&
        f.frameNumber === frame.frameNumber,
    )
    if (i >= 0) {
      const j = clamp(i + delta, 0, order.length - 1)
      jumpToImage(entry, j)
      return j !== i
    }
  }
  const axis =
    NORMAL_AXIS[nv.sliceType] ?? NORMAL_AXIS[acquisitionSliceType(nv) ?? -1]
  if (axis === undefined) return false
  const step = [0, 0, 0]
  step[axis] = delta
  nv.moveCrosshairInVox(step[0] ?? 0, step[1] ?? 0, step[2] ?? 0)
  return false
}

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
  extensionManager,
}: OhifExtensionParams) {
  const route =
    (
      name: (typeof NIIVUE_STANDARD_COMMANDS)[number],
      act: (entry: NiivueViewportEntry, opts: StandardOptions) => void,
    ) =>
    (opts: StandardOptions = {}) => {
      // OHIF passes the target as viewportId, or (jumpToImage) as a grid viewport.
      const entry = getActiveNiivueEntry(
        servicesManager,
        opts.viewportId ?? opts.viewport?.id,
      )
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
    // Reference Lines / Image Overlay: cornerstone's targets the active pane's
    // cornerstone tool group; a NiiVue pane's group holds the mode its overlays
    // read (referenceLines.tsx, overlayPlanes.ts).
    toggleEnabledDisabledToolbar: {
      commandFn: (opts: StandardOptions = {}) => {
        const entry = getActiveNiivueEntry(servicesManager)
        const toolGroupId = entry?.toolGroupId ?? 'default'
        const result = ohifCommandsManager(commandsManager)?.runCommand?.(
          'toggleEnabledDisabledToolbar',
          entry && opts.toolGroupId === undefined
            ? { ...opts, toolGroupId }
            : opts,
          'CORNERSTONE',
        )
        if (entry && (opts.itemId ?? opts.value) === 'ImageOverlayViewer')
          for (const e of niivueEntries())
            if ((e.toolGroupId ?? 'default') === toolGroupId)
              void refreshOverlayPlanes(e.nv, extensionManager, toolGroupId)
        return result
      },
    },
    // Image Slice Sync: cornerstone's synchronizer links only its own viewports.
    toggleSynchronizer: {
      commandFn: (opts: StandardOptions = {}) => {
        if (opts.type === 'imageSlice') toggleSliceSync()
        return ohifCommandsManager(commandsManager)?.runCommand?.(
          'toggleSynchronizer',
          opts,
          'CORNERSTONE',
        )
      },
    },
    // Cornerstone's targets the active pane's Cornerstone tool group, which a
    // NiiVue pane lacks (AdvancedMagnify's button): target the pane's group.
    toggleActiveDisabledToolbar: {
      commandFn: (opts: StandardOptions = {}) => {
        const entry =
          opts.toolGroupId === undefined && opts.toolGroupIds === undefined
            ? getActiveNiivueEntry(servicesManager)
            : undefined
        return ohifCommandsManager(commandsManager)?.runCommand?.(
          'toggleActiveDisabledToolbar',
          entry
            ? { ...opts, toolGroupId: entry.toolGroupId ?? 'default' }
            : opts,
          'CORNERSTONE',
        )
      },
    },
    // OHIF's (DEFAULT context) asks cornerstone for the pane's orientation,
    // which throws on a NiiVue pane; a NiiVue pane only needs the display set
    // hung after its own (the data overlay menu's Add: a SEG or RTSTRUCT layer).
    addDisplaySetAsLayer: {
      commandFn: (opts: StandardOptions = {}) => {
        const grid = ohifServices(servicesManager)?.viewportGridService as
          | {
              getActiveViewportId(): string
              getDisplaySetsUIDsForViewport(id: string): string[]
              getState?(): {
                viewports?: Map<
                  string,
                  { displaySetOptions?: Record<string, unknown>[] }
                >
              }
            }
          | undefined
        const viewportId = opts.viewportId ?? grid?.getActiveViewportId()
        const uid = opts.displaySetInstanceUID
        const commands = ohifCommandsManager(commandsManager)
        if (
          !grid ||
          !viewportId ||
          !getActiveNiivueEntry(servicesManager, viewportId)
        )
          return commands?.runCommand?.('addDisplaySetAsLayer', opts, 'DEFAULT')
        const uids = grid.getDisplaySetsUIDsForViewport(viewportId) ?? []
        if (typeof uid !== 'string' || uids.includes(uid)) return
        // Without the grid's state, leave the layers' options to OHIF.
        const state = grid.getState?.()
        const kept = state?.viewports?.get(viewportId)?.displaySetOptions ?? []
        commands?.runCommand?.('setDisplaySetsForViewports', {
          viewportsToUpdate: [
            {
              viewportId,
              displaySetInstanceUIDs: [...uids, uid],
              ...(state && {
                displaySetOptions: [
                  ...uids.map((_, i) => kept[i] ?? {}),
                  layerOptions(servicesManager, uid),
                ],
              }),
            },
          ],
        })
      },
    },
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
    invertViewport: { commandFn: route('invertViewport', invertBase) },
    // cornerstone's volume rendering options (D5-06) on a NiiVue 3D pane.
    // Quality: samples per voxel along the ray (NiiVue's 1-4).
    setVolumeRenderingQulaity: {
      commandFn: route('setVolumeRenderingQulaity', ({ nv }, opts) => {
        nv.volumeSampleRate = Math.min(
          4,
          Math.max(1, Number(opts.volumeQuality) || 1),
        )
      }),
    },
    // Shift: the opacity ramp moves along intensity with the window.
    shiftVolumeOpacityPoints: {
      commandFn: route('shiftVolumeOpacityPoints', ({ nv }, opts) => {
        const vol = nv.volumes[0]
        const shift = Number(opts.shift) || 0
        if (vol && shift)
          void nv.setVolume(0, {
            calMin: vol.calMin + shift,
            calMax: vol.calMax + shift,
          })
      }),
    },
    // Shade: standard 3D's illumination. Ambient, diffuse and specular set the
    // pane's 3D Cinematic lighting (standard 3D has one illumination strength).
    setVolumeLighting: {
      commandFn: route('setVolumeLighting', ({ nv }, opts) => {
        // OHIF's menu nests the values; useViewportRendering passes them flat.
        const o = (opts.options ?? opts) as Record<string, unknown>
        if (typeof o.shade === 'boolean')
          nv.volumeIllumination = o.shade ? 0.6 : 0
        const lighting = Object.fromEntries(
          Object.entries(CINEMATIC_LIGHTING)
            .filter(([k]) => typeof o[k] === 'number')
            .map(([k, key]) => [key, o[k]]),
        )
        if (Object.keys(lighting).length) nv.volumeCinematic = lighting
      }),
    },
    // Delete on a NiiVue pane removes its selected annotation (undoably; undo
    // and redo are OHIF's, through its history: history.ts).
    deleteActiveAnnotation: {
      commandFn: route('deleteActiveAnnotation', ({ nv }) => {
        // A half-drawn contour goes first (Backspace mid-draw), as cornerstone.
        if (nv.cancelAnnotationInProgress()) return
        const id = nv.selectedAnnotation
        if (id) nv.removeAnnotation(id, true)
      }),
    },
    // Escape (OHIF's cancelActiveOperation, which calls cornerstone's
    // cancelMeasurement action directly): drop a half-drawn shape.
    cancelActiveOperation: {
      commandFn: route('cancelActiveOperation', ({ nv }) => {
        nv.cancelAnnotationInProgress()
      }),
    },
    cancelMeasurement: {
      commandFn: route('cancelMeasurement', ({ nv }) => {
        nv.cancelAnnotationInProgress()
      }),
    },
    jumpToImage: {
      commandFn: route('jumpToImage', (entry, opts) =>
        jumpToImage(entry, opts.imageIndex),
      ),
    },
    // Cornerstone's call its own actions directly, so they need shadowing too.
    nextImage: {
      commandFn: route('nextImage', (entry) => scrollImage(entry, 1)),
    },
    previousImage: {
      commandFn: route('previousImage', (entry) => scrollImage(entry, -1)),
    },
    firstImage: {
      commandFn: route('firstImage', (entry) => jumpToImage(entry, 0)),
    },
    lastImage: {
      commandFn: route('lastImage', (entry) => jumpToImage(entry, -1)),
    },
    // Capture: the pane as shown, as a PNG.
    // ponytail: no size/filename form (cornerstone's modal renders off-screen).
    showDownloadViewportModal: {
      commandFn: route('showDownloadViewportModal', (entry) =>
        showCaptureForm(entry, ohifServices(servicesManager)),
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
