import { type mat4, vec4 } from 'gl-matrix'
import * as Annotation from '@/annotation'
import { annotationDelta } from '@/annotation/delta'
import {
  shouldAppendMultiClickPoint,
  shouldStartFreshMultiClickContour,
} from '@/annotation/multiClick'
import type { ShapeBoundsUpdate } from '@/annotation/selection'
import {
  emitOrientationChange,
  emitPan2DChange,
  emitScaleMultiplierChange,
} from '@/control/cameraEvents'
import { computeBoundsPixelRect } from '@/control/canvasRegistry'
import * as DragModes from '@/control/dragModes'
import { pointToSegmentDistance } from '@/control/measurements'
import {
  clampScale3D,
  type Pinch,
  pinchCamera,
  yokedZoom2D,
} from '@/control/pinchZoom'
import { resolveWheelZoomAnchorMM } from '@/control/wheelZoomAnchor'
import { getDrawingBitmap } from '@/drawing/drawingManager'
import {
  drawLine,
  drawPenFilled,
  drawPoint,
  drawSphere,
  floodFill3D,
  isSamePoint,
  magicWand3D,
} from '@/drawing/penTool'
import { computeSlicePointerEvent } from '@/extension/context'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import { DRAG_MODE, sliceTypeDim } from '@/NVConstants'
import type NiiVue from '@/NVControl'
import type {
  AnnotationPoint,
  AnnotationTool,
  NVImage,
  PolygonWithHoles,
  VectorAnnotation,
  ViewHitTest,
} from '@/NVTypes'
import { pickSlideWorld } from '@/slide/slidePlane'
import { computeTolerance } from '@/view/NVAnnotation'
import { type GraphLayout, graphHitTest } from '@/view/NVGraph'
import {
  isInLegend,
  isLegendScrollable,
  type LegendEntry,
  type LegendLayout,
  legendHitTest,
  legendScrollHit,
} from '@/view/NVLegend'
import { setNextActionTag } from '@/view/NVPerfMarks'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import { projectMMToCanvas } from '@/view/sliceUtils'
import {
  type ClipDrawPlane,
  chunkExplodeEnabled,
  clipPlaneToMMAxisPlane,
  type ExplodedBlockFace,
  explodedChunkAABB,
  isMatRASAxisAligned,
  pickClipPlaneBlockFace,
  pickExplodedBlockFace,
  pickExplodedVoxel,
  rayBlockFacePointMM,
} from '@/volume/ChunkExplode'
import { chunksNotClippedOut } from '@/volume/ChunkVisibility'
import { displayedFrame, getImageDataRAS, voxelSizeMM } from '@/volume/utils'

/** Texture-space coordinate `d` of a world-mm point: its slice along `d`. */
const texDepth = (p: ArrayLike<number>, d: number, m: mat4): number =>
  m[d] * p[0] + m[4 + d] * p[1] + m[8 + d] * p[2] + m[12 + d]

/** Whether `mm` lies on the slice through `anchor` (within half a voxel in
 * texture depth; on an oblique volume the mm depth varies across one slice). */
function isOnSliceOf(
  ctrl: NiiVue,
  anchor: ArrayLike<number>,
  mm: ArrayLike<number>,
  depthDim: number,
): boolean {
  const mm2tex = ctrl.model.mm2tex
  const dims = ctrl.volumes[0]?.dimsRAS
  if (!mm2tex || !dims) return Math.abs(anchor[depthDim] - mm[depthDim]) <= 1e-3
  const dt = texDepth(anchor, depthDim, mm2tex) - texDepth(mm, depthDim, mm2tex)
  return Math.abs(dt) <= 0.5 / dims[depthDim + 1]
}

/**
 * Off any slice: drop the hover cursor and a parked click-to-place start's
 * rubber band (the start keeps waiting for its second click). True if either
 * was shown.
 */
function clearHover(ctrl: NiiVue): boolean {
  const parkedPreview =
    !!ctrl._annotationClickStart && !!ctrl.model._annotationPreview
  if (!ctrl.model._annotationCursor && !parkedPreview) return false
  ctrl.model._annotationCursor = null
  if (parkedPreview) ctrl.model._annotationPreview = null
  return true
}

// isClickToPlace: a press and release this close (CSS px) is a click, not a drag;
// screen space so thick slices or zoom don't change what counts as a click.
const CLICK_PX = 3
// A multi-click contour closes on a click this close (CSS px) to its first
// point, as cornerstone's closeContourProximity (10).
const CLOSE_PX = 10

function isNearFirstPoint(
  ctrl: NiiVue,
  evt: PointerEvent,
  first: AnnotationPoint,
): boolean {
  // Through the clicked tile: the nearest tile to the point may be another
  // plane through it (a multiplanar layout's crosshair).
  const tile = ctrl.activeTileHit
    ? ctrl.view?.screenSlices[ctrl.activeTileHit.tileIndex]
    : undefined
  const { mvpMatrix, planeNormal, planePoint, leftTopWidthHeight } = tile ?? {}
  if (!mvpMatrix || !planeNormal || !planePoint || !leftTopWidthHeight)
    return false
  const mm = Annotation.slice2DToMMOnPlane(
    first,
    ctrl._annotationPolySliceType,
    planeNormal,
    planePoint,
  )
  // Tiles are laid out in bounds-local pixels.
  const [cx, cy] = projectMMToCanvas(mm, mvpMatrix, leftTopWidthHeight)
  const at = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
  if (!at) return false
  return (
    Math.hypot(at[0] - cx, at[1] - cy) <=
    CLOSE_PX * ctrl.effectiveDevicePixelRatio
  )
}

function startAnnotationDrag(ctrl: NiiVue, evt: PointerEvent): void {
  ctrl.isDragging = true
  ctrl.activeButton = evt.button
  ctrl.lastPointerX = evt.clientX
  ctrl.lastPointerY = evt.clientY
  ctrl.canvas?.setPointerCapture(evt.pointerId)
}

// Drag control point `cpIdx` of `ann` (selected) until pointer-up.
function startResize(
  ctrl: NiiVue,
  evt: PointerEvent,
  ann: VectorAnnotation,
  cpIdx: number,
): void {
  const shape = ann.shape as NonNullable<VectorAnnotation['shape']>
  // Recorded on release, so a cancelled resize leaves no step.
  ctrl._resizeUndoSnapshot = structuredClone(ctrl.model.annotations)
  ctrl._resizingControlPoint = cpIdx
  ctrl._resizeOriginalShape = {
    start: { ...shape.start },
    end: { ...shape.end },
    width: shape.width,
    polygons: ann.polygons,
    anchorMM: ann.anchorMM,
    isErased: Annotation.isAnnotationErased(
      ann,
      ctrl.model.annotation.style.strokeWidth,
    ),
    start2: shape.start2 && { ...shape.start2 },
    end2: shape.end2 && { ...shape.end2 },
    stats: ann.stats,
  }
  ctrl._resizingAnnotation = ann
  startAnnotationDrag(ctrl, evt)
}

// Is `ann` on the slice `tile` shows: its anchor on the tile's plane, else its
// stored depth near `depth` (the pressed slice's position).
function isOnTile(
  ann: VectorAnnotation,
  tile: NVSliceLayout.SliceTile | undefined,
  depth: number,
  tolerance: number,
): boolean {
  const anchor = ann.anchorMM
  return anchor && tile?.planeNormal && tile.planePoint
    ? Annotation.isOnSlice(anchor, tile.planeNormal, tile.planePoint, tolerance)
    : Math.abs(ann.slicePosition - depth) <= tolerance
}

// annotationIsGrabbable: a shape the host hides takes no press (grab, handle
// or select).
function isGrabbable(ctrl: NiiVue, ann: VectorAnnotation): boolean {
  return ctrl.annotationIsGrabbable?.(ann) ?? true
}

// Handles within this many CSS px of a press grab (annotation.isHandleGrab).
const GRAB_PX = 6

/**
 * isHandleGrab: the shown shape and control point under a press on 2D tile
 * `tileIndex`, the selected shape first; null when none is near.
 */
function handleUnderPointer(
  ctrl: NiiVue,
  evt: PointerEvent,
  tileIndex: number,
): { ann: VectorAnnotation; cpIdx: number } | null {
  const tile = ctrl.view?.screenSlices[tileIndex]
  const { mvpMatrix, planeNormal, planePoint, leftTopWidthHeight } = tile ?? {}
  const at = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
  if (
    !tile ||
    !mvpMatrix ||
    !planeNormal ||
    !planePoint ||
    !leftTopWidthHeight ||
    !at
  )
    return null
  const tolerance = computeTolerance(ctrl.model)
  const radius = GRAB_PX * ctrl.effectiveDevicePixelRatio
  const depth = planePoint[sliceTypeDim(tile.axCorSag)] as number
  // The selected shape first: its handles win where shapes overlap.
  const selectedId = ctrl.model._annotationSelection?.annotationId
  const selected = ctrl.model.annotations.find((a) => a.id === selectedId)
  for (const ann of selected
    ? [selected, ...ctrl.model.annotations]
    : ctrl.model.annotations) {
    if (!ann.shape || ann.sliceType !== tile.axCorSag) continue
    if (!isGrabbable(ctrl, ann)) continue
    if (!isOnTile(ann, tile, depth, tolerance)) continue
    const cps = Annotation.getControlPoints(ann.shape)
    for (let i = 0; i < cps.length; i++) {
      const mm = Annotation.slice2DToMMOnPlane(
        cps[i] as AnnotationPoint,
        ann.sliceType,
        planeNormal,
        planePoint,
      )
      const [cx, cy] = projectMMToCanvas(mm, mvpMatrix, leftTopWidthHeight)
      if (Math.hypot(at[0] - cx, at[1] - cy) <= radius) return { ann, cpIdx: i }
    }
  }
  return null
}

// --- Legend label visibility ---------------------------------------------------

/**
 * Replace the hidden labels of the volume or mesh layer a legend entry belongs
 * to with `next(current)`. Reads the live list: the legend's isHidden lags a
 * frame, so a quick double-click would otherwise act on stale state. False
 * when the entry has no label source (a connectome).
 */
function updateLegendHidden(
  ctrl: NiiVue,
  entry: LegendEntry,
  next: (hidden: number[]) => number[],
): boolean {
  const failed = (e: unknown) => log.error('legend label toggle failed', e)
  const { volumeIndex, meshIndex, layerIndex } = entry
  if (volumeIndex !== undefined) {
    const hidden = ctrl.volumes[volumeIndex]?.hiddenLabels ?? []
    ctrl.setVolume(volumeIndex, { hiddenLabels: next(hidden) }).catch(failed)
    return true
  }
  if (meshIndex !== undefined && layerIndex !== undefined) {
    const layer = ctrl.model.getMeshes()[meshIndex]?.layers?.[layerIndex]
    ctrl
      .setMeshLayerProperty(meshIndex, layerIndex, {
        hiddenLabels: next(layer?.hiddenLabels ?? []),
      })
      .catch(failed)
    return true
  }
  return false
}

/**
 * Show only the entry's label among its volume's or layer's legend labels, or
 * show them all when it is already the only one shown. The double-click's two
 * single clicks toggle the label and back first, so this sees the state from
 * before the gesture.
 */
function soloLegendLabel(ctrl: NiiVue, entry: LegendEntry): void {
  const value = entry.labelValue
  if (value === undefined) return
  const others = ctrl.model
    .collectLegendEntries()
    .flatMap((e) =>
      e.volumeIndex === entry.volumeIndex &&
      e.meshIndex === entry.meshIndex &&
      e.layerIndex === entry.layerIndex &&
      e.labelValue !== undefined &&
      e.labelValue !== value
        ? [e.labelValue]
        : [],
    )
  updateLegendHidden(ctrl, entry, (hidden) =>
    !hidden.includes(value) && others.every((v) => hidden.includes(v))
      ? []
      : others,
  )
}

// --- Multi-click contour tools (spline / livewire) --------------------------
// These place control points across successive clicks (not a single drag) and
// close on double-click, so they need their own small state machine.

function isLivewireTool(tool: AnnotationTool): boolean {
  return tool === 'livewire' || tool === 'measureLivewire'
}

// Fixed-count multi-click tools: they commit on their last click.
const ANGLE_CLICKS: Partial<Record<AnnotationTool, number>> = {
  measureAngle: 3,
  measureCobbAngle: 4,
}

function isMultiClickTool(tool: AnnotationTool): boolean {
  return (
    tool === 'spline' ||
    tool === 'measureSpline' ||
    isLivewireTool(tool) ||
    tool in ANGLE_CLICKS
  )
}

// An angle tool's annotation from its clicks so far: two thin-line arms with
// the clicked points in shape (measureAngle: start, end = start2 = vertex,
// end2; measureCobbAngle: two lines), and the angle once both arms exist.
function angleAnnotation(
  ctrl: NiiVue,
  pts: readonly AnnotationPoint[],
): VectorAnnotation | null {
  if (pts.length < 2) return null
  const cfg = ctrl.model.annotation
  const [a, b, c, d] = pts
  const arm2 = cfg.tool === 'measureAngle' ? c && [b, c] : c && d && [c, d]
  const w = cfg.style.strokeWidth
  const polys = [
    ...Annotation.generateShape('measureLine', a, b, w),
    ...(arm2
      ? Annotation.generateShape('measureLine', arm2[0], arm2[1], w)
      : []),
  ]
  if (polys.length === 0) return null
  const ann = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    ctrl._annotationPolySliceType,
    ctrl._annotationPolySlicePosition,
    polys,
    cfg.style,
    ctrl._annotationPolyAnchorMM,
  )
  ann.shape = {
    type: cfg.tool,
    start: a,
    end: b,
    width: w,
    ...(arm2 ? { start2: arm2[0], end2: arm2[1] } : {}),
  }
  if (arm2)
    ann.stats = {
      area: 0,
      min: 0,
      mean: 0,
      max: 0,
      stdDev: 0,
      angle: Annotation.shapeAngle(ann.shape, angleToMM(ctrl, ann)),
    }
  return ann
}

// Slice-2D -> world mm on the plane the renderer draws the angle on (through
// its anchor; oblique on a tilted volume), else at its constant depth.
type Placement = Pick<
  VectorAnnotation,
  'sliceType' | 'slicePosition' | 'anchorMM'
>

function angleToMM(
  ctrl: NiiVue,
  ann: Placement,
): (p: AnnotationPoint) => ArrayLike<number> {
  const { mm2tex, tex2mm } = ctrl.model
  const anchor = ann.anchorMM
  const plane =
    mm2tex && tex2mm && anchor
      ? NVTransforms.slicePlaneEquation(
          tex2mm,
          ann.sliceType,
          vec4.transformMat4(
            vec4.create(),
            vec4.fromValues(anchor[0], anchor[1], anchor[2], 1),
            mm2tex,
          )[sliceTypeDim(ann.sliceType)] as number,
        )
      : null
  return plane
    ? (p) =>
        Annotation.slice2DToMMOnPlane(
          p,
          ann.sliceType,
          plane.normal,
          plane.point,
        )
    : (p) => Annotation.slice2DToMM(p, ann.slicePosition, ann.sliceType)
}

/**
 * Slice-2D <-> an orthonormal 2D frame (mm) of the plane a shape is drawn on.
 * Slice-2D drops the depth, so on an oblique slice its lengths and right
 * angles are not physical; this frame's are.
 */
function planeFrame(ctrl: NiiVue, at: Placement) {
  const toMM = angleToMM(ctrl, at)
  const o = Array.from(toMM({ x: 0, y: 0 }))
  const a = Array.from(toMM({ x: 1, y: 0 }))
  const b = Array.from(toMM({ x: 0, y: 1 }))
  const sub = (p: number[], q: number[]) =>
    p.map((v, i) => v - (q[i] as number))
  const dot = (p: number[], q: number[]) =>
    p.reduce((sum, v, i) => sum + v * (q[i] as number), 0)
  const e1 = sub(a, o)
  const n1 = Math.hypot(...e1)
  for (let i = 0; i < 3; i++) e1[i] = (e1[i] as number) / n1
  const d = sub(b, o)
  const k = dot(d, e1)
  const e2 = d.map((v, i) => v - k * (e1[i] as number))
  const n2 = Math.hypot(...e2)
  for (let i = 0; i < 3; i++) e2[i] = (e2[i] as number) / n2
  return {
    to(p: AnnotationPoint): AnnotationPoint {
      const w = sub(Array.from(toMM(p)), o)
      return { x: dot(w, e1), y: dot(w, e2) }
    },
    from(q: AnnotationPoint): AnnotationPoint {
      const w = o.map(
        (v, i) => v + q.x * (e1[i] as number) + q.y * (e2[i] as number),
      )
      return Annotation.mmToSlice2D(w as [number, number, number], at.sliceType)
    },
  }
}

// Cornerstone's automatic short axis, perpendicular on the drawing plane.
function autoShortAxis(
  ctrl: NiiVue,
  long: Axis,
  at: Placement = currentPlacement(ctrl),
): Axis {
  const f = planeFrame(ctrl, at)
  const ax = Annotation.bidirectionalShortAxis(f.to(long.start), f.to(long.end))
  return { start: f.from(ax.start), end: f.from(ax.end) }
}

function currentPlacement(ctrl: NiiVue): Placement {
  return {
    sliceType: ctrl._annotationSliceType,
    slicePosition: ctrl._annotationSlicePosition,
    anchorMM: ctrl._annotationAnchorMM,
  }
}

