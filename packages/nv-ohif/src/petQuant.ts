import type NiiVue from '@niivue/niivue'
import type { NVImage, VectorAnnotation } from '@niivue/niivue'
import { PEN_SHAPE, SLICE_TYPE, slice2DToMM } from '@niivue/niivue'
import { frameScale, showComputed, showFrames } from './frames4D'
import {
  type ComputeOp,
  computeVolume,
  csvCell,
  type Frames,
  timeActivity,
  timePoints,
  timeReportCsv,
  voxelSeries,
} from './kinetics'
import {
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  niivueEntries,
  ohifServices,
} from './niivueRegistry'
import type {
  OhifDisplaySet,
  OhifExtensionParams,
  OhifServicesManager,
} from './ohif-types'
import { drawingOwned, holdOverlayPlanes } from './overlayPlanes'
import {
  boxAround,
  boxMax,
  type CtRange,
  ijkAxes,
  lpsToVoxelOf,
  type RasGrid,
  rasGrid,
  resampleLabel,
  type Sampled,
  type SegmentStats,
  sampled,
  segmentStats,
  slabCorners,
  spacing,
  thresholdBox,
} from './quantify'
import { type ExportSegment, frameLabels } from './segExport'
import { paletteColor } from './segPanel'
import { OHIF_BRUSHES } from './toolBridge'

// OHIF's TMTV (extension-tmtv) and 4D ROI workflow (cornerstone-dynamic-volume)
// on NiiVue panes. Cornerstone keeps labelmaps on the PT grid; so does this:
// one label per PT series (values = segments, each standing for one OHIF
// segmentation), shown as the drawing of every pane holding that series
// (resampled where the base is the CT, as fusion panes) and read back after
// brush strokes.

type Services = OhifServicesManager | undefined
interface Pane {
  entry: NiivueViewportEntry
  /** The PT's volume index in the pane (0: base). */
  index: number
}
interface Pet {
  uid: string
  ds?: OhifDisplaySet
  vol: NVImage
  pane: Pane
}
interface Mask {
  label: Uint8Array
  grid: RasGrid
  /** Segment names by value. */
  names: string[]
  /** Bumped on every label write: panes showing an older revision re-show it. */
  rev: number
}

const masks = new Map<string, Mask>()
const listeners = new Set<() => void>()
let activeSegment = 1
// Panes whose pen paints the active segment (brush, threshold brush).
// ponytail: a pane switched to a SEG tool (segEdit) skips armBrush and stays
// listed until its next PT tool; re-arm there if that pairing ever occurs.
// Weak: a closed pane leaves the registry and must not stay alive here.
const armedPens = new WeakSet<NiiVue>()
const setActiveSegment = (value: number) => {
  activeSegment = value
  for (const { nv } of niivueEntries())
    if (armedPens.has(nv)) nv.drawPenValue = value
  notify()
}
/** RectangleROIStartEndThreshold start/end slice positions (RAS mm). */
const roiSlices: { start?: number[]; end?: number[] } = {}
// Panes whose armed brush is OHIF's threshold brush.
const thresholdPens = new WeakSet<NiiVue>()
// Panes whose drawing a label holds, with the overlay planes' release. Weak:
// an unmounted pane goes with its viewer.
const planeHolds = new WeakMap<NiiVue, () => void>()
// Drawings a label created; one it wrote into (a SEG's) is not its to close.
const ownDrawings = new WeakSet<NVImage>()
let thresholdRange: [number, number] = [2.5, 50]
// Armed panes' pen size (OHIF's brush size), re-read by refreshBrushSizes.
const penSizes = new WeakMap<NiiVue, () => number>()
// cornerstone's RectangleROIStartEndThreshold default depth (numSlicesToPropagate).
const ROI_SLICES = 10

export const onQuantChange = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const notify = () => {
  for (const fn of listeners) fn()
}

/** Drop every PT label and the tool state: a mode exit leaves no study's
 * masks (a full label grid per brushed PT series) behind. */
export function resetQuant(): void {
  // Panes still mounted drop the label and get their planes back; the rest
  // are destroyed.
  for (const { nv } of niivueEntries()) if (planeHolds.has(nv)) dropLabel(nv)
  masks.clear()
  thresholdRange = [2.5, 50]
  roiSlices.start = roiSlices.end = undefined
  lastConfig = DEFAULT_THRESHOLD
  setActiveSegment(1) // notifies
}

