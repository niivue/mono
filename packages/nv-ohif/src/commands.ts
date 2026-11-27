import type NiiVue from '@niivue/niivue'
import { lookupColorMap, type NVImage, SLICE_TYPE } from '@niivue/niivue'
import { showCaptureForm } from './captureForm'
import { classifyDisplaySet } from './classifyDisplaySet'
import { jumpToContourSegment } from './contourSeg'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { displaySetToNiivue } from './displaySetToNiivue'
import { installClearHistory } from './history'
import { takeMeasurementJump } from './measurementReflection'
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
import { getQuantCommandDefinitions, showPaneLabel } from './petQuant'
import { getSegCommandDefinitions } from './segCommands'
import { jumpToNiivueSegment } from './segPanel'
import type { SliceFrames } from './sliceFrames'
import { mirrorNiivueMeasurements } from './srBridge'
import { getStandardCommandDefinitions } from './standardCommands'
import { petSuvFactor } from './suv'

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

/**
 * The slice type a hanging protocol asks of a viewport: a `volume3d` viewport
 * renders, an orientation (axial/coronal/sagittal) picks that plane, and
 * anything else (stack, 'acquisition', unset) keeps the multiplanar default.
 */
export function initialSliceType(viewportOptions?: {
  orientation?: string
  viewportType?: string
}): number {
  if (viewportOptions?.viewportType === 'volume3d') return SLICE_TYPE.RENDER
  return (
    NIIVUE_SLICE_TYPES[viewportOptions?.orientation ?? ''] ??
    SLICE_TYPE.MULTIPLANAR
  )
}

/**
 * The render camera [azimuth, elevation] for a volume3d viewport's hanging-protocol
 * orientation, matching cornerstone's camera (coronal from the front, sagittal
 * from patient left, axial from below); undefined keeps NiiVue's default.
 */