// Live-wire snapped path (slice-2D points) from the current seed's field to a
// target slice-2D point. Empty when no slice/field is ready.
function livewireSnappedPath(
  ctrl: NiiVue,
  target: AnnotationPoint,
): AnnotationPoint[] {
  const slice = ctrl._livewireSlice
  const field = ctrl._livewireField
  if (!slice || !field) return []
  const g = Annotation.slice2DToGrid(slice, target)
  const gridPath = Annotation.livewireBacktrack(field, slice.width, g.x, g.y)
  return gridPath.map((p) => Annotation.gridToSlice2D(slice, p.x, p.y))
}

// (Re)seed the live wire at a slice-2D point: extract the slice on first use,
// then compute the Dijkstra field from that point. False if unavailable.
function seedLivewire(ctrl: NiiVue, pt: AnnotationPoint): boolean {
  const vol = ctrl.model.getVolumes()[0]
  if (!vol) return false
  if (!ctrl._livewireSlice) {
    ctrl._livewireSlice = Annotation.extractLivewireSlice(
      vol,
      ctrl._annotationPolySliceType,
      ctrl._annotationPolySlicePosition,
    )
  }
  const slice = ctrl._livewireSlice
  if (!slice) return false
  const g = Annotation.slice2DToGrid(slice, pt)
  ctrl._livewireField = Annotation.livewireField(
    slice.cost,
    slice.width,
    slice.height,
    g.x,
    g.y,
  )
  ctrl._livewireSeed = g
  return true
}

function resetLivewire(ctrl: NiiVue): void {
  ctrl._livewireSlice = null
  ctrl._livewireField = null
  ctrl._livewireSeed = null
  ctrl._livewireClicks = 0
}

// The contour polygon for the active tool: spline smooths through the control
// points; live-wire uses the dense snapped points directly.
function contourPolygons(
  ctrl: NiiVue,
  points: readonly AnnotationPoint[],
): PolygonWithHoles[] {
  return isLivewireTool(ctrl.model.annotation.tool)
    ? Annotation.generatePolygonFromPoints(points)
    : Annotation.generateSplineFromPoints(points)
}

// Refresh the live preview: the contour through the placed points plus the
// hovered cursor (a straight cursor for spline, the snapped path for live wire).
function updateMultiClickPreview(
  ctrl: NiiVue,
  cursor: AnnotationPoint | null,
): void {
  const pts = ctrl._annotationPolyPoints
  if (!pts || pts.length === 0) {
    ctrl.model._annotationPreview = null
    return
  }
  const cfg = ctrl.model.annotation
  const all = cursor
    ? isLivewireTool(cfg.tool)
      ? [...pts, ...livewireSnappedPath(ctrl, cursor)]
      : [...pts, cursor]
    : pts
  if (cfg.tool in ANGLE_CLICKS) {
    ctrl.model._annotationPreview = angleAnnotation(ctrl, all)
    return
  }
  const polygons = contourPolygons(ctrl, all)
  if (polygons.length === 0) {
    ctrl.model._annotationPreview = null
    return
  }
  const preview = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    ctrl._annotationPolySliceType,
    ctrl._annotationPolySlicePosition,
    polygons,
    cfg.style,
    ctrl._annotationPolyAnchorMM,
  )
  preview.shape = { type: cfg.tool, start: all[0], end: all[all.length - 1] }
  ctrl.model._annotationPreview = preview
}

// Preview a two-point shape from start to end (a drag, or a parked click start).
function updateShapePreview(
  ctrl: NiiVue,
  start: AnnotationPoint,
  end: AnnotationPoint,
  sliceType: number,
  slicePosition: number,
  anchorMM: [number, number, number],
): void {
  const cfg = ctrl.model.annotation
  ;[start, end] = Annotation.dragCorners(
    cfg.tool,
    start,
    end,
    cfg.isDrawnFromCenter,
  )
  const polygons = Annotation.generateShape(
    cfg.tool,
    start,
    end,
    cfg.style.strokeWidth,
  )
  if (polygons.length === 0) {
    ctrl.model._annotationPreview = null
    return
  }
  const preview = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    sliceType,
    slicePosition,
    polygons,
    cfg.style,
    anchorMM,
  )
  preview.shape = { type: cfg.tool, start, end }
  if (cfg.tool === 'measureLine') {
    preview.stats = {
      area: 0,
      min: 0,
      mean: 0,
      max: 0,
      stdDev: 0,
      length: Math.hypot(end.x - start.x, end.y - start.y),
    }
  }
  ctrl.model._annotationPreview = preview
}

// The bounding box of the control points (for the stats-label anchor).
function pointsBounds(pts: readonly AnnotationPoint[]): {
  start: AnnotationPoint
  end: AnnotationPoint
} {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { start: { x: minX, y: minY }, end: { x: maxX, y: maxY } }
}

// Close the in-progress contour into a committed annotation (>= 3 points).
// Returns true when an annotation was created.
function commitMultiClickContour(ctrl: NiiVue): boolean {
  const pts = ctrl._annotationPolyPoints
  if (!pts || pts.length < 3) return false
  const cfg = ctrl.model.annotation
  const polygons = contourPolygons(ctrl, pts)
  if (polygons.length === 0) return false
  ctrl._annotationUndoStack.push(ctrl.model.annotations)
  const newAnn = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    ctrl._annotationPolySliceType,
    ctrl._annotationPolySlicePosition,
    polygons,
    cfg.style,
    ctrl._annotationPolyAnchorMM,
  )
  const bounds = pointsBounds(pts)
  newAnn.shape = { type: cfg.tool, start: bounds.start, end: bounds.end }
  commitAnnotation(ctrl, newAnn, cfg.mergesOverlaps)
  return true
}

// --- Bidirectional (two perpendicular measured axes) ------------------------

type Axis = { start: AnnotationPoint; end: AnnotationPoint }

function isBidirectionalTool(tool: AnnotationTool): boolean {
  return tool === 'bidirectional' || tool === 'measureBidirectional'
}

// The axes' lengths in mm on the drawing plane.
function bidirectionalLengths(
  ctrl: NiiVue,
  at: Placement,
  long: Axis,
  short: Axis | null,
): { length: number; shortLength?: number } {
  const f = planeFrame(ctrl, at)
  const len = (a: Axis) => {
    const [p, q] = [f.to(a.start), f.to(a.end)]
    return Math.hypot(q.x - p.x, q.y - p.y)
  }
  return { length: len(long), ...(short ? { shortLength: len(short) } : {}) }
}

// Build the annotation for a bidirectional measurement from its two axes: two
// thin-line polygons (so the built-in draw renders both), plus long/short
// lengths in stats. The seam projects the second axis for the UIKit overlay.
function bidirectionalAnnotation(
  ctrl: NiiVue,
  long: Axis,
  short: Axis | null,
  at: Placement = currentPlacement(ctrl),
): VectorAnnotation | null {
  const cfg = ctrl.model.annotation
  const w = cfg.style.strokeWidth
  const polys = [
    ...Annotation.generateShape('measureLine', long.start, long.end, w),
    ...(short
      ? Annotation.generateShape('measureLine', short.start, short.end, w)
      : []),
  ]
  if (polys.length === 0) return null
  const ann = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    at.sliceType,
    at.slicePosition,
    polys,
    cfg.style,
    at.anchorMM,
  )
  ann.shape = {
    type: cfg.tool,
    start: long.start,
    end: long.end,
    width: w,
    ...(short ? { start2: short.start, end2: short.end } : {}),
  }
  ann.stats = {
    area: 0,
    min: 0,
    mean: 0,
    max: 0,
    stdDev: 0,
    ...bidirectionalLengths(ctrl, at, long, short),
  }
  return ann
}

// Live preview during a bidirectional measurement: the long axis (fixed once
// placed) plus the short axis being dragged.
function bidirectionalPreview(ctrl: NiiVue, cursor: AnnotationPoint): void {
  let long: Axis | null
  let short: Axis | null
  if (ctrl._bidirectionalLong) {
    long = ctrl._bidirectionalLong
    short = ctrl._annotationShapeStart
      ? { start: ctrl._annotationShapeStart, end: cursor }
      : null
  } else {
    long = ctrl._annotationShapeStart
      ? { start: ctrl._annotationShapeStart, end: cursor }
      : null
    short =
      long && ctrl.model.annotation.isClickToPlace
        ? autoShortAxis(ctrl, long)
        : null
  }
  ctrl.model._annotationPreview = long
    ? bidirectionalAnnotation(ctrl, long, short)
    : null
}

// Store a finished annotation and announce it.
function commitAnnotation(
  ctrl: NiiVue,
  ann: VectorAnnotation,
  mergesOverlaps: boolean,
): void {
  const before = ctrl.model.annotations
  ctrl.model.annotations = Annotation.storeAnnotation(
    before,
    ann,
    mergesOverlaps,
  )
  // Measure after the store: a merge or a cut changes a measurement's polygons.
  const vol = ctrl.model.getVolumes()[0]
  if (vol) {
    const unchanged = new Set(before)
    for (const stored of ctrl.model.annotations) {
      if (unchanged.has(stored) || !stored.shape) continue
      if (!Annotation.isMeasureTool(stored.shape.type)) continue
      stored.stats =
        Annotation.computeAnnotationStats(
          stored,
          vol,
          ctrl.model.annotation.isAreaGeometric,
        ) ?? undefined
      if (stored.id === ann.id) ann.stats = stored.stats
    }
  }
  ctrl.emit('annotationAdded', { annotation: ann })
  ctrl.emit('annotationChanged', {
    action: 'draw',
    ...annotationDelta(before, ctrl.model.annotations),
  })
}

// Commit the finished bidirectional measurement.
function commitBidirectional(ctrl: NiiVue, long: Axis, short: Axis): void {
  const ann = bidirectionalAnnotation(ctrl, long, short)
  if (!ann) return
  ctrl._annotationUndoStack.push(ctrl.model.annotations)
  commitAnnotation(ctrl, ann, ctrl.model.annotation.mergesOverlaps)
}

function clientToCanvasPixel(
  ctrl: NiiVue,
  clientX: number,
  clientY: number,
): [number, number] {
  const rect = ctrl.canvas?.getBoundingClientRect()
  if (!rect) {
    return [0, 0]
  }
  const dpr = ctrl.effectiveDevicePixelRatio
  const x = (clientX - rect.left) * dpr
  const y = (clientY - rect.top) * dpr
  return [x, y]
}

/** Convert client coords to bounds-local pixel coords. Returns null if outside bounds.
 *  Uses the post-viewport pixel rect so hit testing tracks the same transform
 *  the renderer applies — otherwise pan/zoom would route events to the wrong tile.
 *  Exposed publicly as `NiiVue.clientToCanvas` so callers of `hitTest` /
 *  `canvasToMM` feed them the same pixels the built-in handlers use. */
export function clientToBoundsPixel(
  ctrl: NiiVue,
  clientX: number,
  clientY: number,
): [number, number] | null {
  const [canvasX, canvasY] = clientToCanvasPixel(ctrl, clientX, clientY)
  const bounds = ctrl.opts.bounds
  if (
    !bounds ||
    (bounds[0][0] === 0 &&
      bounds[0][1] === 0 &&
      bounds[1][0] === 1 &&
      bounds[1][1] === 1)
  ) {
    return [canvasX, canvasY]
  }
  const canvas = ctrl.canvas
  if (!canvas) return null
  const rect = computeBoundsPixelRect(canvas, bounds)
  if (rect.isOffscreen) return null
  const boundsX = canvasX - rect.left
  const boundsY = canvasY - rect.top
  if (
    boundsX < 0 ||
    boundsX >= rect.width ||
    boundsY < 0 ||
    boundsY >= rect.height
  )
    return null
  return [boundsX, boundsY]
}

function handleGraphHitTest(ctrl: NiiVue, x: number, y: number): boolean {
  const layout = ctrl.view?.graphLayout as GraphLayout | null
  const hit = graphHitTest(x, y, layout)
  if (!hit) return false
  if (hit.type === 'deferred') {
    const vol = ctrl.volumes[0]
    if (vol?.id) {
      // Fire-and-forget from a pointer handler: catch so a failed reload (bad
      // URL, network error, allocation failure) can't become an unhandled
      // rejection. loadDeferred4DVolumes leaves the loaded frames intact on error.
      ctrl.loadDeferred4DVolumes(vol.id).catch((err) => {
        log.error('Failed to load deferred 4D frames:', err)
      })
    }
    return true
  }
  if (hit.type === 'frame' && hit.frame >= 0) {
    const vol = ctrl.volumes[0]
    if (vol?.id) {
      ctrl
        .setFrame4D(vol.id, hit.frame)
        .catch((e) => log.error('setFrame4D failed', e))
    }
    return true
  }
  if (hit.type === 'signalCursor') {
    ctrl.setSignalCursorFraction(hit.xFrac)
    return true
  }
  if (hit.type === 'graphControl') {
    if (hit.id === 'zoomIn') ctrl.graphZoom(2)
    else if (hit.id === 'zoomOut') ctrl.graphZoom(0.5)
    else if (hit.id === 'panLeft') ctrl.graphPan(-0.25)
    else if (hit.id === 'panRight') ctrl.graphPan(0.25)
    return true
  }
  // Inside graph but not on a specific element — consume to prevent tile hit
  return hit.type === 'frame'
}

function handleKeydown(ctrl: NiiVue, e: KeyboardEvent): void {
  // composedPath reaches a focused field inside a shadow root.
  const active = e.composedPath()[0]
  if (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))
  )
    return
  const pointer = ctrl._pointerClient
  if (!pointer || !clientToBoundsPixel(ctrl, pointer[0], pointer[1])) return
  setNextActionTag('keydown')
  const key = e.key.toUpperCase()
  if (key === 'ESCAPE') {
    // Abandon a half-placed angle.
    if (ctrl._angleState !== 'none') {
      ctrl._cancelAngle()
      // End a drag in progress too, or later moves orbit the camera (#471).
      if (ctrl.isDragging) resetDragState(ctrl)
      return
    }
    // Abandon an in-progress multi-click contour (spline / livewire), a
    // half-placed bidirectional measurement, a parked click start or an
    // annotation drag, ending the drag so later moves do not orbit (#471).
    ctrl.cancelAnnotationInProgress()
    return
  }
  if (key === 'V') {
    if (!ctrl.model.interaction.isViewModeHotKeyEnabled) {
      log.info(`NIIVUE VERSION: ${ctrl.version}`)
    } else if (
      !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat)
    ) {
      // Modifiers leave Cmd/Ctrl+V to paste; a held key would spin the views.
      ctrl.sliceType = NVConstants.nextSliceType(ctrl.model.layout.sliceType)
    }
  } else if (key === 'A') {
    ctrl.activeClipPlaneIndex++
    if (ctrl.activeClipPlaneIndex >= NVConstants.NUM_CLIP_PLANE) {
      ctrl.activeClipPlaneIndex = 0
    }
  } else if (key === 'C') {
    ctrl.currentClipPlaneIndex++
    if (ctrl.currentClipPlaneIndex > 6) ctrl.currentClipPlaneIndex = 0
    let clipPlane = [2, 0, 0] //none
    switch (ctrl.currentClipPlaneIndex) {
      case 3: // left a 270 e 0
        // this.scene.clipPlane = [1, 0, 0, 0];
        clipPlane = [0, 270, 0]
        break
      case 2: // right a 90 e 0
        clipPlane = [0, 90, 0]
        break
      case 1: // posterior a 0 e 0
        clipPlane = [0, 0, 0]
        break
      case 4: // anterior a 0 e 0
        clipPlane = [0, 180, 0]
        break
      case 5: // inferior a 0 e -90
        clipPlane = [0, 0, -90]
        break
      case 6: // superior: a 0 e 90'
        clipPlane = [0, 0, 90]
        break
    }
    ctrl.setClipPlaneDepthAziElev(
      clipPlane[0],
      clipPlane[1],
      clipPlane[2],
      ctrl.activeClipPlaneIndex,
    )
  } else if (ctrl.model.layout.sliceType === NVConstants.SLICE_TYPE.RENDER) {
    if (key === 'H') {
      ctrl.azimuth = (((ctrl.azimuth - 1) % 360) + 360) % 360
    } else if (key === 'L') {
      ctrl.azimuth = (((ctrl.azimuth + 1) % 360) + 360) % 360
    } else if (key === 'K') {
      ctrl.elevation = Math.max(-90, Math.min(90, ctrl.elevation - 1))
    } else if (key === 'J') {
      ctrl.elevation = Math.max(-90, Math.min(90, ctrl.elevation + 1))
    }
  } else {
    if (key === 'H') ctrl.moveCrosshairInVox(-1, 0, 0)
    else if (key === 'L') ctrl.moveCrosshairInVox(1, 0, 0)
    else if (key === 'J') ctrl.moveCrosshairInVox(0, -1, 0)
    else if (key === 'K') ctrl.moveCrosshairInVox(0, 1, 0)
    else if (key === 'U' && e.ctrlKey) ctrl.moveCrosshairInVox(0, 0, 1)
    else if (key === 'D' && e.ctrlKey) ctrl.moveCrosshairInVox(0, 0, -1)
  }
}

