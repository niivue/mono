// OHIF contour segmentation on NiiVue panes. A contour segmentation is a
// cornerstone segmentation with a Contour representation (for OHIF's contour
// panel and its buttons); its geometry is NiiVue vector annotations, one group
// per segmentation (`seg:<id>`), labelled by segment index. Same-segment
// shapes merge and other segments' are cut, within the group only
// (annotationMergedGroups); measurements stay in the default group.
import {
  type AnnotationStyle,
  type AnnotationTool,
  forEachAnnotationVoxel,
  type NiiVue,
  type VectorAnnotation,
} from '@niivue/niivue'
import { startSculpt } from './contourSculpt'
import { historyMemo } from './history'
import type { NiivueViewportEntry } from './niivueRegistry'
import { niivueEntries, ohifServices } from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'
import { invertAffine, rasGrid, voxelMM3 } from './quantify'
import { closedPlanar, type RtRoi } from './segExport'
import {
  addRepresentation,
  type CstSegmentation,
  cornerstoneSegmentation,
  paletteColor,
  type SegmentationServiceLike,
  segmentStats,
} from './segPanel'

const CONTOUR = 'Contour'
const GROUP_PREFIX = 'seg:'

/** OHIF's contour segmentation tools -> the core tool each draws with. */
export const CONTOUR_TOOLS: Record<string, AnnotationTool> = {
  PlanarFreehandContourSegmentationTool: 'freehand',
  LivewireContourSegmentationTool: 'livewire',
  // ponytail: core's spline is Catmull-Rom; linear and B-spline draw as it.
  CatmullRomSplineROI: 'spline',
  LinearSplineROI: 'spline',
  BSplineROI: 'spline',
}

const SCULPTOR = 'SculptorTool'

/** Every OHIF contour tool a NiiVue pane takes. */
export const CONTOUR_TOOL_NAMES = [...Object.keys(CONTOUR_TOOLS), SCULPTOR]

export const contourGroup = (segmentationId: string): string =>
  `${GROUP_PREFIX}${segmentationId}`

/** A contour segment's shape, not a measurement (the measurement bridge skips it). */
export const isContourAnnotation = (
  a: Pick<VectorAnnotation, 'group'>,
): boolean => a.group.startsWith(GROUP_PREFIX)

type Row = {
  color: number[]
  visible: boolean
  locked: boolean
  label: string
}
type Service = SegmentationServiceLike & {
  getActiveSegmentation?(
    viewportId: string,
  ): { segmentationId: string } | undefined
  getActiveSegment?(viewportId: string): { segmentIndex: number } | undefined
}
interface ContourSegmentation {
  viewportId: string
  nv: NiiVue
  rows: Map<number, Row>
  fillAlpha: number
  outlineWidth: number
  /** The panel's Delete Segment: one undo step, shapes included. */
  deleteSegment(index: number): void
  /** `park`: the pane goes but the segmentation stays (see adoptContours). */
  stop(park?: boolean): void
}

const contours = new Map<string, ContourSegmentation>()

/**
 * Contour segmentations whose pane went (a layout change, a series swap): their
 * shapes wait for the next NiiVue pane showing the same series.
 */
const parked = new Map<
  string,
  { source: string; shapes: VectorAnnotation[]; lutIndex: number }
>()

const ofAnnotation = (a: Pick<VectorAnnotation, 'group'>) =>
  isContourAnnotation(a)
    ? contours.get(a.group.slice(GROUP_PREFIX.length))
    : undefined

// A Shift stroke cuts a hole in this segment only (see holeStroke).
let cutting: { group: string; label: number } | undefined
const HOLE = -1

/** False for a hidden or locked segment's shape: no grab, select, erase or cut. */
export function isContourEditable(
  a: Pick<VectorAnnotation, 'group' | 'label'>,
): boolean {
  if (cutting) return a.group === cutting.group && a.label === cutting.label
  const c = ofAnnotation(a)
  // A segment shape with no live segmentation (undone past its deletion) is inert.
  if (!c) return !isContourAnnotation(a)
  // Only a contour tool edits contours: a Length press inside a segment does not grab it.
  const row = c.rows.get(a.label)
  return armed.has(c.viewportId) && !!row && row.visible && !row.locked
}