const displaySet = (services: Services, uid: string) =>
  (
    ohifServices(services)?.displaySetService as
      | { getDisplaySetByUID?: (uid: string) => OhifDisplaySet | undefined }
      | undefined
  )?.getDisplaySetByUID?.(uid)

const loaded = (v: NVImage | undefined): v is NVImage => !!v?.img && !!v.dimsRAS

/** Panes holding PT series `uid`, as base or overlay. */
function panesOf(uid: string): Pane[] {
  const out: Pane[] = []
  for (const entry of niivueEntries()) {
    const { nv } = entry
    if (entry.displaySets[0]?.displaySetInstanceUID === uid) {
      if (loaded(nv.volumes[0])) out.push({ entry, index: 0 })
      continue
    }
    const hdr = entry.overlays.get(uid)
    const index = hdr ? nv.volumes.findIndex((v) => v.hdr === hdr) : -1
    if (index > 0 && loaded(nv.volumes[index])) out.push({ entry, index })
  }
  return out
}

/** Whether a pane holds a PT series (its ROI/brush tools act on it). */
export const holdsPet = (entry: NiivueViewportEntry, services: Services) =>
  !!paneTarget(entry, services)

/** The PT series a pane holds (base first), if any; `want` filters them. */
function paneTarget(
  entry: NiivueViewportEntry,
  services: Services,
  want: (uid: string) => boolean = () => true,
): Pet | undefined {
  const base = entry.displaySets[0]
  const uid = base?.displaySetInstanceUID
  const vol = entry.nv.volumes[0]
  if (base?.Modality === 'PT' && uid && loaded(vol) && want(uid))
    return { uid, ds: base, vol, pane: { entry, index: 0 } }
  for (const [uid, hdr] of entry.overlays) {
    const ds = displaySet(services, uid)
    const index = entry.nv.volumes.findIndex((v) => v.hdr === hdr)
    const v = entry.nv.volumes[index]
    if (ds?.Modality === 'PT' && index > 0 && loaded(v) && want(uid))
      return { uid, ds, vol: v, pane: { entry, index } }
  }
  return undefined
}

/** The PT series to quantify: the active pane's, else the first shown. */
function findPet(services: Services, viewportId?: string): Pet | undefined {
  const active = getActiveNiivueEntry(services, viewportId)
  for (const e of [...(active ? [active] : []), ...niivueEntries()]) {
    const pet = paneTarget(e, services)
    if (pet) return pet
  }
  return undefined
}

function maskFor(pet: Pet): Mask | undefined {
  const grid = rasGrid(pet.vol)
  if (!grid) return undefined
  const n = grid.dims[0] * grid.dims[1] * grid.dims[2]
  let m = masks.get(pet.uid)
  if (m?.label.length !== n) {
    m = { label: new Uint8Array(n), grid, names: ['', 'Segment 1'], rev: 0 }
    masks.set(pet.uid, m)
  }
  return m
}

const hooked = new WeakSet<NiiVue>()
// The label and drawing each pane last got: a resample onto a CT grid costs
// ~0.5 s, so arming a pen or a pane joining re-shows only panes not current.
const shownIn = new WeakMap<NiiVue, [Mask, number, NVImage]>()

/**
 * Show series `uid`'s label as the drawing of every pane holding it (but
 * `skip`); `stale`: only panes not showing it yet.
 */