// Paint a 3D ball of `radius` at every voxel on the segment from `a` to `b`, so
// a fast drag leaves a continuous tube instead of disconnected stamps. Steps at
// ~1 voxel spacing along the longest axis; a single point (a===b) paints once.
function drawSphereSegment(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
  penValue: number,
  drawBitmap: Uint8Array,
  dims: number[],
  penOverwrites: boolean,
): void {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const steps = Math.max(
    1,
    Math.round(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))),
  )
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    drawSphere({
      x: Math.round(a[0] + dx * t),
      y: Math.round(a[1] + dy * t),
      z: Math.round(a[2] + dz * t),
      radius,
      penValue,
      drawBitmap,
      dims,
      penOverwrites,
    })
  }
}

// Paint the exploded block under the cursor on the 3D render tile. Builds the
// render tile's MVP exactly as depthPick does, unprojects the click to a world
// ray (in vox2mm mm-space), CPU-ray-casts the exploded chunk AABBs to find the
// block + voxel, then paints a 3D ball there. On a drag continuation it connects
// the new voxel to the previous one (drawSphereSegment) so pen strokes and the
// eraser leave no gaps. `isStrokeStart` gates the undo snapshot so a whole drag
// is one undo step. Refreshes via the incremental drawing flush so only the
// touched chunk re-uploads. Returns the painted voxel (null if the ray missed).
interface ExplodedDrawPick {
  voxel: [number, number, number]
  // Index of the exploded block the ray hit. Successive stroke picks only
  // connect when this matches, so a drag that crosses a block gap doesn't streak
  // a line between two data-space-distant voxels.
  chunkIndex: number
  // The active drawing volume, or null when none is open (vector-annotation
  // callers don't need one; raster callers bail when it's null).
  drawingVol: NVImage | null
  // Predicate over RAS voxel coords: true for visible tissue (source intensity
  // above the transparency threshold). Reused by the 3D flood fill to bound the
  // region. When the volume has no readable data it is always-true (paint/fill
  // anywhere in bounds).
  keep: (x: number, y: number, z: number) => boolean
}

// getImageDataRAS reorders the whole volume when its native storage isn't already
// a Float32Array in RAS order. During a 3D draw/vector stroke it would run on
// every pointermove, so cache the result for the stroke (keyed by volume
// identity and displayed frame); the cache is cleared on pointerup/pointercancel.
export function strokeSample(ctrl: NiiVue, vol: NVImage): Float32Array | null {
  const cache = ctrl._draw3DSampleCache
  const frame = vol.frame4D ?? 0
  if (cache && cache.vol === vol && cache.frame === frame) return cache.data
  const data = getImageDataRAS(displayedFrame(vol))
  ctrl._draw3DSampleCache = data ? { vol, frame, data } : null
  return data
}

// Unproject the cursor over the active render tile to a world ray (origin + unit
// dir) in the volume's vox2mm mm-space — the shared front end of every 3D
// exploded-block pick (draw, wand, vector face). Null if there is no render-tile
// hit for this volume.
function explodedPickRay(
  ctrl: NiiVue,
  vol: NVImage,
  hitOverride?: ViewHitTest | null,
): { origin: [number, number, number]; dir: [number, number, number] } | null {
  // Defaults to the tile the pointer went down on (every drag-driven pick), but
  // a caller that hit-tested its own point passes it in — see pickExplodedBlock.
  const hit = hitOverride ?? ctrl.activeTileHit
  if (!hit || !vol.chunkPlan) return null
  return renderPickRay(ctrl, hit, vol.obliqueRAS as mat4 | undefined)
}

/**
 * The world ray (origin + unit dir, mm) under a render-tile hit, unprojected
 * through the render loop's MVP. Null without a tile rect.
 */
export function renderPickRay(
  ctrl: NiiVue,
  hit: ViewHitTest,
  obliqueRAS: mat4 | undefined,
): { origin: [number, number, number]; dir: [number, number, number] } | null {
  const tile = ctrl.view?.screenSlices[hit.tileIndex]
  const ltwh = tile?.leftTopWidthHeight
  if (!ltwh) return null
  const md = ctrl.model
  const mvp = NVTransforms.calculateMvpMatrix(
    ltwh,
    md.scene.azimuth,
    md.scene.elevation,
    md._renderPivotMM ?? md.pivot3D,
    md.furthestFromPivot,
    md.scene.scaleMultiplier,
    obliqueRAS,
    md.scene.renderPan,
  )[0] as mat4
  const near = NVTransforms.unprojectScreen(
    hit.normalizedX,
    hit.normalizedY,
    0,
    mvp,
  )
  const far = NVTransforms.unprojectScreen(
    hit.normalizedX,
    hit.normalizedY,
    1,
    mvp,
  )
  let dx = far[0] - near[0]
  let dy = far[1] - near[1]
  let dz = far[2] - near[2]
  const len = Math.hypot(dx, dy, dz) || 1
  dx /= len
  dy /= len
  dz /= len
  return { origin: [near[0], near[1], near[2]], dir: [dx, dy, dz] }
}

// Shared pick for 3D drawing on exploded blocks: unprojects the cursor to a world
// ray (explodedPickRay), CPU-ray-casts the exploded chunk AABBs restricted to the
// clip-visible set, and returns the entered voxel plus a visible-tissue predicate.
// Null if the ray misses every block or there is no drawing volume.
function pickExplodedDraw(
  ctrl: NiiVue,
  vol: NVImage,
  hitOverride?: ViewHitTest | null,
): ExplodedDrawPick | null {
  const plan = vol.chunkPlan
  const ray = explodedPickRay(ctrl, vol, hitOverride)
  if (!plan || !ray) return null
  const near = ray.origin
  const [dx, dy, dz] = ray.dir
  // Only blocks the clip plane leaves visible are pickable, so a right-click
  // can't land on a block hidden behind the cutaway. The shader clips each block
  // by its un-exploded data position, which is exactly what chunksNotClippedOut
  // computes (no explode offset).
  const allIdx = plan.chunks.map((_, i) => i)
  const clipPlanes = ctrl.model.clipPlanes
  const isCutaway = ctrl.model.scene.isClipPlaneCutaway
  const visible = new Set(
    chunksNotClippedOut(plan, allIdx, clipPlanes, isCutaway),
  )
  // March the volume's data so the paint lands on the visible tissue surface
  // (first voxel above the transparency threshold), not the block's empty
  // bounding-box face, and skips the clipped-away portion of a straddling block.
  const data = strokeSample(ctrl, vol)
  const dimX = (vol.dimsRAS as number[])[1]
  const dimXY = dimX * (vol.dimsRAS as number[])[2]
  // The window cal_min/cal_max are in display units; convert to the raw scale
  // getImageDataRAS returns. The first faintly-non-zero voxel is near-transparent
  // ("cloud"), so threshold a short way up the window so the paint lands on the
  // first clearly-visible voxel instead.
  const sclSlope = vol.hdr?.scl_slope || 1
  const sclInter = vol.hdr?.scl_inter || 0
  const winLo = (vol.calMin - sclInter) / sclSlope
  const winHi = (vol.calMax - sclInter) / sclSlope
  let threshold = winLo + 0.15 * (winHi - winLo)
  let sample: ((x: number, y: number, z: number) => number) | undefined
  const base = vol.pickSampler
  if (data) {
    sample = (x: number, y: number, z: number): number =>
      data[x + y * dimX + z * dimXY]
  } else if (base) {
    // A STREAMED volume has no CPU `img` -- its voxels live in GPU brick
    // textures -- so fall back to the volume's own mm-space `pickSampler` (the
    // resident coarse floor NVChunkedVolume installs). It already returns a
    // WINDOW-VISIBLE value, so its threshold is 0 rather than a fraction of the
    // window. Same wrapping the 3D depth pick uses (NVViewGPU/NVViewGL), so a
    // click lands on the same voxel whether the volume is resident or streamed.
    const matRAS = vol.matRAS as mat4
    sample = (x: number, y: number, z: number): number => {
      const mm = NVTransforms.vox2mm(null, [x, y, z], matRAS)
      return base(mm[0], mm[1], mm[2])
    }
    threshold = 0
  }
  const picked = pickExplodedVoxel(
    plan,
    vol.matRAS as Float32Array,
    vol.chunkExplode,
    [near[0], near[1], near[2]],
    [dx, dy, dz],
    { allowed: visible, clipPlanes, isCutaway, sample, threshold },
  )
  if (!picked) return null
  const keep = sample
    ? (x: number, y: number, z: number): boolean => sample(x, y, z) > threshold
    : (): boolean => true
  return {
    voxel: picked.voxel,
    chunkIndex: picked.chunkIndex,
    drawingVol: (ctrl.model.drawingVolume as NVImage | null) ?? null,
    keep,
  }
}

// Paint the exploded block under the cursor on the 3D render tile with a 3D
// ball. On a drag continuation it connects the new voxel to the previous one
// (drawSphereSegment) so pen strokes and the eraser leave no gaps.
// `isStrokeStart` gates the undo snapshot so a whole drag is one undo step.
// Refreshes via the incremental drawing flush; returns the painted voxel (null
// if the ray missed).
function draw3DOnExplodedBlock(
  ctrl: NiiVue,
  vol: NVImage,
  isStrokeStart: boolean,
): [number, number, number] | null {
  const pick = pickExplodedDraw(ctrl, vol)
  if (!pick) return null
  const { voxel, chunkIndex, drawingVol } = pick
  if (!drawingVol) return null
  // Snapshot for undo on the first successful paint of the stroke (set at
  // pointer-down), so a stroke that starts on a ray-miss still gets a baseline.
  if (ctrl._draw3DNeedsUndo) {
    ctrl.drawAddUndoBitmap()
    ctrl._draw3DNeedsUndo = false
  }
  const radius = Math.max(0, Math.floor(ctrl.model.draw.penSize / 2))
  // Continue from the previous voxel only when this pick is in the SAME block as
  // the last one — connecting across a block gap would streak a line between two
  // voxels that are adjacent on screen but far apart in data space. A fresh
  // stamp (stroke start, or a jump to another block) paints just the picked
  // voxel.
  const sameBlock =
    !isStrokeStart &&
    ctrl._draw3DLastVoxel !== null &&
    ctrl._draw3DLastChunk === chunkIndex
  const from = sameBlock
    ? (ctrl._draw3DLastVoxel as [number, number, number])
    : voxel
  drawSphereSegment(
    from,
    voxel,
    radius,
    ctrl.model.draw.penValue,
    getDrawingBitmap(drawingVol),
    vol.dimsRAS as number[],
    ctrl.model.draw.isFillOverwriting,
  )
  // Mark both segment endpoints so the incremental flush covers the tube.
  ctrl.markDrawDirty(from[0], from[1], from[2], ctrl.model.draw.penSize)
  ctrl.markDrawDirty(voxel[0], voxel[1], voxel[2], ctrl.model.draw.penSize)
  ctrl.refreshDrawing()
  ctrl._emitDrawingChanged('stroke', true)
  ctrl._draw3DLastChunk = chunkIndex
  return voxel
}

// Take a fill's undo snapshot; the returned function discards it again
// (drawAddUndoBitmap returns fresh arrays, so restoring the prior pointers drops it).
function beginFillUndo(ctrl: NiiVue): () => void {
  const prevUndoBitmaps = ctrl.drawUndoBitmaps
  const prevUndoIndex = ctrl.currentDrawUndoBitmap
  ctrl.drawAddUndoBitmap()
  return () => {
    ctrl.drawUndoBitmaps = prevUndoBitmaps
    ctrl.currentDrawUndoBitmap = prevUndoIndex
  }
}

// Close a region fill: drop the undo snapshot of a no-op fill, else flush the
// fill's AABB. Returns whether anything was filled.
function finishFill(
  ctrl: NiiVue,
  result: { filled: number; min: number[]; max: number[] },
  dropUndo: () => void,
): boolean {
  if (result.filled === 0) {
    dropUndo()
    return false
  }
  ctrl.markDrawDirty(result.min[0], result.min[1], result.min[2], 1)
  ctrl.markDrawDirty(result.max[0], result.max[1], result.max[2], 1)
  ctrl.refreshDrawing()
  ctrl._emitDrawingChanged('stroke', true)
  return true
}

// Draw a pen segment from the last pen location to ptB with the current pen.
function penLineTo(ctrl: NiiVue, vol: NVImage, ptB: number[]): void {
  drawLine({
    ptA: ctrl._drawPenLocation,
    ptB,
    penValue: ctrl.model.draw.penValue,
    penShape: ctrl.model.draw.penShape,
    drawBitmap: getDrawingBitmap(ctrl.model.drawingVolume as NVImage),
    dims: vol.dimsRAS as number[],
    penSize: ctrl.model.draw.penSize,
    penAxCorSag: ctrl._drawPenAxCorSag,
    penOverwrites: ctrl.model.draw.isFillOverwriting,
    pixDims: vol.pixDimsRAS as number[],
  })
}

// 3D flood fill on an exploded block (fill mode): a right-click seeds a 3D
// region-grow at the picked voxel, filling the connected visible-tissue blob
// (6-connected, bounded by the same threshold the pick uses) with the pen value.
// One undo step; refreshes only the touched region. Returns true if it ran.
function floodFill3DOnExplodedBlock(ctrl: NiiVue, vol: NVImage): boolean {
  const pick = pickExplodedDraw(ctrl, vol)
  if (!pick) return false
  const { voxel, drawingVol, keep } = pick
  if (!drawingVol) return false
  const dropUndo = beginFillUndo(ctrl)
  const dims = vol.dimsRAS as number[]
  // Cap the fill so a click on a huge connected structure can't run unbounded.
  // The cap applies to erase (penValue 0) too; on a volume with more than 4M
  // voxels a large erase flood stops at the cap and warns. 4M is generous for a
  // single anatomical blob.
  const maxVoxels = Math.min(dims[1] * dims[2] * dims[3], 4_000_000)
  const result = floodFill3D({
    seed: voxel,
    drawBitmap: getDrawingBitmap(drawingVol),
    dims,
    penValue: ctrl.model.draw.penValue,
    keep,
    fillOverwrites: ctrl.model.draw.isFillOverwriting,
    maxVoxels,
  })
  if (result.hitCap) {
    log.warn(`3D flood fill stopped at the ${maxVoxels}-voxel cap`)
  }
  finishFill(ctrl, result, dropUndo)
  return true
}

// Click-to-segment ("magic wand") at a seed voxel (RAS ijk) on `vol`: grow a 3D
// region of voxels whose source intensity is within the configured tolerance of
// the seed's value and paint them the pen value. Shared by the 2D-slice click and
// the 3D exploded-block right-click. The tolerance is a fraction of the display
// window, converted to the raw sample scale. One undo step; refreshes only the
// touched region. Returns true if it ran (there was data + a drawing volume).
function magicWandFill(
  ctrl: NiiVue,
  vol: NVImage,
  seed: [number, number, number],
  // When given, confine the grow to this slice axis at the seed's index (2D
  // mode). The 3D exploded-block entry point omits it (always a full 3D grow).
  restrictAxis?: number,
): boolean {
  const drawingVol = ctrl.model.drawingVolume as NVImage | null
  if (!drawingVol) return false
  const data = strokeSample(ctrl, vol)
  if (!data) return false
  const dims = vol.dimsRAS as number[]
  const dimX = dims[1]
  const dimXY = dimX * dims[2]
  const sample = (x: number, y: number, z: number): number =>
    data[x + y * dimX + z * dimXY]
  // Tolerance: a fraction of the display window, in the raw sample scale that
  // getImageDataRAS returns (so it tracks the current windowing).
  const sclSlope = vol.hdr?.scl_slope || 1
  const sclInter = vol.hdr?.scl_inter || 0
  const winLo = (vol.calMin - sclInter) / sclSlope
  const winHi = (vol.calMax - sclInter) / sclSlope
  const tolerance =
    ctrl.model.draw.clickToSegmentTolerance * Math.abs(winHi - winLo)
  const dropUndo = beginFillUndo(ctrl)
  const maxVoxels = Math.min(dims[1] * dims[2] * dims[3], 4_000_000)
  const result = magicWand3D({
    seed,
    drawBitmap: getDrawingBitmap(drawingVol),
    dims,
    penValue: ctrl.model.draw.penValue,
    sample,
    tolerance,
    fillOverwrites: ctrl.model.draw.isFillOverwriting,
    maxVoxels,
    restrictToSlice:
      restrictAxis === undefined
        ? undefined
        : { axis: restrictAxis, index: seed[restrictAxis] },
  })
  if (result.hitCap) {
    log.warn(`Magic wand stopped at the ${maxVoxels}-voxel cap`)
  }
  if (!finishFill(ctrl, result, dropUndo)) return true
  // Report the segmented region so a host can show its size without walking
  // the bitmap itself. Voxel volume comes from the segmented volume's own RAS
  // grid (the drawing shares that grid).
  const v = voxelSizeMM(vol)
  const mm3 = v ? result.filled * v[0] * v[1] * v[2] : 0
  ctrl.emit('clickToSegment', {
    seed,
    penValue: ctrl.model.draw.penValue,
    voxelCount: result.filled,
    mm3,
    mL: mm3 / 1000,
    hitCap: result.hitCap,
    is2D: restrictAxis !== undefined,
  })
  return true
}

// Magic wand seeded by a 3D exploded-block right-click: pick the block voxel the
// ray hits, then grow the intensity-similar region from it. Returns true if a
// block was hit.
function magicWand3DOnExplodedBlock(ctrl: NiiVue, vol: NVImage): boolean {
  const pick = pickExplodedDraw(ctrl, vol)
  if (!pick) return false
  return magicWandFill(ctrl, vol, pick.voxel)
}