/** False for a hidden segment's shape (the overlay does not draw it). */
export function isContourShown(
  a: Pick<VectorAnnotation, 'group' | 'label'>,
): boolean {
  const c = ofAnnotation(a)
  if (!c) return !isContourAnnotation(a)
  return c.rows.get(a.label)?.visible !== false
}

const toStyle = (
  row: Row,
  c: Pick<ContourSegmentation, 'fillAlpha' | 'outlineWidth'>,
): AnnotationStyle => {
  const [r = 0, g = 0, b = 0] = row.color.map((v) => v / 255)
  return {
    strokeColor: [r, g, b, 1],
    // Core fills under the overlay, which hides a hidden segment's stroke only.
    fillColor: [r, g, b, row.visible ? c.fillAlpha : 0],
    strokeWidth: c.outlineWidth,
  }
}

/**
 * OHIF's createContourForViewport on a NiiVue pane: a new contour
 * segmentation with one segment, active on the pane. It lives as long as the
 * pane's base volume.
 */
export function createContourSegmentation(
  entry: NiivueViewportEntry,
  { servicesManager, extensionManager }: OhifExtensionParams,
): string | undefined {
  const cst = cornerstoneSegmentation(extensionManager)
  const service = ohifServices(servicesManager)?.segmentationService as
    | Service
    | undefined
  if (!cst || !service) return undefined
  const { viewportId } = entry
  const segmentationId = crypto.randomUUID()
  const count =
    (service as { getSegmentations?(): unknown[] }).getSegmentations?.()
      .length ?? 0
  cst.addSegmentations([
    {
      segmentationId,
      representation: {
        type: CONTOUR,
        data: { geometryIds: [], imageIds: [] },
      },
      config: {
        label: `Segmentation ${count + 1}`,
        segments: {
          1: {
            segmentIndex: 1,
            label: 'Segment 1',
            locked: false,
            active: true,
          },
        },
      },
    },
  ])
  // OHIF offers Save only for a segmentation with no contour data it can read
  // (or with some): NiiVue keeps the shapes, so the save commands read them.
  const added = cst.state.getSegmentation(segmentationId) as
    | { representationData?: Record<string, unknown> }
    | undefined
  if (added?.representationData) delete added.representationData[CONTOUR]
  const lut = [
    [0, 0, 0, 0],
    ...Array.from({ length: 255 }, (_, i) => paletteColor(i + 1)),
  ]
  let freeIndex = 0
  while (cst.state.getColorLUT(freeIndex)) freeIndex++
  const lutIndex = cst.config.color.addColorLUT(lut, freeIndex)
  addRepresentation(cst, viewportId, segmentationId, lutIndex, CONTOUR)
  attach(entry, segmentationId, cst, service, lutIndex, extensionManager)
  service.setActiveSegmentation(viewportId, segmentationId)
  service.setActiveSegment(segmentationId, 1)
  return segmentationId
}

/** A contour segmentation on a pane: merge group, panel sync, registry. */
function attach(
  { nv, viewportId, displaySets }: NiivueViewportEntry,
  segmentationId: string,
  cst: CstSegmentation,
  service: Service,
  lutIndex: number,
  extensionManager: OhifExtensionParams['extensionManager'],
): void {
  const group = contourGroup(segmentationId)
  nv.annotationMergedGroups = [...(nv.annotationMergedGroups ?? []), group]
  contours.set(
    segmentationId,
    startContourSync(
      nv,
      viewportId,
      displaySets[0]?.displaySetInstanceUID ?? '',
      segmentationId,
      cst,
      service,
      lutIndex,
      extensionManager,
    ),
  )
}

/**
 * A new NiiVue pane showing a parked segmentation's series takes its shapes
 * back. In a multi-pane layout, the pane in the shapes' orientation does.
 */
export function adoptContours(
  entry: NiivueViewportEntry,
  {
    servicesManager,
    extensionManager,
  }: Pick<OhifExtensionParams, 'servicesManager' | 'extensionManager'>,
): void {
  const source = entry.displaySets[0]?.displaySetInstanceUID
  if (!source || parked.size === 0) return
  const cst = cornerstoneSegmentation(extensionManager)
  const service = ohifServices(servicesManager)?.segmentationService as
    | Service
    | undefined
  if (!cst || !service) return
  for (const [id, p] of [...parked]) {
    if (p.source !== source) continue
    if (!cst.state.getSegmentation(id)) {
      parked.delete(id)
      continue
    }
    const tally = new Map<number, number>()
    for (const a of p.shapes)
      tally.set(a.sliceType, (tally.get(a.sliceType) ?? 0) + 1)
    const want = [...tally].sort((x, y) => y[1] - x[1])[0]?.[0]
    const better = niivueEntries().some(
      (e) =>
        e !== entry &&
        e.displaySets[0]?.displaySetInstanceUID === source &&
        e.nv.sliceType === want,
    )
    if (entry.nv.sliceType !== want && better) continue
    parked.delete(id)
    entry.nv.replaceAnnotations([], p.shapes, false)
    addRepresentation(cst, entry.viewportId, id, p.lutIndex, CONTOUR)
    attach(entry, id, cst, service, p.lutIndex, extensionManager)
  }
}