function showMask(
  uid: string,
  services: Services,
  skip?: NiiVue,
  stale = false,
): void {
  const m = masks.get(uid)
  if (!m) return
  let empty: boolean | undefined
  for (const { entry } of panesOf(uid)) {
    const { nv } = entry
    const grid = nv.volumes[0] && rasGrid(nv.volumes[0])
    if (nv === skip || !grid) continue
    const shown = shownIn.get(nv)
    if (
      stale &&
      shown?.[0] === m &&
      shown[1] === m.rev &&
      shown[2] === nv.drawingVolume
    )
      continue
    // A SEG or RT loading here wins: a drawing made now would cancel its load.
    if (drawingOwned(nv)) continue
    // A shown 60xx plane is display only: the label replaces it.
    if (!planeHolds.has(nv))
      planeHolds.set(
        nv,
        holdOverlayPlanes(nv, () => dropLabel(nv)),
      )
    // A SEG or RT drawing is not the label's to overwrite: that pane goes without.
    if (nv.drawingVolume && !ownDrawings.has(nv.drawingVolume)) {
      dropLabel(nv)
      continue
    }
    if (!nv.drawingVolume) {
      // createEmptyDrawing arms the pen; the pane's tool decides.
      const armed = nv.drawIsEnabled
      nv.createEmptyDrawing()
      nv.drawIsEnabled = armed
      if (nv.drawingVolume) ownDrawings.add(nv.drawingVolume)
    }
    const img = nv.drawingVolume?.img
    if (!(img instanceof Uint8Array)) continue
    // A new label (first pen armed) is empty: nothing to resample.
    empty ??= m.label.every((x) => x === 0)
    if (empty) img.fill(0)
    else img.set(resampleLabel(m.label, m.grid, grid))
    nv.refreshDrawing()
    shownIn.set(nv, [m, m.rev, nv.drawingVolume as NVImage])
    if (hooked.has(nv)) continue
    hooked.add(nv)
    nv.addEventListener('drawingChanged', (e) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action
      if (action === 'stroke' || action === 'undo') pull(entry, services)
    })
  }
}

/** The pane shows the label's drawing and no SEG/RT is loading over it. */
const labelOwns = (nv: NiiVue) =>
  !!nv.drawingVolume && ownDrawings.has(nv.drawingVolume) && !drawingOwned(nv)

/** A pane's label drawing goes and its overlay planes come back. */
function dropLabel(nv: NiiVue): void {
  const draw = nv.drawingVolume
  if (draw && ownDrawings.has(draw)) {
    // A loading SEG/RT replaces the label; closing it would cancel that load.
    // Keep the hold: its yield drops the label if the SEG is cancelled.
    if (drawingOwned(nv)) return
    nv.closeDrawing()
  }
  planeHolds.get(nv)?.()
  planeHolds.delete(nv)
}

/**
 * Show the label of a pane's PT series once it holds one (a late or re-hung
 * pane); a pane now on another series gives its planes back.
 */
export function showPaneLabel(
  entry: NiivueViewportEntry,
  services: Services,
): void {
  // A labelled PT overlay keeps its label under an unlabelled PT base.
  const pet = paneTarget(entry, services, (uid) => masks.has(uid))
  if (pet) showMask(pet.uid, services, undefined, true)
  else if (planeHolds.has(entry.nv)) dropLabel(entry.nv)
}

/** Read a pane's brushed drawing back into its series' label. */
function pull(entry: NiivueViewportEntry, services: Services): void {
  const pet = paneTarget(entry, services)
  const m = pet && masks.get(pet.uid)
  const img = labelOwns(entry.nv) ? entry.nv.drawingVolume?.img : undefined
  const base = entry.nv.volumes[0] && rasGrid(entry.nv.volumes[0])
  if (!pet || !m || !base || !(img instanceof Uint8Array)) return
  // A pane covering only part of the PT grid leaves the rest of the label.
  const next = resampleLabel(img, base, m.grid, m.label)
  const pt = thresholdPens.has(entry.nv) && sampled(pet.vol)
  if (pt) keepInRange(next, m.label, pt, thresholdRange)
  m.label.set(next)
  m.rev++
  showMask(pet.uid, services, pt ? undefined : entry.nv)
  notify()
}

/** The threshold brush: newly painted voxels outside [lo, hi] keep their old value. */
function keepInRange(
  next: Uint8Array,
  prev: Uint8Array,
  v: Sampled,
  [lo, hi]: [number, number],
): void {
  const [nx, ny] = v.grid.dims
  const [sx, sy, sz] = v.grid.step
  for (let i = 0; i < next.length; i++) {
    if (next[i] === prev[i] || next[i] === 0) continue
    const x = i % nx
    const y = Math.floor(i / nx) % ny
    const z = Math.floor(i / (nx * ny))
    const s =
      (v.data[v.grid.start + x * sx + y * sy + z * sz] as number) * v.slope +
      v.inter
    if (s < lo || s > hi) next[i] = prev[i] as number
  }
}

/**
 * Arm `viewportId`'s pen for OHIF brush `tool` on its PT series' label. False
 * (pen off) for other tools or panes without a PT.
 */
