import type {
  AnnotationChangedDetail,
  NiiVueLocation,
  NiiVueOptions,
  SlideTileSource,
  VectorAnnotation,
  VolumeUpdatedDetail,
} from '@niivue/niivue'
import NiiVue, { NVSlide, SLICE_TYPE } from '@niivue/niivue'
import {
  DicomWebWsiSource,
  registerDcm2niixDecoders,
} from '@niivue/nv-ext-tile/dicom'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createAdvancedMagnifyBinding } from './advancedMagnify'
import { useArrowText } from './arrowText'
import {
  calibrationEvents,
  calibrationScale,
  labelCalibration,
  paneDisplaySet,
  paneScale,
  setCalibrationScale,
  syncReportRows,
} from './calibration'
import { askCalibrationDistance, CalibratedMarker } from './calibrationForm'
import { classifyDisplaySet, extraDisplaySetsNote } from './classifyDisplaySet'
import {
  centerCrosshair,
  cornerstonePetWindowingStep,
  cornerstoneWindowingStep,
  dicomWindow,
  initialRenderView,
  initialSliceType,
  NIIVUE_SLICE_TYPES,
  readBaseWindowLevel,
  voiRange,
} from './commands'
import { useAnnotationContextMenu } from './contextMenu'
import {
  adoptContours,
  applyContourTool,
  isContourAnnotation,
  isContourCut,
  isContourEditable,
  isContourShown,
  parkContours,
  releaseContourTools,
} from './contourSeg'
import {
  convertDisplaySetToNifti,
  type DicomConversion,
  loadConversion,
} from './dicomToNiivue'
import { DisplayMenu } from './displayMenu'
import { displaySetToNiivue } from './displaySetToNiivue'
import { joinFrames } from './frames4D'
import {
  addCornerstoneColormaps,
  applyViewportStyle,
  baseStyle,
  isMip,
  isMipInverted,
  overlayDisplaySets,
  useHungOverlays,
} from './hangingOptions'
import {
  mirrorAnnotationHistory,
  useAnnotationHistory,
  withdrawLastStep,
} from './history'
import { createMagnifyBinding } from './magnify'
import { MeasurementData } from './measurementData'
import {
  applyDefaultAnnotationText,
  applyNiivueAnnotationDelta,
  clearNiivueAnnotations,
  isAnnotationShown,
  measurementNote,
  reconcileNiivueAnnotations,
  reflectNiivueAnnotation,
  releaseImportedRows,
  roundNumber,
  subscribeOhifLabelSync,
  unitForDisplaySet,
} from './measurementReflection'
import { useMetadataRevision } from './metadataReload'
import { useMipTools } from './mipTools'
import {
  authHeaders,
  getNiivueEntry,
  type NiivueViewportEntry,
  ohifServices,
  refreshToolbar,
  registerNiivue,
  type StatusKind,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import type {
  OhifDisplaySet,
  OhifExtensionManager,
  OhifViewportProps,
} from './ohif-types'
import { OrientationMenu } from './orientationMenu'
import { matchStoredOrientation, useOutputStack } from './outputStack'
import { setOverlayPlanes } from './overlayPlanes'
import { armBrush, showPaneLabel } from './petQuant'
import { ReferenceLines } from './referenceLines'
import { resolveSegDisplaySetsFor, useSegDrawing } from './segDrawing'
import {
  applySegTool,
  drawingValueAtMM,
  ohifPenSize,
  onToolModeChanged,
  toolMode,
} from './segEdit'
import { PaneCorner, useHydratePrompt } from './segHydration'
import { SegmentLabel, segmentLabel } from './segmentLabel'
import { SliceCine } from './sliceCine'
import type { SliceFrames } from './sliceFrames'
import { bindSlideMeasurements } from './slideMeasurements'
import { useOhifRowImport } from './srImport'
import { acquisitionSliceType } from './standardCommands'
import { floorSuvWindow } from './suv'
import {
  measureFreehand,
  ohifToolToAnnotationTool,
  ohifToolToDragMode,
} from './toolBridge'
import { useMeasurementTracking } from './trackingBridge'
import { ViewportNotification } from './viewportNotification'
import {
  CrosshairValueReadout,
  reformatPosition,
  type StackPosition,
  StackPositionReadout,
  StudyLabel,
  stackPosition,
  type WindowLevel,
  WindowLevelReadout,
} from './viewportOverlay'
import { joinSyncGroups } from './viewportSync'
import { displayPresetColormap } from './vrPresets'
import { wsiFetch, wsiRetrieveBulkData, wsiSeriesSlide } from './wsiSeries'
import {
  mountWsiSlideView,
  RULER_COLOR,
  type WsiSlideView,
} from './wsiSlideView'

const viewName = (sliceType: number | undefined) =>
  Object.keys(NIIVUE_SLICE_TYPES).find(
    (k) => NIIVUE_SLICE_TYPES[k] === sliceType,
  )

// Default NiiVue config for the OHIF viewport. Opens multiplanar (set after attach)
// so an OHIF user sees the three orthogonal planes; the toolbar (later) can switch to
// 3D render etc.
export const DEFAULT_OPTIONS: Partial<NiiVueOptions> = {
  backgroundColor: [0, 0, 0, 1],
  // WebGL2 is the robust default for an embedded viewport (broad support; avoids
  // WebGPU device churn when OHIF mounts/unmounts viewports). Revisit once WebGPU
  // multi-instance handling is proven in-app.
  backend: 'webgl2',
  // OHIF panel measurements are independent records: overlapping ones never
  // merge or cut (that would destroy their identity and stats). Contour
  // segments do merge: each contour segmentation adds its group.
  annotationMergedGroups: [],
  // A click lands the crosshair on a slice centre, so a measurement drawn there
  // lies on its DICOM frame (sliceFrames.frameAt).
  isSnapToVoxelCenters: true,
  // Cornerstone's convention: patient right on screen left, sagittal nose left.
  isRadiological: true,
  // Cornerstone's tools also place lines and ROIs click-move-click.
  annotationIsClickToPlace: true,
  // ...and draw ellipses and circles from their centre.
  annotationIsDrawnFromCenter: true,
  // ROI area as cornerstone reports it: the outline's, not a voxel count.
  annotationAreaIsGeometric: true,
  // Cornerstone's handles: a press on any measurement's handle drags it,
  // whatever the tool, with no selecting click first.
  annotationIsHandleGrab: true,
  // Yellow outlines without fill, as slide measurements and cornerstone's.
  annotationStyle: {
    fillColor: [0, 0, 0, 0],
    strokeColor: RULER_COLOR,
    strokeWidth: 2,
  },
}

export type Status = { kind: 'idle' } | { kind: StatusKind; message: string }

/**
 * The crosshair a load keeps: only on a reload of the display set shown (OHIF
 * keeps its UID on a metadata reload, as petSUV's), not on a switch to another,
 * even one split from the same series.
 */
export function keptCrosshair(
  nv: {
    volumes: readonly unknown[]
    getCrosshairPos(): [number, number, number]
  },
  ds: OhifDisplaySet | undefined,
  shownUid: string | undefined,
): [number, number, number] | undefined {
  return nv.volumes[0] && shownUid && ds?.displaySetInstanceUID === shownUid
    ? nv.getCrosshairPos()
    : undefined
}

/**
 * OHIF's data overlay menu offers a foreground only over a background with
 * imageIds, which cornerstone's viewport fills on load. Fill them only when one
 * per instance: nv-ohif reads them aligned with `instances`.
 */
export function fillImageIds(
  ds: OhifDisplaySet,
  extensionManager: OhifExtensionManager | undefined,
): void {
  if (ds.imageIds) return
  const ids = extensionManager
    ?.getActiveDataSource?.()[0]
    ?.getImageIdsForDisplaySet?.(ds)
  if (ids?.length && ids.length === ds.instances?.length) ds.imageIds = ids
}

/**
 * A series opens in its acquired plane, as a cornerstone stack does, unless the
 * hanging protocol names a view ('acquisition' names that plane). OHIF marks
 * unequal slice spacing (or orthogonal localizers) not reconstructable: only
 * the acquired plane is faithful there, even under a multiplanar protocol.
 */
export function openingSliceType(
  nv: Parameters<typeof acquisitionSliceType>[0] & {
    volumes: ReadonlyArray<{ dims?: number[] }>
  },
  viewportOptions: { orientation?: string } | undefined,
  isReconstructable: boolean | undefined,
): number {
  const initial = initialSliceType(viewportOptions)
  const orientation = viewportOptions?.orientation
  const plane =
    initial === SLICE_TYPE.MULTIPLANAR &&
    (!orientation ||
      orientation === 'acquisition' ||
      nv.volumes[0]?.dims?.[3] === 1 ||
      isReconstructable === false)
      ? acquisitionSliceType(nv)
      : undefined
  return plane ?? initial
}

/** Show `message` for `ms`; the clear never touches a newer status. */
export function briefNote(
  setStatus: Dispatch<SetStateAction<Status>>,
  message: string,
  ms = 6000,
): void {
  const status: Status = { kind: 'note', message }
  setStatus(status)
  setTimeout(() => setStatus((s) => (s === status ? { kind: 'idle' } : s)), ms)
}

// OHIF's toolbar tools operate on cornerstone viewports; our NiiVue viewport isn't in
// a cornerstone tool group. Instead we mirror OHIF's active primary mouse tool onto
// NiiVue's left-drag behaviour, so picking Window/Level, Pan, etc. in the toolbar
// controls the NiiVue viewport too.

/**
 * The NiiVue viewport React component OHIF hangs a display set in. It routes each
 * display set to the right NiiVue load path (see {@link classifyDisplaySet}):
 *   - a NIfTI/volume URL loads directly,
 *   - a volumetric DICOM series is fetched + converted with dcm2niix, then loaded,
 *   - whole-slide (SM) series render with NVSlide (JPEG, JPEG 2000, JPEG-LS),
 *   - anything else shows an explanatory note.
 *
 * NiiVue's core is framework-agnostic, so this owns a plain <canvas> + a `NiiVue`
 * instance directly (React 18) rather than depending on `@niivue/nvreact` (React 19).
 */
/**
 * Effect keys for the hanging-protocol options, by value (OHIF passes fresh
 * objects each render): `view` for the slice type, render camera, sync
 * groups and MIP; `style` for the pane background and MIP inversion; `load` for
 * what needs a reload (a 3D pane); `display` for the window and 3D preset,
 * applied in place.
 */
export function hangingKeys(
  viewportOptions: OhifViewportProps['viewportOptions'],
  displaySetOptions: OhifViewportProps['displaySetOptions'],
): { view: string; style: string; load: string; display: string } {
  const { orientation, viewportType, syncGroups } = viewportOptions ?? {}
  const mip = isMip(displaySetOptions)
  return {
    view: JSON.stringify([orientation, viewportType, syncGroups, mip]),
    style: JSON.stringify([
      viewportOptions?.background,
      isMipInverted(displaySetOptions),
    ]),
    load: JSON.stringify(
      initialSliceType(viewportOptions) === SLICE_TYPE.RENDER,
    ),
    display: JSON.stringify(displaySetOptions ?? null),
  }
}

/**
 * The base's display as cornerstone opens it: a 3D pane's volume-rendering
 * preset (its colormap carries its own window), else the hanging protocol's
 * window, else the shown instances' DICOM window, else NiiVue's robust range.
 */
export function hangingDisplay(
  viewportOptions: OhifViewportProps['viewportOptions'],
  displaySetOptions: OhifViewportProps['displaySetOptions'],
  ds: OhifDisplaySet,
  shown?: SliceFrames,
): { colormap: string } | { calMin: number; calMax: number } | undefined {
  const preset =
    initialSliceType(viewportOptions) === SLICE_TYPE.RENDER
      ? displayPresetColormap(displaySetOptions, ds.Modality)
      : undefined
  return preset
    ? { colormap: preset }
    : (voiRange(displaySetOptions) ?? dicomWindow(ds, shown))
}

/** What the load effect keys on: it changes whenever a new base starts loading. */
/**
 * Whether the display set hung under `key` is on screen. Keyed, so a new hang
 * reads as not loaded on its first render, before its load effect resets it.
 */
export function useLoadedFor(key: string): [boolean, (on: boolean) => void] {
  const [loadedKey, setLoadedKey] = useState<string>()
  return [loadedKey === key, (on) => setLoadedKey(on ? key : undefined)]
}

export function baseKey(
  displaySetsKey: string,
  ready: boolean,
  keys: { load: string },
): string {
  return JSON.stringify([displaySetsKey, ready, keys.load])
}

/** A new hanging protocol's window / preset on the loaded base, in place. */
export function applyHangingDisplay(
  entry: NiivueViewportEntry | undefined,
  viewportOptions: OhifViewportProps['viewportOptions'],
  displaySetOptions: OhifViewportProps['displaySetOptions'],
): void {
  const ds = entry?.displaySets[0]
  // A loading base takes the current options in settleBase.
  if (!entry || entry.baseLoading || !ds || !entry.nv.volumes[0]) return
  const spec = hangingDisplay(
    viewportOptions,
    displaySetOptions,
    ds,
    entry.sliceFrames,
  )
  // A window without a preset also drops a removed preset's colormap.
  // The protocol's colormap / inversion stays under a new window.
  const style = {
    isColormapInverted: false,
    ...baseStyle(entry.nv, displaySetOptions),
  }
  entry.nv
    .setVolume(
      0,
      spec
        ? { colormap: 'gray', ...style, ...spec }
        : { ...DEFAULT_DISPLAY, ...style },
    )
    .catch((err: unknown) =>
      console.error('[nv-ohif] hanging-protocol window failed', err),
    )
}

// No protocol window or preset: what a load installs, gray at the robust range.
const DEFAULT_DISPLAY = {
  colormap: 'gray',
  calMin: Number.NaN,
  calMax: Number.NaN,
}

/**
 * A base load that installed window `installed` and colormap/inversion
 * `installedStyle` has settled: apply protocol options changed meanwhile
 * (the display effect skips a loading base).
 */
export function settleBase(
  viewportId: string,
  installed: ReturnType<typeof hangingDisplay>,
  viewportOptions: OhifViewportProps['viewportOptions'],
  displaySetOptions: OhifViewportProps['displaySetOptions'],
  installedStyle: ReturnType<typeof baseStyle> = {},
): void {
  const entry = getNiivueEntry(viewportId)
  const ds = entry?.displaySets[0]
  if (!entry || !ds) return
  const latest = [
    hangingDisplay(viewportOptions, displaySetOptions, ds, entry.sliceFrames),
    baseStyle(entry.nv, displaySetOptions),
  ]
  if (JSON.stringify(latest) !== JSON.stringify([installed, installedStyle]))
    applyHangingDisplay(entry, viewportOptions, displaySetOptions)
}

export function NiivueViewport(props: OhifViewportProps) {
  const { viewportId, servicesManager } = props
  // A hung SEG shows as a drawing over the series it references (segDrawing.ts).
  const { displaySets, seg } = resolveSegDisplaySetsFor(
    props.displaySets,
    servicesManager,
  )
  // Hung itself and not yet hydrated: a preview, with OHIF's hydrate prompt.
  const isSegPreview =
    !!seg && props.displaySets[0] === seg && seg.isHydrated !== true
  const toolGroupId = props.viewportOptions?.toolGroupId ?? 'default'
  // Longitudinal (tracking) modes: forward new measurements to OHIF's tracker.
  useMeasurementTracking(viewportId, servicesManager, props.extensionManager)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nvRef = useRef<NiiVue | null>(null)
  const slideViewRef = useRef<WsiSlideView | null>(null)
  const magnifyRef = useRef<ReturnType<typeof createMagnifyBinding> | null>(
    null,
  )
  const glassesRef = useRef<ReturnType<
    typeof createAdvancedMagnifyBinding
  > | null>(null)
  const activeOhifToolRef = useRef<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // The series whose volume is shown: imports must not target an outgoing one.
  const [loadedSeries, setLoadedSeries] = useState<string>()
  // The series the pane last showed: a reload of it (petSUV Reload Data) keeps the crosshair.
  const shownDisplaySetRef = useRef<string | undefined>(undefined)
  // The base display set shown: a NIfTI set may carry no series UID.
  const [loadedBase, setLoadedBase] = useState<string>()
  // The shown conversion, for stepping through a series' other outputs.
  const [conversion, setConversion] = useState<DicomConversion | null>(null)
  // An arrow's text through OHIF's dialog, as cornerstone asks (arrowText.ts).
  useArrowText(ready ? nvRef.current : null, props.commandsManager)
  // Orthogonal localizers: the wheel steps through the series' outputs (outputStack.ts).
  const outputNote = useCallback(
    (message: string) => briefNote(setStatus, message),
    [],
  )
  useOutputStack(
    ready ? nvRef.current : null,
    viewportId,
    displaySets[0],
    conversion,
    outputNote,
    (o) => {
      const nv = nvRef.current
      if (nv)
        void setOverlayPlanes(
          nv,
          o.overlayPlanes,
          props.extensionManager,
          getNiivueEntry(viewportId)?.toolGroupId ?? 'default',
        )
    },
  )
  // The load's first position predates the split registering: recount it.
  const showStackRef = useRef<(e: Event) => void>(() => {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: reruns per conversion by design
  useEffect(() => showStackRef.current(new Event('outputs')), [conversion])
  // NiiVue edits in OHIF's undo history (history.ts).
  useAnnotationHistory(ready ? nvRef.current : null, props.extensionManager)
  // Right-click on an annotation: OHIF's measurement menu (contextMenu.ts).
  useAnnotationContextMenu(ready ? nvRef.current : null, props.commandsManager)
  // Hydrated SR rows on this series become NiiVue measurements (srImport.ts).
  useOhifRowImport(
    loadedSeries ? nvRef.current : null,
    loadedSeries,
    servicesManager,
  )
  // Display sets 1.. layer over the base (TMTV fusion), as cornerstone's.
  useHungOverlays(
    ready ? nvRef.current : null,
    viewportId,
    displaySets,
    props.displaySetOptions,
    loadedBase,
    props.commandsManager,
  )
  // Resolves once the current load installs its base volume (the SEG's background).
  const baseInstalledRef = useRef<Promise<boolean>>(Promise.resolve(false))
  // Base window, shown lower left as cornerstone's viewport overlay does.
  const [windowLevel, setWindowLevel] = useState<WindowLevel | null>(null)
  // Instance under the crosshair, for a 2D slice in the acquisition plane.
  const [stack, setStack] = useState<StackPosition | null>(null)
  // Base intensity at the crosshair (cornerstone has no such readout; Probe pins one).
  const [crosshairValue, setCrosshairValue] = useState<string | null>(null)
  // Name of the segment at the crosshair, shown above the value.
  const [crosshairSegment, setCrosshairSegment] = useState<string>()
  // A 3D render has no slice to label: hide the corner text, as the HP's 3D pane does.
  const [sliceType, setSliceType] = useState<number>()
  const isRender = sliceType === SLICE_TYPE.RENDER
  // TMTV's MIP pane: wheel rotates, a click jumps to the brightest voxel.
  useMipTools(
    ready ? nvRef.current : null,
    containerRef.current,
    toolGroupId,
    servicesManager,
  )

  // OHIF can re-render with fresh displaySets/servicesManager object
  // identities on unrelated state changes (e.g. toolbar interactions). Effects
  // must NOT key on those identities — a spurious re-run of the create effect
  // would tear down the GPU context, and of the load effect refetch the whole
  // series — so they read the latest props from refs and key on stable values.
  const displaySetsRef = useRef(displaySets)
  displaySetsRef.current = displaySets
  const servicesManagerRef = useRef(servicesManager)
  servicesManagerRef.current = servicesManager
  const extensionManagerRef = useRef(props.extensionManager)
  extensionManagerRef.current = props.extensionManager
  const dataSourceRef = useRef(props.dataSource)
  dataSourceRef.current = props.dataSource
  const displaySetOptionsRef = useRef(props.displaySetOptions)
  displaySetOptionsRef.current = props.displaySetOptions
  const viewportOptionsRef = useRef(props.viewportOptions)
  viewportOptionsRef.current = props.viewportOptions
  const onElementEnabledRef = useRef(props.onElementEnabled)
  onElementEnabledRef.current = props.onElementEnabled
  const displaySetsKey = displaySets
    .map((ds) => String(ds.displaySetInstanceUID ?? ds.SeriesInstanceUID ?? ''))
    .join('|')
  // petSUV panel edits (metadataReload.ts) reload this pane, overlays included.
  const metadataRevision = useMetadataRevision(servicesManager, displaySetsKey)

  const keys = hangingKeys(props.viewportOptions, props.displaySetOptions)
  // A petSUV edit (metadataRevision) is a new base: the SEG reloads on it too.
  const base = `${baseKey(displaySetsKey, ready, keys)}#${metadataRevision}`
  // The hung display set is on screen: `data-loaded`, a positive signal for tests.
  const [isLoaded, setIsLoaded] = useLoadedFor(base)
  useHydratePrompt(seg, isSegPreview, isLoaded, {
    viewportId,
    servicesManager,
    commandsManager: props.commandsManager,
    extensionManager: props.extensionManager,
  })
  // The hanging protocol's view and sync groups, on attach and whenever a new
  // protocol changes them for the same viewport and series. Declared before the
  // create effect so unmount leaves the sync groups before nv.destroy().
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on keys.view by design
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !ready) return
    // Before the first load no volume is open, so this is the protocol's own
    // type; the load then picks the acquired plane.
    nv.sliceType = openingSliceType(
      nv,
      viewportOptionsRef.current,
      displaySets[0]?.isReconstructable,
    )
    const view = initialRenderView(viewportOptionsRef.current)
    if (view) [nv.azimuth, nv.elevation] = view
    return joinSyncGroups(
      viewportId,
      nv,
      viewportOptionsRef.current?.syncGroups,
    )
  }, [ready, viewportId, keys.view])
  // Background and MIP (hangingOptions.ts): after the view, which a MIP
  // overrides. Not on a window change, which must not re-aim a MIP camera.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on keys.view by design
  useEffect(() => {
    const nv = nvRef.current
    if (!nv?.canvas || !ready) return
    applyViewportStyle(
      nv,
      nv.canvas,
      viewportOptionsRef.current,
      displaySetOptionsRef.current,
    )
  }, [ready, viewportId, keys.view, keys.style])

  // Create / tear down the NiiVue instance with the canvas.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let noteTimeout: number | undefined
    const flashNote = (message: string, ms = 2000) => {
      window.clearTimeout(noteTimeout)
      const note: Status = { kind: 'note', message }
      setStatus(note)
      noteTimeout = window.setTimeout(() => {
        noteTimeout = undefined
        // Only clear this occurrence, never a newer status with the same text.
        setStatus((current) => (current === note ? { kind: 'idle' } : current))
      }, ms)
    }
    // UIKit annotation overlay for volume measurements + ROIs (registered after
    // the font loads); torn down on unmount.
    let leaveFrames: (() => void) | null = null
    let unfloorSuv: (() => void) | null = null
    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%'
    container.appendChild(canvas)

    const nv = new NiiVue(DEFAULT_OPTIONS)
    nvRef.current = nv
    // Only mark ready once attach resolves — loading before that races the GPU
    // context (and StrictMode double-mounts), which left the volume unloaded.
    // Catching the chained promise also covers a throw in the ready callback.
    const started = nv.attachToCanvas(canvas).then(() => {
      if (disposed) return
      addCornerstoneColormaps(nv)
      // A locked contour segment's shape cannot be grabbed (core already
      // refuses any shape annotationIsHidden hides).
      nv.annotationIsGrabbable = (a) => isContourEditable(a, viewportId)
      nv.annotationIsCut = isContourCut
      // Panel-hidden measurements and hidden contour segments are not drawn
      // or picked.
      nv.annotationIsHidden = (a) =>
        !isAnnotationShown(viewportId, a.id) || !isContourShown(a, nv)
      // Expose the instance to OHIF commands / toolbar evaluators (commands.ts),
      // with a status sink so async commands (overlay load) surface progress.
      registerNiivue(viewportId, nv)
      leaveFrames = joinFrames(
        viewportId,
        nv,
        servicesManagerRef.current,
        container.parentElement,
      )
      unfloorSuv = floorSuvWindow(
        nv,
        () => unitForDisplaySet(displaySetsRef.current[0]) === 'SUV',
      )
      updateNiivueViewport(viewportId, {
        setStatus: (message, kind = 'note') =>
          setStatus(message === null ? { kind: 'idle' } : { kind, message }),
      })
      refreshToolbar(servicesManagerRef.current, viewportId)
      setReady(true)
      // Without it the grid never reaches VIEWPORTS_READY.
      onElementEnabledRef.current?.()
    })
    started.catch((err) => {
      if (disposed) return
      console.error('[nv-ohif] viewer failed to start', err)
      setStatus({ kind: 'error', message: 'Failed to start the viewer.' })
    })

    const ro = new ResizeObserver(() => nv.resize())
    ro.observe(container)

    // Core emits volumeUpdated for every base-window change (windowing/contrast
    // drags, pointercancel, setVolume); keep the corner readout current.
    const showWindowLevel = () => {
      const wl = readBaseWindowLevel(nv)
      setWindowLevel((shown) =>
        wl && shown?.window === wl.window && shown.level === wl.level
          ? shown
          : (wl ?? null),
      )
    }
    const onVolumeUpdated = (e: CustomEvent<VolumeUpdatedDetail>) => {
      if (e.detail.volumeIndex === 0) showWindowLevel()
    }
    nv.addEventListener('volumeUpdated', onVolumeUpdated)
    nv.addEventListener('locationChange', showWindowLevel)
    // OHIF shows I: only for a stack: a single 2D view in the acquisition plane.
    // sliceTypeChange carries no position: reuse the last crosshair.
    let vox: number[] | undefined
    // A label overlay's name there (a SEG shown before it loads as the drawing).
    let overlayLabel: string | undefined
    const showStack = (e: Event) => {
      const values = (e as CustomEvent<Partial<NiiVueLocation>>).detail?.values
      if (values) {
        const v = values[0]
        vox = v?.vox
        overlayLabel = values
          .slice(1)
          .map((o) => o.label)
          .find(Boolean)
        setCrosshairValue(
          v && Number.isFinite(v.value)
            ? `${v.approximate ? '~' : ''}${roundNumber(v.value)}`
            : null,
        )
      }
      const entry = getNiivueEntry(viewportId)
      const moved = (e as CustomEvent<{ mm?: number[] }>).detail?.mm
      if (entry && moved) entry.crosshairMM = moved
      const mm = moved ?? entry?.crosshairMM
      const seg = mm ? drawingValueAtMM(nv, mm) : 0
      setCrosshairSegment(
        (seg ? segmentLabel(nv.drawColormap, seg) : undefined) ?? overlayLabel,
      )
      const pos =
        mm && nv.sliceType === acquisitionSliceType(nv)
          ? stackPosition(
              entry?.displaySets[0],
              entry?.sliceFrames,
              mm,
              viewportOptionsRef.current?.viewportType === 'volume',
              !!entry?.switchToInstance,
            )
          : reformatPosition(nv.sliceType, vox, nv.volumes[0]?.dimsRAS)
      setStack((shown) =>
        pos && shown?.index === pos.index && shown.total === pos.total
          ? shown
          : (pos ?? null),
      )
    }
    showStackRef.current = showStack
    nv.addEventListener('locationChange', showStack)
    nv.addEventListener('sliceTypeChange', showStack)
    const showRender = () => setSliceType(nv.sliceType)
    showRender()
    nv.addEventListener('sliceTypeChange', showRender)

    // Annotations (Length / ROI / arrow): reflect a completed vector annotation
    // into OHIF's measurement panel, remove its row when the annotation is
    // removed, and drop every row when annotations are cleared (series swap /
    // clear-all).
    const onAnnotationAdded = (
      annotation: VectorAnnotation,
      drawn: boolean,
    ) => {
      // Contour segments are segmentation, not measurements (contourSeg.ts).
      if (isContourAnnotation(annotation)) return
      // A CalibrationLine the user draws asks for the actual distance, then
      // goes, as OHIF's.
      if (
        drawn &&
        activeOhifToolRef.current === 'CalibrationLine' &&
        annotation.shape?.type === 'measureLine'
      ) {
        nv.removeAnnotation(annotation.id)
        withdrawLastStep(nv, extensionManagerRef.current)
        void calibrate(annotation.stats?.length)
        return
      }
      if (applyDefaultAnnotationText(annotation, nv.annotations)) nv.drawScene()
      measureFreehand(nv, annotation)
      const added = reflectNiivueAnnotation(
        viewportId,
        servicesManagerRef.current,
        annotation,
      )
      const message = measurementNote(annotation.stats, paneScale(viewportId))
      if (added && message) flashNote(message)
    }
    // One handler per change: a shape just drawn or added is reflected first,
    // an edited one (erase, merge, undo) re-measured, then the panel follows
    // the delta, including a removal or a draw that merged (clipper union or
    // cut) a reflected annotation out of the set.
    const onAnnotationChanged = (e: Event) => {
      const detail = (e as CustomEvent<AnnotationChangedDetail>).detail
      const byId = new Map(nv.annotations.map((a) => [a.id, a]))
      if (detail.action === 'draw' || detail.action === 'add')
        for (const id of detail.added) {
          const a = byId.get(id)
          if (a) onAnnotationAdded(a, detail.action === 'draw')
        }
      for (const id of detail.updated) {
        const a = byId.get(id)
        if (a && !isContourAnnotation(a)) measureFreehand(nv, a)
      }
      applyNiivueAnnotationDelta(viewportId, servicesManagerRef.current, detail)
      syncReportRows()
    }
    const calibrate = async (nativeMM: number | undefined) => {
      const ds = paneDisplaySet(viewportId)
      if (!ds || !nativeMM) return
      const shown = `${Math.round(nativeMM * calibrationScale(ds) * 100) / 100}`
      const text = await askCalibrationDistance(
        servicesManagerRef.current?.services,
        shown,
      )
      if (text === null || text.trim() === shown) return
      const mm = Number(text)
      if (Number.isFinite(mm) && mm > 0) setCalibrationScale(ds, mm / nativeMM)
      else flashNote('Calibration needs a distance above 0 mm')
    }
    // Rows, labels and rulers of this pane's display set follow a calibration.
    const onCalibration = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== paneDisplaySet(viewportId))
        return
      nv.annotationCalibration = labelCalibration(paneScale(viewportId))
      reconcileNiivueAnnotations(viewportId, servicesManagerRef.current)
    }
    calibrationEvents.addEventListener('change', onCalibration)
    nv.addEventListener('annotationChanged', onAnnotationChanged)

    // Push OHIF measurement-label edits onto the matching NiiVue annotation as
    // free text, so labeling a row in the panel labels the shape on the canvas.
    const unsubscribeLabelSync = subscribeOhifLabelSync(
      servicesManagerRef.current,
    )

    return () => {
      disposed = true
      window.clearTimeout(noteTimeout)
      setReady(false)
      // Drop this viewport's reflected measurement rows and their bookkeeping:
      // nv.destroy() fires no 'clear' event, so without this the panel rows and
      // the module-level reflection maps would leak across every unmount
      // (StrictMode double-mount, route / layout churn).
      clearNiivueAnnotations(viewportId)
      leaveFrames?.()
      unfloorSuv?.()
      unregisterNiivue(viewportId)
      // Report rows this pane held no longer count toward their scale.
      syncReportRows()
      releaseContourTools(viewportId)
      refreshToolbar(servicesManagerRef.current, viewportId)
      nv.removeEventListener('volumeUpdated', onVolumeUpdated)
      nv.removeEventListener('locationChange', showWindowLevel)
      nv.removeEventListener('locationChange', showStack)
      nv.removeEventListener('sliceTypeChange', showStack)
      nv.removeEventListener('sliceTypeChange', showRender)
      calibrationEvents.removeEventListener('change', onCalibration)
      nv.removeEventListener('annotationChanged', onAnnotationChanged)
      unsubscribeLabelSync?.()
      // React cleans this effect up before the tool effect's: the lens must
      // go first, or its dispose draws a destroyed viewer.
      magnifyRef.current?.dispose()
      magnifyRef.current = null
      glassesRef.current?.dispose()
      glassesRef.current = null
      ro.disconnect()
      nv.destroy()
      // Free the WebGL context now, not at GC: layout churn would otherwise
      // hit the browser's ~16 live-context cap (D5-08).
      canvas
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context')
        ?.loseContext()
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      nvRef.current = null
    }
  }, [viewportId])

  // Load the display set(s) hung in this viewport, once attached / on change.
  // Keyed on displaySetsKey and keys.load (not the array identity) by design — see above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the base key by design
  useEffect(() => {
    const nv = nvRef.current
    const displaySets = displaySetsRef.current
    const servicesManager = servicesManagerRef.current
    if (!nv || !ready) return
    // This effect re-runs when a NEW display set is hung in the same viewport
    // slot (OHIF swaps props; the NiiVue instance is reused — the create effect
    // keys only on viewportId). Core loadVolumes replaces the volume array but
    // does NOT reset annotations or our overlay bookkeeping, so clear them here
    // before loading the new series: otherwise the previous series' measurements
    // and ROIs re-project onto the new anatomy, and the Overlay button reads
    // active with nothing overlaid. (No-op on the first load — nothing to clear
    // yet.)
    releaseImportedRows(viewportId)
    parkContours(viewportId)
    nv.clearAnnotations()
    let baseInstalled = (_: boolean) => {}
    baseInstalledRef.current = new Promise((resolve) => {
      baseInstalled = resolve
    })
    setWindowLevel(null)
    setStack(null)
    setCrosshairValue(null)
    // Keep the registry's view of the base display sets current, so overlay
    // commands know what is already loaded and W/L-preset buttons can gate on
    // the base modality (see commands.ts). Refresh the toolbar so those
    // modality-gated buttons re-evaluate now that the modality is known.
    // Only displaySets[0] is shown (owner Q7), so only it counts as the base:
    // the others stay overlay candidates.
    updateNiivueViewport(viewportId, {
      displaySets: displaySets.slice(0, 1),
      overlays: new Map(),
      baseLoading: true,
      overlayLoading: false,
      sliceFrames: undefined,
    })
    // Labels follow the calibration of the series the pane now shows.
    nv.annotationCalibration = labelCalibration(paneScale(viewportId))
    refreshToolbar(servicesManager, viewportId)

    // Volume-loading routes call loadVolumes, which replaces nv.volumes to match
    // the reset overlays. Routes that do NOT load a volume (WSI /
    // unsupported / empty) must drop any volumes left from a previous series, or
    // nv.volumes desyncs from the empty overlays — the volume-gated Overlay button
    // would stay enabled on a WSI viewport and toggling it would stack volumes.
    const dropStaleVolumes = () => {
      if (nv.volumes.length > 0) void nv.removeAllVolumes().catch(() => {})
    }

    // If OHIF hung nothing, stay idle.
    const ds: OhifDisplaySet | undefined = displaySets[0]
    const kept = keptCrosshair(nv, ds, shownDisplaySetRef.current)
    setIsLoaded(false)
    setLoadedSeries(undefined)
    setLoadedBase(undefined)
    setConversion(null)
    if (!ds) {
      dropStaleVolumes()
      setStatus({ kind: 'idle' })
      return
    }

    // Every outcome names the display sets not shown.
    const overlays = overlayDisplaySets(displaySets)
    const extraNote = extraDisplaySetsNote(
      displaySets.filter((d) => !overlays.includes(d)),
    )
    const withExtra = (message?: string) =>
      [message, extraNote].filter(Boolean).join(' ')
    const loaded = (note?: string) => {
      const message = withExtra(note)
      if (!message) return setStatus({ kind: 'idle' })
      briefNote(setStatus, message)
    }

    let cancelled = false
    const abort = new AbortController()
    // The protocol's colormap / inversion under its window or preset.
    const style = baseStyle(nv, displaySetOptionsRef.current)
    const spec = hangingDisplay(
      viewportOptionsRef.current,
      displaySetOptionsRef.current,
      ds,
    )

    // The base is installed: show its window, enable the volume toolbar.
    const seedWindowLevel = (installed = spec) => {
      if (cancelled) return
      baseInstalled(true)
      setLoadedSeries(ds.SeriesInstanceUID as string | undefined)
      setLoadedBase(ds.displaySetInstanceUID)
      shownDisplaySetRef.current = ds.displaySetInstanceUID
      fillImageIds(ds, props.extensionManager)
      if (kept) nv.setCrosshairPos(kept)
      else centerCrosshair(nv)
      const vol = nv.volumes[0]
      const suv = unitForDisplaySet(ds) === 'SUV'
      const step =
        vol &&
        (suv
          ? cornerstonePetWindowingStep(vol, nv.canvas?.clientHeight ?? 0)
          : cornerstoneWindowingStep(vol))
      // Set on every load: a PT pane reloaded as CT must drop it.
      nv.isWindowingUpperBoundOnly = suv && !!step
      if (step) nv.windowingStep = step
      const wl = readBaseWindowLevel(nv)
      setWindowLevel(wl ?? null)
      updateNiivueViewport(viewportId, { baseLoading: false })
      settleBase(
        viewportId,
        installed,
        viewportOptionsRef.current,
        displaySetOptionsRef.current,
        style,
      )
      // A reflection may have failed while OHIF's backing series or the converted
      // volume was still becoming ready. Retry after the load boundary even when
      // annotation geometry itself has not changed.
      reconcileNiivueAnnotations(viewportId, servicesManagerRef.current)
      const entry = getNiivueEntry(viewportId)
      if (entry) {
        showPaneLabel(entry, servicesManagerRef.current)
        // Contours whose pane went (a layout change) come back on this one.
        adoptContours(entry, {
          servicesManager: servicesManagerRef.current,
          extensionManager: props.extensionManager,
        })
      }
      // The volume-gated toolbar buttons (Views, Clip, W/L, ...) were evaluated
      // at attach time when no volume was loaded yet, so they came up disabled.
      // Now that the volume is in (esp. after the async dcm2niix conversion),
      // re-evaluate the toolbar so they enable.
      refreshToolbar(servicesManagerRef.current, viewportId)
      setIsLoaded(true)
    }

    // Phase-1 fast path: a display set that is already a NiiVue volume URL.
    const direct = displaySetToNiivue(ds)
    if (direct) {
      loaded()
      // Fetch first and install only if the slot still shows this series: a
      // stale load must not replace (or, undone, remove) a newer base.
      nv.prepareVolume({ ...direct, ...style, ...spec })
        .then(async (image) => {
          if (cancelled) return
          await nv.loadVolumes([image])
          if (cancelled) return
          // The view effect ran before any volume was open.
          nv.sliceType = openingSliceType(
            nv,
            viewportOptionsRef.current,
            ds.isReconstructable,
          )
          seedWindowLevel()
        })
        .catch(() => {
          if (!cancelled)
            setStatus({
              kind: 'error',
              message: withExtra('Failed to load volume.'),
            })
        })
      return () => {
        cancelled = true
      }
    }

    // Otherwise route by kind.
    const kind = classifyDisplaySet(ds)

    if (kind === 'wsi') {
      // WSI renders on its own slide canvas, not the NiiVue volume renderer, so
      // drop any volume left from a previous series in this slot.
      dropStaleVolumes()
      // Whole-slide imaging renders with NVSlide (tiled deep-zoom) on its own
      // WebGL2 canvas, independent of NiiVue's volume renderer. The NiiVue canvas
      // stays blank underneath; the slide canvas is overlaid and torn down here.
      const picked = wsiSeriesSlide(ds)
      if ('note' in picked) {
        setStatus({ kind: 'note', message: withExtra(picked.note) })
        return
      }
      const { slide: slideIndex, seriesUrl } = picked
      registerDcm2niixDecoders() // lazy: loads nothing until a JPEG 2000 or JPEG-LS tile
      const container = containerRef.current
      if (!container) return
      let slideCanvas: HTMLCanvasElement | null = null
      let view: WsiSlideView | null = null
      let unbindMeasurements: (() => void) | undefined
      let limitTimeout: number | undefined
      let limitNote: Status | null = null
      const cannotShow = (err: unknown) =>
        setStatus({
          kind: 'note',
          message: withExtra(
            `This slide cannot be shown: ${err instanceof Error ? err.message : String(err)}.`,
          ),
        })
      // Reads one frame per level whose metadata states no transfer syntax.
      DicomWebWsiSource.open(
        slideIndex,
        {
          seriesUrl,
          fetch: wsiFetch(servicesManager),
          retrieveBulkData: wsiRetrieveBulkData(
            dataSourceRef.current,
            ds.StudyInstanceUID,
          ),
        },
        abort.signal,
      ).then(
        async (source) => {
          // Not shown: the source is ours to release (NVSlide owns it once built).
          if (cancelled) {
            ;(source as SlideTileSource).dispose?.()
            return
          }
          let slide: NVSlide
          try {
            slide = NVSlide.fromSource(source)
          } catch (err) {
            ;(source as SlideTileSource).dispose?.()
            cannotShow(err)
            return
          }
          const canvas = document.createElement('canvas')
          slideCanvas = canvas
          canvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none'
          container.appendChild(canvas)
          try {
            // Annotations draw their size labels on the slide itself, so the
            // status overlay does not repeat the reading.
            const mounted = await mountWsiSlideView(canvas, slide, {
              // A brief note, cleared early when the requested level fits again.
              onLevelLimit: (message) => {
                window.clearTimeout(limitTimeout)
                const shown = limitNote
                setStatus((s) => (s === shown ? { kind: 'idle' } : s))
                limitNote = message ? { kind: 'note', message } : null
                if (!limitNote) return
                const note = limitNote
                setStatus(note)
                limitTimeout = window.setTimeout(
                  () => setStatus((s) => (s === note ? { kind: 'idle' } : s)),
                  3000,
                )
              },
            })
            slideCanvas = mounted.canvas
            // Cancelled while the renderer started: the cleanup already ran.
            if (cancelled) {
              mounted.dispose()
              slideCanvas.remove()
              return
            }
            view = mounted
            slideViewRef.current = view
            view.setTool(activeOhifToolRef.current)
            const unbindRows = bindSlideMeasurements(
              view,
              servicesManager,
              ds,
              props.commandsManager,
            )
            // Handle edits are undoable steps, as NiiVue's.
            const unbindHistory = view.annotations
              ? mirrorAnnotationHistory(
                  view.annotations,
                  props.extensionManager,
                )
              : undefined
            unbindMeasurements = () => {
              unbindHistory?.()
              unbindRows()
            }
            updateNiivueViewport(viewportId, { slideView: view })
            refreshToolbar(servicesManager, viewportId)
            setIsLoaded(true)
            loaded()
          } catch (err) {
            slide.dispose()
            canvas.remove()
            if (cancelled) return
            console.error('[nv-ohif] WSI view failed', err)
            setStatus({
              kind: 'error',
              message: withExtra('Failed to start the whole-slide viewer.'),
            })
          }
        },
        (err) => {
          // An undecodable transfer syntax lands here, named in the message.
          if (!cancelled) cannotShow(err)
        },
      )
      return () => {
        cancelled = true
        abort.abort()
        window.clearTimeout(limitTimeout)
        updateNiivueViewport(viewportId, { slideView: undefined })
        slideViewRef.current = null
        unbindMeasurements?.()
        view?.dispose()
        if (slideCanvas) {
          slideCanvas.width = 0
          slideCanvas.height = 0
          slideCanvas.remove()
        }
      }
    }

    if (kind === 'unsupported') {
      dropStaleVolumes()
      setStatus({
        kind: 'note',
        message: withExtra("This series isn't something NiiVue can load yet."),
      })
      return
    }

    // kind === 'dicom-volume': fetch original DICOM P10 + convert with dcm2niix.
    setStatus({ kind: 'loading', message: 'Fetching DICOM series...' })
    convertDisplaySetToNifti(ds, {
      headers: authHeaders(servicesManager),
      signal: abort.signal,
      onProgress: (phase, loaded, total) => {
        if (cancelled) return
        setStatus({
          kind: 'loading',
          message:
            phase === 'fetching'
              ? `Fetching DICOM series... ${loaded}/${total}`
              : 'Converting DICOM to NIfTI (dcm2niix)...',
        })
      },
    })
      .then((converted) => {
        if (cancelled) return
        if (!converted) {
          setStatus({
            kind: 'error',
            message: withExtra('DICOM conversion produced no volume.'),
          })
          return
        }
        loaded(converted.note)
        // The DICOM window of the instances this output was made of.
        const dicomSpec = hangingDisplay(
          viewportOptionsRef.current,
          displaySetOptionsRef.current,
          ds,
          converted.sliceFrames,
        )
        return loadConversion(
          nv,
          viewportId,
          converted,
          { ...style, ...dicomSpec },
          () => cancelled,
        ).then((shown) => {
          if (!shown) return
          setConversion(converted)
          void setOverlayPlanes(
            nv,
            converted.overlayPlanes,
            props.extensionManager,
            getNiivueEntry(viewportId)?.toolGroupId ?? 'default',
          )
          // Each series gets its own view, not the one the previous series
          // left (a coronal scout's).
          matchStoredOrientation(nv)
          nv.sliceType = openingSliceType(
            nv,
            viewportOptionsRef.current,
            ds.isReconstructable,
          )
          seedWindowLevel(dicomSpec)
        })
      })
      .catch((err) => {
        if (cancelled || abort.signal.aborted) return
        console.error('[nv-ohif] DICOM load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        setStatus({
          kind: 'error',
          message: withExtra(
            `DICOM load failed: ${message || 'unknown error'}`,
          ),
        })
      })
      // Release the shared conversion once the base settles: NiiVue holds its
      // own decoded copy, and panes in the same commit have joined already.
      .finally(() => abort.abort())

    return () => {
      cancelled = true
      abort.abort()
    }
  }, [base])

  // After the load effect, so a base and SEG changed together wait on the new base.
  useSegDrawing(
    nvRef,
    seg,
    isSegPreview,
    baseInstalledRef,
    base,
    { viewportId, servicesManager, extensionManager: props.extensionManager },
    (message, brief) =>
      brief
        ? briefNote(setStatus, message)
        : setStatus({ kind: 'note', message }),
  )

  const isVolumeViewport = props.viewportOptions?.viewportType === 'volume'
  useEffect(() => {
    if (ready) updateNiivueViewport(viewportId, { isVolumeViewport })
  }, [ready, viewportId, isVolumeViewport])

  // A new window / preset for the loaded series: in place, so the volume and
  // the user's measurements stay. Declared after the load effect, so a new
  // series (baseLoading) takes it in settleBase instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on keys.display by design
  useEffect(() => {
    if (!ready) return
    applyHangingDisplay(
      getNiivueEntry(viewportId),
      viewportOptionsRef.current,
      displaySetOptionsRef.current,
    )
  }, [ready, viewportId, keys.display])

  // Mirror OHIF's active primary tool onto NiiVue's matching left-drag mode, so
  // windowing, pan, zoom, measurements, angles and ROI tools drive this viewport.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !ready) return
    updateNiivueViewport(viewportId, { toolGroupId })
    const svc = ohifServices(servicesManager)?.toolGroupService
    if (!svc?.getActivePrimaryMouseButtonTool) return

    const magnify = createMagnifyBinding(nv)
    magnifyRef.current = magnify
    const glasses = createAdvancedMagnifyBinding(nv)
    glassesRef.current = glasses
    const apply = () => {
      const tool = svc.getActivePrimaryMouseButtonTool?.(toolGroupId)
      activeOhifToolRef.current = tool
      magnify.setTool(tool)
      // Passive (another tool primary) keeps the glasses; Disabled removes them.
      glasses.setMode(
        toolMode(
          props.extensionManager,
          toolGroupId ?? 'default',
          'AdvancedMagnify',
        ),
      )
      // Labelmap tools paint the pane's drawing (segEdit.ts); contour tools
      // draw the active contour segment (contourSeg.ts). Each disarms when
      // the other's tool comes, so both run.
      if (applySegTool(nv, tool, toolGroupId, props.extensionManager)) {
        applyContourTool(nv, viewportId, undefined, servicesManager)
        return
      }
      if (applyContourTool(nv, viewportId, tool, servicesManager)) return
      // ROI / arrow tools drive NiiVue's vector-annotation system (measureEllipse
      // etc.); the master gate must be on for a left-drag to draw. Every other
      // tool turns the gate off and maps to a left-drag mode instead.
      // CalibrationLine draws a measured line (onAnnotationAdded calibrates).
      const annoTool =
        tool === 'CalibrationLine'
          ? 'measureLine'
          : ohifToolToAnnotationTool(tool)
      // Brush/Eraser/Threshold paint the PT label (petQuant.ts).
      nv.drawIsEnabled = armBrush(viewportId, tool, servicesManager, () =>
        ohifPenSize(nv, toolGroupId, props.extensionManager),
      )
      if (nv.drawIsEnabled) nv.annotationIsEnabled = false
      else if (annoTool) {
        nv.annotationTool = annoTool
        // A closed freehand path is a filled ROI (cornerstone's
        // PlanarFreehandROI), core's polygon mode, not a brush stroke.
        if (annoTool === 'freehand') nv.annotationBrushRadius = 1
        nv.annotationIsEnabled = true
      } else {
        nv.annotationIsEnabled = false
        nv.primaryDragMode = ohifToolToDragMode(tool)
      }
      slideViewRef.current?.setTool(tool)
    }
    apply()
    const event = svc.EVENTS?.PRIMARY_TOOL_ACTIVATED
    const sub = event ? svc.subscribe?.(event, apply) : undefined
    // Toggling AdvancedMagnify off while Passive activates no tool.
    const offMode = onToolModeChanged(
      props.extensionManager,
      toolGroupId ?? 'default',
      'AdvancedMagnify',
      (m: string | undefined) => glasses.setMode(m),
    )
    return () => {
      sub?.unsubscribe?.()
      offMode()
      magnify.dispose()
      magnifyRef.current = null
      glasses.dispose()
      glassesRef.current = null
    }
  }, [ready, servicesManager, toolGroupId, viewportId, props.extensionManager])

  // Per render it would rescan a 4D PET's 9400 instances (SUV decay time) on every frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: petSUV edits bump metadataRevision
  const unit = useMemo(
    () => unitForDisplaySet(displaySets[0]),
    [displaySets[0], metadataRevision],
  )
  const overlay = status.kind === 'idle' ? null : status.message
  return (
    <div
      data-viewport-id={viewportId}
      // OHIF's viewport attribute (cornerstone sets it): OHIF tooling and specs find panes by it.
      data-viewportid={viewportId}
      data-loaded={isLoaded || undefined}
      // The pane's view (axial, ..., render): asserted against the protocol.
      data-view={viewName(sliceType)}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        // iOS long-press otherwise selects the canvas and opens its callout.
        style={{
          position: 'absolute',
          inset: 0,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      />
      {overlay ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: status.kind === 'error' ? '#e88' : '#9aa',
            font: '14px sans-serif',
            textAlign: 'center',
            padding: '1rem',
            pointerEvents: 'none',
          }}
        >
          {overlay}
        </div>
      ) : null}
      <CalibratedMarker displaySetUID={displaySets[0]?.displaySetInstanceUID} />
      <MeasurementData
        nv={ready ? nvRef.current : null}
        slide={isLoaded ? slideViewRef.current?.annotations : undefined}
        viewportId={viewportId}
        unit={unit}
      />
      {/* Reconstructable volumes only, as cornerstone's evaluate.orientationMenu:
          a whole slide or a lone/orthogonal image has no other plane. */}
      <OrientationMenu
        nv={
          isLoaded &&
          !slideViewRef.current &&
          displaySets[0]?.isReconstructable !== false
            ? nvRef.current
            : null
        }
        isCT={displaySets[0]?.Modality === 'CT'}
      />
      {props.viewportOptions?.customViewportProps?.hideOverlays ||
      isRender ? null : (
        <>
          <StudyLabel ds={displaySets[0]} />
          {windowLevel ? <WindowLevelReadout {...windowLevel} /> : null}
          {stack ? <StackPositionReadout {...stack} /> : null}
          {crosshairValue !== null ? (
            <CrosshairValueReadout
              value={crosshairValue}
              unit={unit}
              aboveStack={!!stack}
              segment={crosshairSegment}
            />
          ) : null}
        </>
      )}
      <PaneCorner
        viewportId={viewportId}
        displaySetsKey={props.displaySets
          .map((ds) => ds.displaySetInstanceUID)
          .join()}
        servicesManager={servicesManager}
      />
      <ReferenceLines
        viewportId={viewportId}
        isLoaded={isLoaded && !slideViewRef.current}
        servicesManager={servicesManager}
        extensionManager={props.extensionManager}
      />
      <SegmentLabel
        viewportId={viewportId}
        isLoaded={isLoaded && !slideViewRef.current}
        extensionManager={props.extensionManager}
      />
      <DisplayMenu
        viewportId={viewportId}
        isLoaded={isLoaded && !slideViewRef.current}
        servicesManager={servicesManager}
      />
      <SliceCine
        viewportId={viewportId}
        isLoaded={isLoaded && !slideViewRef.current && !isRender}
        servicesManager={servicesManager}
      />
      <ViewportNotification
        viewportId={viewportId}
        servicesManager={servicesManager}
      />
    </div>
  )
}
