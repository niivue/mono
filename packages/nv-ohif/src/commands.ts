import { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import { classifyDisplaySet } from './classifyDisplaySet'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { displaySetToNiivue } from './displaySetToNiivue'
import {
  authHeaders,
  getActiveNiivue,
  getActiveNiivueEntry,
  getNiivueEntry,
  type NiivueViewportEntry,
  ohifCommandsManager,
  ohifServices,
  refreshToolbar,
} from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'

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

// Clip plane presets as NiiVue [depth, azimuth, elevation]. Depth 2 is out of
// range, which disables the plane (NiiVue's own convention for "off").
export const NIIVUE_CLIP_PLANES: Record<string, [number, number, number]> = {
  none: [2, 0, 0],
  right: [0, 90, 0],
  left: [0, 270, 0],
  anterior: [0, 180, 0],
  posterior: [0, 0, 0],
  superior: [0, 0, 90],
  inferior: [0, 0, -90],
}

// Overlay styling: a warm colormap over the grayscale base, half transparent.
export const OVERLAY_COLORMAP = 'warm'
export const OVERLAY_OPACITY = 0.5

// Base-volume colormaps offered in the toolbar dropdown (name -> label). Names
// are lowercase; NiiVue canonicalizes casing internally. All are registered
// NiiVue LUTs. 'gray' is the default a grayscale medical volume loads with.
export const NIIVUE_COLORMAPS: Array<{ name: string; label: string }> = [
  { name: 'gray', label: 'Gray' },
  { name: 'hot', label: 'Hot' },
  { name: 'bone', label: 'Bone' },
  { name: 'cool', label: 'Cool' },
  { name: 'warm', label: 'Warm' },
  { name: 'viridis', label: 'Viridis' },
  { name: 'plasma', label: 'Plasma' },
  { name: 'inferno', label: 'Inferno' },
  { name: 'turbo', label: 'Turbo' },
  { name: 'jet', label: 'Jet' },
]

// A DICOM window/level preset (width + center), the shape OHIF's
// `cornerstone.windowLevelPresets` customization stores per modality. `window`
// and `level` are strings there (from the preset UI); we coerce with Number().
export interface WindowLevelPreset {
  id?: string
  description?: string
  window: string | number
  level: string | number
}

// Fallback presets matching OHIF's shipped `defaultWindowLevelPresets`, used
// only when the host app does not expose the customization (e.g. a bare mode).
// The live values come from OHIF via the customization service (see
// resolveWindowLevelPreset), so a consumer's overrides flow through.
export const FALLBACK_WL_PRESETS: Record<string, WindowLevelPreset[]> = {
  CT: [
    {
      id: 'ct-soft-tissue',
      description: 'Soft tissue',
      window: 400,
      level: 40,
    },
    { id: 'ct-lung', description: 'Lung', window: 1500, level: -600 },
    { id: 'ct-liver', description: 'Liver', window: 150, level: 90 },
    { id: 'ct-bone', description: 'Bone', window: 2500, level: 480 },
    { id: 'ct-brain', description: 'Brain', window: 80, level: 40 },
  ],
  PT: [
    { id: 'pt-default', description: 'Default', window: 5, level: 2.5 },
    { id: 'pt-suv-5', description: 'SUV 5', window: 0, level: 5 },
    { id: 'pt-suv-10', description: 'SUV 10', window: 0, level: 10 },
  ],
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

interface DisplaySetServiceLike {
  getActiveDisplaySets?: () => OhifDisplaySet[]
  getDisplaySetsForSeries?: (uid: string) => ReadonlyArray<OhifDisplaySet>
}

// The next display set in the study that NiiVue could load but is not already
// the base or an overlay of this viewport.
export function findOverlayCandidate(
  entry: Pick<NiivueViewportEntry, 'displaySets' | 'overlayUIDs'>,
  activeDisplaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet | undefined {
  const loaded = new Set<string>(entry.overlayUIDs)
  for (const ds of entry.displaySets) {
    if (typeof ds.displaySetInstanceUID === 'string')
      loaded.add(ds.displaySetInstanceUID)
  }
  return activeDisplaySets.find((ds) => {
    const uid = ds.displaySetInstanceUID
    if (typeof uid !== 'string' || loaded.has(uid)) return false
    const kind = classifyDisplaySet(ds)
    return kind === 'nifti' || kind === 'dicom-volume'
  })
}

// Show a transient message in the viewport (no-op if the viewport did not
// register a status sink).
function flashStatus(entry: NiivueViewportEntry, message: string): void {
  entry.setStatus?.(message)
  setTimeout(() => entry.setStatus?.(null), 4000)
}

// The base series' modality (what OHIF's presets are keyed by).
export function baseModality(
  entry: Pick<NiivueViewportEntry, 'displaySets'>,
): string | undefined {
  const modality = entry.displaySets[0]?.Modality
  return typeof modality === 'string' ? modality : undefined
}

interface CustomizationServiceLike {
  getCustomization?: (id: string) => unknown
}

/** OHIF's window/level presets (customization first, built-in fallback). */
export function windowLevelPresets(
  servicesManager: OhifExtensionParams['servicesManager'],
): Record<string, WindowLevelPreset[]> {
  const svc = ohifServices(servicesManager)?.customizationService as
    | CustomizationServiceLike
    | undefined
  const custom = svc?.getCustomization?.('cornerstone.windowLevelPresets')
  if (custom && typeof custom === 'object') {
    return custom as Record<string, WindowLevelPreset[]>
  }
  return FALLBACK_WL_PRESETS
}

/**
 * Resolve a preset for the base modality, by id then index (OHIF's own
 * fallback order). Returns the [calMin, calMax] window it maps to.
 */
export function resolveWindowLevel(
  presets: Record<string, WindowLevelPreset[]>,
  modality: string | undefined,
  presetId: string | undefined,
  presetIndex: number | undefined,
): [number, number] | undefined {
  const list = modality ? presets[modality] : undefined
  if (!list || list.length === 0) return undefined
  const preset =
    (presetId ? list.find((p) => p.id === presetId) : undefined) ??
    (presetIndex !== undefined ? list[presetIndex] : undefined)
  if (!preset) return undefined
  const width = Number(preset.window)
  const center = Number(preset.level)
  if (!Number.isFinite(width) || !Number.isFinite(center)) return undefined
  // A zero-width preset (PT/SUV) is a level-only clamp: show 0..level.
  if (width === 0) return [0, center]
  return [center - width / 2, center + width / 2]
}

// Minimal shape of the NiiVue instance's base volume the W/L reader needs.
interface NiivueLike {
  volumes: ReadonlyArray<{ calMin?: number; calMax?: number }>
}

/** Read the base volume's window/level ({ window: width, level: center }). */
export function readBaseWindowLevel(
  nv: NiivueLike,
): { window: number; level: number } | undefined {
  const vol = nv.volumes[0]
  if (!vol) return undefined
  const { calMin, calMax } = vol
  if (
    calMin === undefined ||
    calMax === undefined ||
    !Number.isFinite(calMin) ||
    !Number.isFinite(calMax)
  )
    return undefined
  return { window: calMax - calMin, level: (calMin + calMax) / 2 }
}

/** Record a calMin/calMax pair as the entry's window/level (width + center). */
function recordWindowLevel(
  entry: NiivueViewportEntry | undefined,
  calMin: number,
  calMax: number,
): void {
  if (entry)
    entry.windowLevel = {
      window: calMax - calMin,
      level: (calMin + calMax) / 2,
    }
}

// Two window/level pairs are the same if within this fraction of the width — a
// contrast drag moves them well beyond this, crosshair navigation not at all.
function sameWindowLevel(
  a: { window: number; level: number },
  b: { window: number; level: number },
): boolean {
  const eps = Math.max(1e-3, Math.abs(a.window) * 1e-3)
  return (
    Math.abs(a.window - b.window) < eps && Math.abs(a.level - b.level) < eps
  )
}

interface ViewportGridStateLike {
  getState?: () => {
    viewports?:
      | Map<string, { displaySetInstanceUIDs?: string[] }>
      | Record<string, { displaySetInstanceUIDs?: string[] }>
  }
}

/** [viewportId, displaySetInstanceUIDs] pairs from OHIF's viewport grid state. */
function viewportEntries(
  servicesManager: OhifExtensionParams['servicesManager'],
): Array<[string, string[]]> {
  const grid = ohifServices(servicesManager)?.viewportGridService as
    | ViewportGridStateLike
    | undefined
  const viewports = grid?.getState?.().viewports
  if (!viewports) return []
  const raw =
    viewports instanceof Map
      ? [...viewports.entries()]
      : Object.entries(viewports)
  return raw.map(([id, vp]) => [id, vp?.displaySetInstanceUIDs ?? []])
}

/**
 * Reflect a window/level onto every OTHER OHIF viewport showing the same series
 * (e.g. a cornerstone sibling in a multi-viewport layout). Each is targeted by
 * id via `setViewportWindowLevel`, which no-ops on a viewport cornerstone does
 * not own (our NiiVue viewports, stale ids). Do NOT use the `setWindowLevel`
 * command here: it targets the *active* viewport (ours) and throws on our
 * non-cornerstone element.
 */
function syncWindowLevelToSiblings(
  entry: NiivueViewportEntry,
  viewportId: string,
  wl: { window: number; level: number },
  servicesManager: OhifExtensionParams['servicesManager'],
  commandsManager: OhifExtensionParams['commandsManager'],
): void {
  const baseUIDs = new Set(
    entry.displaySets
      .map((ds) => ds.displaySetInstanceUID)
      .filter((u): u is string => typeof u === 'string'),
  )
  if (baseUIDs.size === 0) return
  const cm = ohifCommandsManager(commandsManager)
  if (!cm) return
  for (const [id, uids] of viewportEntries(servicesManager)) {
    if (id === viewportId || !uids.some((u) => baseUIDs.has(u))) continue
    try {
      cm.runCommand?.('setViewportWindowLevel', {
        viewportId: id,
        windowWidth: wl.window,
        windowCenter: wl.level,
      })
    } catch (err) {
      console.warn('[nv-ohif] setViewportWindowLevel sync failed', err)
    }
  }
}

/**
 * Reverse W/L bridge: after a manual contrast drag, record the base volume's new
 * window/level on the entry and reflect it onto any other OHIF viewport showing
 * the same series (see {@link syncWindowLevelToSiblings}). Returns the new
 * window/level when it changed (for a viewport readout), else undefined.
 */
// --- ruler / length: reflect a NiiVue measurement into OHIF ------------------

/** NiiVue's `measurementCompleted` detail: endpoints in world mm (RAS) + length. */
export interface NiivueCompletedMeasurement {
  startMM: [number, number, number]
  endMM: [number, number, number]
  distance: number
}

// OHIF's polyline value type (a 2-point Length). Literal, so we don't depend on
// measurementService.VALUE_TYPES being present at runtime.
const POLYLINE_VALUE_TYPE = 'value_type::polyline'

interface MeasurementSourceLike {
  uid?: string
}
interface MeasurementServiceLike {
  createSource: (name: string, version: string) => MeasurementSourceLike
  addMapping: (
    source: MeasurementSourceLike,
    annotationType: string,
    matchingCriteria: Array<{ valueType: string; points: number }>,
    toAnnotationSchema: (data: unknown) => unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ) => void
  addRawMeasurement: (
    source: MeasurementSourceLike,
    annotationType: string,
    data: unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ) => unknown
}
// One 'NiiVue' source + Length mapping per MeasurementService. createSource is
// idempotent, but addMapping stacks, so register the mapping exactly once.
const measurementSources = new WeakMap<object, MeasurementSourceLike>()
function niivueMeasurementSource(
  measurementService: MeasurementServiceLike,
): MeasurementSourceLike {
  const cached = measurementSources.get(measurementService as object)
  if (cached) return cached
  const source = measurementService.createSource('NiiVue', '1.0')
  measurementService.addMapping(
    source,
    'Length',
    [{ valueType: POLYLINE_VALUE_TYPE, points: 2 }],
    () => ({}),
    (data) => data.measurement,
  )
  measurementSources.set(measurementService as object, source)
  return source
}

let niivueMeasurementCounter = 0

/**
 * Reflect a completed NiiVue ruler measurement into OHIF's MeasurementService so
 * it shows in the measurement panel. NiiVue endpoints are world mm in NIfTI RAS;
 * DICOM patient space is LPS, so negate x and y. The panel needs a
 * `referenceSeriesUID` resolving to a loaded displaySet with instances, a
 * `label`, and `displayText.primary` (the length string). Returns false (and adds
 * nothing) when no backing DICOM series with instances exists — e.g. a NIfTI-URL
 * display set — so the panel can never throw on an unresolvable reference.
 */
export function reflectNiivueMeasurement(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  measurement: NiivueCompletedMeasurement,
): boolean {
  const services = ohifServices(servicesManager)
  const measurementService = services?.measurementService as
    | MeasurementServiceLike
    | undefined
  const displaySetService = services?.displaySetService as
    | DisplaySetServiceLike
    | undefined
  if (
    !measurementService?.addRawMeasurement ||
    !displaySetService?.getDisplaySetsForSeries
  )
    return false
  const entry = getNiivueEntry(viewportId)
  if (!entry) return false

  // Resolve a backing DICOM series that OHIF can render a row for.
  let backing: OhifDisplaySet | undefined
  for (const ds of entry.displaySets) {
    if (!ds.SeriesInstanceUID) continue
    const resolved = displaySetService.getDisplaySetsForSeries(
      ds.SeriesInstanceUID,
    )
    const withInstances = resolved?.find((r) => (r.instances?.length ?? 0) > 0)
    if (withInstances) {
      backing = withInstances
      break
    }
  }
  if (!backing?.SeriesInstanceUID) return false

  const source = niivueMeasurementSource(measurementService)
  const uid = `niivue-length-${++niivueMeasurementCounter}`
  const toLps = (p: [number, number, number]): [number, number, number] => [
    -p[0],
    -p[1],
    p[2],
  ]
  const lengthMm = measurement.distance
  const forUID = backing.instances?.[0]?.FrameOfReferenceUID as
    | string
    | undefined
  measurementService.addRawMeasurement(
    source,
    'Length',
    {
      uid,
      // addRawMeasurement unconditionally destructures data.annotation.data.
      annotation: { data: {} },
      measurement: {
        uid,
        toolName: 'Length',
        label: 'NiiVue length',
        referenceSeriesUID: backing.SeriesInstanceUID,
        referenceStudyUID: backing.StudyInstanceUID as string | undefined,
        displaySetInstanceUID: backing.displaySetInstanceUID,
        FrameOfReferenceUID: forUID,
        points: [toLps(measurement.startMM), toLps(measurement.endMM)],
        displayText: { primary: [`${lengthMm.toFixed(1)} mm`], secondary: [] },
        data: { length: lengthMm, unit: 'mm' },
        type: POLYLINE_VALUE_TYPE,
        metadata: { toolName: 'Length', FrameOfReferenceUID: forUID },
      },
    },
    (data) => data.measurement,
  )
  return true
}

export function syncNiivueWindowLevelToOhif(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  commandsManager: OhifExtensionParams['commandsManager'],
): { window: number; level: number } | undefined {
  const entry = getNiivueEntry(viewportId)
  if (!entry) return undefined
  const wl = readBaseWindowLevel(entry.nv)
  if (!wl) return undefined
  // First observation just seeds the baseline (no readout / no sync).
  if (entry.windowLevel && sameWindowLevel(entry.windowLevel, wl))
    return undefined
  const seeded = entry.windowLevel !== undefined
  entry.windowLevel = wl
  if (!seeded) return undefined
  syncWindowLevelToSiblings(
    entry,
    viewportId,
    wl,
    servicesManager,
    commandsManager,
  )
  return wl
}

/**
 * getCommandsModule: OHIF commands operating on the active NiiVue viewport.
 * Toolbar buttons (see toolbar.ts) reference these by name; they are also
 * runnable from any OHIF surface via `commandsManager.runCommand(...)`.
 */
export function getNiivueCommandsModule({
  servicesManager,
  commandsManager,
}: OhifExtensionParams) {
  const actions = {
    /** Switch the view: axial / coronal / sagittal / multiplanar / render. */
    niivueSetSliceType: ({ sliceType }: { sliceType?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      const mapped = sliceType ? NIIVUE_SLICE_TYPES[sliceType] : undefined
      if (!nv || mapped === undefined) return
      nv.sliceType = mapped
    },

    /**
     * Activate the ruler (length) tool. Routes through OHIF's `setToolActiveToolbar`
     * so OHIF's active-tool state and NiiVue agree: the tool bridge in
     * NiivueViewport maps the active `Length` tool onto NiiVue's measurement
     * drag mode. Setting `nv.primaryDragMode` directly would be reset by that
     * bridge the next time OHIF's active tool (e.g. WindowLevel) re-applies. On
     * release a completed measurement is reflected into OHIF's measurement panel
     * (see the measurementCompleted subscription in NiivueViewport). Falls back to
     * setting NiiVue's drag mode directly when no commandsManager is available.
     */
    niivueSetMeasurementMode: () => {
      const cmds = ohifCommandsManager(commandsManager)
      if (cmds?.runCommand) {
        cmds.runCommand('setToolActiveToolbar', { toolName: 'Length' })
        return
      }
      const nv = getActiveNiivue(servicesManager)
      if (nv) nv.primaryDragMode = DRAG_MODE.measurement
    },

    /** Reset camera, pan, zoom, and crosshair to their defaults. */
    niivueResetView: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      if (entry.slideView) {
        entry.slideView.resetView()
        return
      }
      const { nv } = entry
      nv.azimuth = VIEW_DEFAULTS.azimuth
      nv.elevation = VIEW_DEFAULTS.elevation
      nv.scaleMultiplier = VIEW_DEFAULTS.scaleMultiplier
      nv.pan2Dxyzmm = [...VIEW_DEFAULTS.pan2Dxyzmm]
      nv.renderPan = [...VIEW_DEFAULTS.renderPan]
      nv.crosshairPos = [...VIEW_DEFAULTS.crosshairPos]
    },

    /** Download the visible NiiVue volume or NVSlide canvas as a PNG. */
    niivueSaveBitmap: async () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      if (entry.slideView) {
        await entry.slideView.saveBitmap()
        return
      }
      await entry.nv.saveBitmap('niivue.png')
    },

    /** Set (or clear, plane: 'none') the 3D render clip plane. */
    niivueSetClipPlane: ({ plane }: { plane?: string } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      const preset = plane ? NIIVUE_CLIP_PLANES[plane] : undefined
      if (!entry || !preset || plane === undefined) return
      entry.nv.setClipPlane([...preset])
      entry.clipPlane = plane
    },

    /**
     * Toggle a colormapped overlay: with overlays loaded, remove them;
     * otherwise load the study's next loadable series on top of the base
     * (fetch + dcm2niix conversion for DICOM).
     */
    niivueToggleOverlay: async () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry || entry.overlayLoading) return
      const { nv, viewportId } = entry

      if (entry.overlayUIDs.length > 0) {
        while (nv.volumes.length > 1) {
          nv.model.removeVolume(nv.volumes.length - 1)
        }
        entry.overlayUIDs = []
        await nv.updateGLVolume()
        refreshToolbar(servicesManager, viewportId)
        return
      }

      // Need a loaded base to overlay onto.
      if (nv.volumes.length === 0) return

      const dsService = ohifServices(servicesManager)?.displaySetService as
        | DisplaySetServiceLike
        | undefined
      const candidate = findOverlayCandidate(
        entry,
        dsService?.getActiveDisplaySets?.() ?? [],
      )
      if (!candidate) {
        flashStatus(entry, 'No other loadable series in this study.')
        return
      }
      const uid = String(candidate.displaySetInstanceUID)
      const label =
        typeof candidate.SeriesDescription === 'string'
          ? candidate.SeriesDescription
          : 'overlay'

      entry.overlayLoading = true
      try {
        // Direct volume-URL display sets skip conversion.
        const direct = displaySetToNiivue(candidate)
        if (direct) {
          await nv.addVolume({
            ...direct,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        } else {
          entry.setStatus?.(`Fetching overlay: ${label}...`)
          const niftiFile = await convertDisplaySetToNifti(candidate, {
            headers: authHeaders(servicesManager),
            onProgress: (phase, loaded, total) => {
              entry.setStatus?.(
                phase === 'fetching'
                  ? `Fetching overlay: ${label}... ${loaded}/${total}`
                  : `Converting overlay: ${label} (dcm2niix)...`,
              )
            },
          })
          if (!niftiFile) throw new Error('conversion produced no volume')
          await nv.addVolume({
            url: niftiFile,
            name: niftiFile.name,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        }
        entry.overlayUIDs.push(uid)
        entry.setStatus?.(null)
      } catch (err) {
        console.error('[nv-ohif] overlay load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        flashStatus(entry, `Overlay load failed: ${message || 'unknown error'}`)
      } finally {
        entry.overlayLoading = false
        refreshToolbar(servicesManager, viewportId)
      }
    },

    /**
     * Apply a window/level (width + center) to the base volume as NiiVue
     * calMin/calMax. Bridges OHIF's W/L model onto NiiVue's calibration range.
     */
    niivueSetWindowLevel: ({
      window,
      level,
    }: {
      window?: number
      level?: number
    } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      if (!nv || nv.volumes.length === 0) return
      if (
        window === undefined ||
        level === undefined ||
        !Number.isFinite(window) ||
        !Number.isFinite(level)
      )
        return
      // A zero-width window (PT/SUV) is a level-only clamp: show 0..level.
      const [calMin, calMax] =
        window === 0 ? [0, level] : [level - window / 2, level + window / 2]
      nv.setVolume(0, { calMin, calMax })
      recordWindowLevel(getActiveNiivueEntry(servicesManager), calMin, calMax)
    },

    /**
     * Apply one of OHIF's modality window/level presets (resolved from the
     * `cornerstone.windowLevelPresets` customization, keyed by the base series'
     * modality) to the base volume.
     */
    niivueSetWindowLevelPreset: ({
      presetId,
      presetIndex,
    }: {
      presetId?: string
      presetIndex?: number
    } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry || entry.nv.volumes.length === 0) return
      const range = resolveWindowLevel(
        windowLevelPresets(servicesManager),
        baseModality(entry),
        presetId,
        presetIndex,
      )
      if (!range) return
      entry.nv.setVolume(0, { calMin: range[0], calMax: range[1] })
      recordWindowLevel(entry, range[0], range[1])
    },

    /** Recompute the base volume's robust (2-98%) auto window. */
    niivueAutoWindowLevel: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry || entry.nv.volumes.length === 0) return
      entry.nv.recalculateCalMinMax(0).then(() => {
        const wl = readBaseWindowLevel(entry.nv)
        if (wl) entry.windowLevel = wl
      })
    },

    /** Set the base volume's colormap (e.g. gray / hot / viridis). */
    niivueSetColormap: ({ colormap }: { colormap?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      if (!nv || nv.volumes.length === 0 || !colormap) return
      nv.setVolume(0, { colormap })
    },

    /** Toggle the colormap legend (colorbar) on the viewport. */
    niivueToggleColorbar: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      entry.nv.isColorbarVisible = !entry.nv.isColorbarVisible
      refreshToolbar(servicesManager, entry.viewportId)
    },

    /** Toggle nearest-neighbor vs smooth (linear) volume interpolation. */
    niivueToggleInterpolation: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      entry.nv.volumeIsNearestInterpolation =
        !entry.nv.volumeIsNearestInterpolation
      refreshToolbar(servicesManager, entry.viewportId)
    },
  }

  return {
    actions,
    definitions: {
      niivueSetSliceType: actions.niivueSetSliceType,
      niivueSetMeasurementMode: actions.niivueSetMeasurementMode,
      niivueResetView: actions.niivueResetView,
      niivueSaveBitmap: actions.niivueSaveBitmap,
      niivueSetClipPlane: actions.niivueSetClipPlane,
      niivueToggleOverlay: actions.niivueToggleOverlay,
      niivueSetWindowLevel: actions.niivueSetWindowLevel,
      niivueSetWindowLevelPreset: actions.niivueSetWindowLevelPreset,
      niivueAutoWindowLevel: actions.niivueAutoWindowLevel,
      niivueSetColormap: actions.niivueSetColormap,
      niivueToggleColorbar: actions.niivueToggleColorbar,
      niivueToggleInterpolation: actions.niivueToggleInterpolation,
    },
    defaultContext: 'NIIVUE',
  }
}