// Pick the front FACE of the visible block under the cursor on the 3D render, as
// an axis-aligned mm plane, for vector drawing directly on the blocks. A stroke
// locks onto the face returned here and projects every later point onto it, so the
// SVG is a flat axis-aligned polygon on one block face (not a path following the
// tissue surface across blocks/depth). Adjusting the face to the clip plane is a
// tracked follow-up.
function pickBlockFace(ctrl: NiiVue, vol: NVImage): ExplodedBlockFace | null {
  const plan = vol.chunkPlan
  const ray = explodedPickRay(ctrl, vol)
  if (!plan || !ray) return null
  // If any clip plane is active, draw on the CLIP-PLANE cut. The block is the one
  // whose cut surface the ray actually hits (pickClipPlaneBlockFace), NOT the tissue
  // pick — in cutaway mode the tissue pick ignores the clip and would land on a
  // removed front block. Only when the ray misses every cut do we fall back to the
  // block's box face below.
  const clipPlanes = clipDrawPlanesMM(ctrl)
  if (clipPlanes.length > 0) {
    const visible = new Set(
      chunksNotClippedOut(
        plan,
        plan.chunks.map((_, i) => i),
        ctrl.model.clipPlanes,
        ctrl.model.scene.isClipPlaneCutaway,
      ),
    )
    const clipFace = pickClipPlaneBlockFace(
      plan,
      vol.matRAS as Float32Array,
      vol.chunkExplode,
      ray.origin,
      ray.dir,
      clipPlanes,
      { allowed: visible },
    )
    if (clipFace) return clipFace
  }
  // No clip cut hit: pick the block by the same TISSUE-AWARE pick as the pen
  // (pickExplodedDraw marches into the data and lands on the first visible voxel).
  // Picking by nearest bounding box instead would choose whichever block's box the
  // ray enters first — in the exploded view that is often a nearer block's empty
  // halo/air margin, so the SVG landed on the wrong block. Take that block's face.
  const hit = pickExplodedDraw(ctrl, vol)
  if (!hit) return null
  return pickExplodedBlockFace(
    plan,
    vol.matRAS as Float32Array,
    vol.chunkExplode,
    ray.origin,
    ray.dir,
    { allowed: new Set([hit.chunkIndex]) },
  )
}

// The mm drawing planes for every ACTIVE axis-aligned clip plane (there are
// NUM_CLIP_PLANE slots; the interaction stack cycles which is active, and more than
// one can be on). pickClipPlaneBlockFace picks the nearest cut the ray hits across
// them. Empty when no clip is active or every active plane is oblique (the
// axis-aligned annotation model can't hold an oblique plane yet).
function clipDrawPlanesMM(ctrl: NiiVue): ClipDrawPlane[] {
  const cps = ctrl.model.clipPlanes
  const tex2mm = ctrl.model.tex2mm
  if (!cps || !tex2mm) return []
  const out: ClipDrawPlane[] = []
  const count = Math.min(NVConstants.NUM_CLIP_PLANE, Math.floor(cps.length / 4))
  for (let i = 0; i < count; i++) {
    const plane = clipPlaneToMMAxisPlane(cps.slice(i * 4, i * 4 + 4), tex2mm)
    if (plane) out.push(plane)
  }
  return out
}

// Outline the block a vector stroke is drawing on, as a hint. Reuses the FocusBox
// render (both backends) with the block's exploded mm AABB.
const PICKED_BLOCK_COLOR = [1, 1, 0, 1]
function setPickedBlockHighlight(
  ctrl: NiiVue,
  vol: NVImage,
  chunkIndex: number,
): void {
  const plan = vol.chunkPlan
  if (!plan) return
  const aabb = explodedChunkAABB(
    plan,
    vol.matRAS as Float32Array,
    vol.chunkExplode,
    chunkIndex,
  )
  ctrl.model._pickedBlockBox = aabb
    ? { min: aabb.min, max: aabb.max, color: PICKED_BLOCK_COLOR, thickness: 2 }
    : null
}

// The raster/vector edit-mode priority rule, in one place: when `draw` is enabled
// AND has a bitmap to paint into, it intercepts the pointer and vector annotation
// editing is inert. This keeps 2D slices and 3D exploded blocks resolving the
// conflict the same way (the 2D raster intercept already preceded the annotation
// one, while the 3D vector intercept preceded the raster one).
function rasterDrawWins(ctrl: NiiVue): boolean {
  return ctrl.model.draw.isEnabled && !!ctrl.model.drawingVolume
}

// Enabling both edit modes is a caller error. Warn on the first interaction that
// is actually ambiguous rather than from the `isEnabled` setters — a caller
// legitimately passes through a both-on state while switching tools, so setter-
// time validation of this two-field invariant would cry wolf.
const warnedBothEditModes = new WeakSet<NiiVue>()
function warnIfBothEditModes(ctrl: NiiVue): void {
  if (!ctrl.model.annotation.isEnabled || !rasterDrawWins(ctrl)) return
  if (warnedBothEditModes.has(ctrl)) return
  warnedBothEditModes.add(ctrl)
  log.warn(
    'drawIsEnabled and annotationIsEnabled are both on: raster drawing takes precedence, so vector annotation editing will not fire. Disable one.',
  )
}

// Clear every piece of transient per-drag state. Runs in the pointerup `finally`
// so a throwing stroke finalize cannot strand `isDragging` true (which pauses the
// chunked-volume streaming pump, gated on `!isDragging`) or leave a half-finished
// stroke behind. Also used by pointercancel.
//
// Every statement here is a plain field write EXCEPT the last: the `isDragging`
// setter calls `drawScene()` on the true->false edge. It is deliberately last so
// that a throw from the renderer cannot skip any of the resets above it, and the
// pointerup `finally` releases pointer capture BEFORE calling this.
// Two-finger pinch zoom on touch screens. Touch points are tracked per
// instance; once the second finger lands the pinch owns the gesture until a
// finger lifts, and the single-pointer handlers skip its events.
const _touches = new WeakMap<NiiVue, Map<number, [number, number]>>()
const _pinches = new WeakMap<NiiVue, Pinch>()

function touchDistance(touches: Map<number, [number, number]>): number {
  const [a, b] = [...touches.values()]
  return Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]))
}

/** Track a touch pointer; true when the event belongs to a pinch. */
function pinchPointer(
  ctrl: NiiVue,
  evt: PointerEvent,
  phase: 'down' | 'move' | 'up',
): boolean {
  if (evt.pointerType !== 'touch') return false
  let touches = _touches.get(ctrl)
  if (!touches) {
    touches = new Map()
    _touches.set(ctrl, touches)
  }
  if (phase === 'up') {
    touches.delete(evt.pointerId)
    return _pinches.delete(ctrl)
  }
  if (phase === 'move' && !touches.has(evt.pointerId)) return false
  touches.set(evt.pointerId, [evt.clientX, evt.clientY])
  if (touches.size !== 2) return _pinches.has(ctrl)
  const scene = ctrl.model.scene
  if (phase === 'down') {
    const [a, b] = [...touches.values()]
    const px = clientToBoundsPixel(ctrl, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    const hit = px && ctrl.view?.hitTest(px[0], px[1])
    if (!px || !hit) return false
    // The first finger's drag gives way to the pinch; a half-placed angle is
    // dropped, not placed at the finger.
    ctrl._cancelAngle()
    if (ctrl._activeDragMode !== DRAG_MODE.none)
      DragModes.handleDragRelease(ctrl)
    resetDragState(ctrl)
    _pinches.set(ctrl, {
      distance: touchDistance(touches),
      pan: [...scene.pan2Dxyzmm],
      scale: scene.scaleMultiplier,
      anchorMM: hit.isRender
        ? null
        : resolveWheelZoomAnchorMM(ctrl, px[0], px[1], hit),
    })
    return true
  }
  const pinch = _pinches.get(ctrl)
  if (!pinch) return false
  const camera = pinchCamera(
    pinch,
    touchDistance(touches),
    ctrl.model.extentsMin,
    ctrl.model.extentsMax,
    ctrl.model.interaction.isYoked3DTo2DZoom,
  )
  if (camera.pan2Dxyzmm) {
    for (let i = 0; i < 4; i++) scene.pan2Dxyzmm[i] = camera.pan2Dxyzmm[i]
    emitPan2DChange(ctrl)
  }
  if (camera.scaleMultiplier !== undefined) {
    scene.scaleMultiplier = camera.scaleMultiplier
    emitScaleMultiplierChange(ctrl)
  }
  ctrl.drawScene()
  return true
}

/**
 * A resized shape's polygons at `box`: an erased shape carries what is left
 * of it there; an intact one is drawn afresh. Empty when `box` is degenerate.
 */
function resizedPolygons(
  ctrl: NiiVue,
  type: AnnotationTool,
  box: ShapeBoundsUpdate,
): PolygonWithHoles[] {
  const original = ctrl._resizeOriginalShape
  if (original?.isErased)
    return (
      Annotation.resizePolygons(type, original, box, original.polygons) ?? []
    )
  return Annotation.generateShape(
    type,
    box.start,
    box.end,
    box.width ?? ctrl.model.annotation.style.strokeWidth,
  )
}

// A bidirectional or angle with handle `cpIdx` dragged to `pt`: a
// bidirectional's axes are recomputed on its drawing plane (perpendicular in
// mm on an oblique slice); each arm carries its own polygons, so an erased
// gap stays erased; lengths or angle are measured again.
function resizeTwoLineShape(
  ctrl: NiiVue,
  ann: VectorAnnotation,
  original: NonNullable<NiiVue['_resizeOriginalShape']>,
  cpIdx: number,
  pt: AnnotationPoint,
): void {
  const shape = ann.shape as NonNullable<VectorAnnotation['shape']>
  let box: ShapeBoundsUpdate
  if (isBidirectionalTool(shape.type)) {
    const f = planeFrame(ctrl, ann)
    const onPlane = (p: AnnotationPoint | undefined) => p && f.to(p)
    const b = Annotation.updateShapeBounds(
      shape.type,
      {
        start: f.to(original.start),
        end: f.to(original.end),
        start2: onPlane(original.start2),
        end2: onPlane(original.end2),
      },
      cpIdx,
      f.to(pt),
    )
    box = {
      start: f.from(b.start),
      end: f.from(b.end),
      start2: b.start2 && f.from(b.start2),
      end2: b.end2 && f.from(b.end2),
    }
  } else box = Annotation.updateShapeBounds(shape.type, original, cpIdx, pt)
  const { start2, end2 } = box
  if (!start2 || !end2 || !original.start2 || !original.end2) return
  const w = shape.width ?? ctrl.model.annotation.style.strokeWidth
  const arms: [ShapeBoundsUpdate, ShapeBoundsUpdate][] = [
    [
      { start: original.start, end: original.end, width: w },
      { start: box.start, end: box.end, width: w },
    ],
    [
      { start: original.start2, end: original.end2, width: w },
      { start: start2, end: end2, width: w },
    ],
  ]
  // Each polygon goes with exactly one arm: the one its outline runs along
  // (summed vertex distance; arms crossing at their centres share a centre).
  const spread = (poly: PolygonWithHoles, arm: ShapeBoundsUpdate) =>
    poly.outer.reduce(
      (sum, p) =>
        sum +
        pointToSegmentDistance(
          p.x,
          p.y,
          arm.start.x,
          arm.start.y,
          arm.end.x,
          arm.end.y,
        ),
      0,
    )
  const longPolys: PolygonWithHoles[] = []
  const shortPolys: PolygonWithHoles[] = []
  for (const poly of original.polygons)
    (spread(poly, arms[0][0]) <= spread(poly, arms[1][0])
      ? longPolys
      : shortPolys
    ).push(poly)
  const polygons: PolygonWithHoles[] = []
  for (const [i, [from, to]] of arms.entries()) {
    const own = i === 0 ? longPolys : shortPolys
    const moved = Annotation.resizePolygons('measureLine', from, to, own)
    // A degenerate arm keeps the last valid shape.
    if (!moved) return
    polygons.push(...moved)
  }
  Object.assign(shape, { start: box.start, end: box.end, start2, end2 })
  ann.polygons = polygons
  const stats = { area: 0, min: 0, mean: 0, max: 0, stdDev: 0 }
  ann.stats = isBidirectionalTool(shape.type)
    ? {
        ...stats,
        ...bidirectionalLengths(
          ctrl,
          ann,
          { start: box.start, end: box.end },
          { start: start2, end: end2 },
        ),
      }
    : { ...stats, angle: Annotation.shapeAngle(shape, angleToMM(ctrl, ann)) }
  if (ctrl.model._annotationSelection)
    ctrl.model._annotationSelection.controlPoints =
      Annotation.getControlPoints(shape)
}

export function resetDragState(ctrl: NiiVue): void {
  // A resize that pointerup did not finish (pointercancel, pinch, annotation
  // mode off) is reverted, as a cancel: pointerup alone records its undo step.
  ctrl._revertResize()
  // Vector (annotation) stroke state.
  ctrl._annotation3DActive = false
  ctrl._annotation3DMMPath = []
  ctrl._annotation3DFace = null
  ctrl.model._pickedBlockBox = null
  ctrl._annotationBrushPath = []
  ctrl._frozenLoopPoints = null
  ctrl._annotationShapeStart = null
  // As at pointerup: a grab outside annotation mode leaves nothing selected.
  if (ctrl._resizingControlPoint >= 0 && !ctrl.model.annotation.isEnabled)
    ctrl.model._annotationSelection = null
  ctrl._resizingControlPoint = -1
  ctrl._resizingAnnotation = null
  ctrl._resizeOriginalShape = null
  ctrl._resizeUndoSnapshot = null
  ctrl.model._annotationPreview = null
  ctrl.model._annotationErasePreview = null
  // Raster (draw) stroke state. The 2D pen accumulates `_drawPenFillPts` during
  // the drag and consumes them in the pointerup finalize; if that finalize throws
  // they must not survive, or the NEXT pointerup re-commits the abandoned stroke.
  ctrl._drawPenLocation = [NaN, NaN, NaN]
  ctrl._drawPenAxCorSag = -1
  ctrl._drawPenFillPts = []
  ctrl._draw3DActive = false
  ctrl._draw3DNeedsUndo = false
  ctrl._draw3DLastVoxel = null
  ctrl._draw3DLastChunk = null
  ctrl._draw3DSampleCache = null
  ctrl.activeTileHit = null
  // Last: this setter renders (resumes the chunk-streaming pump).
  ctrl.isDragging = false
}

// Commit a freehand 3D vector stroke (mm points picked off the blocks) as a
// slice annotation. The annotation model is planar, so fit the best axis-aligned
// plane — the axis with the smallest spread is the depth — project the points
// onto it, and create the annotation. It renders explode-aware (tracks its
// block) and exports via annotationsToSVG. Points are un-exploded mm, so the
// stored annotation sits at the block's true position.
function finish3DAnnotationStroke(ctrl: NiiVue): void {
  const pts = ctrl._annotation3DMMPath
  ctrl._annotation3DActive = false
  ctrl._annotation3DMMPath = []
  // Annotation mode turned off (or raster took over) mid-drag: discard the
  // partial stroke rather than committing a shape the user can no longer see
  // themselves drawing.
  if (!ctrl.model.annotation.isEnabled) return
  if (pts.length < 3) return
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ]
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (const p of pts) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a]
      if (p[a] > max[a]) max[a] = p[a]
    }
  }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  let depthAxis = 0
  if (ext[1] < ext[depthAxis]) depthAxis = 1
  if (ext[2] < ext[depthAxis]) depthAxis = 2
  // sliceType is the depth axis inverse: z(2)->AXIAL(0), y(1)->CORONAL(1),
  // x(0)->SAGITTAL(2).
  const sliceType = 2 - depthAxis
  const slicePosition = (min[depthAxis] + max[depthAxis]) / 2
  const outer = pts.map((p) =>
    Annotation.mmToSlice2D([p[0], p[1], p[2]], sliceType),
  )
  // A polygon needs area. Reject a degenerate stroke — one point, or any set of
  // collinear points (an axis-aligned OR diagonal line) — that would otherwise
  // commit an invisible zero-area annotation and an undo entry. Test the actual
  // area of the projected polygon (shoelace) rather than its bounding box, which
  // a diagonal line would pass with two non-zero extents. eps is in mm^2.
  let twiceArea = 0
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i]
    const b = outer[(i + 1) % outer.length]
    twiceArea += a.x * b.y - b.x * a.y
  }
  if (Math.abs(twiceArea) / 2 <= 1e-6) return
  const anchorMM: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  anchorMM[depthAxis] = slicePosition
  const cfg = ctrl.model.annotation
  ctrl._annotationUndoStack.push(ctrl.model.annotations)
  const newAnn = Annotation.createAnnotation(
    cfg.activeLabel,
    cfg.activeGroup,
    sliceType,
    slicePosition,
    [{ outer, holes: [] }],
    cfg.style,
    anchorMM,
  )
  commitAnnotation(ctrl, newAnn, cfg.mergesOverlaps)
  ctrl.drawScene()
}

