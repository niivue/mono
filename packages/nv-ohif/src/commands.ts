import {
  type AnnotationStats,
  DRAG_MODE,
  SLICE_TYPE,
  type VectorAnnotation,
} from '@niivue/niivue'
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
  remove?: (uid: string, source?: MeasurementSourceLike) => void
  EVENTS?: { MEASUREMENT_UPDATED?: string }
  subscribe?: (
    event: string,
    cb: (payload: { measurement?: { uid?: string; label?: string } }) => void,
  ) => { unsubscribe?: () => void }
}
// OHIF value types for the ROI / point tools (literals, so we do not depend on
// measurementService.VALUE_TYPES at runtime).
const ELLIPSE_VALUE_TYPE = 'value_type::ellipse'
const CIRCLE_VALUE_TYPE = 'value_type::circle'
const POINT_VALUE_TYPE = 'value_type::point'

// NiiVue annotation tool -> OHIF measurement tool + value type. Only the tools
// nv-ohif activates (see toolBridge) are mapped; measureLine doubles as Length.
const ANNOTATION_TO_OHIF: Record<
  string,
  { toolName: string; valueType: string; points: number }
> = {
  measureEllipse: {
    toolName: 'EllipticalROI',
    valueType: ELLIPSE_VALUE_TYPE,
    points: 4,
  },
  // OHIF's Rectangle mapping uses the polyline value type.
  measureRect: {
    toolName: 'RectangleROI',
    valueType: POLYLINE_VALUE_TYPE,
    points: 4,
  },
  measureCircle: {
    toolName: 'CircleROI',
    valueType: CIRCLE_VALUE_TYPE,
    points: 2,
  },
  measureLine: {
    toolName: 'Length',
    valueType: POLYLINE_VALUE_TYPE,
    points: 2,
  },
  measureSpline: {
    toolName: 'SplineROI',
    valueType: POLYLINE_VALUE_TYPE,
    points: 2,
  },
  measureLivewire: {
    toolName: 'LivewireContour',
    valueType: POLYLINE_VALUE_TYPE,
    points: 2,
  },
  arrow: { toolName: 'ArrowAnnotate', valueType: POINT_VALUE_TYPE, points: 1 },
}

// One 'NiiVue' source per MeasurementService, with a mapping per tool. Length
// covers the ruler; the annotation tools cover the ROI/arrow shapes. createSource
// is idempotent, but addMapping stacks, so register the set exactly once.
const measurementSources = new WeakMap<object, MeasurementSourceLike>()
function niivueMeasurementSource(
  measurementService: MeasurementServiceLike,
): MeasurementSourceLike {
  const cached = measurementSources.get(measurementService as object)
  if (cached) return cached
  const source = measurementService.createSource('NiiVue', '1.0')
  const register = (toolName: string, valueType: string, points: number) =>
    measurementService.addMapping(
      source,
      toolName,
      [{ valueType, points }],
      () => ({}),
      (data) => data.measurement,
    )
  register('Length', POLYLINE_VALUE_TYPE, 2)
  for (const { toolName, valueType, points } of Object.values(
    ANNOTATION_TO_OHIF,
  )) {
    if (toolName === 'Length') continue // registered above
    register(toolName, valueType, points)
  }
  measurementSources.set(measurementService as object, source)
  return source
}

let niivueMeasurementCounter = 0

/**
 * Resolve a loaded DICOM series (a displaySet with a non-empty `instances`
 * array) backing this viewport, so an OHIF measurement can carry a
 * `referenceSeriesUID` the panel can render without throwing. Returns undefined
 * for a NIfTI-URL display set (no instances) so callers skip reflection.
 */
function resolveBackingSeries(
  entry: NiivueViewportEntry,
  displaySetService: DisplaySetServiceLike,
): OhifDisplaySet | undefined {
  for (const ds of entry.displaySets) {
    if (!ds.SeriesInstanceUID) continue
    const resolved = displaySetService.getDisplaySetsForSeries?.(
      ds.SeriesInstanceUID,
    )
    const withInstances = resolved?.find((r) => (r.instances?.length ?? 0) > 0)
    if (withInstances?.SeriesInstanceUID) return withInstances
  }
  return undefined
}

// world mm in NIfTI RAS -> DICOM patient LPS (negate x and y).
function rasToLps(p: [number, number, number]): [number, number, number] {
  return [-p[0], -p[1], p[2]]
}

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

  const backing = resolveBackingSeries(entry, displaySetService)
  if (!backing?.SeriesInstanceUID) return false

  const source = niivueMeasurementSource(measurementService)
  const uid = `niivue-length-${++niivueMeasurementCounter}`
  const toLps = rasToLps
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

// --- ROI / arrow annotations: reflect NiiVue vector annotations into OHIF -----

// niivue annotation id -> OHIF measurement uid, per viewport, so a removed or
// cleared annotation can remove its panel row.
const reflectedAnnotations = new Map<string, Map<string, string>>()