/**
 * A series swap in a reused pane: its contour segmentations park (shapes
 * kept) before the pane clears its annotations; adoptContours brings them
 * back when that series is shown again.
 */
export function parkContours(viewportId: string): void {
  for (const c of [...contours.values()])
    if (c.viewportId === viewportId) c.stop(true)
}

/** A pane's teardown: its Sculptor listeners and armed tool state go with it. */
export function releaseContourTools(viewportId: string): void {
  sculpting.get(viewportId)?.()
  sculpting.delete(viewportId)
  armed.delete(viewportId)
  measurementStyle.delete(viewportId)
}

function startContourSync(
  nv: NiiVue,
  viewportId: string,
  source: string,
  segmentationId: string,
  cst: CstSegmentation,
  service: Service,
  lutIndex: number,
  extensionManager: OhifExtensionParams['extensionManager'],
): ContourSegmentation {
  const group = contourGroup(segmentationId)
  const specifier = { segmentationId, type: CONTOUR }
  const c: ContourSegmentation = {
    viewportId,
    nv,
    rows: new Map(),
    fillAlpha: 0.5,
    outlineWidth: 2,
    stop: () => {},
    // Not cornerstone's removeSegment: it needs the contour data this entry
    // omits so OHIF offers Save.
    deleteSegment: (index) => {
      const segment = cst.state.getSegmentation(segmentationId)?.segments[index]
      if (!segment) return
      const shapes = nv.annotations.filter(
        (a) => a.group === group && a.label === index,
      )
      const apply = (undo = false) => {
        const segments = cst.state.getSegmentation(segmentationId)?.segments
        if (!segments || !contours.has(segmentationId)) return
        if (undo) {
          // Not active: the panel may have activated another meanwhile.
          segments[index] = { ...segment, active: false }
          for (const a of shapes) nv.addAnnotation(a)
        } else {
          for (const a of shapes) nv.removeAnnotation(a.id)
          delete segments[index]
        }
        cst.triggerSegmentationEvents.triggerSegmentationModified(
          segmentationId,
        )
      }
      apply(false)
      historyMemo(extensionManager)?.push({
        id: crypto.randomUUID(),
        restoreMemo: apply,
      })
    },
  }
  const sync = () => {
    const segmentation = cst.state.getSegmentation(segmentationId)
    const rep = cst.state.getSegmentationRepresentation(viewportId, specifier)
    const before = c.rows
    c.rows = new Map()
    // Deleted: its shapes go, as cornerstone's, and so does this sync.
    if (!segmentation) {
      parked.delete(segmentationId)
      nv.removeAnnotations(
        nv.annotations.filter((a) => a.group === group).map((a) => a.id),
      )
      c.stop()
      return
    }
    // Removed from the pane (rep gone): kept, hidden.
    for (const [key, s] of Object.entries(segmentation.segments)) {
      const index = Number(key)
      c.rows.set(index, {
        color:
          cst.config.color.getSegmentIndexColor(
            viewportId,
            segmentationId,
            index,
          ) ?? paletteColor(index),
        visible:
          !!rep &&
          rep.visible !== false &&
          rep.segments?.[index]?.visible !== false,
        locked: s.locked === true,
        label: s.label ?? key,
      })
    }
    const style = cst.config.style.getStyle({ viewportId, ...specifier })
    c.fillAlpha = style.renderFill === false ? 0 : (style.fillAlpha ?? 0.5)
    c.outlineWidth =
      style.renderOutline === false ? 0 : (style.outlineWidth ?? 2)
    // A deleted segment's (or segmentation's) shapes go, as cornerstone's.
    for (const a of [...nv.annotations])
      if (a.group === group && before.has(a.label) && !c.rows.has(a.label))
        nv.removeAnnotation(a.id)
    for (const a of nv.annotations) {
      const row = a.group === group && c.rows.get(a.label)
      if (row) a.style = toStyle(row, c)
    }
    rearm(viewportId)
    nv.drawScene()
  }
  const { EVENTS } = service
  const subscriptions = [
    EVENTS.SEGMENTATION_MODIFIED,
    EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
    EVENTS.SEGMENTATION_STYLE_MODIFIED,
    EVENTS.SEGMENTATION_REMOVED,
    EVENTS.SEGMENTATION_REPRESENTATION_REMOVED,
  ]
    .filter((event): event is string => !!event)
    .map((event) =>
      service.subscribe(event, (e) => {
        if (!e?.segmentationId || e.segmentationId === segmentationId) sync()
      }),
    )
  // The shapes belong to the base volume's grid: when the pane drops it (or
  // goes) they park until a pane shows that series again.
  const base = nv.volumes[0]
  const onRemoved = (e: Event) => {
    if ((e as CustomEvent<{ volume: unknown }>).detail?.volume !== base) return
    c.stop(true)
    nv.removeAnnotations(
      nv.annotations.filter((a) => a.group === group).map((a) => a.id),
    )
  }
  const onDestroyed = () => {
    if (nv.isDestroyed) c.stop(true)
  }
  // Edits refresh the panel's statistics (voxels whose centres a shape covers).
  const grid = base && rasGrid(base)
  const voxel = grid ? voxelMM3(grid) : 1
  let counted = ''
  const onEdit = () => {
    const segmentation = cst.state.getSegmentation(segmentationId)
    if (!segmentation) return
    const counts = segmentVoxels(nv, group)
    const key = JSON.stringify([...counts])
    if (key === counted) return
    counted = key
    for (const [k, seg] of Object.entries(segmentation.segments))
      seg.cachedStats = {
        ...seg.cachedStats,
        ...segmentStats(counts.get(Number(k)) ?? 0, voxel),
      }
    cst.triggerSegmentationEvents.triggerSegmentationModified(segmentationId)
  }
  const edits = ['annotationAdded', 'annotationRemoved', 'annotationChanged']
  for (const e of edits) nv.addEventListener(e, onEdit)
  nv.addEventListener('volumeRemoved', onRemoved)
  nv.addEventListener('viewDestroyed', onDestroyed)
  c.stop = (park = false) => {
    if (!contours.has(segmentationId)) return
    if (park && source && cst.state.getSegmentation(segmentationId))
      parked.set(segmentationId, {
        source,
        shapes: nv.annotations.filter((a) => a.group === group),
        lutIndex,
      })
    for (const s of subscriptions) s.unsubscribe()
    for (const e of edits) nv.removeEventListener(e, onEdit)
    nv.removeEventListener('volumeRemoved', onRemoved)
    nv.removeEventListener('viewDestroyed', onDestroyed)
    contours.delete(segmentationId)
    nv.annotationMergedGroups = (nv.annotationMergedGroups ?? []).filter(
      (g) => g !== group,
    )
    cst.removeSegmentationRepresentations(viewportId, { segmentationId })
    if (!parked.has(segmentationId)) cst.state.removeColorLUT(lutIndex)
  }
  sync()
  return c
}