export function armBrush(
  viewportId: string,
  tool: string | undefined,
  services: Services,
  penSize: () => number,
): boolean {
  const mode = tool ? OHIF_BRUSHES[tool] : undefined
  const entry = niivueEntries().find((e) => e.viewportId === viewportId)
  const pet = mode && entry && paneTarget(entry, services)
  if (entry) {
    armedPens.delete(entry.nv)
    thresholdPens.delete(entry.nv)
    penSizes.delete(entry.nv)
  }
  if (!entry || !pet || !maskFor(pet)) return false
  showMask(pet.uid, services, undefined, true)
  const { nv } = entry
  if (!labelOwns(nv)) return false
  nv.drawPenValue = mode === 'erase' ? 0 : activeSegment
  if (mode !== 'erase') armedPens.add(nv)
  nv.drawPenShape = tool?.includes('Sphere')
    ? PEN_SHAPE.SPHERE
    : PEN_SHAPE.CIRCLE
  penSizes.set(nv, penSize)
  nv.drawPenSize = penSize()
  if (mode === 'threshold') thresholdPens.add(nv)
  return true
}

/** Re-read armed panes' pen size (OHIF's brush size changed). */
export function refreshBrushSizes(): void {
  for (const { nv } of niivueEntries()) {
    const size = penSizes.get(nv)
    if (size) nv.drawPenSize = size()
  }
}

// --- RectangleROIStartEndThreshold -------------------------------------------

interface Roi {
  /** Rectangle corners, RAS mm. */
  rect: number[][]
  /** World axis normal to the rectangle (0 x, 1 y, 2 z). */
  axis: number
  start: number
  end: number
}

/** PT voxel edge along world axis `axis` (cornerstone's spacingInNormal). */
function stepAlong(g: RasGrid, axis: number): number {
  let c = 0
  for (let k = 1; k < 3; k++)
    if (
      Math.abs(g.affine[axis * 4 + k] as number) >
      Math.abs(g.affine[axis * 4 + c] as number)
    )
      c = k
  return spacing(g)[c] as number
}

const AXIS_OF: Record<number, number> = {
  [SLICE_TYPE.AXIAL]: 2,
  [SLICE_TYPE.CORONAL]: 1,
  [SLICE_TYPE.SAGITTAL]: 0,
}

/** The latest rectangle drawn on a pane of `pet` (the active pane first). */
function annotationRoi(pet: Pet, grid: RasGrid): Roi | undefined {
  const entries = [pet.pane.entry, ...panesOf(pet.uid).map((p) => p.entry)]
  let a: VectorAnnotation | undefined
  for (const e of entries) {
    a = e.nv.annotations.findLast((x) => x.shape?.type === 'measureRect')
    if (a) break
  }
  const shape = a?.shape
  const axis = a && AXIS_OF[a.sliceType]
  if (!a || !shape || axis === undefined) return undefined
  const { start: s, end: t } = shape
  const rect = [s, { x: t.x, y: s.y }, t, { x: s.x, y: t.y }].map((p) =>
    Array.from(slice2DToMM(p, a.slicePosition, a.sliceType)),
  )
  const start = roiSlices.start?.[axis] ?? (rect[0]?.[axis] as number)
  // cornerstone's default end: 10 slices along its view-plane normal (LPS
  // axial -z, sagittal +x, coronal -y: RAS -z, -x, +y).
  const dir = axis === 1 ? 1 : -1
  const end =
    roiSlices.end?.[axis] ?? start + dir * ROI_SLICES * stepAlong(grid, axis)
  return { rect, axis, start, end }
}

/** A cornerstone-style ROI in LPS: 4 corners and start/end coordinates (number or point). */
export interface LpsRoi {
  points: number[][]
  startCoordinate: number | number[]
  endCoordinate: number | number[]
}

function roiFromLps(r: LpsRoi): Roi {
  const rect = r.points.map(([x = 0, y = 0, z = 0]) => [-x, -y, z])
  let axis = 2
  for (let a = 0; a < 3; a++)
    if (
      rect.every(
        (p) => Math.abs((p[a] as number) - (rect[0]?.[a] as number)) < 1e-3,
      )
    )
      axis = a
  const coord = (c: number | number[]) =>
    (typeof c === 'number' ? c : (c[axis] as number)) * (axis < 2 ? -1 : 1)
  return {
    rect,
    axis,
    start: coord(r.startCoordinate),
    end: coord(r.endCoordinate),
  }
}