// OHIF measurement uid -> the NiiVue annotation it reflects, so an edit of the
// measurement's label in OHIF's panel can be pushed back as the annotation text.
const measurementToAnnotation = new Map<
  string,
  { viewportId: string; annotationId: string }
>()

function modalityUnit(entry: NiivueViewportEntry): string {
  const modality = baseModality(entry)
  if (modality === 'CT') return 'HU'
  if (modality === 'PT') return 'SUV'
  return ''
}

// The panel row content + cachedStats for a reflected annotation. Measure tools
// (ellipse/rect/circle) carry area (mm^2) + intensity stats; arrows carry none.
function buildAnnotationDisplay(
  toolName: string,
  stats: AnnotationStats | undefined,
  unit: string,
): { primary: string[]; data: Record<string, unknown>; label: string } {
  const label = `NiiVue ${toolName}`
  if (toolName === 'ArrowAnnotate' || !stats) {
    return { primary: [label], data: {}, label }
  }
  const withUnit = (v: number, key: string) =>
    unit ? `${key}: ${v.toFixed(1)} ${unit}` : `${key}: ${v.toFixed(1)}`
  return {
    primary: [
      `${stats.area.toFixed(1)} mm²`,
      withUnit(stats.max, 'Max'),
      withUnit(stats.mean, 'Mean'),
    ],
    data: {
      area: stats.area,
      mean: stats.mean,
      stdDev: stats.stdDev,
      max: stats.max,
      min: stats.min,
      unit,
      areaUnit: 'mm²',
    },
    label,
  }
}

/**
 * Reflect a completed NiiVue vector annotation (ellipse/rect/circle/arrow) into
 * OHIF's MeasurementService so it renders as a first-class panel row with its
 * stats. Returns true when a row was added. Needs a backing DICOM series with
 * instances (same constraint as the ruler; a NIfTI-URL display set is skipped).
 * Intensity stats are the NiiVue volume's sampled values in the base modality's
 * unit; area is in mm^2 (voxel-spacing aware, from NiiVue's annotation stats).
 */
export function reflectNiivueAnnotation(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  annotation: VectorAnnotation,
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
  const toolType = annotation.shape?.type
  const mapping = toolType ? ANNOTATION_TO_OHIF[toolType] : undefined
  if (!mapping) return false
  const entry = getNiivueEntry(viewportId)
  if (!entry) return false
  const backing = resolveBackingSeries(entry, displaySetService)
  if (!backing?.SeriesInstanceUID) return false

  const source = niivueMeasurementSource(measurementService)
  const uid = `niivue-${mapping.toolName}-${++niivueMeasurementCounter}`
  const forUID = backing.instances?.[0]?.FrameOfReferenceUID as
    | string
    | undefined
  const points = annotation.anchorMM ? [rasToLps(annotation.anchorMM)] : []
  const unit = modalityUnit(entry)
  const { primary, data, label } = buildAnnotationDisplay(
    mapping.toolName,
    annotation.stats,
    unit,
  )
  // The user's free text (if set) is the panel row label; else a default name.
  const rowLabel =
    annotation.text && annotation.text.length > 0 ? annotation.text : label

  measurementService.addRawMeasurement(
    source,
    mapping.toolName,
    {
      uid,
      // addRawMeasurement unconditionally destructures data.annotation.data.
      annotation: { data: {} },
      measurement: {
        uid,
        toolName: mapping.toolName,
        label: rowLabel,
        referenceSeriesUID: backing.SeriesInstanceUID,
        referenceStudyUID: backing.StudyInstanceUID as string | undefined,
        displaySetInstanceUID: backing.displaySetInstanceUID,
        FrameOfReferenceUID: forUID,
        points,
        displayText: { primary, secondary: [] },
        data,
        type: mapping.valueType,
        metadata: { toolName: mapping.toolName, FrameOfReferenceUID: forUID },
      },
    },
    (d) => d.measurement,
  )

  let byView = reflectedAnnotations.get(viewportId)
  if (!byView) {
    byView = new Map()
    reflectedAnnotations.set(viewportId, byView)
  }
  byView.set(annotation.id, uid)
  measurementToAnnotation.set(uid, { viewportId, annotationId: annotation.id })
  return true
}

/**
 * Push an OHIF measurement's label (edited in the panel) back onto the NiiVue
 * annotation it reflects, so the free text shows on the viewport. No-op if the
 * uid is not one of ours.
 */
export function applyOhifLabelToAnnotation(
  servicesManager: OhifExtensionParams['servicesManager'],
  measurementUid: string,
  label: string,
): void {
  const ref = measurementToAnnotation.get(measurementUid)
  if (!ref) return
  const entry = getNiivueEntry(ref.viewportId)
  entry?.nv.setAnnotationText(ref.annotationId, label ?? '')
}

/**
 * Subscribe to OHIF measurement-label edits and push them onto the matching
 * NiiVue annotation as free text (so editing a row's label in the panel labels
 * the shape on the viewport). Returns an unsubscribe, or undefined if the
 * MeasurementService does not expose the event.
 */