/**
 * The contour panel's segment click on a NiiVue pane: activate it and move the
 * crosshair to its first shape. False when the pane does not hold it.
 */
export function jumpToContourSegment(
  servicesManager: OhifExtensionParams['servicesManager'],
  viewportId: string | undefined,
  segmentationId: string,
  segmentIndex: number,
): boolean {
  const c = contours.get(segmentationId)
  if (!c || c.viewportId !== viewportId) return false
  const service = ohifServices(servicesManager)?.segmentationService as
    | Service
    | undefined
  service?.setActiveSegmentation(viewportId, segmentationId)
  service?.setActiveSegment(segmentationId, segmentIndex)
  const group = contourGroup(segmentationId)
  const at = c.nv.annotations.find(
    (a) => a.group === group && a.label === segmentIndex,
  )?.anchorMM
  if (at) c.nv.setCrosshairPos(at)
  return true
}

// The measurement style a contour tool replaces while it is armed, per pane.
const measurementStyle = new Map<string, AnnotationStyle>()
const armed = new Map<string, { tool: string; services: Service }>()

/** Back to measurement drawing (default group, the measurement style). */
function disarm(nv: NiiVue, viewportId: string): void {
  armed.delete(viewportId)
  nv.annotationActiveGroup = 'default'
  nv.annotationActiveLabel = 1
  const style = measurementStyle.get(viewportId)
  if (style) nv.annotationStyle = style
  measurementStyle.delete(viewportId)
}