export function initInteraction(ctrl: NiiVue): void {
  // Prevent browser default touch gestures so pointer events fire instead
  if (ctrl.canvas) ctrl.canvas.style.touchAction = 'none'
  // Store bound handlers for cleanup
  ctrl._eventListeners.contextmenu = (e: Event) => {
    const evt = e as PointerEvent
    if (!evt.shiftKey) {
      evt.preventDefault()
    }
  }
  ctrl._eventListeners.pointerdown = (e: Event) => {
    const evt = e as PointerEvent
    if (pinchPointer(ctrl, evt, 'down')) return
    setNextActionTag('pointerdown')
    // Dismiss thumbnail on click
    if (ctrl.model.ui.isThumbnailVisible) {
      ctrl.isThumbnailVisible = false
      return
    }
    // If Shift is held, don't start dragging to allow context menu
    if (evt.shiftKey) {
      ctrl.isDragging = false
      ctrl.activeTileHit = null
      return
    }
    // Perform hit test to determine which tile was clicked
    const boundsHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
    if (!boundsHit) return // outside this instance's bounds
    const [px, py] = boundsHit
    warnIfBothEditModes(ctrl)

    // Check for legend click first
    const legendLayout = ctrl.view?.legendLayout ?? null
    const page = legendScrollHit(px, py, legendLayout)
    if (page !== null && legendLayout) {
      // Clicking the track pages (the only scroll on touch screens); the
      // thumb is consumed too, so a drag on it never moves the camera.
      if (page !== 0)
        scrollLegend(
          ctrl,
          legendLayout,
          page * Math.max(1, legendLayout.visibleRows - 1),
        )
      return
    }
    const legendHit = legendHitTest(px, py, legendLayout)
    if (legendHit) {
      const { entry, isOnBox } = legendHit
      log.info(`Legend clicked: ${entry.label}`)
      const value = entry.labelValue
      if (
        isOnBox &&
        ctrl.model.interaction.isLegendToggleEnabled &&
        value !== undefined
      ) {
        const hasLabelSource = updateLegendHidden(ctrl, entry, (hidden) =>
          hidden.includes(value)
            ? hidden.filter((v) => v !== value)
            : [...hidden, value],
        )
        if (hasLabelSource) return
      }
      const centroid = entry.centroid?.()
      if (centroid) ctrl.setCrosshairPos(centroid)
      return // Don't process tile interactions if legend was clicked
    }

    // Check for graph click
    const graphHit = handleGraphHitTest(ctrl, px, py)
    if (graphHit) return

    ctrl.activeTileHit = ctrl.view?.hitTest(px, py) ?? null
    // Freehand vector (SVG) drawing directly on the exploded blocks: a RIGHT-drag
    // in vector (annotation) mode picks block points along the drag and, on
    // release, commits them as a slice annotation. Checked before the clip-plane
    // path so right-drag draws the vector shape.
    {
      const annVol = ctrl.model.getVolumes()[0]
      if (
        ctrl.model.annotation.isEnabled &&
        // Raster drawing takes precedence when it can actually draw. This is the
        // one priority rule, and it matches the 2D slice path (whose raster
        // intercept precedes the annotation one). Enabling both edit modes at
        // once is a caller error; `warnIfBothEditModes` (pointerdown) says so.
        !rasterDrawWins(ctrl) &&
        !ctrl.model.annotation.isErasing &&
        ctrl.activeTileHit?.isRender &&
        evt.button === 2 &&
        // Alt+right-drag rotates the clip plane instead of drawing, so both are
        // usable without leaving the draw mode (Shift is reserved for the context
        // menu). Plain right-drag draws.
        !evt.altKey &&
        annVol?.matRAS &&
        annVol.chunkPlan &&
        chunkExplodeEnabled(annVol.chunkExplode) &&
        // The block-face math builds axis-aligned mm planes from a block's mm AABB,
        // which only matches the visible face for an axis-aligned volume. On an
        // oblique/sheared volume the face would be wrong, so don't intercept —
        // right-drag falls through to clip-plane rotation. (Arbitrary-plane
        // annotations are a tracked follow-up.)
        isMatRASAxisAligned(annVol.matRAS as Float32Array)
      ) {
        const face = pickBlockFace(ctrl, annVol)
        ctrl._annotation3DActive = true
        // Lock the stroke to the picked block's front face (an axis-aligned mm
        // plane). null if the first pick missed a block; pointermove establishes
        // it on the first successful pick. Every later point is projected onto
        // this one plane, so the SVG stays flat on that block face.
        ctrl._annotation3DFace = face
        ctrl._annotation3DMMPath = face ? [face.entryMM] : []
        if (face) setPickedBlockHighlight(ctrl, annVol, face.chunkIndex)
        ctrl.isDragging = true
        ctrl.activeButton = evt.button
        ctrl.lastPointerX = evt.clientX
        ctrl.lastPointerY = evt.clientY
        ctrl.canvas?.setPointerCapture(evt.pointerId)
        return
      }
    }
    // 3D drawing on exploded blocks: a RIGHT-click on the render tile paints the
    // block the pick ray hits, leaving left-drag free to rotate the camera.
    // Depth-pick can't see the explode (it ray-marches the un-exploded single
    // texture), so we CPU-ray-cast the exploded chunk AABBs. Only intercept when
    // the active volume is actually exploded, so right-drag still adjusts the
    // clip plane otherwise.
    {
      const drawVol = ctrl.model.getVolumes()[0]
      if (
        ctrl.model.draw.isEnabled &&
        ctrl.model.drawingVolume &&
        ctrl.activeTileHit?.isRender &&
        evt.button === 2 &&
        // Alt+right-drag rotates the clip plane instead of painting (see above).
        !evt.altKey &&
        drawVol?.matRAS &&
        drawVol.chunkPlan &&
        chunkExplodeEnabled(drawVol.chunkExplode)
      ) {
        // Magic wand: a single right-click grows the intensity-similar region
        // from the picked voxel (no drag stroke). Checked before fill mode.
        if (ctrl.model.draw.isClickToSegment) {
          magicWand3DOnExplodedBlock(ctrl, drawVol)
          return
        }
        // Fill mode: a single right-click floods the connected tissue blob at
        // the picked voxel (3D region-grow) — no drag stroke.
        if (ctrl.drawPenFilled) {
          floodFill3DOnExplodedBlock(ctrl, drawVol)
          return
        }
        // Take the undo snapshot on the first painted voxel of this stroke (in
        // draw3DOnExplodedBlock), so starting on a ray-miss doesn't skip it.
        ctrl._draw3DNeedsUndo = true
        const painted = draw3DOnExplodedBlock(ctrl, drawVol, true)
        // Begin a continuous 3D stroke: capture the pointer and mark the drag as
        // a 3D-draw so pointermove paints instead of rotating the clip plane.
        ctrl._draw3DActive = true
        ctrl._draw3DLastVoxel = painted
        ctrl.isDragging = true
        ctrl.activeButton = evt.button
        ctrl.lastPointerX = evt.clientX
        ctrl.lastPointerY = evt.clientY
        ctrl.canvas?.setPointerCapture(evt.pointerId)
        return
      }
    }
    // Drawing intercept: if drawing enabled and click is on a 2D slice
    if (
      ctrl.model.draw.isEnabled &&
      ctrl.model.drawingVolume &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      evt.button === 0
    ) {
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      )
      if (mm) {
        const vol = ctrl.model.getVolumes()[0]
        if (vol) {
          // Magic wand: a single click on the slice grows the intensity-similar
          // region from the picked voxel (no stroke). Checked before the pen. In
          // 2D mode the grow is confined to the clicked slice plane; otherwise it
          // grows through the whole connected 3D structure.
          if (ctrl.model.draw.isClickToSegment) {
            const wandVox = NVTransforms.mm2vox(vol, mm)
            const restrictAxis = ctrl.model.draw.clickToSegmentIs2D
              ? sliceTypeDim(ctrl.activeTileHit.sliceType)
              : undefined
            magicWandFill(
              ctrl,
              vol,
              [
                Math.round(wandVox[0]),
                Math.round(wandVox[1]),
                Math.round(wandVox[2]),
              ],
              restrictAxis,
            )
            ctrl.setCrosshairPos(mm)
            return
          }
          // Save undo state before first stroke
          ctrl.drawAddUndoBitmap()
          // Convert screen → mm → voxel
          const vox = NVTransforms.mm2vox(vol, mm)
          const pt = [
            Math.round(vox[0]),
            Math.round(vox[1]),
            Math.round(vox[2]),
          ]
          ctrl._drawPenLocation = pt
          ctrl._drawPenAxCorSag = ctrl.activeTileHit.sliceType
          ctrl._drawPenFillPts = [pt.slice()]
          drawPoint({
            x: pt[0],
            y: pt[1],
            z: pt[2],
            penValue: ctrl.model.draw.penValue,
            drawBitmap: getDrawingBitmap(ctrl.model.drawingVolume as NVImage),
            dims: vol.dimsRAS as number[],
            penSize: ctrl.model.draw.penSize,
            penShape: ctrl.model.draw.penShape,
            penAxCorSag: ctrl._drawPenAxCorSag,
            penOverwrites: ctrl.model.draw.isFillOverwriting,
            pixDims: vol.pixDimsRAS,
          })
          ctrl.markDrawDirty(pt[0], pt[1], pt[2], ctrl.model.draw.penSize)
          ctrl.refreshDrawing()
          ctrl.setCrosshairPos(mm)
        }
      }
      ctrl.isDragging = true
      ctrl.activeButton = evt.button
      ctrl.lastPointerX = evt.clientX
      ctrl.lastPointerY = evt.clientY
      ctrl.canvas?.setPointerCapture(evt.pointerId)
      return
    }
    // isHandleGrab: a press on any shown shape's handle drags it, whatever the
    // tool, unless a raster pen or a multi-click shape is in progress.
    if (
      ctrl.model.annotation.isHandleGrab &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      evt.button === 0 &&
      !(ctrl.model.annotation.isEnabled && ctrl.model.annotation.isErasing) &&
      ctrl._angleState === 'none' &&
      !ctrl._annotationPolyPoints &&
      !ctrl._bidirectionalLong &&
      !ctrl._annotationClickStart
    ) {
      const grab = handleUnderPointer(ctrl, evt, ctrl.activeTileHit.tileIndex)
      if (grab?.ann.shape) {
        ctrl._annotationSliceType = grab.ann.sliceType
        ctrl.model._annotationSelection = {
          annotationId: grab.ann.id,
          controlPoints: Annotation.getControlPoints(grab.ann.shape),
        }
        startResize(ctrl, evt, grab.ann, grab.cpIdx)
        ctrl.drawScene()
        return
      }
    }
    // Annotation intercept: if annotation mode enabled and click is on a 2D slice
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      evt.button === 0
    ) {
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      )
      if (mm) {
        const sliceType = ctrl.activeTileHit.sliceType
        const depthDim = sliceTypeDim(sliceType)
        const slicePosition = mm[depthDim]
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          sliceType,
        )
        // A bidirectional long axis belongs to the slice it was drawn on; a
        // press on another slice starts the measurement over (#111). Compare
        // texture depths: on an oblique volume the mm depth varies across one
        // slice.
        const mm2tex = ctrl.model.mm2tex
        const dims = ctrl.volumes[0]?.dimsRAS
        if (
          ctrl._bidirectionalLong &&
          (ctrl._annotationSliceType !== sliceType ||
            (mm2tex &&
              dims &&
              Math.abs(
                texDepth(ctrl._annotationAnchorMM, depthDim, mm2tex) -
                  texDepth(mm, depthDim, mm2tex),
              ) >
                0.5 / dims[depthDim + 1]))
        ) {
          ctrl._abandonAnnotationInProgress()
        }
        ctrl._annotationSliceType = sliceType
        ctrl._annotationSlicePosition = slicePosition
        ctrl._annotationAnchorMM = mm as [number, number, number]

        const cfg = ctrl.model.annotation
        const tool = cfg.tool

        // Multi-click contour tools (spline / livewire): each click drops a
        // control point; the contour is closed on double-click (see the dblclick
        // handler) or cancelled with Escape. Do NOT start a drag.
        if (isMultiClickTool(tool) && !cfg.isErasing) {
          // The same slice test as the bidirectional axis above, measured from
          // the contour's first click (mm without a volume).
          const sliceTest: [number, number, number] =
            mm2tex && dims
              ? [
                  texDepth(ctrl._annotationPolyAnchorMM, depthDim, mm2tex),
                  texDepth(mm, depthDim, mm2tex),
                  0.5 / dims[depthDim + 1],
                ]
              : [ctrl._annotationPolySlicePosition, slicePosition, 1e-3]
          const fresh = shouldStartFreshMultiClickContour(
            Boolean(ctrl._annotationPolyPoints),
            ctrl._annotationPolySliceType,
            sliceTest[0],
            sliceType,
            sliceTest[1],
            sliceTest[2],
          )
          if (fresh) {
            // Start a fresh contour (first point, or the user moved to a new
            // slice — abandon the old in-progress contour and begin here).
            ctrl._annotationPolyPoints = []
            ctrl._annotationPolySliceType = sliceType
            ctrl._annotationPolySlicePosition = slicePosition
            ctrl._annotationPolyAnchorMM = mm as [number, number, number]
            resetLivewire(ctrl)
            // As a drag shape does: Delete must not hit an older selection.
            ctrl.model._annotationSelection = null
          }
          const poly = ctrl._annotationPolyPoints as AnnotationPoint[]
          // isClickToPlace (cornerstone's conventions): a click back near the
          // first point closes the contour, as a double-click does.
          if (
            cfg.isClickToPlace &&
            !(tool in ANGLE_CLICKS) &&
            (isLivewireTool(tool) ? ctrl._livewireClicks : poly.length) >= 3 &&
            isNearFirstPoint(ctrl, evt, poly[0] as AnnotationPoint)
          ) {
            // Live wire closes along the snapped path back to the first point
            // (its ends duplicate the last and first vertices), not a chord.
            if (isLivewireTool(tool)) {
              const seg = livewireSnappedPath(ctrl, poly[0] as AnnotationPoint)
              for (let i = 1; i < seg.length - 1; i++) poly.push(seg[i])
            }
            commitMultiClickContour(ctrl)
            ctrl._abandonAnnotationInProgress()
            ctrl.drawScene()
            return
          }
          // The second press of a double-click (which closes the contour via
          // the dblclick handler) and a press coincident with the last placed
          // point must not append: the duplicate point would let a single
          // placed point + double-click pass the >= 3-point commit guard as a
          // degenerate contour, and a normally finished spline would carry a
          // coincident closing pair (a Catmull-Rom cusp at the close point).
          // Angles have no double-click close: a fast second click is a point.
          const append = shouldAppendMultiClickPoint(
            tool in ANGLE_CLICKS ? 1 : evt.detail,
            poly[poly.length - 1],
            pt2d,
            computeTolerance(ctrl.model),
          )
          if (isLivewireTool(tool)) {
            // Counted per placed click, seeded or not: without a slice the
            // contour still places straight points (guarded as any click) and must still close.
            if (fresh || (!ctrl._livewireSeed && append)) {
              seedLivewire(ctrl, pt2d)
              poly.push(pt2d)
              ctrl._livewireClicks++
            } else if (append) {
              // Commit the snapped path from the last seed to this click (drop
              // its first point, a duplicate of the last committed one), then
              // re-seed the live wire here.
              const seg = livewireSnappedPath(ctrl, pt2d)
              for (let i = 1; i < seg.length; i++) poly.push(seg[i])
              seedLivewire(ctrl, pt2d)
              ctrl._livewireClicks++
            }
          } else if (append) {
            poly.push(pt2d)
          }
          if (poly.length === ANGLE_CLICKS[tool]) {
            const ann = angleAnnotation(ctrl, poly)
            if (ann) {
              ctrl._annotationUndoStack.push(ctrl.model.annotations)
              commitAnnotation(ctrl, ann, cfg.mergesOverlaps)
            }
            ctrl._abandonAnnotationInProgress()
            ctrl.drawScene()
            return
          }
          updateMultiClickPreview(ctrl, pt2d)
          ctrl.drawScene()
          return
        }

        // A) Selection/resize check for shape annotations
        if (!cfg.isErasing && tool !== 'freehand') {
          // A press on the slice of a parked click start ends that shape
          // (isClickToPlace), ahead of a selected shape's control points; elsewhere it drops it.
          const parked = ctrl._annotationClickStart
          ctrl._annotationClickStart = null
          ctrl._annotationClickResumed =
            !!parked &&
            parked.sliceType === sliceType &&
            isOnSliceOf(ctrl, parked.anchorMM, mm, depthDim)
          if (parked && ctrl._annotationClickResumed) {
            ctrl._annotationShapeStart = parked.start
            ctrl._annotationSlicePosition = parked.slicePosition
            ctrl._annotationAnchorMM = parked.anchorMM
            startAnnotationDrag(ctrl, evt)
            return
          }
          // Check control point hit on current selection
          if (ctrl.model._annotationSelection) {
            const cpIdx = Annotation.hitTestControlPoint(
              pt2d,
              ctrl.model._annotationSelection.controlPoints,
              2.0,
            )
            if (cpIdx >= 0) {
              const ann = ctrl.model.annotations.find(
                (a) => a.id === ctrl.model._annotationSelection?.annotationId,
              )
              // A probe lands on a region's handle, as anywhere inside it.
              if (
                ann?.shape &&
                isGrabbable(ctrl, ann) &&
                (tool !== 'measurePoint' || ann.shape.type === 'measurePoint')
              ) {
                startResize(ctrl, evt, ann, cpIdx)
                return
              }
            }
          }
          // Hit-test existing shape annotations for selection
          const selTile = (ctrl.view?.screenSlices ?? [])[
            ctrl.activeTileHit.tileIndex
          ]
          const selTolerance = computeTolerance(ctrl.model)
          for (const ann of ctrl.model.annotations) {
            if (!ann.shape) continue
            if (ann.sliceType !== sliceType) continue
            // A probe lands inside a region; only another probe's dot selects.
            if (tool === 'measurePoint' && ann.shape.type !== 'measurePoint')
              continue
            if (!isGrabbable(ctrl, ann)) continue
            if (!isOnTile(ann, selTile, slicePosition, selTolerance)) continue
            if (Annotation.hitTestAnnotationPolygon(pt2d, ann) !== -1) {
              ctrl.model._annotationSelection = {
                annotationId: ann.id,
                controlPoints: Annotation.getControlPoints(ann.shape),
              }
              ctrl.drawScene()
              return
            }
          }
          // No selection hit — clear selection and start a new shape.
          ctrl.model._annotationSelection = null
          ctrl._annotationShapeStart = pt2d
          ctrl._annotationPressClient = [evt.clientX, evt.clientY]
          startAnnotationDrag(ctrl, evt)
          return
        }

        // C) Freehand / eraser mode
        ctrl._annotationBrushPath = [pt2d]
        startAnnotationDrag(ctrl, evt)
        return
      }
    }
    ctrl.isDragging = true
    ctrl.activeButton = evt.button
    // 2D slice tile: dispatch through drag mode system
    if (ctrl.activeTileHit && !ctrl.activeTileHit.isRender) {
      const mode = DragModes.getDragModeForButton(ctrl, evt.button)
      // Another mode, or a press on another tile, drops a half-placed angle
      // (the latter starts a new one there). Before the mode is set: the
      // cancel clears an angle mode.
      if (
        mode !== DRAG_MODE.angle ||
        ctrl._angleArm?.hit.tileIndex !== ctrl.activeTileHit.tileIndex
      ) {
        ctrl._cancelAngle()
      }
      ctrl._activeDragMode = mode
      ctrl._crosshairPanDidDrag = false
      ctrl.dragStartXY = [px, py]
      ctrl.dragEndXY = [px, py]
      // A half-placed angle keeps showing while its second arm is placed.
      if (ctrl._angleState !== 'drawing_second_line') {
        ctrl.model._dragOverlay = null
      }
      if (mode === DRAG_MODE.crosshair) {
        const mm = NVSliceLayout.screenSlicePick(
          ctrl.view?.screenSlices ?? [],
          ctrl.model,
          px,
          py,
          ctrl.activeTileHit,
        )
        if (mm) ctrl.setCrosshairPos(mm)
      } else if (
        mode === DRAG_MODE.pan ||
        mode === DRAG_MODE.slicer3D ||
        mode === DRAG_MODE.crosshairPan
      ) {
        const p = ctrl.model.scene.pan2Dxyzmm
        ctrl._pan2DxyzmmAtDragStart = [p[0], p[1], p[2], p[3]]
      } else if (mode === DRAG_MODE.angle) {
        if (ctrl._angleState !== 'drawing_second_line') {
          ctrl._angleState = 'drawing_first_line'
        }
      }
    }
    ctrl.lastPointerX = evt.clientX
    ctrl.lastPointerY = evt.clientY
    // Capture the pointer so pointermove/pointerup fire on the canvas
    // even when the pointer moves outside it
    ctrl.canvas?.setPointerCapture(evt.pointerId)
  }
  ctrl._eventListeners.pointerup = (e: Event) => {
    const evt = e as PointerEvent
    if (pinchPointer(ctrl, evt, 'up')) return
    setNextActionTag('pointerup')
    // Stroke finalize (below) can throw. Cleanup lives in the `finally` so an
    // interrupted finalize cannot strand `isDragging`/pointer capture; the
    // pointerUp emits run after, and are intentionally skipped on a throw.
    try {
      // Finalize drawing stroke on mouse-up
      if (
        ctrl.model.draw.isEnabled &&
        ctrl._drawPenFillPts.length > 0 &&
        ctrl.model.drawingVolume
      ) {
        const vol = ctrl.model.getVolumes()[0]
        if (vol?.dimsRAS) {
          if (ctrl.drawPenAutoClose && ctrl._drawPenFillPts.length > 2) {
            penLineTo(ctrl, vol, ctrl._drawPenFillPts[0])
          }
          if (ctrl.drawPenFilled && ctrl._drawPenFillPts.length > 2) {
            const currentUndo =
              ctrl.drawUndoBitmaps[ctrl.currentDrawUndoBitmap] ?? null
            const fillResult = drawPenFilled({
              penFillPts: ctrl._drawPenFillPts,
              penAxCorSag: ctrl._drawPenAxCorSag,
              drawBitmap: getDrawingBitmap(ctrl.model.drawingVolume as NVImage),
              dims: vol.dimsRAS,
              penValue: ctrl.model.draw.penValue,
              fillOverwrites: ctrl.model.draw.isFillOverwriting,
              currentUndoBitmap: currentUndo,
            })
            if (fillResult.success) {
              ;(ctrl.model.drawingVolume as NVImage).img = fillResult.drawBitmap
            }
          }
          const penSize = ctrl.model.draw.penSize
          for (const p of ctrl._drawPenFillPts) {
            ctrl.markDrawDirty(p[0], p[1], p[2], penSize)
          }
          ctrl.refreshDrawing()
        }
        ctrl._drawPenLocation = [NaN, NaN, NaN]
        ctrl._drawPenAxCorSag = -1
        ctrl._drawPenFillPts = []
        ctrl._emitDrawingChanged('stroke', true)
      }
      // Finalize resize on mouse-up
      if (ctrl._resizingControlPoint >= 0) {
        const sel = ctrl.model._annotationSelection
        const ann = ctrl._resizingAnnotation
        // A move replaces the polygons: a click on a handle changed nothing
        // and records no step.
        if (sel && ann?.polygons !== ctrl._resizeOriginalShape?.polygons) {
          if (ann?.shape) {
            // The last move already set the polygons and control points (and
            // a two-line shape's stats, which need its drawing plane).
            if (
              Annotation.isMeasureTool(ann.shape.type) &&
              !Annotation.isTwoLineShape(ann.shape.type)
            ) {
              const vol = ctrl.model.getVolumes()[0]
              if (vol)
                ann.stats =
                  Annotation.computeAnnotationStats(
                    ann,
                    vol,
                    ctrl.model.annotation.isAreaGeometric,
                  ) ?? undefined
            }
            if (ctrl._resizeUndoSnapshot)
              ctrl._annotationUndoStack.push(ctrl._resizeUndoSnapshot)
            ctrl.emit('annotationChanged', {
              action: 'resize',
              added: [],
              updated: [ann.id],
              removed: [],
            })
          }
        }
        // A grab outside annotation mode leaves nothing selected (no handles
        // to linger, nothing for Delete to remove).
        if (!ctrl.model.annotation.isEnabled)
          ctrl.model._annotationSelection = null
        ctrl._resizingControlPoint = -1
        ctrl._resizeOriginalShape = null
        ctrl._resizeUndoSnapshot = null
        ctrl._resizingAnnotation = null
        ctrl.model._annotationPreview = null
        ctrl.drawScene()
      }
      // Finalize shape creation on mouse-up
      if (ctrl.model.annotation.isEnabled && ctrl._annotationShapeStart) {
        const shapeHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
        if (shapeHit && ctrl.activeTileHit && !ctrl.activeTileHit.isRender) {
          const mm = NVSliceLayout.screenSlicePick(
            ctrl.view?.screenSlices ?? [],
            ctrl.model,
            shapeHit[0],
            shapeHit[1],
            ctrl.activeTileHit,
          )
          if (mm) {
            let pt2d = Annotation.mmToSlice2D(
              mm as [number, number, number],
              ctrl._annotationSliceType,
            )
            const cfg = ctrl.model.annotation
            let start = ctrl._annotationShapeStart
            const [pressX, pressY] = ctrl._annotationPressClient
            if (cfg.tool === 'measurePoint') {
              // A point lands where the button is released.
              start = pt2d
            } else if (
              cfg.isClickToPlace &&
              !ctrl._annotationClickResumed &&
              Math.hypot(evt.clientX - pressX, evt.clientY - pressY) <= CLICK_PX
            ) {
              // A click: park the start; the next press ends the shape.
              ctrl._annotationClickStart = {
                start,
                sliceType: ctrl._annotationSliceType,
                slicePosition: ctrl._annotationSlicePosition,
                anchorMM: ctrl._annotationAnchorMM,
              }
            } else {
              ;[start, pt2d] = Annotation.dragCorners(
                cfg.tool,
                start,
                pt2d,
                cfg.isDrawnFromCenter,
              )
            }
            if (ctrl._annotationClickStart) {
              // Parked: nothing to commit yet.
            } else if (isBidirectionalTool(cfg.tool)) {
              // First drag places the long axis; the second commits the pair.
              // Click-to-place commits the long axis with an automatic short one.
              const drag: Axis = { start, end: pt2d }
              if (ctrl._bidirectionalLong) {
                commitBidirectional(ctrl, ctrl._bidirectionalLong, drag)
                ctrl._bidirectionalLong = null
              } else if (cfg.isClickToPlace) {
                commitBidirectional(ctrl, drag, autoShortAxis(ctrl, drag))
              } else {
                ctrl._bidirectionalLong = drag
              }
            } else {
              const polygons = Annotation.generateShape(
                cfg.tool,
                start,
                pt2d,
                cfg.style.strokeWidth,
              )
              if (polygons.length > 0) {
                ctrl._annotationUndoStack.push(ctrl.model.annotations)
                const newAnn = Annotation.createAnnotation(
                  cfg.activeLabel,
                  cfg.activeGroup,
                  ctrl._annotationSliceType,
                  ctrl._annotationSlicePosition,
                  polygons,
                  cfg.style,
                  ctrl._annotationAnchorMM,
                )
                const shapeData: typeof newAnn.shape = {
                  type: cfg.tool,
                  start,
                  end: pt2d,
                }
                // A point samples where it was released, not the press.
                if (cfg.tool === 'measurePoint')
                  newAnn.anchorMM = [mm[0], mm[1], mm[2]]
                if (
                  cfg.tool === 'line' ||
                  cfg.tool === 'arrow' ||
                  cfg.tool === 'measureLine' ||
                  cfg.tool === 'measurePoint'
                ) {
                  shapeData.width = cfg.style.strokeWidth
                }
                newAnn.shape = shapeData
                commitAnnotation(ctrl, newAnn, cfg.mergesOverlaps)
              }
            }
          }
        }
        ctrl._annotationShapeStart = null
        // Keep the long axis on screen while waiting for the short-axis drag.
        ctrl.model._annotationPreview = ctrl._bidirectionalLong
          ? bidirectionalAnnotation(ctrl, ctrl._bidirectionalLong, null)
          : null
        ctrl.drawScene()
      }
      // Finalize annotation stroke on mouse-up (freehand/eraser)
      if (
        ctrl.model.annotation.isEnabled &&
        ctrl._annotationBrushPath.length > 0
      ) {
        if (ctrl._annotationBrushPath.length > 1) {
          // Save undo snapshot before modifying annotations
          ctrl._annotationUndoStack.push(ctrl.model.annotations)
          const cfg = ctrl.model.annotation
          if (cfg.isErasing) {
            // Commit the erase preview (already computed during pointermove)
            const preview = ctrl.model._annotationErasePreview
            const beforeErase = ctrl.model.annotations
            if (preview) {
              // An erased measurement re-measures what is left (#115); the
              // preview keeps untouched annotations by identity.
              const vol = ctrl.model.getVolumes()[0]
              const before = new Set(ctrl.model.annotations)
              ctrl.model.annotations = preview.map((ann) =>
                vol &&
                !before.has(ann) &&
                ann.shape &&
                Annotation.isMeasureTool(ann.shape.type)
                  ? {
                      ...ann,
                      stats:
                        Annotation.computeAnnotationStats(
                          ann,
                          vol,
                          ctrl.model.annotation.isAreaGeometric,
                        ) ?? undefined,
                    }
                  : ann,
              )
            }
            ctrl.emit('annotationChanged', {
              action: 'erase',
              ...annotationDelta(beforeErase, ctrl.model.annotations),
            })
          } else {
            const usePolygonMode = cfg.brushRadius <= 1
            let polygons: PolygonWithHoles[] = []
            if (usePolygonMode) {
              // Polygon mode: use frozen loop or auto-close path
              const pts = ctrl._frozenLoopPoints ?? ctrl._annotationBrushPath
              if (pts.length >= 3) {
                polygons = [{ outer: pts, holes: [] }]
              }
            } else {
              // Brush mode: inflate path
              polygons = Annotation.clipperInflatePath(
                ctrl._annotationBrushPath,
                cfg.brushRadius,
              )
            }
            if (polygons.length > 0) {
              const newAnn = Annotation.createAnnotation(
                cfg.activeLabel,
                cfg.activeGroup,
                ctrl._annotationSliceType,
                ctrl._annotationSlicePosition,
                polygons,
                cfg.style,
                ctrl._annotationAnchorMM,
              )
              commitAnnotation(ctrl, newAnn, cfg.mergesOverlaps)
            }
          }
          ctrl.drawScene()
        }
      }
      // Handle drag mode release for 2D slices
      if (ctrl._activeDragMode !== DRAG_MODE.none) {
        // `dragEndXY` is only written by pointerdown and pointermove, so a
        // click whose release lands away from the last move point (coalesced
        // moves, or no moves at all) would place the crosshair at a stale
        // point. Refresh it from the release coordinates for crosshairPan
        // only: measurement/angle/ROI release semantics expect the last
        // in-bounds move point, and a null hit (released outside the tile
        // bounds under pointer capture) keeps the last known point.
        if (ctrl._activeDragMode === DRAG_MODE.crosshairPan) {
          const upHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
          if (upHit) ctrl.dragEndXY = [upHit[0], upHit[1]]
        }
        DragModes.handleDragRelease(ctrl)
      }
      // Commit a freehand vector stroke drawn on the 3D blocks (clears its state).
      if (ctrl._annotation3DActive) finish3DAnnotationStroke(ctrl)
    } finally {
      // Release capture FIRST: `resetDragState` ends by clearing `isDragging`,
      // whose setter renders, and a throw from the renderer must not strand the
      // pointer captured on the canvas (every later pointer event would retarget).
      try {
        ctrl.canvas?.releasePointerCapture(evt.pointerId)
      } catch {
        /* already released */
      }
      // End a 3D exploded-block stroke + every other transient drag field.
      resetDragState(ctrl)
    }
    // Emit high-level slice pointer event for extensions
    const sliceEvt = computeSlicePointerEvent(ctrl, evt)
    if (sliceEvt) {
      ctrl.emit(
        'slicePointerUp' as keyof import('@/NVEvents').NVEventMap,
        sliceEvt as never,
      )
    }
    ctrl.emit('pointerUp', {
      x: evt.offsetX,
      y: evt.offsetY,
      button: evt.button,
    })
  }
  // A pointer can be cancelled (touch interrupted, palm rejection, browser
  // gesture) WITHOUT a pointerup. Reset the drag state so an interrupted drag
  // does not leave isDragging stuck true — which would keep the chunked-volume
  // streaming pump paused (it is gated on !isDragging) and stall streaming.
  ctrl._eventListeners.pointercancel = (e: Event) => {
    pinchPointer(ctrl, e as PointerEvent, 'up')
    // The browser took over: drop a half-placed angle rather than place it.
    ctrl._cancelAngle()
    if (ctrl._activeDragMode !== DRAG_MODE.none) {
      // A cancelled crosshair-pan gesture must not place the crosshair: the
      // browser took over (touch scroll, palm rejection), so the release point
      // is not where the user meant to click.
      if (ctrl._activeDragMode === DRAG_MODE.crosshairPan) {
        ctrl._crosshairPanDidDrag = true
      }
      DragModes.handleDragRelease(ctrl)
    }
    try {
      // Commit the stroke, as pointerup does. A raster stroke paints incrementally
      // so its voxels already survive a cancel; a vector stroke only exists in the
      // accumulator, and dropping it here would silently lose a finished polygon
      // whenever touch/pen input ends in pointercancel instead of pointerup. The
      // degenerate guards in finish3DAnnotationStroke discard a palm-reject.
      if (ctrl._annotation3DActive) finish3DAnnotationStroke(ctrl)
    } finally {
      // Release capture before resetDragState, which renders (see pointerup).
      try {
        ctrl.canvas?.releasePointerCapture((e as PointerEvent).pointerId)
      } catch {
        /* already released */
      }
      resetDragState(ctrl)
    }
  }
  ctrl._eventListeners.pointermove = (e: Event) => {
    const evt = e as PointerEvent
    if (pinchPointer(ctrl, evt, 'move')) return
    ctrl._pointerClient = [evt.clientX, evt.clientY]
    setNextActionTag(ctrl.isDragging ? 'drag' : 'pointermove')
    // Annotation brush cursor preview (hover, no drag required)
    if (ctrl.model.annotation.isEnabled && !ctrl.isDragging) {
      const hit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (hit) {
        const tileHit = ctrl.view?.hitTest(hit[0], hit[1]) ?? null
        if (tileHit && !tileHit.isRender) {
          const mm = NVSliceLayout.screenSlicePick(
            ctrl.view?.screenSlices ?? [],
            ctrl.model,
            hit[0],
            hit[1],
            tileHit,
          )
          if (mm) {
            const sliceType = tileHit.sliceType
            const depthDim = sliceTypeDim(sliceType)
            ctrl.model._annotationCursor = {
              mm: mm as [number, number, number],
              sliceType,
              slicePosition: mm[depthDim],
            }
            // Multi-click contour in progress: preview the spline through the
            // placed points plus the hovered cursor (same slice only).
            if (
              ctrl._annotationPolyPoints &&
              isMultiClickTool(ctrl.model.annotation.tool) &&
              sliceType === ctrl._annotationPolySliceType
            ) {
              const pt2d = Annotation.mmToSlice2D(
                mm as [number, number, number],
                sliceType,
              )
              updateMultiClickPreview(ctrl, pt2d)
            }
            // Parked click start (isClickToPlace): rubber-band to the cursor.
            const parked = ctrl._annotationClickStart
            if (
              parked &&
              parked.sliceType === sliceType &&
              isOnSliceOf(ctrl, parked.anchorMM, mm, depthDim)
            ) {
              const end = Annotation.mmToSlice2D(
                mm as [number, number, number],
                sliceType,
              )
              if (isBidirectionalTool(ctrl.model.annotation.tool)) {
                // The parked axis is the long one (click-to-place previews its
                // automatic short axis), or the short one once the long is placed.
                const axis = { start: parked.start, end }
                const long = ctrl._bidirectionalLong
                ctrl.model._annotationPreview = bidirectionalAnnotation(
                  ctrl,
                  long ?? axis,
                  long ? axis : autoShortAxis(ctrl, axis, parked),
                  parked,
                )
              } else
                updateShapePreview(
                  ctrl,
                  parked.start,
                  end,
                  sliceType,
                  parked.slicePosition,
                  parked.anchorMM,
                )
            } else if (parked) ctrl.model._annotationPreview = null
            ctrl.drawScene()
            return
          }
        }
      }
      if (clearHover(ctrl)) ctrl.drawScene()
      return
    }
    if (!ctrl.isDragging) {
      // An angle's second arm follows the pointer until a click places it.
      if (ctrl._angleState === 'drawing_second_line') {
        const hover = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
        const tile = hover && ctrl.view?.hitTest(hover[0], hover[1])
        if (hover && tile?.tileIndex === ctrl._angleArm?.hit.tileIndex) {
          ctrl.dragEndXY = [hover[0], hover[1]]
          DragModes.updateDragOverlay(ctrl)
          ctrl.drawScene()
        }
      }
      // Emit high-level slice pointer event for extensions
      const sliceEvt = computeSlicePointerEvent(ctrl, evt)
      if (sliceEvt) {
        ctrl.emit(
          'slicePointerMove' as keyof import('@/NVEvents').NVEventMap,
          sliceEvt as never,
        )
      }
      return
    }
    const deltaX = evt.clientX - ctrl.lastPointerX
    const deltaY = evt.clientY - ctrl.lastPointerY
    if (deltaX === 0 && deltaY === 0) return
    ctrl.lastPointerX = evt.clientX
    ctrl.lastPointerY = evt.clientY
    // 3D vector drag on exploded blocks: re-hit-test and accumulate the picked
    // block point (mm) into the freehand path. Runs before the clip-plane branch
    // so a vector drag draws instead of rotating the clip plane. Gated on the
    // live mode (mirroring the raster drag branch below) so disabling annotation
    // mid-drag stops extending the path.
    if (ctrl._annotation3DActive && ctrl.model.annotation.isEnabled) {
      const annVol = ctrl.model.getVolumes()[0]
      const moveHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (moveHit && annVol) {
        const tileHit = ctrl.view?.hitTest(moveHit[0], moveHit[1]) ?? null
        if (tileHit?.isRender) {
          ctrl.activeTileHit = tileHit
          if (!ctrl._annotation3DFace) {
            // pointer-down missed a block; establish the face on the first hit.
            const face = pickBlockFace(ctrl, annVol)
            if (face) {
              ctrl._annotation3DFace = face
              ctrl._annotation3DMMPath.push(face.entryMM)
              setPickedBlockHighlight(ctrl, annVol, face.chunkIndex)
            }
          } else {
            // Project the cursor ray onto the locked face plane (clamped to the
            // block's face rectangle), so the whole stroke stays flat on that one
            // block face regardless of where the cursor wanders.
            const ray = explodedPickRay(ctrl, annVol)
            const mm = ray
              ? rayBlockFacePointMM(ctrl._annotation3DFace, ray.origin, ray.dir)
              : null
            if (mm) ctrl._annotation3DMMPath.push(mm)
          }
        }
      }
      return
    }
    // 3D drawing drag on exploded blocks: re-hit-test at the current pointer and
    // paint (pen or eraser) the block the ray now hits, connecting to the last
    // painted voxel. Runs before the render-tile clip-plane branch so a 3D-draw
    // drag paints instead of rotating the clip plane.
    if (ctrl._draw3DActive && ctrl.model.draw.isEnabled) {
      const drawVol = ctrl.model.getVolumes()[0]
      const moveHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (moveHit && drawVol) {
        const tileHit = ctrl.view?.hitTest(moveHit[0], moveHit[1]) ?? null
        if (tileHit?.isRender) {
          ctrl.activeTileHit = tileHit
          const painted = draw3DOnExplodedBlock(ctrl, drawVol, false)
          if (painted) ctrl._draw3DLastVoxel = painted
        }
      }
      return
    }
    // Drawing drag: paint along stroke
    if (
      ctrl.model.draw.isEnabled &&
      ctrl._drawPenAxCorSag >= 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      ctrl.model.drawingVolume
    ) {
      const drawHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (!drawHit) return
      const [px, py] = drawHit
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      )
      if (mm) {
        const vol = ctrl.model.getVolumes()[0]
        if (vol?.dimsRAS) {
          const vox = NVTransforms.mm2vox(vol, mm)
          const newPt = [
            Math.round(vox[0]),
            Math.round(vox[1]),
            Math.round(vox[2]),
          ]
          if (!isSamePoint(ctrl._drawPenLocation, newPt)) {
            penLineTo(ctrl, vol, newPt)
            const penSize = ctrl.model.draw.penSize
            ctrl.markDrawDirty(
              ctrl._drawPenLocation[0],
              ctrl._drawPenLocation[1],
              ctrl._drawPenLocation[2],
              penSize,
            )
            ctrl.markDrawDirty(newPt[0], newPt[1], newPt[2], penSize)
            ctrl._drawPenLocation = newPt
            ctrl._drawPenFillPts.push(newPt.slice())
            ctrl.refreshDrawing()
            ctrl.setCrosshairPos(mm)
          }
        }
      }
      return
    }
    // Annotation resize drag (also isHandleGrab with annotation mode off)
    if (
      ctrl._resizingControlPoint >= 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const resHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (!resHit) return
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        resHit[0],
        resHit[1],
        ctrl.activeTileHit,
      )
      if (mm && ctrl._resizeOriginalShape && ctrl.model._annotationSelection) {
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          ctrl._annotationSliceType,
        )
        const ann = ctrl._resizingAnnotation
        if (ann?.shape) {
          if (Annotation.isTwoLineShape(ann.shape.type)) {
            resizeTwoLineShape(
              ctrl,
              ann,
              ctrl._resizeOriginalShape,
              ctrl._resizingControlPoint,
              pt2d,
            )
            ctrl.drawScene()
            return
          }
          const newBox = Annotation.updateShapeBounds(
            ann.shape.type,
            ctrl._resizeOriginalShape,
            ctrl._resizingControlPoint,
            pt2d,
          )
          const polygons = resizedPolygons(ctrl, ann.shape.type, newBox)
          // A degenerate box keeps the last valid bounds and polygons.
          if (polygons.length > 0) {
            ann.shape.start = newBox.start
            ann.shape.end = newBox.end
            // A moved point samples its picked 3D position (oblique slices).
            if (ann.shape.type === 'measurePoint')
              ann.anchorMM = [mm[0], mm[1], mm[2]]
            if (newBox.width !== undefined) ann.shape.width = newBox.width
            ann.polygons = polygons
            ctrl.model._annotationSelection.controlPoints =
              Annotation.getControlPoints(ann.shape)
          }
          ctrl.drawScene()
        }
      }
      return
    }
    // Annotation shape drag: preview shape from start to current
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._annotationShapeStart &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const shpHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (!shpHit) return
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        shpHit[0],
        shpHit[1],
        ctrl.activeTileHit,
      )
      if (mm) {
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          ctrl._annotationSliceType,
        )
        if (isBidirectionalTool(ctrl.model.annotation.tool)) {
          bidirectionalPreview(ctrl, pt2d)
          ctrl.drawScene()
          return
        }
        updateShapePreview(
          ctrl,
          ctrl._annotationShapeStart,
          pt2d,
          ctrl._annotationSliceType,
          ctrl._annotationSlicePosition,
          ctrl._annotationAnchorMM,
        )
        ctrl.drawScene()
      }
      return
    }
    // Annotation drag: accumulate brush path (freehand/eraser)
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._annotationBrushPath.length > 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const annHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (!annHit) return
      const [px, py] = annHit
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      )
      if (mm) {
        const sliceType = ctrl.activeTileHit.sliceType
        const depthDim = sliceTypeDim(sliceType)
        ctrl.model._annotationCursor = {
          mm: mm as [number, number, number],
          sliceType,
          slicePosition: mm[depthDim],
        }
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          sliceType,
        )
        const lastPt =
          ctrl._annotationBrushPath[ctrl._annotationBrushPath.length - 1]
        if (lastPt) {
          const dist = Math.sqrt(
            (pt2d.x - lastPt.x) ** 2 + (pt2d.y - lastPt.y) ** 2,
          )
          if (dist > 0.1) {
            ctrl._annotationBrushPath.push(pt2d)
            if (ctrl._annotationBrushPath.length > 1) {
              const cfg = ctrl.model.annotation
              const usePolygonMode = cfg.brushRadius <= 1
              if (cfg.isErasing) {
                // Erase preview
                const erasePreview: VectorAnnotation[] = []
                const eraseTile = (ctrl.view?.screenSlices ?? [])[
                  ctrl.activeTileHit?.tileIndex
                ]
                const eraseTolerance = computeTolerance(ctrl.model)
                // The brush reaches its path's bounds plus its radius. A
                // polygon beyond that is not clipped, and an annotation with
                // none clipped keeps its identity, so the commit does not
                // re-measure it (#486).
                const reach = pointsBounds(ctrl._annotationBrushPath)
                const r = cfg.brushRadius
                const isOutOfReach = (ring: readonly AnnotationPoint[]) => {
                  const b = pointsBounds(ring)
                  return (
                    b.start.x > reach.end.x + r ||
                    b.end.x < reach.start.x - r ||
                    b.start.y > reach.end.y + r ||
                    b.end.y < reach.start.y - r
                  )
                }
                for (const ann of ctrl.model.annotations) {
                  // A shape the host hides is not erased either.
                  if (
                    ann.sliceType !== ctrl._annotationSliceType ||
                    !isOnTile(
                      ann,
                      eraseTile,
                      ctrl._annotationSlicePosition,
                      eraseTolerance,
                    ) ||
                    !isGrabbable(ctrl, ann)
                  ) {
                    erasePreview.push(ann)
                    continue
                  }
                  const newPolys = []
                  let isClipped = false
                  for (const poly of ann.polygons) {
                    if (isOutOfReach(poly.outer)) {
                      newPolys.push(poly)
                      continue
                    }
                    isClipped = true
                    newPolys.push(
                      ...Annotation.clipperSubtractBrush(
                        poly,
                        ctrl._annotationBrushPath,
                        cfg.brushRadius,
                      ),
                    )
                  }
                  if (!isClipped) {
                    erasePreview.push(ann)
                    continue
                  }
                  if (newPolys.length > 0) {
                    erasePreview.push({ ...ann, polygons: newPolys })
                  }
                }
                ctrl.model._annotationErasePreview = erasePreview
              } else if (usePolygonMode) {
                // Polygon mode: detect self-intersection for auto-close
                if (
                  !ctrl._frozenLoopPoints &&
                  ctrl._annotationBrushPath.length >= 4
                ) {
                  const ix = Annotation.findFirstSelfIntersection(
                    ctrl._annotationBrushPath,
                  )
                  if (ix) {
                    ctrl._frozenLoopPoints = Annotation.extractClosedLoop(
                      ctrl._annotationBrushPath,
                      ix,
                    )
                  }
                }
                // Preview: use frozen loop or auto-close the current path
                const previewPts =
                  ctrl._frozenLoopPoints ?? ctrl._annotationBrushPath
                if (previewPts.length >= 3) {
                  const poly: PolygonWithHoles = {
                    outer: previewPts,
                    holes: [],
                  }
                  ctrl.model._annotationPreview = Annotation.createAnnotation(
                    cfg.activeLabel,
                    cfg.activeGroup,
                    ctrl._annotationSliceType,
                    ctrl._annotationSlicePosition,
                    [poly],
                    cfg.style,
                    ctrl._annotationAnchorMM,
                  )
                }
              } else {
                // Brush mode: inflate path
                const inflated = Annotation.clipperInflatePath(
                  ctrl._annotationBrushPath,
                  cfg.brushRadius,
                )
                if (inflated.length > 0) {
                  ctrl.model._annotationPreview = Annotation.createAnnotation(
                    cfg.activeLabel,
                    cfg.activeGroup,
                    ctrl._annotationSliceType,
                    ctrl._annotationSlicePosition,
                    inflated,
                    cfg.style,
                    ctrl._annotationAnchorMM,
                  )
                }
              }
              ctrl.drawScene()
            }
          }
        }
      }
      return
    }
    // 2D slice tiles: dispatch through drag mode system
    if (
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      ctrl._activeDragMode !== DRAG_MODE.none
    ) {
      const sliceHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
      if (!sliceHit) return
      const [px, py] = sliceHit
      ctrl.dragEndXY = [px, py]

      switch (ctrl._activeDragMode) {
        case DRAG_MODE.crosshair: {
          const mm = NVSliceLayout.screenSlicePick(
            ctrl.view?.screenSlices ?? [],
            ctrl.model,
            px,
            py,
            ctrl.activeTileHit,
          )
          if (mm) ctrl.setCrosshairPos(mm)
          break
        }
        case DRAG_MODE.pan:
          DragModes.dragForPanZoom(ctrl)
          ctrl.drawScene()
          break
        case DRAG_MODE.crosshairPan:
          if (DragModes.dragForCrosshairPan(ctrl)) ctrl.drawScene()
          break
        case DRAG_MODE.slicer3D:
          DragModes.dragForSlicer3D(ctrl)
          ctrl.drawScene()
          break
        case DRAG_MODE.windowing:
          DragModes.dragForWindowing(ctrl, deltaX, deltaY)
          ctrl.drawScene()
          break
        case DRAG_MODE.slice:
          DragModes.dragForSlice(ctrl)
          break
        case DRAG_MODE.contrast:
        case DRAG_MODE.measurement:
        case DRAG_MODE.callbackOnly:
        case DRAG_MODE.roiSelection:
        case DRAG_MODE.angle:
          DragModes.updateDragOverlay(ctrl)
          ctrl.drawScene()
          break
        // DRAG_MODE.none: do nothing
      }
      return
    }
    // 3D render tiles: existing rotation/clip behavior
    if (ctrl.activeButton === 2) {
      const dae = ctrl.getClipPlaneDepthAziElev(ctrl.activeClipPlaneIndex)
      dae[1] += deltaX
      dae[2] -= deltaY
      ctrl.setClipPlaneDepthAziElev(
        dae[0],
        dae[1],
        dae[2],
        ctrl.activeClipPlaneIndex,
      )
      ctrl.drawScene()
      return
    }
    // Pan / zoom as the primary drag move the 3D view rather than rotate it.
    const renderMode =
      ctrl.activeButton === 0
        ? ctrl.model.interaction.primaryDragMode
        : DRAG_MODE.none
    if (renderMode === DRAG_MODE.pan || renderMode === DRAG_MODE.slicer3D) {
      if (renderMode === DRAG_MODE.pan) {
        const tile =
          ctrl.view?.screenSlices?.[ctrl.activeTileHit?.tileIndex ?? -1]
        const [, , w = 1, h = 1] = tile?.leftTopWidthHeight ?? []
        // renderPan is clip space: a tile spans 2 units.
        const dpr = ctrl.effectiveDevicePixelRatio
        const p = ctrl.model.scene.renderPan
        ctrl.renderPan = [
          p[0] + (2 * deltaX * dpr) / w,
          p[1] - (2 * deltaY * dpr) / h,
        ]
      }
      // ponytail: 2D zoom not yoked here (pinch yokes it); add if asked.
      else
        ctrl.scaleMultiplier = clampScale3D(
          ctrl.model.scene.scaleMultiplier * Math.exp(-deltaY * 0.01),
          ctrl.model.scene.scaleMultiplier,
        )
      ctrl.drawScene()
      return
    }
    const sensitivity = 0.5
    ctrl.model.scene.azimuth =
      (((ctrl.model.scene.azimuth + deltaX * sensitivity) % 360) + 360) % 360
    ctrl.model.scene.elevation = Math.max(
      -90,
      Math.min(90, ctrl.model.scene.elevation + deltaY * sensitivity),
    )
    emitOrientationChange(ctrl)
    ctrl.drawScene()
  }
  ctrl._eventListeners.wheel = (e: Event) => {
    const evt = e as WheelEvent
    // Perform hit test to determine which tile the wheel event is on
    const wheelHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
    if (!wheelHit) return // outside this instance's bounds
    setNextActionTag('wheel')
    evt.preventDefault()
    const [px, py] = wheelHit
    const legendLayout = ctrl.view?.legendLayout ?? null
    if (
      legendLayout &&
      isLegendScrollable(legendLayout) &&
      isInLegend(px, py, legendLayout)
    ) {
      // The position keeps fractional rows (the layout shows whole ones), so
      // small trackpad deltas add up instead of being lost. Pixel deltas are
      // CSS px; line and page deltas (Firefox, some mice) are not.
      const rows =
        evt.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? evt.deltaY
          : evt.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? evt.deltaY * legendLayout.visibleRows
            : (evt.deltaY * ctrl.effectiveDevicePixelRatio) / legendLayout.pitch
      scrollLegend(ctrl, legendLayout, rows)
      return
    }
    // Wheel over the 4D timeline graph: step to previous/next frame
    const graphLayout = ctrl.view?.graphLayout as GraphLayout | null
    if (graphLayout && graphHitTest(px, py, graphLayout)) {
      // Target the associated volume (matches graph-click scrubbing) when a
      // physio signal is bound to one, else the background volume.
      const vol = ctrl.model.getAssociatedVolume() ?? ctrl.volumes[0]
      const delta = evt.deltaY > 0 ? 1 : -1
      if (vol?.id && (vol.nFrame4D ?? 1) > 1) {
        // Spatial 4D volume: discrete per-frame stepping takes precedence.
        // setFrame4D keeps the marker in the zoom window (ensureGraphCursorVisible).
        ctrl
          .setFrame4D(vol.id, (vol.frame4D ?? 0) + delta)
          .catch((e) => log.error('setFrame4D failed', e))
      } else if (ctrl.signals.length > 0) {
        // Fallback for a non-spatial signal graph: scrub the cursor. Negated so
        // the marker moves on screen the same way the 4D frame marker does.
        ctrl.stepSignalCursor(-delta)
      }
      return
    }
    const hit = ctrl.view?.hitTest(px, py)
    if (!hit) return
    // 2D slice: zoom in pan mode, otherwise step the crosshair through slices.
    // slicer3D also pans/zooms on drag, but its wheel scrolls slices, as in 0.6.
    if (!hit.isRender) {
      const isPanZoomMode =
        ctrl.model.interaction.primaryDragMode === DRAG_MODE.pan ||
        ctrl.model.interaction.secondaryDragMode === DRAG_MODE.pan
      if (isPanZoomMode) {
        const zoomDirection = evt.deltaY < 0 ? 1 : -1
        const zoom = NVTransforms.stepZoom2D(
          ctrl.model.scene.pan2Dxyzmm[3],
          zoomDirection,
        )
        if (ctrl.model.interaction.isYoked3DTo2DZoom) {
          ctrl.model.scene.scaleMultiplier = zoom
          emitScaleMultiplierChange(ctrl)
        }
        // Pan so the anchor stays put under the new zoom. The anchor is the
        // crosshair by default (issue #68), or the pointer's pick on the
        // hovered tile when interaction.wheelZoomAnchor is 'pointer'. The
        // compensation is NVTransforms' business, not this handler's: the
        // ortho window is built there and only it knows that holding a point
        // takes a ratio of the zooms measured from the extent centre.
        const mm = resolveWheelZoomAnchorMM(ctrl, px, py, hit)
        const pan = NVTransforms.zoomPan2DAbout(
          ctrl.model.scene.pan2Dxyzmm,
          zoom,
          mm,
          ctrl.model.extentsMin,
          ctrl.model.extentsMax,
        )
        ctrl.model.scene.pan2Dxyzmm[3] = zoom
        ctrl.model.scene.pan2Dxyzmm[0] = pan[0]
        ctrl.model.scene.pan2Dxyzmm[1] = pan[1]
        ctrl.model.scene.pan2Dxyzmm[2] = pan[2]
        emitPan2DChange(ctrl)
        ctrl.drawScene()
        return
      }
      DragModes.stepSlice(ctrl, hit.sliceType, evt.deltaY > 0 ? 1 : -1)
      return
    }
    const dae = ctrl.getClipPlaneDepthAziElev(ctrl.activeClipPlaneIndex)
    if (dae[0] > -1 && dae[0] < 1) {
      dae[0] = NVTransforms.stepClipDepth(dae[0], evt.deltaY)
      ctrl.setClipPlaneDepthAziElev(
        dae[0],
        dae[1],
        dae[2],
        ctrl.activeClipPlaneIndex,
      )
      ctrl.drawScene()
      return
    }
    const zoomSpeed = 0.001
    const scaleBefore = ctrl.model.scene.scaleMultiplier
    ctrl.model.scene.scaleMultiplier = clampScale3D(
      scaleBefore + evt.deltaY * zoomSpeed,
      scaleBefore,
    )
    emitScaleMultiplierChange(ctrl)
    // Yoked, the slices zoom by the same ratio and keep their pan.
    if (ctrl.model.interaction.isYoked3DTo2DZoom) {
      ctrl.model.scene.pan2Dxyzmm[3] = yokedZoom2D(
        ctrl.model.scene.pan2Dxyzmm[3],
        scaleBefore,
        ctrl.model.scene.scaleMultiplier,
      )
      emitPan2DChange(ctrl)
    }
    ctrl.drawScene()
  }
  ctrl._eventListeners.keydown = (e: Event) =>
    handleKeydown(ctrl, e as KeyboardEvent)
  ctrl._eventListeners.dblclick = async (e: Event) => {
    const evt = e as PointerEvent
    const dblHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY)
    if (!dblHit) return // outside this instance's bounds
    setNextActionTag('dblclick')
    const [px, py] = dblHit
    // Double-clicking a legend colour box solos that label; any legend
    // double-click is consumed so it never depth-picks behind the panel.
    const legendLayout = ctrl.view?.legendLayout ?? null
    if (isInLegend(px, py, legendLayout)) {
      const legendHit = legendHitTest(px, py, legendLayout)
      if (legendHit?.isOnBox && ctrl.model.interaction.isLegendToggleEnabled)
        soloLegendLabel(ctrl, legendHit.entry)
      return
    }
    // Double-clicking the zoom-out ("-") button jumps straight to the full view
    // (the one-click way back from a deep zoom). The reset is restricted to that
    // button: a double-click on "+"/"<"/">" must keep its single-click action
    // (zoom in / pan) rather than be overridden by a reset, and a plot
    // double-click just scrubs. Any graph hit still consumes the event so it does
    // not fall through to depth-pick (there is nothing to pick on the 2-D plot).
    const graphLayout = ctrl.view?.graphLayout as GraphLayout | null
    const graphHit = graphHitTest(px, py, graphLayout)
    if (graphHit) {
      if (graphHit.type === 'graphControl' && graphHit.id === 'zoomOut') {
        ctrl.graphResetView()
      }
      return
    }
    // Close an in-progress multi-click contour (spline / livewire) instead of
    // depth-picking. The two clicks of the double-click already added their
    // points via the pointerdown handler; commit the accumulated contour. A
    // double-click off the slices (the 3D render) is ignored: it must neither
    // close the contour nor depth-pick it off its slice (#114).
    if (
      ctrl._annotationPolyPoints &&
      isMultiClickTool(ctrl.model.annotation.tool)
    ) {
      const dblTile = ctrl.view?.hitTest(px, py)
      if (!dblTile || dblTile.isRender) return
      // Angle tools commit on their last click, not a double-click.
      if (ctrl.model.annotation.tool in ANGLE_CLICKS) return
      commitMultiClickContour(ctrl)
      ctrl._abandonAnnotationInProgress()
      ctrl.drawScene()
      return
    }
    // The depth pick sees volumes and meshes only; on a miss, fall back to the
    // slide plane (drawn on render tiles only), e.g. a slide with no volume.
    const mm =
      (await ctrl.view?.depthPick(px, py)) ??
      (ctrl.view?.slidePlane && ctrl.view.hitTest(px, py)?.isRender
        ? pickSlideWorld(
            ctrl.view.slidePlane,
            ...clientToCanvasPixel(ctrl, evt.clientX, evt.clientY),
          )
        : null)
    if (mm) {
      ctrl._setCrosshairPos(mm, NVConstants.SLICE_TYPE.RENDER)
    } else {
      // Redraw to fix any pixel artifacts from the depth-pick shader
      ctrl.drawScene()
    }
  }
  ctrl._eventListeners.pointerleave = () => {
    ctrl._pointerClient = null
    if (clearHover(ctrl)) {
      setNextActionTag('pointerleave')
      ctrl.drawScene()
    }
    ctrl.emit(
      'slicePointerLeave' as keyof import('@/NVEvents').NVEventMap,
      undefined as never,
    )
  }
  // Add event listeners (pointer events on canvas with capture for drag tracking)
  ctrl.canvas?.addEventListener('contextmenu', ctrl._eventListeners.contextmenu)
  ctrl.canvas?.addEventListener('pointerdown', ctrl._eventListeners.pointerdown)
  ctrl.canvas?.addEventListener('pointerup', ctrl._eventListeners.pointerup)
  ctrl.canvas?.addEventListener(
    'pointercancel',
    ctrl._eventListeners.pointercancel,
  )
  ctrl.canvas?.addEventListener('pointermove', ctrl._eventListeners.pointermove)
  ctrl.canvas?.addEventListener(
    'pointerleave',
    ctrl._eventListeners.pointerleave,
  )
  ctrl.canvas?.addEventListener('wheel', ctrl._eventListeners.wheel, {
    passive: false,
  })
  window.addEventListener('keydown', ctrl._eventListeners.keydown)
  ctrl.canvas?.addEventListener('dblclick', ctrl._eventListeners.dblclick)
}

