import {
  type AnnotationPoint,
  type AnnotationScreenShape,
  type AnnotationStats,
  generateShape,
  isAnnotationErased,
  type NVImage,
  SLICE_TYPE,
  slice2DToMM,
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
  type StatusKind,
} from './niivueRegistry'
import type {
  OhifCommandsModule,
  OhifDisplaySet,
  OhifExtensionParams,
  OhifViewportProps,
} from './ohif-types'
import { frameAt, type SliceFrames } from './sliceFrames'
import { getStandardCommandDefinitions } from './standardCommands'
import { ANNOTATION_TO_OHIF, type AnnotationToolDescriptor } from './toolBridge'

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

// The study's display sets NiiVue could load as an overlay of this viewport:
// neither its base nor already overlaid (SEG/RT and slides classify out).
export function overlayCandidates(
  entry: Pick<NiivueViewportEntry, 'displaySets' | 'overlays'>,
  activeDisplaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet[] {
  const loaded = new Set<string>(entry.overlays.keys())
  for (const ds of entry.displaySets) {
    if (typeof ds.displaySetInstanceUID === 'string')
      loaded.add(ds.displaySetInstanceUID)
  }
  return activeDisplaySets.filter((ds) => {
    const uid = ds.displaySetInstanceUID
    if (typeof uid !== 'string' || loaded.has(uid)) return false
    const kind = classifyDisplaySet(ds)
    return kind === 'nifti' || kind === 'dicom-volume'
  })
}

// OHIF (Cornerstone) colormap names whose NiiVue LUT is named differently.
// Other names match NiiVue's case-insensitively.
const CORNERSTONE_COLORMAPS: Record<string, string> = {
  grayscale: 'gray',
  hot_iron: 'hotiron',
}

/**
 * The registered NiiVue colormap for a name or `{ name }` (OHIF passes
 * either), or undefined when NiiVue has no such LUT.
 */
function niivueColormapName(
  registered: readonly string[],
  colormap: unknown,
): string | undefined {
  const raw =
    typeof colormap === 'object' && colormap !== null
      ? (colormap as { name?: unknown }).name
      : colormap
  if (typeof raw !== 'string') return undefined
  const lower = raw.toLowerCase()
  const name = CORNERSTONE_COLORMAPS[lower] ?? lower
  return registered.find((n) => n.toLowerCase() === name)
}

/**
 * OHIF's setViewportColormap on a NiiVue viewport: targets the base (no
 * `displaySetInstanceUID`, or the base's) or an overlay; any other display set
 * is a no-op. An unknown colormap keeps the current one, and `opacity` applies
 * only when given (Cornerstone defaults it to 1, which would undo an overlay's
 * blend). A hidden overlay stays hidden.
 */
export function setViewportColormap(
  entry: NiivueViewportEntry,
  { displaySetInstanceUID: uid, colormap, opacity }: Record<string, unknown>,
): void {
  const { nv } = entry
  const isBase =
    uid === undefined || uid === entry.displaySets[0]?.displaySetInstanceUID
  const index = isBase ? 0 : overlayVolumeIndex(entry, uid as string)
  if ((!isBase && index === 0) || !nv.volumes[index]) return
  const name = niivueColormapName(nv.colormaps, colormap)
  const alpha = Number.isFinite(opacity)
    ? Math.min(1, Math.max(0, opacity as number))
    : undefined
  if (name === undefined && alpha === undefined) return
  nv.setVolume(index, {
    ...(name === undefined ? {} : { colormap: name }),
    ...(alpha === undefined ? {} : { opacity: alpha }),
  }).catch((err: unknown) =>
    console.error('[nv-ohif] colormap update failed', err),
  )
}

// The volume index of a display set's overlay, or 0 when it is not one.
export function overlayVolumeIndex(
  entry: NiivueViewportEntry,
  uid?: string,
): number {
  const hdr = uid === undefined ? undefined : entry.overlays.get(uid)
  const index = entry.nv.volumes.findIndex((v) => v.hdr === hdr)
  return hdr && index > 0 ? index : 0
}

/** The loaded overlays' display sets, bottom layer first. */
export function overlayOrder(entry: NiivueViewportEntry): string[] {
  return [...entry.overlays.keys()]
    .map((uid) => ({ uid, index: overlayVolumeIndex(entry, uid) }))
    .filter((o) => o.index > 0)
    .sort((a, b) => a.index - b.index)
    .map((o) => o.uid)
}

// Every status write from this module bumps the entry's token, so a flash's
// deferred clear can tell whether its message is still the one on screen.
const statusTokens = new WeakMap<NiivueViewportEntry, number>()

// Write a status message (or null to clear) through the viewport's sink,
// invalidating any pending flash clear (no-op if the viewport did not register
// a status sink).
function writeStatus(
  entry: NiivueViewportEntry,
  message: string | null,
  kind?: StatusKind,
): void {
  statusTokens.set(entry, (statusTokens.get(entry) ?? 0) + 1)
  entry.setStatus?.(message, kind)
}

// Show a transient message in the viewport. The deferred clear is dropped when
// a newer status was written in the meantime (e.g. a retried overlay load's
// progress readout must not be blanked by a stale failure-flash timer).
export function flashStatus(
  entry: NiivueViewportEntry,
  message: string,
  kind: StatusKind = 'note',
  ms = 4000,
): void {
  writeStatus(entry, message, kind)
  const token = statusTokens.get(entry)
  setTimeout(() => {
    if (statusTokens.get(entry) === token) writeStatus(entry, null)
  }, ms)
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
  return windowToRange(width, center)
}

/** OHIF window/level -> NiiVue [calMin, calMax]. */
function windowToRange(width: number, center: number): [number, number] {
  // A zero-width window (PT/SUV) is a level-only clamp: show 0..level.
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

// The NiiVue annotation tool for an annotation (shape.type, or freehand inferred
// from a polygon when there is no shape).
function annotationToolType(a: VectorAnnotation): string | undefined {
  return a.shape?.type ?? (a.polygons[0]?.outer.length ? 'freehand' : undefined)
}

function defaultLabelPrefix(a: VectorAnnotation): string {
  const type = annotationToolType(a)
  return (type && ANNOTATION_TO_OHIF[type]?.labelPrefix) || 'ROI'
}

/**
 * Assign the default viewport label before reflecting a new annotation to OHIF.
 * The label is tool-aware ('Arrow #N' / 'Bidirectional #N' / 'ROI #N') and the
 * number is one past the highest existing "<prefix> #N", so a label is never
 * reused after a deletion. Returns true if it assigned text (so the caller can
 * redraw).
 *
 * A measured line (Length) gets NO default text: its ruler already draws the mm
 * reading, and a free-text label would cross / obscure the ruler.
 */
export function applyDefaultAnnotationText(
  annotation: VectorAnnotation,
  annotations: readonly VectorAnnotation[],
): boolean {
  if (annotation.text?.length) return false
  if (annotationToolType(annotation) === 'measureLine') return false
  const prefix = defaultLabelPrefix(annotation)
  const re = new RegExp(`^${prefix} #(\\d+)$`)
  let maxN = 0
  for (const candidate of annotations) {
    const m = candidate.text ? re.exec(candidate.text) : null
    if (m) {
      const n = Number(m[1])
      if (n > maxN) maxN = n
    }
  }
  const text = `${prefix} #${maxN + 1}`
  annotation.text = text
  // storeAnnotation may keep a shallow clone, while annotationAdded carries the
  // pre-merge object. Update the stored annotation too so the overlay sees it.
  const stored = annotations.find((c) => c.id === annotation.id)
  if (stored) stored.text = text
  return true
}

interface MeasurementSourceLike {
  uid?: string
}
interface MeasurementServiceLike {
  createSource: (name: string, version: string) => MeasurementSourceLike
  addMapping: (
    source: MeasurementSourceLike,
    annotationType: string,
    matchingCriteria: Array<{ valueType: string; points?: number }>,
    toAnnotationSchema: (data: unknown) => unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ) => void
  addRawMeasurement: (
    source: MeasurementSourceLike,
    annotationType: string,
    data: unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ) => string | undefined
  remove?: (uid: string, source?: MeasurementSourceLike) => void
  EVENTS?: {
    MEASUREMENT_UPDATED?: string
    JUMP_TO_MEASUREMENT?: string
    MEASUREMENT_REMOVED?: string
  }
  subscribe?: (
    event: string,
    cb: (payload: {
      viewportId?: string
      // MEASUREMENT_UPDATED/JUMP carry the full measurement object; the
      // MEASUREMENT_REMOVED payload carries the uid as a bare string.
      measurement?:
        | string
        | { uid?: string; label?: string; isVisible?: boolean }
    }) => void,
  ) => { unsubscribe?: () => void }
}
// One 'NiiVue' source per MeasurementService, with a mapping per tool. Every
// tool (Length + the ROI/arrow shapes) is an annotation in ANNOTATION_TO_OHIF.
// createSource is idempotent, but addMapping stacks, so register the set once.
const measurementSources = new WeakMap<object, MeasurementSourceLike>()
function niivueMeasurementSource(
  measurementService: MeasurementServiceLike,
): MeasurementSourceLike {
  const cached = measurementSources.get(measurementService as object)
  if (cached) return cached
  const source = measurementService.createSource('NiiVue', '1.0')
  for (const { toolName, valueType, points } of Object.values(
    ANNOTATION_TO_OHIF,
  )) {
    measurementService.addMapping(
      source,
      toolName,
      [{ valueType, ...(points === undefined ? {} : { points }) }],
      () => ({}),
      (data) => data.measurement,
    )
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
  return [p[0] === 0 ? 0 : -p[0], p[1] === 0 ? 0 : -p[1], p[2]]
}

function annotationPointToLps(
  annotation: VectorAnnotation,
  point: AnnotationPoint,
): [number, number, number] {
  // slice2DToMM's signature is (point, slicePosition, sliceType) — matching every
  // niivue caller. Passing sliceType/slicePosition in the wrong order silently
  // corrupts the depth (and orientation for coronal/sagittal).
  return rasToLps(
    slice2DToMM(point, annotation.slicePosition, annotation.sliceType),
  )
}

function annotationPointsLps(
  annotation: VectorAnnotation,
): [number, number, number][] {
  const shape = annotation.shape
  if (!shape) {
    const outer = annotation.polygons[0]?.outer
    if (outer && outer.length >= 2)
      return outer.map((point) => annotationPointToLps(annotation, point))
    return annotation.anchorMM ? [rasToLps(annotation.anchorMM)] : []
  }

  const { start, end } = shape
  const cx = (start.x + end.x) / 2
  const cy = (start.y + end.y) / 2
  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  let points: AnnotationPoint[]

  switch (shape.type) {
    case 'measureEllipse':
      // cornerstone3D's EllipticalROI reads consecutive point PAIRS as its two
      // axes (points[0..1] = one axis, points[2..3] = the other), so the vertical
      // axis endpoints must be adjacent, then the horizontal ones. An interleaved
      // top/right/bottom/left order makes the pairs the bounding-box diagonals,
      // which reconstructs a rotated, mis-sized ellipse.
      points = [
        { x: cx, y: minY }, // top    \ vertical axis
        { x: cx, y: maxY }, // bottom /
        { x: minX, y: cy }, // left   \ horizontal axis
        { x: maxX, y: cy }, // right  /
      ]
      break
    case 'measureRect':
      points = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ]
      break
    case 'measureCircle':
      points = [
        { x: cx, y: cy },
        { x: maxX, y: cy },
      ]
      break
    case 'measureBidirectional':
      points =
        shape.start2 && shape.end2
          ? [start, end, shape.start2, shape.end2]
          : [start, end]
      break
    case 'measureSpline':
    case 'measureLivewire':
    case 'freehand':
      // Exactly one ring, enforced by the contour guard.
      points = annotation.polygons[0]?.outer ?? []
      break
    case 'measureLine':
      points = [start, end]
      break
    case 'arrow':
      // niivue's shape.end is the arrowHEAD/tip; cornerstone3D ArrowAnnotate reads
      // points[0] as the arrowhead / annotated location, so emit tip first.
      points = [end, start]
      break
    default:
      points = [start]
  }
  return points.map((point) => annotationPointToLps(annotation, point))
}

// --- annotations: reflect NiiVue vector annotations into OHIF ----------------

// niivue annotation id -> OHIF measurement uid, per viewport, so a removed or
// cleared annotation can remove its panel row.
// viewportId -> (annotationId -> { OHIF measurement uid, content hash }). The hash
// lets reconcile touch only the rows whose annotation actually changed, so an edit
// to one annotation never re-mints another's uid (which would drop OHIF's panel
// selection / jump on a row the user never touched).
interface ReflectedRow {
  // The OHIF measurement uid, or absent when the row is a NEGATIVE CACHE entry for
  // a permanently-unsupported geometry: the hash lets reconcile skip re-attempting
  // the reflect until the annotation content changes. Transient/retryable failures
  // are NOT cached (they get no entry), so they retry on the next reconcile once
  // the backing series / service becomes ready.
  uid?: string
  hash: string
}
const reflectedAnnotations = new Map<string, Map<string, ReflectedRow>>()

// Thrown OHIF add/remove errors per annotation, keyed on the content hash so an
// edit retries afresh. Only thrown errors count: a not-yet-loaded backing series
// is a normal wait and keeps retrying every reconcile.
const MAX_MAPPING_ATTEMPTS = 3
const mappingFailures = new Map<
  string,
  Map<string, { hash: string; attempts: number }>
>()

function recordMappingFailure(
  viewportId: string,
  annotationId: string,
  hash: string,
  action: string,
  err: unknown,
): void {
  let byView = mappingFailures.get(viewportId)
  if (!byView) {
    byView = new Map()
    mappingFailures.set(viewportId, byView)
  }
  const prev = byView.get(annotationId)
  // Warn once per failing change (hash), so a later remove failure is still logged.
  if (prev?.hash !== hash)
    console.warn(
      `[nv-ohif] measurement ${action} failed for annotation ${annotationId} (retrying up to ${MAX_MAPPING_ATTEMPTS} attempts)`,
      err,
    )
  byView.set(annotationId, {
    hash,
    attempts: prev?.hash === hash ? prev.attempts + 1 : 1,
  })
}

function mappingExhausted(
  viewportId: string,
  annotationId: string,
  hash: string,
): boolean {
  const f = mappingFailures.get(viewportId)?.get(annotationId)
  return f?.hash === hash && f.attempts >= MAX_MAPPING_ATTEMPTS
}

function clearMappingFailure(viewportId: string, annotationId: string): void {
  const byView = mappingFailures.get(viewportId)
  byView?.delete(annotationId)
  if (byView?.size === 0) mappingFailures.delete(viewportId)
}

/**
 * A stable fingerprint of everything reflected into the panel row (stats, free
 * text, and the shape geometry). Equal hashes mean the row does not need
 * rebuilding. Includes the shape endpoints/second axis and the contour vertices
 * (spline/livewire move without changing the endpoint bbox), so a move or resize
 * is always detected.
 */
function annotationContentHash(a: VectorAnnotation): string {
  const s = a.stats
  const shape = a.shape
  return JSON.stringify([
    a.text ?? '',
    a.sliceType,
    a.slicePosition,
    a.anchorMM ?? null,
    s ? [s.area, s.min, s.mean, s.max, s.stdDev, s.length, s.shortLength] : 0,
    shape ? [shape.type, shape.start, shape.end, shape.start2, shape.end2] : 0,
    a.polygons.map((polygon) => [
      polygon.outer.map((p) => [p.x, p.y]),
      polygon.holes.map((hole) => hole.map((p) => [p.x, p.y])),
    ]),
  ])
}

// The row's hash: its content plus the frame it lies on, which appears only once
// the converted volume's slice map is published, so that re-reflects the row.
function rowHash(a: VectorAnnotation, sf: SliceFrames | undefined): string {
  const frame = sf && frameAt(sf, annotationPointsLps(a))
  const at = frame ? `${frame.SOPInstanceUID}:${frame.frameNumber}` : ''
  return `${annotationContentHash(a)}|${at}`
}

// OHIF measurement uid -> the NiiVue annotation it reflects, so an edit of the
// measurement's label in OHIF's panel can be pushed back as the annotation text.
const measurementToAnnotation = new Map<
  string,
  { viewportId: string; annotationId: string }
>()

// Measurement uids we are removing from OHIF ourselves (removeNiivueAnnotation ->
// measurementService.remove). OHIF broadcasts MEASUREMENT_REMOVED synchronously
// from that call; the reverse-delete handler skips these so our own teardown does
// not re-enter and try to remove the annotation a second time.
const removingUids = new Set<string>()

// Annotation ids hidden from the overlay because their OHIF measurement was
// toggled invisible in the panel (the eye icon). The overlay's shape provider
// filters these out; toggling visibility back on clears the id. Keyed by
// viewport, so it is torn down alongside the reflect bookkeeping.
const hiddenAnnotations = new Map<string, Set<string>>()

interface LabelSyncSubscription {
  refCount: number
  unsubscribe: () => void
}
const labelSyncSubscriptions = new WeakMap<object, LabelSyncSubscription>()

function releaseLabelSync(service: object): void {
  const subscription = labelSyncSubscriptions.get(service)
  if (!subscription) return
  subscription.refCount -= 1
  if (subscription.refCount > 0) return
  subscription.unsubscribe()
  labelSyncSubscriptions.delete(service)
}

function modalityUnit(entry: NiivueViewportEntry): string {
  const modality = baseModality(entry)
  if (modality === 'CT') return 'HU'
  if (modality === 'PT') return 'SUV'
  return ''
}

// The panel row content + cachedStats for a reflected annotation. Measure tools
// (ellipse/rect/circle) carry area (mm^2) + intensity stats; arrows carry none.
function buildAnnotationDisplay(
  { toolName, readout }: AnnotationToolDescriptor,
  stats: AnnotationStats | undefined,
  unit: string,
): { primary: string[]; data: Record<string, unknown>; label: string } {
  const label = `NiiVue ${toolName}`
  if (readout === 'none' || !stats) {
    return { primary: [label], data: {}, label }
  }
  // Length is a single measured line: in-plane distance in mm, no area/intensity.
  if (readout === 'length' && stats.length !== undefined) {
    return {
      primary: [`${stats.length.toFixed(1)} mm`],
      data: { length: stats.length, unit: 'mm' },
      label,
    }
  }
  // Bidirectional carries long + short diameters (mm), not area/intensity.
  if (readout === 'bidirectional' && stats.length !== undefined) {
    const short = stats.shortLength ?? 0
    return {
      primary: [
        `L: ${stats.length.toFixed(1)} mm`,
        `W: ${short.toFixed(1)} mm`,
      ],
      data: { length: stats.length, width: short, unit: 'mm' },
      label,
    }
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

// True when the eraser cut a shape OHIF draws from its bounds or endpoints. NiiVue's
// isAnnotationErased cannot rebuild a bidirectional (two line axes), so do it here.
function isErasedForOhif(annotation: VectorAnnotation): boolean {
  const s = annotation.shape
  if (s?.type !== 'measureBidirectional' && s?.type !== 'bidirectional')
    return isAnnotationErased(annotation)
  const w = s.width ?? annotation.style.strokeWidth
  const intact = [
    ...generateShape('measureLine', s.start, s.end, w),
    ...(s.start2 && s.end2
      ? generateShape('measureLine', s.start2, s.end2, w)
      : []),
  ]
  return JSON.stringify(intact) !== JSON.stringify(annotation.polygons)
}

type ReflectionResult =
  | { status: 'success' }
  | { status: 'permanentlyUnsupported' }
  | { status: 'retryableFailure' }

/**
 * Reflect a completed NiiVue vector annotation (ellipse/rect/circle/arrow) into
 * OHIF's MeasurementService so it renders as a first-class panel row with its
 * stats, and say whether the row was added. Needs a backing DICOM series with
 * instances (same constraint as the ruler; a NIfTI-URL display set is skipped).
 * Intensity stats are the NiiVue volume's sampled values in the base modality's
 * unit; area is in mm^2 (voxel-spacing aware, from NiiVue's annotation stats).
 */
function reflectNiivueAnnotationResult(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  annotation: VectorAnnotation,
  existingUid?: string,
): ReflectionResult {
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
    return { status: 'retryableFailure' }
  // Freehand annotations predate shape metadata and are represented by polygons.
  const toolType = annotationToolType(annotation)
  const mapping = toolType ? ANNOTATION_TO_OHIF[toolType] : undefined
  if (!mapping) return { status: 'permanentlyUnsupported' }
  // OHIF's contour measurements carry one polyline and cannot represent an
  // eraser-split ROI or holes. Do not export only the first ring while the
  // stats cover every piece (#484).
  if (
    mapping.contour &&
    (annotation.polygons.length !== 1 ||
      (annotation.polygons[0]?.holes.length ?? 0) > 0)
  )
    return { status: 'permanentlyUnsupported' }
  const entry = getNiivueEntry(viewportId)
  if (!entry) return { status: 'retryableFailure' }
  const backing = resolveBackingSeries(entry, displaySetService)
  if (!backing?.SeriesInstanceUID) return { status: 'retryableFailure' }

  const source = niivueMeasurementSource(measurementService)
  const uid =
    existingUid ?? `niivue-${mapping.toolName}-${++niivueMeasurementCounter}`
  const forUID = backing.instances?.[0]?.FrameOfReferenceUID as
    | string
    | undefined
  const points = annotationPointsLps(annotation)
  if (points.length < (mapping.minPoints ?? 0))
    return { status: 'permanentlyUnsupported' }
  // An eraser cut leaves the bounds and endpoints intact, so OHIF would draw the
  // whole shape beside stats for what is left. Drop the row instead.
  if (isErasedForOhif(annotation)) return { status: 'permanentlyUnsupported' }
  // SOPInstanceUID / frameNumber / referencedImageId when the shape lies on one
  // acquired frame; MeasurementService rejects keys outside its schema, so an
  // unmapped shape omits them rather than sending undefined.
  const frame = entry.sliceFrames && frameAt(entry.sliceFrames, points)
  const unit = modalityUnit(entry)
  const { primary, data } = buildAnnotationDisplay(
    mapping,
    annotation.stats,
    unit,
  )
  // The row label is the annotation's own text (applyDefaultAnnotationText seeds a
  // sensible default on add). Do NOT substitute an internal "NiiVue <Tool>"
  // fallback for empty text: reflecting that fallback would echo it back through
  // the label sync onto the canvas, making a user-cleared label impossible.
  const rowLabel = annotation.text ?? ''
  const hash = rowHash(annotation, entry.sliceFrames)
  if (mappingExhausted(viewportId, annotation.id, hash))
    return { status: 'retryableFailure' }

  let acceptedUid: string | undefined
  try {
    acceptedUid = measurementService.addRawMeasurement(
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
          ...frame,
          points,
          displayText: { primary, secondary: [] },
          data,
          type: mapping.valueType,
          metadata: { toolName: mapping.toolName, FrameOfReferenceUID: forUID },
        },
      },
      (d) => d.measurement,
    )
  } catch (err) {
    recordMappingFailure(viewportId, annotation.id, hash, 'add', err)
    return { status: 'retryableFailure' }
  }
  if (!acceptedUid) return { status: 'retryableFailure' }
  clearMappingFailure(viewportId, annotation.id)

  let byView = reflectedAnnotations.get(viewportId)
  if (!byView) {
    byView = new Map()
    reflectedAnnotations.set(viewportId, byView)
  }
  byView.set(annotation.id, { uid: acceptedUid, hash })
  measurementToAnnotation.set(acceptedUid, {
    viewportId,
    annotationId: annotation.id,
  })
  return { status: 'success' }
}

export function reflectNiivueAnnotation(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  annotation: VectorAnnotation,
  existingUid?: string,
): boolean {
  return (
    reflectNiivueAnnotationResult(
      viewportId,
      servicesManager,
      annotation,
      existingUid,
    ).status === 'success'
  )
}

/**
 * Push an OHIF measurement's label (edited in the panel) back onto the NiiVue
 * annotation it reflects, so the free text shows on the viewport. No-op if the
 * uid is not one of ours.
 */
export function applyOhifLabelToAnnotation(
  measurementUid: string,
  label: string,
): void {
  const ref = measurementToAnnotation.get(measurementUid)
  if (!ref) return
  const entry = getNiivueEntry(ref.viewportId)
  if (!entry) return
  // No-op when the text is already what OHIF reports. This breaks the echo loop:
  // an update-in-place reflect broadcasts MEASUREMENT_UPDATED carrying the row
  // label we just wrote from the annotation's own text, and setAnnotationText
  // always re-emits annotationChanged (even for identical text) which would
  // re-drive reconcile -> reflect -> ... (round-2 review R2-0).
  const current = entry.nv.annotations.find((a) => a.id === ref.annotationId)
  if (current && (current.text ?? '') === (label ?? '')) return
  entry.nv.setAnnotationText(ref.annotationId, label ?? '')
}

/** Navigate the owning NiiVue viewport to a reflected OHIF measurement. */
export function jumpToNiivueMeasurement(
  measurementUid: string,
  servicesManager: OhifExtensionParams['servicesManager'],
): void {
  const ref = measurementToAnnotation.get(measurementUid)
  if (!ref) return
  const entry = getNiivueEntry(ref.viewportId)
  const annotation = entry?.nv.annotations.find(
    (candidate) => candidate.id === ref.annotationId,
  )
  if (!entry || !annotation) return

  const services = ohifServices(servicesManager)
  const viewportGridService = services?.viewportGridService as
    | { setActiveViewportId?: (viewportId: string) => void }
    | undefined
  viewportGridService?.setActiveViewportId?.(ref.viewportId)

  // Navigate to the shape's annotated location, in mm (setCrosshairPos takes mm):
  // an arrow's tip (its target), otherwise the shape/contour CENTER. anchorMM is
  // only the drag-START corner (an arrow's tail), so it lands off-center — use it
  // just as a last resort (round-4 R4-4).
  let target: [number, number, number] | undefined
  const shape = annotation.shape
  if (shape) {
    const at =
      shape.type === 'arrow'
        ? shape.end // arrowhead / tip = the annotated location
        : {
            x: (shape.start.x + shape.end.x) / 2,
            y: (shape.start.y + shape.end.y) / 2,
          }
    target = slice2DToMM(at, annotation.slicePosition, annotation.sliceType)
  } else {
    const outer = annotation.polygons[0]?.outer
    if (outer && outer.length > 0) {
      const sum = outer.reduce(
        (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
        { x: 0, y: 0 },
      )
      target = slice2DToMM(
        { x: sum.x / outer.length, y: sum.y / outer.length },
        annotation.slicePosition,
        annotation.sliceType,
      )
    }
  }
  if (!target) target = annotation.anchorMM
  if (target) entry.nv.setCrosshairPos(target)
  entry.nv.selectAnnotation(annotation.id)
}

/**
 * Delete the NiiVue annotation backing an OHIF measurement removed from the
 * panel, then re-render. No-op when the uid is not one of ours, or when WE are
 * the ones removing it (removeNiivueAnnotation -> measurementService.remove
 * echoes MEASUREMENT_REMOVED synchronously; removingUids marks those so we do
 * not double-remove).
 */
export function applyOhifRemoveToAnnotation(measurementUid: string): void {
  if (removingUids.has(measurementUid)) return
  const ref = measurementToAnnotation.get(measurementUid)
  if (!ref) return
  // Drop our bookkeeping BEFORE removing the annotation. nv.removeAnnotation
  // emits annotationRemoved, which drives onAnnotationRemoved ->
  // removeNiivueAnnotation; with the row already gone that is a clean no-op and
  // never calls measurementService.remove for the already-deleted measurement.
  const byView = reflectedAnnotations.get(ref.viewportId)
  byView?.delete(ref.annotationId)
  if (byView && byView.size === 0) reflectedAnnotations.delete(ref.viewportId)
  measurementToAnnotation.delete(measurementUid)
  clearHiddenAnnotation(ref.viewportId, ref.annotationId)
  // removeAnnotation splices the annotation out and calls drawScene, so the
  // viewport re-renders without it.
  getNiivueEntry(ref.viewportId)?.nv.removeAnnotation(ref.annotationId)
}

/** Drop a hidden-annotation entry (annotation gone / row torn down). */
function clearHiddenAnnotation(viewportId: string, annotationId: string): void {
  const set = hiddenAnnotations.get(viewportId)
  if (!set) return
  set.delete(annotationId)
  if (set.size === 0) hiddenAnnotations.delete(viewportId)
}

/**
 * The overlay shape provider: `nv.annotationScreenShapes` minus any annotation
 * hidden via its OHIF measurement's visibility toggle. Core still projects every
 * annotation each frame; we drop the hidden ones just before the overlay draws.
 */
export function visibleAnnotationScreenShapes(
  viewportId: string,
  shapes: readonly AnnotationScreenShape[],
): readonly AnnotationScreenShape[] {
  const hidden = hiddenAnnotations.get(viewportId)
  if (!hidden || hidden.size === 0) return shapes
  return shapes.filter((shape) => !hidden.has(shape.id))
}

/**
 * Show or hide the NiiVue annotation backing an OHIF measurement whose panel
 * visibility (eye icon) was toggled, then re-render. No-op when the uid is not
 * one of ours or the state already matches.
 */
export function applyOhifVisibilityToAnnotation(
  measurementUid: string,
  isVisible: boolean,
): void {
  const ref = measurementToAnnotation.get(measurementUid)
  if (!ref) return
  const set = hiddenAnnotations.get(ref.viewportId)
  const currentlyHidden = set?.has(ref.annotationId) ?? false
  if (isVisible === !currentlyHidden) return
  // Record the hidden state FIRST, before touching the viewport. If the entry is
  // transiently unregistered (a viewport remounting), we still remember the toggle
  // so the next render's visibleAnnotationScreenShapes filter honours it; the
  // drawScene below is only an immediate-repaint optimization.
  if (isVisible) {
    clearHiddenAnnotation(ref.viewportId, ref.annotationId)
  } else {
    const target = set ?? new Set<string>()
    target.add(ref.annotationId)
    hiddenAnnotations.set(ref.viewportId, target)
  }
  getNiivueEntry(ref.viewportId)?.nv.drawScene()
}

/**
 * Subscribe once per MeasurementService to OHIF events handled by NiiVue:
 * label edits are pushed to annotation text, and panel jumps navigate to the
 * owning annotation. The historical function name remains part of the API.
 */
export function subscribeOhifLabelSync(
  servicesManager: OhifExtensionParams['servicesManager'],
): (() => void) | undefined {
  const svc = ohifServices(servicesManager)?.measurementService as
    | MeasurementServiceLike
    | undefined
  const labelEvent = svc?.EVENTS?.MEASUREMENT_UPDATED
  const jumpEvent = svc?.EVENTS?.JUMP_TO_MEASUREMENT
  const removeEvent = svc?.EVENTS?.MEASUREMENT_REMOVED
  if (!svc?.subscribe || (!labelEvent && !jumpEvent && !removeEvent))
    return undefined
  const existing = labelSyncSubscriptions.get(svc as object)
  if (existing) {
    existing.refCount += 1
    return () => releaseLabelSync(svc as object)
  }
  const subscriptions: Array<{ unsubscribe?: () => void }> = []
  if (labelEvent) {
    subscriptions.push(
      svc.subscribe(labelEvent, (payload) => {
        const m = payload?.measurement
        if (typeof m !== 'object' || !m?.uid) return
        // Only a real label field is a label edit. An update that OMITS label (a
        // tracking / cachedStats change) must not be read as an explicit blank.
        if (typeof m.label === 'string')
          applyOhifLabelToAnnotation(m.uid, m.label)
        // The panel eye toggle broadcasts MEASUREMENT_UPDATED with isVisible set.
        if (typeof m.isVisible === 'boolean')
          applyOhifVisibilityToAnnotation(m.uid, m.isVisible)
      }),
    )
  }
  if (jumpEvent) {
    subscriptions.push(
      svc.subscribe(jumpEvent, (payload) => {
        const m = payload?.measurement
        const uid = typeof m === 'object' ? m?.uid : undefined
        if (uid) jumpToNiivueMeasurement(uid, servicesManager)
      }),
    )
  }
  if (removeEvent) {
    subscriptions.push(
      svc.subscribe(removeEvent, (payload) => {
        // MEASUREMENT_REMOVED carries the uid as a bare string; tolerate an
        // object payload too in case a host wraps it.
        const m = payload?.measurement
        const uid = typeof m === 'string' ? m : m?.uid
        if (uid) applyOhifRemoveToAnnotation(uid)
      }),
    )
  }
  labelSyncSubscriptions.set(svc as object, {
    refCount: 1,
    unsubscribe: () => {
      for (const subscription of subscriptions) subscription?.unsubscribe?.()
    },
  })
  return () => releaseLabelSync(svc as object)
}

/** Remove one reflected annotation's OHIF panel row (annotationRemoved). */
/**
 * Returns true when the row is gone (removed, or there was nothing / no uid to
 * remove, or the host has no remove so recovery is impossible). Returns FALSE only
 * when an available remove() THREW: the bookkeeping is preserved so the caller can
 * retry on a later reconcile instead of orphaning the OHIF row (round-5 F1).
 */
export function removeNiivueAnnotation(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
  annotationId: string,
): boolean {
  const byView = reflectedAnnotations.get(viewportId)
  const row = byView?.get(annotationId)
  if (!byView || !row) {
    clearMappingFailure(viewportId, annotationId)
    return true
  }
  const measurementService = ohifServices(servicesManager)
    ?.measurementService as MeasurementServiceLike | undefined
  if (row.uid) {
    // After the retry cap, fall through and drop the bookkeeping: the OHIF row
    // is orphaned, but the maps stop growing and reconcile stops retrying.
    if (
      measurementService?.remove &&
      !mappingExhausted(viewportId, annotationId, row.hash)
    ) {
      removingUids.add(row.uid)
      try {
        measurementService.remove(row.uid)
      } catch (err) {
        // A THROWN remove is transient — keep the bookkeeping so the next
        // reconcile retries the OHIF-side removal.
        recordMappingFailure(viewportId, annotationId, row.hash, 'remove', err)
        return false
      } finally {
        removingUids.delete(row.uid)
      }
    }
    // remove absent (the host can never remove it) or succeeded: drop the
    // bookkeeping so the maps do not leak unbounded across draw/delete and
    // mount/unmount cycles (round-4 R4-1; a negative-cache row has no uid).
    measurementToAnnotation.delete(row.uid)
  }
  byView.delete(annotationId)
  if (byView.size === 0) reflectedAnnotations.delete(viewportId)
  clearMappingFailure(viewportId, annotationId)
  // Only drop the hidden flag when the annotation is actually gone from NiiVue.
  // removeNiivueAnnotation also runs on reconcile's permanently-unsupported path,
  // which drops the OHIF row while the annotation is still alive; clearing there
  // would un-hide a shape the user hid (and leave no row to re-hide it). On a
  // genuine delete the annotation is already spliced out (removeAnnotation emits
  // annotationRemoved after the splice), so this correctly cleans up.
  const stillPresent =
    getNiivueEntry(viewportId)?.nv.annotations.some(
      (a) => a.id === annotationId,
    ) ?? false
  if (!stillPresent) clearHiddenAnnotation(viewportId, annotationId)
  return true
}

/** Remove every reflected row for a viewport (annotation clear / series swap). */
export function clearNiivueAnnotations(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
): void {
  // A viewport whose every add failed has no rows but may still hold failures.
  mappingFailures.delete(viewportId)
  const byView = reflectedAnnotations.get(viewportId)
  if (!byView) return
  const measurementService = ohifServices(servicesManager)
    ?.measurementService as MeasurementServiceLike | undefined
  for (const { uid } of byView.values()) {
    if (!uid) continue
    // Guard against our own echo: this runs on unmount BEFORE the MEASUREMENT_REMOVED
    // subscription is torn down, so remove() synchronously re-enters
    // applyOhifRemoveToAnnotation. Marking the uid makes that a no-op instead of a
    // redundant nv.removeAnnotation + drawScene per row (and a mutation of byView
    // mid-iteration).
    removingUids.add(uid)
    try {
      measurementService?.remove?.(uid)
    } catch {
      // Continue clearing the remaining rows and local bookkeeping.
    } finally {
      removingUids.delete(uid)
    }
    measurementToAnnotation.delete(uid)
  }
  reflectedAnnotations.delete(viewportId)
  hiddenAnnotations.delete(viewportId)
}

/**
 * Reconcile a viewport's reflected panel rows against NiiVue's current annotation
 * set. Used for edits that the per-row annotationAdded / annotationRemoved events
 * do not cover, where the change event carries only an action (no id): a resize or
 * move (geometry/stats changed on an existing shape), an erase, or an undo/redo
 * (membership changed).
 *
 * Diff-based, keyed on annotation id, so it only touches rows that actually
 * changed:
 *   - annotation gone      -> remove its row
 *   - annotation new       -> add a row
 *   - annotation changed   -> update the existing row in place (reuse the uid)
 *   - annotation unchanged -> leave its row (keeps its uid, so OHIF panel
 *                             selection / jump on rows the user did not edit is
 *                             preserved)
 *   - unsupported geometry -> delete any prior row and negative-cache the hash
 *   - transient failure    -> leave uncached and retry on a later reconcile
 *
 * Re-entrancy guarded: an update-in-place reflect can synchronously broadcast
 * MEASUREMENT_UPDATED, whose handler may emit annotationChanged and re-enter here.
 * Those nested calls are echoes of our own OHIF writes (never a fresh user
 * action), so they are skipped — without this a single resize would recurse to a
 * stack overflow (round-2 review R2-0).
 */
const reconcilingViewports = new Set<string>()
export function reconcileNiivueAnnotations(
  viewportId: string,
  servicesManager: OhifExtensionParams['servicesManager'],
): void {
  if (reconcilingViewports.has(viewportId)) return
  const entry = getNiivueEntry(viewportId)
  if (!entry) return
  reconcilingViewports.add(viewportId)
  try {
    const live = entry.nv.annotations
    const liveIds = new Set(live.map((a) => a.id))

    // Remove rows for annotations that no longer exist.
    const byView = reflectedAnnotations.get(viewportId)
    if (byView) {
      for (const annotationId of [...byView.keys()]) {
        if (!liveIds.has(annotationId))
          removeNiivueAnnotation(viewportId, servicesManager, annotationId)
      }
    }
    // Failures for vanished annotations with no row left (erase / undo). A row
    // still present is a pending removal whose attempt count must survive.
    const rows = reflectedAnnotations.get(viewportId)
    for (const annotationId of mappingFailures.get(viewportId)?.keys() ?? [])
      if (!liveIds.has(annotationId) && !rows?.has(annotationId))
        clearMappingFailure(viewportId, annotationId)

    // Add new annotations and update changed rows in place.
    for (const annotation of live) {
      const existing = reflectedAnnotations.get(viewportId)?.get(annotation.id)
      const hash = rowHash(annotation, entry.sliceFrames)
      if (existing && existing.hash === hash) continue
      const result = reflectNiivueAnnotationResult(
        viewportId,
        servicesManager,
        annotation,
        existing?.uid,
      )
      // On success reflect stored {uid, hash}.
      if (result.status === 'permanentlyUnsupported') {
        // The current geometry cannot be represented in OHIF (freehand hole /
        // split, degenerate shape). Per product decision, DELETE any prior row
        // rather than leave it misrepresenting the new geometry, and negative-
        // cache the hash so the permanently-bad shape is not re-attempted every
        // event. A later edit changes the hash and reflects afresh.
        //
        // If the removal THROWS (transient), removeNiivueAnnotation returns false
        // and preserves the { uid, hash } entry: leave it so the NEXT reconcile
        // retries the removal, instead of overwriting it with a uid-less negative
        // cache (which would orphan the OHIF row + leak measurementToAnnotation and
        // block all future removal — round-5 F1).
        const removed = existing?.uid
          ? removeNiivueAnnotation(viewportId, servicesManager, annotation.id)
          : true
        if (!removed) continue
        let map = reflectedAnnotations.get(viewportId)
        if (!map) {
          map = new Map()
          reflectedAnnotations.set(viewportId, map)
        }
        map.set(annotation.id, { hash })
      }
      // retryableFailure (no entry / backing series not ready yet / service
      // hiccup): leave it UNcached so the next reconcile retries — e.g. once a
      // DICOM series finishes loading, the row appears without a content edit.
    }
  } finally {
    reconcilingViewports.delete(viewportId)
  }
}

/**
 * On a base-volume volumeUpdated, record the new window/level on the entry.
 * Returns it when it changed (for a viewport readout), else undefined. Windows
 * stay per viewport, as in OHIF: nothing is pushed to other viewports.
 */
export function trackNiivueWindowLevel(
  viewportId: string,
): { window: number; level: number } | undefined {
  const entry = getNiivueEntry(viewportId)
  if (!entry) return undefined
  const wl = readBaseWindowLevel(entry.nv)
  if (!wl) return undefined
  // First observation just seeds the baseline (no readout).
  if (entry.windowLevel && sameWindowLevel(entry.windowLevel, wl))
    return undefined
  const seeded = entry.windowLevel !== undefined
  entry.windowLevel = wl
  return seeded ? wl : undefined
}

/** A hanging protocol's initial window (`displaySetOptions[0].options.voi`). */
export function voiRange(
  displaySetOptions: OhifViewportProps['displaySetOptions'],
): { calMin: number; calMax: number } | undefined {
  // Cornerstone's mapDisplaySetOptions accepts `item.options || item`.
  const d = displaySetOptions?.[0]
  const options = (d?.options ?? d) as
    | { voi?: { windowWidth?: unknown; windowCenter?: unknown } }
    | undefined
  const width = Number(options?.voi?.windowWidth)
  const center = Number(options?.voi?.windowCenter)
  if (!(width > 0) || !Number.isFinite(center)) return undefined
  const [calMin, calMax] = windowToRange(width, center)
  return { calMin, calMax }
}

/** Reset camera, pan, zoom, crosshair, 2D rotation and flips (or refit a slide). */
export function resetView(entry: NiivueViewportEntry): void {
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
  centerCrosshair(nv)
  // Cornerstone's reset also clears rotation and flips.
  nv.rotation2D = 0
  nv.isFlipped2DHorizontal = false
  nv.isFlipped2DVertical = false
}

/**
 * Put the crosshair on the base volume's centre voxel. NiiVue's default, scene
 * fraction 0.5, falls between two slices when the slice count is even, where
 * frameAt finds no DICOM frame for a measurement.
 */
export function centerCrosshair(nv: NiivueViewportEntry['nv']): void {
  const dims = nv.volumes[0]?.dimsRAS
  const mid = (d = 1) => Math.round((d - 1) / 2)
  nv.crosshairPos = dims
    ? nv.vox2frac([mid(dims[1]), mid(dims[2]), mid(dims[3])])
    : [...VIEW_DEFAULTS.crosshairPos]
}

/** Apply one of OHIF's modality presets (by id, then index) to the base volume. */
export function applyWindowLevelPreset(
  entry: NiivueViewportEntry,
  servicesManager: OhifExtensionParams['servicesManager'],
  presetId: string | undefined,
  presetIndex: number | undefined,
): void {
  if (entry.nv.volumes.length === 0) return
  const range = resolveWindowLevel(
    windowLevelPresets(servicesManager),
    baseModality(entry),
    presetId,
    presetIndex,
  )
  if (!range) return
  entry.nv
    .setVolume(0, { calMin: range[0], calMax: range[1] })
    .catch((err: unknown) =>
      console.error('[nv-ohif] window/level preset failed', err),
    )
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
     * NiivueViewport maps the active `Length` tool onto NiiVue's `measureLine`
     * annotation (the same system as the ROI tools). Setting the annotation tool
     * directly would be reset by that bridge the next time OHIF's active tool
     * (e.g. WindowLevel) re-applies. On release the completed line annotation is
     * reflected into OHIF's measurement panel (see the annotationAdded
     * subscription in NiivueViewport). Falls back to enabling NiiVue's measureLine
     * annotation directly when no commandsManager is available.
     */
    niivueSetMeasurementMode: () => {
      const cmds = ohifCommandsManager(commandsManager)
      if (cmds?.runCommand) {
        cmds.runCommand('setToolActiveToolbar', { toolName: 'Length' })
        return
      }
      const nv = getActiveNiivue(servicesManager)
      if (nv) {
        nv.annotationTool = 'measureLine'
        nv.annotationIsEnabled = true
      }
    },

    /** Reset camera, pan, zoom, crosshair, 2D rotation and flips to their defaults. */
    niivueResetView: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (entry) resetView(entry)
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
     * Toggle a colormapped overlay: cancel a load in flight; with overlays
     * loaded, remove them; otherwise add the study's next loadable series.
     */
    niivueToggleOverlay: async () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const { nv, viewportId } = entry
      if (entry.overlayLoading || entry.overlays.size === 0) {
        await actions.niivueAddOverlay()
        return
      }
      while (nv.volumes.length > 1) {
        nv.model.removeVolume(nv.volumes.length - 1)
      }
      entry.overlays.clear()
      await nv.updateGLVolume()
      refreshToolbar(servicesManager, viewportId)
    },

    /**
     * Add a series of the study as an overlay on the base (fetch + dcm2niix
     * conversion for DICOM): `displaySetInstanceUID`, else the next loadable
     * one. A load in flight is cancelled first; without a chosen series that
     * is all a call does (the Overlay toggle's second press).
     */
    niivueAddOverlay: async ({
      displaySetInstanceUID,
    }: {
      displaySetInstanceUID?: string
    } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      // Cancelling releases the entry at once, so a new load can start while
      // the old one tears down.
      if (entry.overlayLoading && !displaySetInstanceUID) {
        entry.overlayAbort?.abort()
        entry.overlayAbort = undefined
        entry.overlayLoading = false
        writeStatus(entry, null)
        refreshToolbar(servicesManager, entry.viewportId)
        return
      }
      const { nv, viewportId } = entry

      // Need a loaded base to overlay onto (until a new base loads, nv.volumes
      // still holds the old one).
      if (entry.baseLoading || nv.volumes.length === 0) return

      const dsService = ohifServices(servicesManager)?.displaySetService as
        | DisplaySetServiceLike
        | undefined
      const candidates = overlayCandidates(
        entry,
        dsService?.getActiveDisplaySets?.() ?? [],
      )
      const candidate = displaySetInstanceUID
        ? candidates.find(
            (ds) => ds.displaySetInstanceUID === displaySetInstanceUID,
          )
        : candidates[0]
      if (!candidate) {
        flashStatus(
          entry,
          displaySetInstanceUID
            ? 'That series cannot be overlaid here.'
            : 'No other loadable series in this study.',
        )
        return
      }
      // A chosen series replaces a load in flight: one load at a time.
      entry.overlayAbort?.abort()
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
      // overlays. Guard on both: same registered entry AND same base series,
      // so we never overlay onto the wrong anatomy or a destroyed instance. Both
      // also abort the conversion via entry.overlayAbort (see niivueRegistry).
      const baseDisplaySets = entry.displaySets
      const stillLive = () =>
        getNiivueEntry(viewportId) === entry &&
        entry.displaySets === baseDisplaySets
      const abort = new AbortController()
      // stillLive() alone cannot tell two loads on the same base apart.
      const owns = () => stillLive() && entry.overlayAbort === abort

      // Prepare (fetch + parse) the overlay, add it only if this load still owns
      // the viewport, then undo the add if it lost ownership DURING addVolume
      // (cancel press, swap, unmount). Removed by identity, so a newer load's
      // volume or a swap's replaced array is left alone. Returns the hdr of the
      // overlay if it stuck.
      const addOverlayGuarded = async (
        spec: Parameters<typeof nv.prepareVolume>[0],
      ): Promise<NVImage['hdr'] | undefined> => {
        const image = await nv.prepareVolume(spec)
        if (stillLive() && !abort.signal.aborted) {
          await nv.addVolume(image)
          if (stillLive() && !abort.signal.aborted) return image.hdr
          // addVolume stores a copy of `image` that shares its hdr.
          const i = nv.volumes.findIndex((v) => v.hdr === image.hdr)
          if (i >= 0) {
            nv.model.removeVolume(i)
            await nv.updateGLVolume()
          }
        }
        // Cancelled: the cancel press cleared the status.
        abort.signal.throwIfAborted()
        return undefined
      }

      entry.overlayAbort = abort
      entry.overlayLoading = true
      try {
        // Disables the dropdown's add list before the first await.
        refreshToolbar(servicesManager, entry.viewportId)
        // Direct volume-URL display sets skip conversion.
        const direct = displaySetToNiivue(candidate)
        let added: NVImage['hdr'] | undefined
        let note: string | undefined
        if (direct) {
          added = await addOverlayGuarded({
            ...direct,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        } else {
          writeStatus(entry, `Fetching overlay: ${label}...`, 'loading')
          const converted = await convertDisplaySetToNifti(candidate, {
            headers: authHeaders(servicesManager),
            signal: abort.signal,
            onProgress: (phase, loaded, total) => {
              if (!owns()) return
              writeStatus(
                entry,
                phase === 'fetching'
                  ? `Fetching overlay: ${label}... ${loaded}/${total}`
                  : `Converting overlay: ${label} (dcm2niix)...`,
                'loading',
              )
            },
          })
          // A cancel press after convert resolved but before this resumed.
          abort.signal.throwIfAborted()
          if (!converted) throw new Error('conversion produced no volume')
          note = converted.note
          added = await addOverlayGuarded({
            url: converted.image,
            name: converted.image.name,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        }
        if (!added || !owns()) return
        entry.overlays.set(uid, added)
        if (note) flashStatus(entry, note)
        else writeStatus(entry, null)
      } catch (err) {
        // Every abort source (cancel press, base swap, unmount) already let go.
        if (abort.signal.aborted || !owns()) return
        console.error('[nv-ohif] overlay load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        flashStatus(
          entry,
          `Overlay load failed: ${message || 'unknown error'}`,
          'error',
        )
      } finally {
        // A newer load (after a cancel press or a swap) owns the flags now.
        if (entry.overlayAbort === abort) {
          entry.overlayAbort = undefined
          entry.overlayLoading = false
          refreshToolbar(servicesManager, viewportId)
        }
      }
    },

    /** Show or hide an overlay (still loaded); toggles without `visible`. */
    niivueSetOverlayVisible: ({
      displaySetInstanceUID,
      visible,
    }: {
      displaySetInstanceUID?: string
      visible?: boolean
    } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const index = overlayVolumeIndex(entry, displaySetInstanceUID)
      if (index === 0) return
      // Core keeps a hidden volume's opacity for when it is shown again.
      const shown = entry.nv.volumes[index]?.visible !== false
      entry.nv
        .setVolume(index, { visible: visible ?? !shown })
        .catch((err: unknown) =>
          console.error('[nv-ohif] overlay visibility update failed', err),
        )
      refreshToolbar(servicesManager, entry.viewportId)
    },

    /**
     * Move an overlay past the next one up (drawn over it) or down. The base
     * stays the bottom layer.
     */
    niivueMoveOverlay: ({
      displaySetInstanceUID,
      direction,
    }: {
      displaySetInstanceUID?: string
      direction?: 'up' | 'down'
    } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const order = overlayOrder(entry)
      const at = order.indexOf(displaySetInstanceUID as string)
      const step = direction === 'up' ? 1 : direction === 'down' ? -1 : 0
      const neighbor = order[at + step]
      if (at < 0 || step === 0 || neighbor === undefined) return
      const from = overlayVolumeIndex(entry, displaySetInstanceUID)
      const to = overlayVolumeIndex(entry, neighbor)
      // One layer at a time, past a cancelled load's volume between the two.
      for (let i = from; i !== to; i += step)
        (step > 0
          ? entry.nv.moveVolumeUp(i)
          : entry.nv.moveVolumeDown(i)
        ).catch((err: unknown) =>
          console.error('[nv-ohif] overlay move failed', err),
        )
      refreshToolbar(servicesManager, entry.viewportId)
    },

    /** Remove one overlay; the others keep their display-set mapping. */
    niivueRemoveOverlay: ({
      displaySetInstanceUID,
    }: {
      displaySetInstanceUID?: string
    } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const index = overlayVolumeIndex(entry, displaySetInstanceUID)
      if (index === 0) return
      entry.overlays.delete(displaySetInstanceUID as string)
      entry.nv
        .removeVolume(index)
        .catch((err: unknown) =>
          console.error('[nv-ohif] overlay removal failed', err),
        )
      refreshToolbar(servicesManager, entry.viewportId)
    },

    /**
     * Apply a window/level (width + center) to the base volume as NiiVue
     * calMin/calMax, or to a monochrome whole-slide image's display window.
     * Bridges OHIF's W/L model onto NiiVue's calibration range.
     */
    niivueSetWindowLevel: ({
      window,
      level,
    }: {
      window?: number
      level?: number
    } = {}) => {
      if (
        window === undefined ||
        level === undefined ||
        !Number.isFinite(window) ||
        !Number.isFinite(level)
      )
        return
      const [calMin, calMax] = windowToRange(window, level)
      const slideView = getActiveNiivueEntry(servicesManager)?.slideView
      if (slideView) {
        // A finite window can still overflow to an infinite bound.
        if (
          Number.isFinite(calMin) &&
          Number.isFinite(calMax) &&
          calMax > calMin
        )
          slideView.setWindow(calMin, calMax)
        return
      }
      const nv = getActiveNiivue(servicesManager)
      if (!nv || nv.volumes.length === 0) return
      // A queued GPU update can reject; log it rather than leave it unhandled (#467).
      nv.setVolume(0, { calMin, calMax }).catch((err: unknown) =>
        console.error('[nv-ohif] window/level update failed', err),
      )
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
      if (entry)
        applyWindowLevelPreset(entry, servicesManager, presetId, presetIndex)
    },

    /** Recompute the base volume's robust (2-98%) auto window. */
    niivueAutoWindowLevel: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry || entry.nv.volumes.length === 0) return
      entry.nv
        .recalculateCalMinMax(0)
        .then(() => {
          const wl = readBaseWindowLevel(entry.nv)
          if (wl) entry.windowLevel = wl
        })
        .catch((err: unknown) =>
          console.error('[nv-ohif] auto window/level failed', err),
        )
    },

    /** Set the base volume's colormap (e.g. gray / hot / viridis). */
    niivueSetColormap: ({ colormap }: { colormap?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      if (!nv || nv.volumes.length === 0 || !colormap) return
      nv.setVolume(0, { colormap }).catch((err: unknown) =>
        console.error('[nv-ohif] colormap update failed', err),
      )
    },

    /** Toggle the colormap legend (colorbar) on the viewport. */
    niivueToggleColorbar: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry) return
      entry.nv.isColorbarVisible = !entry.nv.isColorbarVisible
      refreshToolbar(servicesManager, entry.viewportId)
    },

    /**
     * Cornerstone's global JUMP_TO_MEASUREMENT handler runs this command without
     * a context, so the newest context answers: NIIVUE, when nv-ohif registers
     * after cornerstone. A NiiVue row is navigated by subscribeOhifLabelSync;
     * Cornerstone would otherwise re-hang the viewport. Others go to Cornerstone.
     */
    jumpToMeasurementViewport: (options: {
      measurement?: { uid?: string }
    }) => {
      const uid = options.measurement?.uid
      if (uid && measurementToAnnotation.has(uid)) return
      ohifCommandsManager(commandsManager)?.runCommand?.(
        'jumpToMeasurementViewport',
        options,
        'CORNERSTONE',
      )
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

  // OHIF command definitions wrap each action, so a new action cannot be left
  // unregistered.
  const definitions: OhifCommandsModule['definitions'] = {
    ...Object.fromEntries(
      Object.entries(actions).map(([name, commandFn]) => [name, { commandFn }]),
    ),
    ...getStandardCommandDefinitions({ servicesManager, commandsManager }),
  }

  return {
    actions,
    definitions,
    defaultContext: 'NIIVUE',
  }
}