/**
 * Arm a contour tool on a NiiVue pane: it draws the active segment of the
 * pane's active contour segmentation, in its colour. Not a contour tool:
 * false (restoring measurement drawing if one was armed). A contour tool with
 * no drawable segment (none, hidden or locked): true, with drawing off.
 */
export function applyContourTool(
  nv: NiiVue,
  viewportId: string,
  tool: string | undefined,
  servicesManager: OhifExtensionParams['servicesManager'],
): boolean {
  if (tool !== SCULPTOR) {
    sculpting.get(viewportId)?.()
    sculpting.delete(viewportId)
  }
  const services = ohifServices(servicesManager)?.segmentationService as
    | Service
    | undefined
  if (tool === SCULPTOR) {
    armed.set(viewportId, { tool, services: services as Service })
    nv.annotationIsEnabled = false
    nv.drawIsEnabled = false
    if (!sculpting.has(viewportId))
      sculpting.set(
        viewportId,
        startSculpt(nv, () =>
          drawableSegment(viewportId, armed.get(viewportId)?.services),
        ),
      )
    return true
  }
  const core = tool ? CONTOUR_TOOLS[tool] : undefined
  if (!core) {
    if (armed.has(viewportId)) disarm(nv, viewportId)
    return false
  }
  if (!measurementStyle.has(viewportId))
    measurementStyle.set(viewportId, nv.annotationStyle)
  armed.set(viewportId, {
    tool: tool as string,
    services: services as Service,
  })
  nv.drawIsEnabled = false
  const target = drawableSegment(viewportId, services)
  if (!target) {
    nv.annotationIsEnabled = false
    return true
  }
  const { segmentationId, label: index, row, c } = target
  nv.annotationTool = core
  // A closed freehand path is a filled contour (core's polygon mode).
  if (core === 'freehand') {
    nv.annotationBrushRadius = 1
    holeStroke(nv, viewportId)
  }
  nv.annotationActiveGroup = contourGroup(segmentationId)
  nv.annotationActiveLabel = index
  nv.annotationStyle = toStyle(row, c)
  nv.annotationIsEnabled = true
  return true
}

const sculpting = new Map<string, () => void>()

/** The pane's active contour segment, if shown and unlocked. */
function drawableSegment(viewportId: string, services: Service | undefined) {
  const segmentationId =
    services?.getActiveSegmentation?.(viewportId)?.segmentationId
  const c = segmentationId ? contours.get(segmentationId) : undefined
  const label = services?.getActiveSegment?.(viewportId)?.segmentIndex
  const row = label !== undefined ? c?.rows.get(label) : undefined
  return c &&
    row &&
    segmentationId &&
    label !== undefined &&
    row.visible &&
    !row.locked
    ? { segmentationId, group: contourGroup(segmentationId), label, row, c }
    : undefined
}

// The active segment or its colour changed: an armed tool follows it.
function rearm(viewportId: string): void {
  const a = armed.get(viewportId)
  const c = [...contours.values()].find((x) => x.viewportId === viewportId)
  if (!a || !c) return
  const { tool } = a
  armed.delete(viewportId)
  applyContourTool(c.nv, viewportId, tool, {
    services: { segmentationService: a.services },
  } as never)
}

/** The overlay's shapes minus hidden contour segments'. */
export function visibleContourShapes<T extends { id: string }>(
  nv: NiiVue,
  shapes: readonly T[],
): readonly T[] {
  if (contours.size === 0) return shapes
  const hidden = new Set(
    nv.annotations.filter((a) => !isContourShown(a)).map((a) => a.id),
  )
  return hidden.size ? shapes.filter((s) => !hidden.has(s.id)) : shapes
}

const withHoles = new WeakSet<NiiVue>()

/**
 * OHIF's Shift+drag freehand: a hole in the active segment. The stroke draws
 * with a label no segment has, so the store cuts it from the active segment
 * (the only shape editable meanwhile) and the stroke itself is then dropped;
 * the store's undo snapshot predates it, so one undo restores the segment.
 */