export function removeInteractionListeners(ctrl: NiiVue): void {
  if (ctrl._eventListeners.contextmenu) {
    ctrl.canvas?.removeEventListener(
      'contextmenu',
      ctrl._eventListeners.contextmenu,
    )
  }
  if (ctrl._eventListeners.pointerdown) {
    ctrl.canvas?.removeEventListener(
      'pointerdown',
      ctrl._eventListeners.pointerdown,
    )
  }
  if (ctrl._eventListeners.pointerup) {
    ctrl.canvas?.removeEventListener(
      'pointerup',
      ctrl._eventListeners.pointerup,
    )
  }
  if (ctrl._eventListeners.pointercancel) {
    ctrl.canvas?.removeEventListener(
      'pointercancel',
      ctrl._eventListeners.pointercancel,
    )
  }
  if (ctrl._eventListeners.pointermove) {
    ctrl.canvas?.removeEventListener(
      'pointermove',
      ctrl._eventListeners.pointermove,
    )
  }
  if (ctrl._eventListeners.wheel) {
    ctrl.canvas?.removeEventListener('wheel', ctrl._eventListeners.wheel)
  }
  if (ctrl._eventListeners.keydown) {
    window.removeEventListener('keydown', ctrl._eventListeners.keydown)
  }
  if (ctrl._eventListeners.dragover) {
    ctrl.canvas?.removeEventListener('dragover', ctrl._eventListeners.dragover)
  }
  if (ctrl._eventListeners.drop) {
    ctrl.canvas?.removeEventListener('drop', ctrl._eventListeners.drop)
  }
  if (ctrl._eventListeners.dblclick) {
    ctrl.canvas?.removeEventListener('dblclick', ctrl._eventListeners.dblclick)
  }
  if (ctrl._eventListeners.pointerleave) {
    ctrl.canvas?.removeEventListener(
      'pointerleave',
      ctrl._eventListeners.pointerleave,
    )
  }
  if (ctrl.canvas) {
    ctrl.canvas.style.touchAction = ''
  }
}