export function subscribeOhifLabelSync(
  servicesManager: OhifExtensionParams['servicesManager'],
): (() => void) | undefined {
  const svc = ohifServices(servicesManager)?.measurementService as
    | MeasurementServiceLike
    | undefined
  const evt = svc?.EVENTS?.MEASUREMENT_UPDATED
  if (!svc?.subscribe || !evt) return undefined
  const sub = svc.subscribe(evt, (payload) => {
    const m = payload?.measurement
    if (m?.uid)
      applyOhifLabelToAnnotation(servicesManager, m.uid, m.label ?? '')
  })
  return () => sub?.unsubscribe?.()
}

/** Remove one reflected annotation's OHIF panel row (annotationRemoved). */
export function removeNiivueAnnotation(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  annotationId: string,
): void {
  const byView = reflectedAnnotations.get(viewportId)
  const uid = byView?.get(annotationId)
  if (!byView || !uid) return
  const measurementService = ohifServices(servicesManager)
    ?.measurementService as MeasurementServiceLike | undefined
  measurementService?.remove?.(uid)
  byView.delete(annotationId)
  measurementToAnnotation.delete(uid)
}

/** Remove every reflected row for a viewport (annotation clear / series swap). */
export function clearNiivueAnnotations(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
): void {
  const byView = reflectedAnnotations.get(viewportId)
  if (!byView || byView.size === 0) return
  const measurementService = ohifServices(servicesManager)
    ?.measurementService as MeasurementServiceLike | undefined
  for (const uid of byView.values()) {
    measurementService?.remove?.(uid)
    measurementToAnnotation.delete(uid)
  }
  byView.clear()
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

      // The fetch + dcm2niix conversion below can take seconds, during which two
      // things can invalidate this overlay load: (a) the viewport unmounts
      // (navigation / layout change) — cleanup runs unregisterNiivue + nv.destroy()
      // and the entry leaves the registry; (b) a NEW base series is hung in the
      // same viewport slot — the entry object is REUSED (so the registry check
      // alone passes), but the load effect replaces entry.displaySets and resets
      // overlayUIDs. Guard on both: same registered entry AND same base series,
      // so we never overlay onto the wrong anatomy or a destroyed instance.
      const baseDisplaySets = entry.displaySets
      const stillLive = () =>
        getNiivueEntry(viewportId) === entry &&
        entry.displaySets === baseDisplaySets

      // Add the overlay volume, then reconcile against a swap that may have
      // invalidated this load DURING the addVolume await: if we no longer own the
      // viewport's base series, remove the overlay we just added so it doesn't
      // linger on the wrong anatomy. Count-guarded (only remove when our add is
      // still the last, untouched volume) so a concurrent swap-load that already
      // replaced the volume array is left alone. Returns true if the overlay
      // stuck, false if it was invalidated/undone.
      const addOverlayGuarded = async (
        spec: Parameters<typeof nv.addVolume>[0],
      ): Promise<boolean> => {
        const before = nv.volumes.length
        await nv.addVolume(spec)
        if (stillLive()) return true
        if (nv.volumes.length === before + 1) {
          nv.model.removeVolume(nv.volumes.length - 1)
          await nv.updateGLVolume()
        }
        return false
      }

      entry.overlayLoading = true
      try {
        // Direct volume-URL display sets skip conversion.
        const direct = displaySetToNiivue(candidate)
        let added: boolean
        if (direct) {
          if (!stillLive()) return
          added = await addOverlayGuarded({
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
          if (!stillLive()) return
          if (!niftiFile) throw new Error('conversion produced no volume')
          added = await addOverlayGuarded({
            url: niftiFile,
            name: niftiFile.name,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        }
        if (!added) return
        entry.overlayUIDs.push(uid)
        entry.setStatus?.(null)
      } catch (err) {
        console.error('[nv-ohif] overlay load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        flashStatus(entry, `Overlay load failed: ${message || 'unknown error'}`)
      } finally {
        // Only clear the loading flag if this load still owns the entry: a swap
        // may have started a NEWER overlay load on the reused entry, whose
        // overlayLoading=true we must not clobber.
        if (stillLive()) {
          entry.overlayLoading = false
          refreshToolbar(servicesManager, viewportId)
        }
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

    /**
     * Toggle the crosshair on/off. Overrides OHIF's cornerstone Crosshairs
     * button on a NiiVue viewport. `crosshairWidth = 0` hides the 2D crosshair
     * (its width is the marker radius); `is3DCrosshairVisible` follows for the
     * 3D render tile. Neither setter redraws on its own, so drawScene() here.
     */
    niivueToggleCrosshair: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const visible = entry.nv.crosshairWidth > 0
      entry.nv.crosshairWidth = visible ? 0 : 1
      entry.nv.is3DCrosshairVisible = !visible
      entry.nv.drawScene()
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
      niivueToggleCrosshair: actions.niivueToggleCrosshair,
    },
    defaultContext: 'NIIVUE',
  }
}