function holeStroke(nv: NiiVue, viewportId: string): void {
  if (withHoles.has(nv) || !nv.canvas) return
  withHoles.add(nv)
  const end = () => {
    if (!cutting) return
    cutting = undefined
    nv.annotationActiveLabel = drawnLabel
  }
  let drawnLabel = 1
  nv.canvas.addEventListener(
    'pointerdown',
    (e) => {
      const tool = armed.get(viewportId)?.tool
      if (!e.shiftKey || !tool || CONTOUR_TOOLS[tool] !== 'freehand') return
      if (!nv.annotationIsEnabled) return
      drawnLabel = nv.annotationActiveLabel
      cutting = { group: nv.annotationActiveGroup, label: drawnLabel }
      nv.annotationActiveLabel = HOLE
      // Core keeps Shift presses for the context menu: press without it.
      e.stopImmediatePropagation()
      nv.canvas?.dispatchEvent(
        new PointerEvent('pointerdown', { ...pointerInit(e), shiftKey: false }),
      )
    },
    { capture: true },
  )
  nv.addEventListener('annotationAdded', (e) => {
    const added = (e as CustomEvent<{ annotation: VectorAnnotation }>).detail
      ?.annotation
    if (!cutting || added?.label !== HOLE) return
    nv.removeAnnotation(added.id)
    end()
  })
  // A stroke too short to commit adds nothing.
  for (const type of ['pointerup', 'pointercancel'])
    nv.canvas.addEventListener(type, () => setTimeout(end))
}

const pointerInit = (e: PointerEvent): PointerEventInit => ({
  bubbles: true,
  cancelable: true,
  clientX: e.clientX,
  clientY: e.clientY,
  screenX: e.screenX,
  screenY: e.screenY,
  button: e.button,
  buttons: e.buttons,
  pointerId: e.pointerId,
  pointerType: e.pointerType,
  isPrimary: e.isPrimary,
  detail: e.detail,
})

const SLICE_DEPTH = [2, 1, 0] // axial, coronal, sagittal: the RAS axis across
const IN_PLANE = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const

/** Voxels inside each shape, by its polygons' identity (an edit replaces them). */
const voxelCounts = new WeakMap<object, number>()
// A segment of several shapes: its count, by the shapes' polygons.
const unionCounts = new WeakMap<object, { polygons: object[]; n: number }>()

function shapeVoxels(
  a: VectorAnnotation,
  base: NiiVue['volumes'][number],
): number {
  const known = voxelCounts.get(a.polygons)
  if (known !== undefined) return known
  let n = 0
  forEachAnnotationVoxel(a, base, () => n++)
  voxelCounts.set(a.polygons, n)
  return n
}

/**
 * Each segment's voxel count, for the panel's statistics: a voxel two of its
 * shapes cover (crossing planes, a sculpted push into a neighbour) counts once,
 * as in the SEG.
 */
function segmentVoxels(nv: NiiVue, group: string): Map<number, number> {
  const counts = new Map<number, number>()
  const base = nv.volumes[0]
  const grid = base && rasGrid(base)
  if (!base || !grid) return counts
  const bySegment = new Map<number, VectorAnnotation[]>()
  for (const a of nv.annotations)
    if (a.group === group)
      bySegment.set(a.label, [...(bySegment.get(a.label) ?? []), a])
  const [nx, ny] = grid.dims
  for (const [label, shapes] of bySegment) {
    const [first] = shapes
    if (shapes.length === 1 && first) {
      counts.set(label, shapeVoxels(first, base))
      continue
    }
    const polygons = shapes.map((a) => a.polygons)
    const cached = first && unionCounts.get(first.polygons)
    if (
      cached &&
      cached.polygons.length === polygons.length &&
      cached.polygons.every((p, i) => p === polygons[i])
    ) {
      counts.set(label, cached.n)
      continue
    }
    const seen = new Set<number>()
    for (const a of shapes)
      forEachAnnotationVoxel(a, base, ([x, y, z]) =>
        seen.add(x + nx * (y + ny * z)),
      )
    if (first) unionCounts.set(first.polygons, { polygons, n: seen.size })
    counts.set(label, seen.size)
  }
  return counts
}

/**
 * A contour segmentation as a labelmap on the base volume's RAS grid
 * (x + nx * (y + ny * z)), each voxel whose centre a segment's shape covers.
 */