export function setupDragAndDrop(ctrl: NiiVue): void {
  ctrl._eventListeners.dragover = (event: Event) => {
    const evt = event as DragEvent
    evt.preventDefault()
    if (evt.dataTransfer) {
      evt.dataTransfer.dropEffect = 'copy'
    }
  }

  ctrl._eventListeners.drop = async (event: Event) => {
    const evt = event as DragEvent
    evt.preventDefault()
    if (!ctrl.opts.isDragDropEnabled) return
    const files = evt.dataTransfer?.files
    if (!files || files.length === 0) return
    await ctrl.loadFiles(Array.from(files))
  }

  ctrl.canvas?.addEventListener('dragover', ctrl._eventListeners.dragover)
  ctrl.canvas?.addEventListener('drop', ctrl._eventListeners.drop)
}

export function setupResizeHandler(ctrl: NiiVue): void {
  if (ctrl.resizeObserver) {
    ctrl.resizeObserver.disconnect()
  }
  const onResize = () => {
    setNextActionTag('resize')
    ctrl.resize()
    if (ctrl.canvas) {
      ctrl.emit('canvasResize', {
        width: ctrl.canvas.clientWidth,
        height: ctrl.canvas.clientHeight,
      })
    }
  }
  ctrl.resizeObserver = new ResizeObserver(onResize)
  try {
    ctrl.resizeObserver.observe(ctrl.canvas as HTMLCanvasElement, {
      box: 'device-pixel-content-box',
    })
  } catch {
    ctrl.resizeObserver.observe(ctrl.canvas as HTMLCanvasElement)
  }
  // Track devicePixelRatio changes (e.g., window moved between displays
  // with different DPR). matchMedia('(resolution: ...)') fires once when
  // the DPR crosses the queried value; re-arm with the new DPR each time.
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    const armDprListener = () => {
      const mql = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      )
      const handler = () => {
        mql.removeEventListener('change', handler)
        ctrl._dprMediaQuery = null
        onResize()
        armDprListener()
      }
      mql.addEventListener('change', handler)
      ctrl._dprMediaQuery = { mql, handler }
    }
    if (ctrl._dprMediaQuery) {
      ctrl._dprMediaQuery.mql.removeEventListener(
        'change',
        ctrl._dprMediaQuery.handler,
      )
      ctrl._dprMediaQuery = null
    }
    armDprListener()
  }
}