export function initialRenderView(viewportOptions?: {
  orientation?: string
  viewportType?: string
}): [number, number] | undefined {
  if (viewportOptions?.viewportType !== 'volume3d') return undefined
  return (
    { coronal: [180, 0], sagittal: [90, 0], axial: [180, -90] } as Record<
      string,
      [number, number]
    >
  )[viewportOptions.orientation ?? '']
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
const FALLBACK_WL_PRESETS: Record<string, WindowLevelPreset[]> = {
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

// The study's display sets NiiVue could load as an overlay of this viewport:
// neither its base nor already overlaid (SEG/RT and slides classify out). Sets
// hung after the base (TMTV's PT) are candidates until layered.
export function overlayCandidates(
  entry: Pick<NiivueViewportEntry, 'displaySets' | 'overlays'>,
  activeDisplaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet[] {
  const loaded = new Set<string>(entry.overlays.keys())
  const base = entry.displaySets[0]?.displaySetInstanceUID
  if (typeof base === 'string') loaded.add(base)
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
export function niivueColormapName(
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

type RampPoint = { value: number; opacity: number }
const RAMP = '_ramp_'

// Piecewise-linear y(x) through sorted xs, held flat beyond either end.
function lerp(xs: number[], ys: number[], x: number): number {
  let i = 1
  while (i < xs.length - 1 && (xs[i] as number) < x) i++
  const x0 = xs[i - 1] as number
  const x1 = xs[i] as number
  const y0 = ys[i - 1] as number
  const y1 = ys[i] as number
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0 || 1)))
  return y0 + t * (y1 - y0)
}

/**
 * `name`'s colours with alpha from an OHIF opacity ramp (value 0..1 across the
 * window), registered as its own colormap. A node at every colour and ramp
 * point, so NiiVue's linear LUT build reproduces both.
 */
export function rampColormap(
  nv: Pick<NiiVue, 'addColormap'>,
  name: string,
  ramp: RampPoint[],
): string {
  const cm = lookupColorMap(name)
  if (!cm) return name
  const xs = ramp.map((p) => p.value * 255)
  const I = [...new Set([...cm.I, ...xs.map(Math.round)])].sort((a, b) => a - b)
  const at = (ys: number[]) => I.map((i) => Math.round(lerp(cm.I, ys, i)))
  const alpha = ramp.map((p) => p.opacity * 255)
  const key = ramp.map((p) => `${p.value}_${p.opacity}`).join('_')
  return nv.addColormap(`${name}${RAMP}${key}`, {
    R: at(cm.R),
    G: at(cm.G),
    B: at(cm.B),
    A: I.map((i) => Math.round(lerp(xs, alpha, i))),
    I,
  })
}

/** The opacity ramp a rampColormap name carries, or undefined. */
function rampOf(colormap?: string): RampPoint[] | undefined {
  const v = colormap?.split(RAMP)[1]?.split('_').map(Number)
  if (!v) return undefined
  const ramp: RampPoint[] = []
  for (let k = 0; k + 1 < v.length; k += 2)
    ramp.push({ value: v[k] as number, opacity: v[k + 1] as number })
  return ramp
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
  // The volumes still belong to the series being replaced.
  if (entry.baseLoading) return
  const isBase =
    uid === undefined || uid === entry.displaySets[0]?.displaySetInstanceUID
  const index = isBase ? 0 : overlayVolumeIndex(entry, uid as string)
  if ((!isBase && index === 0) || !nv.volumes[index]) return
  const picked = niivueColormapName(nv.colormaps, colormap)
  // A ramped overlay keeps its opacity ramp on the new colours.
  const ramp = isBase ? undefined : rampOf(nv.volumes[index]?.colormap)
  const name = picked && ramp ? rampColormap(nv, picked, ramp) : picked
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

/** OHIF's window/level presets (customization first, built-in fallback). */
export function windowLevelPresets(
  servicesManager: OhifExtensionParams['servicesManager'],
): Record<string, WindowLevelPreset[]> {
  const svc = ohifServices(servicesManager)?.customizationService
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

// The NiiVue annotation tool for an annotation (shape.type, or freehand inferred
// from a polygon when there is no shape).

export function cornerstoneWindowingStep(vol: {
  globalMin: number
  globalMax: number
  robustMin: number
  robustMax: number
}): [number, number] | undefined {
  const ratio = (vol.globalMax - vol.globalMin) / 1024
  const perPixel = ratio > 1 ? Math.round(ratio) : ratio
  const robust = vol.robustMax - vol.robustMin
  if (!(perPixel > 0) || !(robust > 0)) return undefined
  return [perPixel / robust, -perPixel / robust]
}

/**
 * Cornerstone's WindowLevel drag on SUV PET: only the upper bound moves (with
 * isWindowingUpperBoundOnly), 5 SUV per pane height, dragging down lowering it.
 * ponytail: gain fixed at load; re-derive on resize if panes resize mid-read.
 */
export function cornerstonePetWindowingStep(
  vol: { robustMin: number; robustMax: number },
  paneHeight: number,
): [number, number] | undefined {
  const robust = vol.robustMax - vol.robustMin
  if (!(robust > 0) || !(paneHeight > 0)) return undefined
  return [0, 5 / paneHeight / robust]
}

/** A hanging protocol's initial window (`displaySetOptions[i].options.voi`). */
export function voiRange(
  displaySetOptions: OhifViewportProps['displaySetOptions'],
  i = 0,
): { calMin: number; calMax: number } | undefined {
  // Cornerstone's mapDisplaySetOptions accepts `item.options || item`.
  const d = displaySetOptions?.[i]
  const options = (d?.options ?? d) as
    | { voi?: { windowWidth?: unknown; windowCenter?: unknown } }
    | undefined
  return windowRange(options?.voi?.windowWidth, options?.voi?.windowCenter)
}

/**
 * The series' own DICOM window (first WindowWidth/WindowCenter), which
 * cornerstone opens with when the hanging protocol sets none. Only a window
 * shared by every instance counts: scanners that store a
 * per-slice auto window (e.g. Siemens MR) would otherwise window the whole
 * volume by one edge slice.
 */
export function dicomWindow(
  ds: OhifDisplaySet | undefined,
  shown?: SliceFrames,
): { calMin: number; calMax: number } | undefined {
  // Only the instances the shown output was made of (a series can convert to
  // several outputs, e.g. orthogonal localizers), in slice order.
  const all = (ds?.instances ?? []) as Array<{
    SOPInstanceUID?: string
    WindowWidth?: unknown
    WindowCenter?: unknown
  }>
  const sops = new Set(shown?.frames.map((f) => f?.SOPInstanceUID))
  sops.delete(undefined)
  const instances = sops.size
    ? all.filter((x) => sops.has(x.SOPInstanceUID))
    : all
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const key = (inst: (typeof all)[number] | undefined) =>
    `${first(inst?.WindowWidth)}/${first(inst?.WindowCenter)}`
  // Every instance: a per-slice window can agree at any sampled few.
  if (!instances.every((x) => key(x) === key(instances[0]))) return undefined
  const range = windowRange(
    first(instances[0]?.WindowWidth),
    first(instances[0]?.WindowCenter),
  )
  // The DICOM window is in the stored units (Bq/ml); the volume may be SUV.
  const f = petSuvFactor(ds)
  return range && f
    ? { calMin: range.calMin * f, calMax: range.calMax * f }
    : range
}

function windowRange(
  windowWidth: unknown,
  windowCenter: unknown,
): { calMin: number; calMax: number } | undefined {
  const width = Number(windowWidth)
  const center = Number(windowCenter)
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
  // Cornerstone's reset also clears rotation, flips and inversion.
  nv.rotation2D = 0
  nv.isFlipped2DHorizontal = false
  nv.isFlipped2DVertical = false
  if (nv.volumes[0]?.isColormapInverted) invertBase(entry)
}

/** Toggle the base volume's inverted grayscale (OHIF's invertViewport). */
export function invertBase(entry: NiivueViewportEntry): void {
  const base = entry.nv.volumes[0]
  if (entry.slideView || !base) return
  entry.nv
    .setVolume(0, { isColormapInverted: !base.isColormapInverted })
    .catch((err: unknown) => console.error('[nv-ohif] invert failed', err))
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
// A rebuilt module would otherwise mirror each row twice.
let stopMirror = () => {}

export function getNiivueCommandsModule({
  servicesManager,
  commandsManager,
  extensionManager,
}: OhifExtensionParams) {
  // NiiVue rows in cornerstone's annotation state, for OHIF's SR export.
  stopMirror()
  stopMirror = mirrorNiivueMeasurements(servicesManager, extensionManager)
  // "Delete all" removes NiiVue rows' annotations, undoably (history.ts).
  installClearHistory(servicesManager, extensionManager)
  const actions = {
    /** Drop the active pane's half-drawn annotation (its context menu's Delete). */
    niivueCancelAnnotation: () => {
      getActiveNiivue(servicesManager)?.cancelAnnotationInProgress()
    },
    /** Switch the view: axial / coronal / sagittal / multiplanar / render. */
    niivueSetSliceType: ({ sliceType }: { sliceType?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      const mapped = sliceType ? NIIVUE_SLICE_TYPES[sliceType] : undefined
      if (!nv || mapped === undefined) return
      nv.sliceType = mapped
    },

    /** Download the visible NiiVue volume or NVSlide canvas as a PNG. */
    // Capture: OHIF's download form (name, type), as cornerstone's.
    niivueSaveBitmap: () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (entry) showCaptureForm(entry, ohifServices(servicesManager))
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
     * Add a series of the study as an overlay on the base (fetch + dcm2niix
     * conversion for DICOM): `displaySetInstanceUID`, else the next loadable
     * one. A load in flight is cancelled first; without a chosen series that
     * is all a call does (the Overlays menu's cancel). `viewportId`
     * (else the active one) and the style options serve hanging protocols.
     */
    niivueAddOverlay: async ({
      displaySetInstanceUID,
      viewportId: targetViewportId,
      colormap = OVERLAY_COLORMAP,
      opacity = OVERLAY_OPACITY,
      calMin,
      calMax,
      colormapType,
      isColormapAlphaKept,
    }: {
      displaySetInstanceUID?: string
      viewportId?: string
      colormap?: string
      opacity?: number
      calMin?: number
      calMax?: number
      colormapType?: number
      isColormapAlphaKept?: boolean
    } = {}) => {
      const entry = targetViewportId
        ? getNiivueEntry(targetViewportId)
        : getActiveNiivueEntry(servicesManager)
      const overlayWindow = {
        ...(calMin === undefined ? {} : { calMin, calMax }),
        ...(colormapType === undefined ? {} : { colormapType }),
        ...(isColormapAlphaKept ? { isColormapAlphaKept } : {}),
      }
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

      const dsService = ohifServices(servicesManager)?.displaySetService
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
      if (entry.overlayAbort) {
        entry.overlayAbort.abort()
        writeStatus(entry, null)
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
          if (i >= 0) await nv.removeVolume(i)
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
            colormap,
            opacity,
            ...overlayWindow,
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
            frameSource: converted.frames,
            colormap,
            opacity,
            ...overlayWindow,
          })
        }
        if (!added || !owns()) return
        entry.overlays.set(uid, added)
        showPaneLabel(entry, servicesManager)
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
        // The overlay volume is installed (or abandoned): release the shared
        // conversion, which nothing can abort once overlayAbort is cleared.
        abort.abort()
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
      viewportId,
    }: {
      displaySetInstanceUID?: string
      viewportId?: string
    } = {}) => {
      const entry = viewportId
        ? getNiivueEntry(viewportId)
        : getActiveNiivueEntry(servicesManager)
      if (!entry) return
      const index = overlayVolumeIndex(entry, displaySetInstanceUID)
      if (index === 0) return
      entry.overlays.delete(displaySetInstanceUID as string)
      showPaneLabel(entry, servicesManager)
      const removed = entry.nv
        .removeVolume(index)
        .catch((err: unknown) =>
          console.error('[nv-ohif] overlay removal failed', err),
        )
      refreshToolbar(servicesManager, entry.viewportId)
      return removed
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
        // recalculateCalMinMax emits no volumeUpdated; setVolume does, so the
        // corner W/L readout follows.
        .then(() => {
          const { calMin, calMax } = entry.nv.volumes[0] ?? {}
          return entry.nv.setVolume(0, { calMin, calMax })
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

    /**
     * Cornerstone's global JUMP_TO_MEASUREMENT handler runs this command without
     * a context, so the newest context answers: NIIVUE, when nv-ohif registers
     * after cornerstone. A NiiVue row is navigated by subscribeOhifLabelSync (a
     * slide row by slideMeasurements); Cornerstone would otherwise re-hang the
     * viewport. Others go to Cornerstone.
     */
    jumpToMeasurementViewport: (options: {
      measurement?: { uid?: string }
    }) => {
      if (takeMeasurementJump(options.measurement?.uid)) return
      ohifCommandsManager(commandsManager)?.runCommand?.(
        'jumpToMeasurementViewport',
        options,
        'CORNERSTONE',
      )
    },

    /**
     * The segmentation panel's segment click. Cornerstone's would look for a
     * cornerstone viewport (none for a NiiVue pane); others go to Cornerstone.
     */
    setActiveSegmentAndCenter: (options: {
      segmentationId: string
      segmentIndex: number
    }) => {
      const viewportId =
        ohifServices(
          servicesManager,
        )?.viewportGridService?.getActiveViewportId?.() ?? undefined
      const { segmentationId, segmentIndex } = options
      if (
        jumpToNiivueSegment(
          servicesManager,
          viewportId,
          segmentationId,
          segmentIndex,
        ) ||
        jumpToContourSegment(
          servicesManager,
          viewportId,
          segmentationId,
          segmentIndex,
        )
      )
        return
      ohifCommandsManager(commandsManager)?.runCommand?.(
        'setActiveSegmentAndCenter',
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
    ...getSegCommandDefinitions({
      servicesManager,
      commandsManager,
      extensionManager,
    }),
    ...getQuantCommandDefinitions({ servicesManager }),
  }

  return {
    actions,
    definitions,
    defaultContext: 'NIIVUE',
  }
}