export interface ThresholdConfig {
  strategy?: 'roi_stat' | 'range'
  weight?: number
  ptLower?: number
  ptUpper?: number
  ctLower?: number
  ctUpper?: number
}

/** OHIF's RectangleROIOptions defaults. */
export const DEFAULT_THRESHOLD: Required<ThresholdConfig> = {
  strategy: 'roi_stat',
  weight: 0.41,
  ptLower: 2.5,
  ptUpper: 100,
  ctLower: -1024,
  ctUpper: 1024,
}

/** `v` sampled in cornerstone's voxel order, read off its series' orientation. */
// ponytail: classic instances only; enhanced multi-frame (IOP in functional
// groups) falls back to native order, whose rows run against DICOM's.
function cornerstoneSampled(
  v: NVImage,
  ds: OhifDisplaySet | undefined,
): Sampled | undefined {
  const s = sampled(v)
  const iop = ds?.instances?.[0]?.ImageOrientationPatient
  return (
    s && {
      ...s,
      ijk: ijkAxes(s.grid, Array.isArray(iop) ? iop.map(Number) : undefined),
    }
  )
}

/** The CT of the PT's study shown as some pane's base. */
function findCt(pet: Pet): Sampled | undefined {
  for (const e of niivueEntries()) {
    const ds = e.displaySets[0]
    const v = e.nv.volumes[0]
    if (
      ds?.Modality === 'CT' &&
      ds.StudyInstanceUID === pet.ds?.StudyInstanceUID &&
      loaded(v)
    )
      return cornerstoneSampled(v, ds)
  }
  return undefined
}

let lastConfig: ThresholdConfig = DEFAULT_THRESHOLD

/**
 * OHIF's thresholdSegmentationByRectangleROITool: threshold the PT inside the
 * ROI (`roi`, else the latest rectangle drawn) into segment `segmentIndex`.
 */
export function runThreshold(
  services: Services,
  opts: ThresholdConfig & { roi?: LpsRoi; segmentIndex?: number } = {},
) {
  const pet = findPet(services)
  const pt = pet && cornerstoneSampled(pet.vol, pet.ds)
  const m = pet && maskFor(pet)
  if (!pet || !pt || !m) return undefined
  const roi = opts.roi ? roiFromLps(opts.roi) : annotationRoi(pet, pt.grid)
  if (!roi) return undefined
  const c = { ...DEFAULT_THRESHOLD, ...opts }
  const box = boxAround(
    slabCorners(
      roi.rect,
      roi.axis,
      roi.start,
      roi.end,
      stepAlong(pt.grid, roi.axis),
    ),
    pt.grid,
  )
  let ct: CtRange | undefined
  let [lower, upper] = [Number(c.ptLower), Number(c.ptUpper)]
  if (c.strategy === 'range') {
    const ctVol = findCt(pet)
    if (ctVol)
      ct = { ct: ctVol, lower: Number(c.ctLower), upper: Number(c.ctUpper) }
  } else
    [lower, upper] = [
      Number(c.weight) * boxMax(pt, box),
      Number.POSITIVE_INFINITY,
    ]
  const value = opts.segmentIndex ?? activeSegment
  m.names[value] ??= `Segment ${value}`
  const count = thresholdBox(m.label, pt, box, lower, upper, value, ct)
  m.rev++
  // Start/end belong to the rectangle just run, not the next one drawn.
  roiSlices.start = roiSlices.end = undefined
  lastConfig =
    c.strategy === 'range'
      ? {
          strategy: c.strategy,
          ptLower: lower,
          ptUpper: upper,
          ctLower: c.ctLower,
          ctUpper: c.ctUpper,
        }
      : { strategy: c.strategy, weight: c.weight }
  showMask(pet.uid, services)
  notify()
  return { count, lower, upper, box, ...tmtvStats(services) }
}

export type NamedStats = SegmentStats & { value: number; label: string }

/** OHIF's calculateTMTV plus every segment's stats. */
export function tmtvStats(services: Services) {
  const pet = findPet(services)
  const m = pet && masks.get(pet.uid)
  const pt = pet && cornerstoneSampled(pet.vol, pet.ds)
  if (!pet || !m || !pt) return undefined
  const present = new Set(m.label)
  const segments: NamedStats[] = []
  for (let v = 1; v < 256; v++) {
    const s = present.has(v) ? segmentStats(m.label, pt, v) : undefined
    if (s)
      segments.push({ ...s, value: v, label: m.names[v] ?? `Segment ${v}` })
  }
  // cornerstone's computeMetabolicStats merges segment 1 of every segmentation
  // (here: every segment): TMTV in mL, TLG = mL x mean.
  const tmtv = segments.reduce((t, s) => t + s.volume * 1e-3, 0)
  const tlg = segments.reduce((t, s) => t + s.volume * 1e-3 * s.mean, 0)
  return { tmtv, tlg, segments }
}