/** What {@link pickExplodedBlock} resolves a click on an exploded brick to. */
export interface ExplodedBlockPick {
  /** Index into `ctrl.volumes` of the volume that owns the brick. */
  volumeIndex: number
  /** Index into `vol.chunkPlan.chunks`. */
  chunkIndex: number
  /** Brick data region in the volume's RAS voxel grid (excludes halo). */
  voxelOrigin: [number, number, number]
  voxelDims: [number, number, number]
  /** The visible-tissue voxel the ray landed on, in RAS voxel coords. */
  voxel: [number, number, number]
  /** That voxel in UN-EXPLODED (anatomical) mm. */
  mm: [number, number, number]
  /**
   * The brick's mm bounding box where it is DRAWN, i.e. with the explode offset
   * applied. Feed straight to `ctrl.focusBox` to outline the picked brick.
   */
  explodedMin: [number, number, number]
  explodedMax: [number, number, number]
}

/**
 * Resolve a pointer position over the 3D render onto one exploded brick.
 *
 * The exploded view is a render-time per-brick translation, so GPU depth picking
 * (which ray-marches the un-exploded texture) cannot see it. This runs the same
 * CPU pick the 3D pen and the vector-face pick use: unproject the point to a
 * world ray, cast it against the bricks' EXPLODED bounding boxes restricted to
 * the clip-visible set, then march into the winning brick's data so the hit lands
 * on the first visible voxel rather than the brick's empty bounding-box face.
 *
 * Takes CLIENT coordinates (`event.clientX/clientY`) and does its own hit test,
 * so it is safe to call from a plain click handler without a drag in progress.
 *
 * Returns null when the point is not over a render tile, no loaded volume is a
 * chunked volume with explode enabled, or the ray misses every visible brick.
 */
export function pickExplodedBlock(
  ctrl: NiiVue,
  clientX: number,
  clientY: number,
): ExplodedBlockPick | null {
  const px = clientToBoundsPixel(ctrl, clientX, clientY)
  if (!px) return null
  const hit = ctrl.view?.hitTest(px[0], px[1]) ?? null
  if (!hit?.isRender) return null
  const volumes = ctrl.volumes ?? []
  for (let volumeIndex = 0; volumeIndex < volumes.length; volumeIndex++) {
    const vol = volumes[volumeIndex]
    const plan = vol?.chunkPlan
    if (!plan || !chunkExplodeEnabled(vol.chunkExplode)) continue
    const picked = pickExplodedDraw(ctrl, vol, hit)
    if (!picked) continue
    const desc = plan.chunks[picked.chunkIndex]
    if (!desc) continue
    const aabb = explodedChunkAABB(
      plan,
      vol.matRAS as Float32Array,
      vol.chunkExplode,
      picked.chunkIndex,
    )
    if (!aabb) continue
    const m = vol.matRAS as ArrayLike<number>
    const [vx, vy, vz] = picked.voxel
    return {
      volumeIndex,
      chunkIndex: picked.chunkIndex,
      voxelOrigin: [...desc.voxelOrigin],
      voxelDims: [...desc.voxelDims],
      voxel: [vx, vy, vz],
      mm: [
        m[0] * vx + m[1] * vy + m[2] * vz + m[3],
        m[4] * vx + m[5] * vy + m[6] * vz + m[7],
        m[8] * vx + m[9] * vy + m[10] * vz + m[11],
      ],
      explodedMin: [...aabb.min],
      explodedMax: [...aabb.max],
    }
  }
  return null
}

function scrollLegend(ctrl: NiiVue, layout: LegendLayout, rows: number): void {
  // Start from the shown position: a value left over from a longer legend
  // would otherwise swallow the first scroll back.
  const max = layout.rows - layout.visibleRows
  const from = Math.min(ctrl.model._legendScrollRow, max)
  ctrl.model._legendScrollRow = Math.max(0, Math.min(max, from + rows))
  ctrl.drawScene()
}