export function contourBitmap(
  nv: NiiVue,
  segmentationId: string,
  /** Only this segment (segments may overlap after Duplicate or Combine). */
  only?: number,
): Uint8Array | undefined {
  const base = nv.volumes[0]
  const grid = base && rasGrid(base)
  if (!base || !grid) return undefined
  const [nx, ny, nz] = grid.dims
  const bitmap = new Uint8Array(nx * ny * nz)
  const group = contourGroup(segmentationId)
  for (const a of nv.annotations)
    if (
      a.group === group &&
      a.label > 0 &&
      a.label < 256 &&
      (only === undefined || a.label === only)
    )
      forEachAnnotationVoxel(a, base, ([x, y, z]) => {
        bitmap[x + nx * (y + ny * z)] = a.label
      })
  return bitmap
}

/**
 * A contour segmentation's shapes as RTSTRUCT ROIs, one per segment: each
 * ring (outer and hole) a CLOSED_PLANAR contour in LPS mm, on the voxel plane
 * the shape is measured and rasterized on (an oblique slice's depth varies).
 */
export function contourRois(
  nv: NiiVue,
  segmentationId: string,
  segments: ReadonlyArray<RtRoi['s']>,
): RtRoi[] {
  const base = nv.volumes[0]
  const grid = base && rasGrid(base)
  if (!grid) return []
  const vox2mm = grid.affine
  const mm2vox = invertAffine(vox2mm)
  const group = contourGroup(segmentationId)
  return segments.map((s) => ({
    s,
    contours: nv.annotations
      .filter((a) => a.group === group && a.label === s.value && a.anchorMM)
      .flatMap((a) => {
        const d = SLICE_DEPTH[a.sliceType] as number
        const [i0, i1] = IN_PLANE[a.sliceType] as readonly [number, number]
        const row = (k: number) => mm2vox[d * 4 + k] as number
        const at = a.anchorMM as [number, number, number]
        const depth = Math.round(
          row(0) * at[0] + row(1) * at[1] + row(2) * at[2] + row(3),
        )
        const toLPS = (p: { x: number; y: number }) => {
          const mm = [0, 0, 0]
          mm[i0] = p.x
          mm[i1] = p.y
          mm[d] = (depth - row(3) - row(i0) * p.x - row(i1) * p.y) / row(d)
          return [-(mm[0] as number), -(mm[1] as number), mm[2] as number]
        }
        return a.polygons.flatMap((poly) =>
          [poly.outer, ...poly.holes].map((ring) =>
            closedPlanar(ring.flatMap(toLPS)),
          ),
        )
      }),
  }))
}

/**
 * A contour segmentation as the save commands' pane: rows from the panel, a
 * SEG from the rasterized shapes (`bitmap`), an RTSTRUCT from the shapes.
 */
export function contourPane(segmentationId: string | undefined) {
  const c = segmentationId ? contours.get(segmentationId) : undefined
  if (!c || !segmentationId) return undefined
  const { nv } = c
  const base = nv.volumes[0]
  const grid = base && rasGrid(base)
  const voxel = grid ? voxelMM3(grid) : 1
  return {
    viewportId: c.viewportId,
    segmentationId,
    nv,
    seg: {
      displaySetInstanceUID: segmentationId,
      SeriesDescription: 'Contours',
      Modality: 'RTSTRUCT',
    } as OhifDisplaySet,
    rows: () => {
      const counts = segmentVoxels(nv, contourGroup(segmentationId))
      return [...c.rows].map(([value, r]) => {
        const count = counts.get(value) ?? 0
        return {
          value,
          label: r.label,
          rgb: [r.color[0] ?? 0, r.color[1] ?? 0, r.color[2] ?? 0] as [
            number,
            number,
            number,
          ],
          count,
          volume: count * voxel,
          locked: r.locked,
          active: false,
          visible: r.visible,
        }
      })
    },
    bitmap: (only?: number) => contourBitmap(nv, segmentationId, only),
    rois: (segments: ReadonlyArray<RtRoi['s']>) =>
      contourRois(nv, segmentationId, segments),
    jump: () => {},
    deleteSegment: c.deleteSegment,
    /** A locked segment is not edited by the contour utilities either. */
    isLocked: (index: number) => c.rows.get(index)?.locked === true,
  }
}
export type ContourPane = NonNullable<ReturnType<typeof contourPane>>