/** The PT label's segments on the PT series' own frames, for SEG / RTSS export. */
export function tmtvExport(services: Services) {
  const pet = findPet(services)
  const m = pet && masks.get(pet.uid)
  const lps2vox = m && lpsToVoxelOf(m.grid.affine)
  const instances = pet?.ds?.instances
  if (!m || !lps2vox || !instances) return undefined
  const segments: ExportSegment[] = [...new Set(m.label)]
    .filter((v) => v > 0)
    .sort((p, q) => p - q)
    .map((value) => {
      const [r = 0, g = 0, b = 0] = paletteColor(value)
      return {
        value,
        label: m.names[value] ?? `Segment ${value}`,
        rgb: [r, g, b],
      }
    })
  const frames = frameLabels({
    bitmap: m.label,
    dims: m.grid.dims,
    lps2vox,
    instances,
  })
  return { frames, segments }
}

/** Save `text` as a CSV file. */
export function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** OHIF's createAndDownloadTMTVReport layout. */
export function tmtvCsv(
  study: Record<string, unknown>,
  stats: { tmtv: number; tlg: number; segments: NamedStats[] },
  config: ThresholdConfig,
): string {
  const head = [
    'id',
    'label',
    'count',
    'volume',
    'mean',
    'max',
    'min',
    'peakValue',
    'lesionGlycolysis',
    'PatientID',
    'PatientName',
    'StudyInstanceUID',
    'SeriesInstanceUID',
    'StudyDate',
  ]
  const csv = [head.join(',')]
  for (const s of stats.segments)
    csv.push(
      [
        s.value,
        s.label,
        s.count,
        s.volume,
        s.mean,
        s.max,
        s.min,
        s.peak,
        s.lesionGlycolysis,
        study.PatientID ?? '000000',
        study.PatientName,
        study.StudyInstanceUID,
        study.SeriesInstanceUID,
        study.StudyDate,
      ]
        .map(csvCell)
        .join(','),
    )
  csv.push(
    '',
    '',
    '',
    `Patient ID,${csvCell(study.PatientID)}`,
    `Study Date,${csvCell(study.StudyDate)}`,
    '',
  )
  csv.push(`Total Metabolic Tumor Volume,tmtv,${stats.tmtv}`)
  // The panel's total (mL x SUV), not the per-segment mm³ x SUV sum.
  csv.push(`Total Lesion Glycolysis,tlg,${stats.tlg.toFixed(4)}`)
  csv.push(
    ['Threshold Configuration', ...Object.entries(config).flat()].join(','),
  )
  return csv.join('\n')
}

const firstInstance = (pet: Pet) =>
  (pet.ds?.instances?.[0] ?? {}) as Record<string, unknown>

// --- 4D -----------------------------------------------------------------------

function pet4D(services: Services) {
  const pet = findPet(services)
  const source = pet?.vol.frameSource
  if (!pet || !source) return undefined
  const signal = new AbortController().signal
  const frames: Frames = {
    count: source.count,
    load: (f) => source.load(f, signal),
  }
  const [slope, inter] = frameScale(source.group, pet.vol)
  return { pet, group: source.group, frames, slope, inter }
}

/** Native-order `data` in RAS order. */
function toRas(data: ArrayLike<number>, g: RasGrid): Float32Array {
  const [nx, ny, nz] = g.dims
  const [sx, sy, sz] = g.step
  const out = new Float32Array(nx * ny * nz)
  let i = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        out[i++] = data[g.start + x * sx + y * sy + z * sz] as number
  return out
}

async function curves(services: Services) {
  const d = pet4D(services)
  const m = d && masks.get(d.pet.uid)
  if (!d || !m) return undefined
  const list = await timeActivity(m.label, m.grid, d.frames, d.slope, d.inter)
  const named = list.map((c) => ({
    ...c,
    label: m.names[c.value] ?? `Segment ${c.value}`,
  }))
  return { d, curves: named, time: timePoints(d.pet.ds?.instances ?? []) }
}

export const quantState = (services: Services) => {
  const pet = findPet(services)
  const m = pet && masks.get(pet.uid)
  return {
    pet,
    names: m?.names ?? ['', 'Segment 1'],
    activeSegment,
    roiSlices,
    thresholdRange,
    config: lastConfig,
  }
}

/** The NIIVUE commands behind the TMTV and 4D ROI panels (and the e2e parity scripts). */
export function getQuantCommandDefinitions({
  servicesManager: services,
}: OhifExtensionParams) {
  const actions = {
    /** Threshold the ROI into the active segment (OHIF's Run). */
    niivueROIThreshold: (opts: Parameters<typeof runThreshold>[1]) =>
      runThreshold(services, opts),
    /** Set the ROI's start or end slice at the active pane's crosshair. */
    niivueSetROIThresholdSlice: ({ which }: { which: 'start' | 'end' }) => {
      const mm = getActiveNiivueEntry(services)?.crosshairMM
      if (mm) roiSlices[which] = [...mm]
      notify()
    },
    niivueTMTVStats: () => tmtvStats(services),
    niivueExportTMTVCSV: ({ filename }: { filename?: string } = {}) => {
      const pet = findPet(services)
      const stats = tmtvStats(services)
      if (!pet || !stats) return
      const study = firstInstance(pet)
      download(
        tmtvCsv(study, stats, lastConfig),
        filename ?? `${study.PatientID}_tmtv.csv`,
      )
    },
    /** The PT-grid label (RAS order) with its RAS voxel -> mm affine. */
    niivueGetLabelmap: () => {
      const pet = findPet(services)
      const m = pet && masks.get(pet.uid)
      // The caller may write the label: panes re-show it on the next arm.
      if (m) m.rev++
      return m && { label: m.label, dims: m.grid.dims, affine: m.grid.affine }
    },
    niivueAddSegment: ({ label }: { label?: string } = {}) => {
      const pet = findPet(services)
      const m = pet && maskFor(pet)
      if (!m) return undefined
      const value = m.names.length
      m.names.push(label ?? `Segment ${value}`)
      setActiveSegment(value)
      return value
    },
    niivueSetActiveSegment: ({ segmentIndex }: { segmentIndex: number }) =>
      setActiveSegment(segmentIndex),
    niivueSetThresholdRange: ({ range }: { range: [number, number] }) => {
      thresholdRange = range
      notify()
    },
    /** SUM / AVERAGE / SUBTRACT over 1-based frames start..end; shown unless show: false. */
    niivueComputeVolume: async ({
      operation,
      start,
      end,
      show = true,
    }: {
      operation: ComputeOp
      start: number
      end: number
      show?: boolean
    }) => {
      const d = pet4D(services)
      const grid = d && rasGrid(d.pet.vol)
      if (!d || !grid) return undefined
      const data = await computeVolume(
        operation,
        d.frames,
        start,
        end,
        d.slope,
        d.inter,
      )
      if (show) await showComputed(d.group, data)
      notify()
      return { data: toRas(data, grid), dims: grid.dims, affine: grid.affine }
    },
    /** Back to the 4D frames (the panel's 4D toggle). */
    niivueShowFrames: async () => {
      const d = pet4D(services)
      if (d) await showFrames(d.group)
      notify()
    },
    niivueTimeActivity: async () => {
      const r = await curves(services)
      return (
        r && {
          timePoints: r.time.points,
          unit: r.time.unit,
          curves: r.curves.map(
            ({ value, label, count, mean, std, min, max }) => ({
              value,
              label,
              count,
              mean,
              std,
              min,
              max,
            }),
          ),
        }
      )
    },
    niivueExportTimeReportCSV: async ({
      summaryStats = false,
      filename,
    }: {
      summaryStats?: boolean
      filename?: string
    } = {}) => {
      const r = await curves(services)
      if (!r) return
      const values = summaryStats
        ? undefined
        : await voxelSeries(r.d.frames, r.d.slope, r.d.inter)
      const study = firstInstance(r.d.pet)
      download(
        timeReportCsv(study, r.curves, summaryStats, r.d.frames.count, values),
        filename ?? `${study.PatientID}.csv`,
      )
    },
  }
  return Object.fromEntries(
    Object.entries(actions).map(([name, commandFn]) => [name, { commandFn }]),
  )
}
