import { vec3 } from 'gl-matrix'
import * as Annotation from '@/annotation'
import { isOnSlice } from '@/annotation/sliceProjection'
import {
  emitPan2DChange,
  emitScaleMultiplierChange,
} from '@/control/cameraEvents'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import { DRAG_MODE, sliceTypeDim } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
import type { DragReleaseInfo, VectorAnnotation } from '@/NVTypes'
import { computeTolerance } from '@/view/NVAnnotation'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import { projectMMToCanvas, tilePlane } from '@/view/sliceUtils'

/**
 * Movement (in CSS pixels) a `crosshairPan` gesture must reach (>=) before it
 * is treated as a pan instead of a click that places the crosshair.
 */
export const crosshairPanThresholdCssPx = 4

/**
 * True when the pointer has moved at least `thresholdPx` (canvas pixels)
 * from `start` to `end`. Pure helper for `DRAG_MODE.crosshairPan`.
 */
export function isCrosshairPanDrag(
  start: readonly [number, number],
  end: readonly [number, number],
  thresholdPx: number,
): boolean {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  return dx * dx + dy * dy >= thresholdPx * thresholdPx
}

/**
 * The `crosshairPan` drag threshold in canvas pixels. `dragStartXY`/`dragEndXY`
 * are canvas (backing-store) pixels, so the CSS threshold is scaled by the
 * canvas' backing-store-to-CSS ratio (1:1 without a canvas).
 */
export function crosshairPanThresholdPx(ctrl: NiiVue): number {
  return cssToCanvasPx(ctrl, crosshairPanThresholdCssPx)
}

function cssToCanvasPx(ctrl: NiiVue, cssPx: number): number {
  const canvas = ctrl.canvas
  if (!canvas) return cssPx
  const cssWidth = Math.max(canvas.getBoundingClientRect().width, 1)
  return cssPx * (canvas.width / cssWidth)
}

/** Vertical drag (CSS pixels) per slice step of `DRAG_MODE.slice`. */
const sliceDragCssPx = 4

/**
 * Step the crosshair `delta` slices through a 2D tile of `sliceType`, as one
 * wheel notch per slice does.
 */
export function stepSlice(ctrl: NiiVue, sliceType: number, delta: number) {
  const depthAxis = sliceTypeDim(sliceType)
  if (ctrl.model.getVolumes().length > 0) {
    const step: [number, number, number] = [0, 0, 0]
    step[depthAxis] = delta
    ctrl.moveCrosshairInVox(step[0], step[1], step[2])
    return
  }
  // Mesh-only: step in scene fraction via mm
  const mm = ctrl.model.scene2mm(ctrl.model.scene.crosshairPos)
  const range =
    ctrl.model.extentsMax[depthAxis] - ctrl.model.extentsMin[depthAxis]
  mm[depthAxis] += delta * range * 0.01
  ctrl.setCrosshairPos([mm[0], mm[1], mm[2]])
}

/**
 * `DRAG_MODE.slice`: step one slice per `sliceDragCssPx` of vertical drag.
 * The drag start advances by the distance consumed, so slow drags add up.
 */
export function dragForSlice(ctrl: NiiVue): void {
  const hit = ctrl.activeTileHit
  if (!hit) return
  const perStep = cssToCanvasPx(ctrl, sliceDragCssPx)
  const steps = Math.trunc((ctrl.dragEndXY[1] - ctrl.dragStartXY[1]) / perStep)
  if (!steps) return
  ctrl.dragStartXY[1] += steps * perStep
  stepSlice(ctrl, hit.sliceType, steps)
}

/**
 * Advance a `crosshairPan` gesture. Before the threshold is crossed nothing
 * happens; once crossed (or already crossed earlier in the gesture) the view
 * pans exactly like `DRAG_MODE.pan`. Returns true once the gesture is a pan.
 */
export function dragForCrosshairPan(ctrl: NiiVue): boolean {
  if (
    !ctrl._crosshairPanDidDrag &&
    !isCrosshairPanDrag(
      ctrl.dragStartXY,
      ctrl.dragEndXY,
      crosshairPanThresholdPx(ctrl),
    )
  ) {
    return false
  }
  ctrl._crosshairPanDidDrag = true
  dragForPanZoom(ctrl)
  return true
}

/** Return the DRAG_MODE for a given mouse button on 2D slice tiles. */
export function getDragModeForButton(ctrl: NiiVue, button: number): number {
  if (button === 0) return ctrl.model.interaction.primaryDragMode
  if (button === 2) return ctrl.model.interaction.secondaryDragMode
  return DRAG_MODE.none
}

/**
 * Calculate new cal_min/cal_max from voxel intensities within a drag box.
 * Uses direct array iteration with hoisted index math for cache efficiency.
 * Returns null if no variability or outside volume.
 */
function calculateNewRange(
  ctrl: NiiVue,
  volIdx = 0,
): { calMin: number; calMax: number } | null {
  const model = ctrl.model
  const volumes = model.getVolumes()
  const vol = volumes[volIdx]
  if (!vol?.img || !vol.dimsRAS || !vol.img2RASstep || !vol.img2RASstart)
    return null

  const span = dragSpanMM(ctrl)
  if (!span) return null
  const [startMM, endMM] = span

  const startVox = NVTransforms.mm2vox(vol, startMM)
  const endVox = NVTransforms.mm2vox(vol, endMM)

  const dims = vol.dimsRAS
  const xMin = Math.max(
    0,
    Math.min(Math.round(startVox[0]), Math.round(endVox[0])),
  )
  const xMax = Math.min(
    dims[1] - 1,
    Math.max(Math.round(startVox[0]), Math.round(endVox[0])),
  )
  const yMin = Math.max(
    0,
    Math.min(Math.round(startVox[1]), Math.round(endVox[1])),
  )
  const yMax = Math.min(
    dims[2] - 1,
    Math.max(Math.round(startVox[1]), Math.round(endVox[1])),
  )
  const zMin = Math.max(
    0,
    Math.min(Math.round(startVox[2]), Math.round(endVox[2])),
  )
  const zMax = Math.min(
    dims[3] - 1,
    Math.max(Math.round(startVox[2]), Math.round(endVox[2])),
  )

  // Get typed array view once
  const imgData = vol.img

  // Hoist RAS→native index math outside inner loops
  const start = vol.img2RASstart
  const step = vol.img2RASstep
  const slope = vol.hdr.scl_slope
  const inter = vol.hdr.scl_inter
  // For 4D volumes, scope the search to the currently-displayed frame so
  // contrast reflects the visible volume, not always frame 0.
  const frameOffset = (vol.frame4D ?? 0) * vol.nVox3D

  let lo = Number.MAX_VALUE
  let hi = -Number.MAX_VALUE
  for (let z = zMin; z <= zMax; z++) {
    const zi = start[2] + z * step[2]
    for (let y = yMin; y <= yMax; y++) {
      const yzi = zi + start[1] + y * step[1]
      for (let x = xMin; x <= xMax; x++) {
        const idx = frameOffset + yzi + start[0] + x * step[0]
        if (idx >= 0 && idx < imgData.length) {
          const raw = imgData[idx]
          if (raw < lo) lo = raw
          if (raw > hi) hi = raw
        }
      }
    }
  }
  if (lo >= hi) return null
  // A negative slope maps the raw max to the scaled min.
  const a = lo * slope + inter
  const b = hi * slope + inter
  return { calMin: Math.min(a, b), calMax: Math.max(a, b) }
}

/** Build DragReleaseInfo from current drag state. */
function buildDragReleaseInfo(ctrl: NiiVue): DragReleaseInfo | null {
  const span = dragSpanMM(ctrl)
  const tileHit = ctrl.activeTileHit
  if (!span || !tileHit) return null
  const [startMM, endMM] = span

  const vol = ctrl.model.getVolumes()[0]
  let voxStart: [number, number, number] = [0, 0, 0]
  let voxEnd: [number, number, number] = [0, 0, 0]
  const dims = vol?.dimsRAS
  if (vol && dims) {
    // Voxel indices, and the tile can now extend past the volume, so a drag
    // released in the margin would report an out-of-range index. The mm fields
    // stay unclamped -- they describe the real gesture.
    const clamp = (v: vec3): [number, number, number] => [
      Math.max(0, Math.min(dims[1] - 1, Math.round(v[0]))),
      Math.max(0, Math.min(dims[2] - 1, Math.round(v[1]))),
      Math.max(0, Math.min(dims[3] - 1, Math.round(v[2]))),
    ]
    voxStart = clamp(NVTransforms.mm2vox(vol, startMM))
    voxEnd = clamp(NVTransforms.mm2vox(vol, endMM))
  }

  const mmLength = vec3.distance(
    vec3.fromValues(startMM[0], startMM[1], startMM[2]),
    vec3.fromValues(endMM[0], endMM[1], endMM[2]),
  )

  return {
    tileIdx: tileHit.tileIndex,
    axCorSag: tileHit.sliceType,
    mmLength,
    voxStart,
    voxEnd,
    mmStart: [startMM[0], startMM[1], startMM[2]],
    mmEnd: [endMM[0], endMM[1], endMM[2]],
  }
}

/** Update the model's drag overlay based on the current active drag mode. */
export function updateDragOverlay(ctrl: NiiVue): void {
  const mode = ctrl._activeDragMode
  const [sx, sy] = ctrl.dragStartXY
  const [ex, ey] = ctrl.dragEndXY
  const ui = ctrl.model.ui

  if (
    mode === DRAG_MODE.contrast ||
    mode === DRAG_MODE.callbackOnly ||
    mode === DRAG_MODE.roiSelection
  ) {
    const x = Math.min(sx, ex)
    const y = Math.min(sy, ey)
    const w = Math.abs(ex - sx)
    const h = Math.abs(ey - sy)
    ctrl.model._dragOverlay = {
      rect: { ltwh: [x, y, w, h], color: ui.selectionBoxColor },
    }
  } else if (mode === DRAG_MODE.measurement) {
    // The live measurement is the annotation the release will commit, drawn
    // by the annotation renderer: the same ruler, style and length label.
    const span = dragSpanMM(ctrl)
    const hit = ctrl.activeTileHit
    ctrl.model._dragOverlay = null
    setDragPreview(
      ctrl,
      span && hit ? measurePreview(ctrl, span, hit.sliceType) : null,
    )
  } else if (
    mode === DRAG_MODE.angle ||
    ctrl._angleState === 'drawing_second_line'
  ) {
    ctrl.model._dragOverlay = null
    const arm = ctrl._angleArm
    if (ctrl._angleState === 'drawing_first_line') {
      const span = dragSpanMM(ctrl)
      const hit = ctrl.activeTileHit
      setDragPreview(
        ctrl,
        span && hit
          ? measurePreview(ctrl, span, hit.sliceType, 'measureAngle')
          : null,
      )
    } else if (ctrl._angleState === 'drawing_second_line' && arm) {
      if (!angleArmOnScreen(ctrl)) {
        setDragPreview(ctrl, null)
        return
      }
      // The live reading once the second arm can be placed.
      const placed = placeableAngle(ctrl, ex, ey)
      setDragPreview(
        ctrl,
        measurePreview(
          ctrl,
          placed ? [...arm.mm, placed.end] : arm.mm,
          arm.hit.sliceType,
          'measureAngle',
        ),
      )
    }
  } else {
    ctrl.model._dragOverlay = null
  }
}

/** Handle drag release: perform mode-specific action and fire callback. */
export function handleDragRelease(ctrl: NiiVue): void {
  const mode = ctrl._activeDragMode

  // Crosshair-pan: a release that never crossed the drag threshold is a click
  // that places the crosshair. A gesture that panned (or was cancelled) does
  // not move the crosshair. The threshold is rechecked against the final
  // release point because pointerup refreshes `dragEndXY` from its own
  // coordinates: a press-and-release far apart without any pointermove never
  // set `_crosshairPanDidDrag`, yet it exceeded the threshold, so it is not a
  // click either.
  if (
    mode === DRAG_MODE.crosshairPan &&
    !ctrl._crosshairPanDidDrag &&
    !isCrosshairPanDrag(
      ctrl.dragStartXY,
      ctrl.dragEndXY,
      crosshairPanThresholdPx(ctrl),
    )
  ) {
    const mm = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
    if (mm) ctrl.setCrosshairPos(mm)
  }

  // Angle: drag the first arm to the vertex, then the second arm follows the
  // pointer and a click (or drag release) places it. A release that would give
  // a zero-length arm or a zero angle is ignored, so the user keeps placing.
  if (mode === DRAG_MODE.angle) {
    const [sx, sy] = ctrl.dragStartXY
    const [ex, ey] = ctrl.dragEndXY
    if (ctrl._angleState === 'drawing_first_line') {
      // The first arm is fixed in mm on its own tile, so a later click, scroll
      // or zoom cannot move it.
      const a = screenSlicePickAt(ctrl, sx, sy)
      const v = screenSlicePickAt(ctrl, ex, ey)
      const hit = ctrl.activeTileHit
      if (
        !a ||
        !v ||
        !hit ||
        Math.hypot(ex - sx, ey - sy) < crosshairPanThresholdPx(ctrl)
      ) {
        ctrl._angleState = 'none'
        fireDragRelease(ctrl)
        clearDragState(ctrl)
        return
      }
      ctrl._angleArm = { mm: [a, v], hit }
      ctrl._angleState = 'drawing_second_line'
      // Other gestures must not run this release until the second arm's press.
      ctrl._activeDragMode = DRAG_MODE.none
      updateDragOverlay(ctrl)
      ctrl.drawScene()
      return
    }
    const arm = ctrl._angleArm
    if (ctrl._angleState === 'drawing_second_line' && arm) {
      const placed = placeableAngle(ctrl, ex, ey)
      if (!placed) {
        // Dropped (the slice moved under it): end the gesture as the first
        // arm's abort does. Otherwise the angle stays open for another click.
        if (!ctrl._angleArm) {
          fireDragRelease(ctrl)
          clearDragState(ctrl)
          return
        }
        ctrl._activeDragMode = DRAG_MODE.none
        updateDragOverlay(ctrl)
        ctrl.drawScene()
        return
      }
      ctrl._angleState = 'none'
      ctrl._angleArm = null
      commitMeasure(ctrl, [...arm.mm, placed.end], arm.hit.sliceType)
      fireDragRelease(ctrl)
      clearDragState(ctrl)
      return
    }
  }

  // Contrast: calculate new range
  if (mode === DRAG_MODE.contrast) {
    if (
      ctrl.dragStartXY[0] !== ctrl.dragEndXY[0] ||
      ctrl.dragStartXY[1] !== ctrl.dragEndXY[1]
    ) {
      const range = calculateNewRange(ctrl)
      if (range) {
        const vol = ctrl.model.getVolumes()[0]
        if (vol) {
          vol.calMin = range.calMin
          vol.calMax = range.calMax
          ctrl.emit('volumeUpdated', {
            volumeIndex: 0,
            volume: vol,
            changes: { calMin: range.calMin, calMax: range.calMax },
          })
          ctrl
            ._updateGLChanged()
            .catch((e) => log.error('contrast drag failed', e))
        }
      }
    }
  }

  // Measurement: commit the drag as a measureLine annotation.
  const hit = ctrl.activeTileHit
  if (mode === DRAG_MODE.measurement && hit) {
    const span = dragSpanMM(ctrl)
    const dist = span ? vec3.distance(span[0], span[1]) : 0
    // A click without a drag (or a degenerate span) measures nothing.
    if (span && dist > 0 && Number.isFinite(dist))
      commitMeasure(ctrl, span, hit.sliceType)
  }

  fireDragRelease(ctrl)

  // ROI selection: keep the overlay visible after release
  if (mode === DRAG_MODE.roiSelection) {
    ctrl._activeDragMode = DRAG_MODE.none
    ctrl.isDragging = false
    ctrl.activeTileHit = null
    // Don't clear _dragOverlay — leave selection box visible
    ctrl.drawScene()
    return
  }

  clearDragState(ctrl)
}

/** Fire the dragRelease event. */
function fireDragRelease(ctrl: NiiVue): void {
  const info = buildDragReleaseInfo(ctrl)
  if (info) ctrl.emit('dragRelease', info)
}

/** Clear all drag state and overlay. */
function clearDragState(ctrl: NiiVue): void {
  ctrl._activeDragMode = DRAG_MODE.none
  ctrl._pan2DxyzmmAtDragStart = null
  ctrl._crosshairPanDidDrag = false
  ctrl.model._dragOverlay = null
  setDragPreview(ctrl, null)
  ctrl.drawScene()
}

/** Pan 2D view based on drag delta in mm space. */
export function dragForPanZoom(ctrl: NiiVue): void {
  const saved = ctrl._pan2DxyzmmAtDragStart
  if (!saved) return

  const span = dragSpanMM(ctrl)
  if (!span) return
  const [startMM, endMM] = span

  ctrl.model.scene.pan2Dxyzmm[0] = saved[0] + (endMM[0] - startMM[0])
  ctrl.model.scene.pan2Dxyzmm[1] = saved[1] + (endMM[1] - startMM[1])
  ctrl.model.scene.pan2Dxyzmm[2] = saved[2] + (endMM[2] - startMM[2])
  emitPan2DChange(ctrl)
}

/** Zoom 2D view based on vertical drag delta. */
export function dragForSlicer3D(ctrl: NiiVue): void {
  const saved = ctrl._pan2DxyzmmAtDragStart
  if (!saved) return

  const dy = ctrl.dragEndXY[1] - ctrl.dragStartXY[1]
  let zoom = saved[3] + dy * 0.01
  zoom = Math.max(0.1, Math.min(10.0, zoom))
  const zoomChange = ctrl.model.scene.pan2Dxyzmm[3] - zoom
  ctrl.model.scene.pan2Dxyzmm[3] = zoom
  if (ctrl.model.interaction.isYoked3DTo2DZoom) {
    ctrl.model.scene.scaleMultiplier = zoom
    emitScaleMultiplierChange(ctrl)
  }

  const mm = ctrl.model.scene2mm(ctrl.model.scene.crosshairPos)
  ctrl.model.scene.pan2Dxyzmm[0] += zoomChange * mm[0]
  ctrl.model.scene.pan2Dxyzmm[1] += zoomChange * mm[1]
  ctrl.model.scene.pan2Dxyzmm[2] += zoomChange * mm[2]
  emitPan2DChange(ctrl)
}

/** Windowing: horizontal drag adjusts range width, vertical adjusts center. */
export function dragForWindowing(
  ctrl: NiiVue,
  deltaX: number,
  deltaY: number,
): void {
  const vol = ctrl.model.getVolumes()[0]
  if (!vol) return

  const range = vol.robustMax - vol.robustMin
  const { windowingStep, isWindowingUpperBoundOnly } = ctrl.model.interaction
  const [widthGain, centerGain] = windowingStep
  const widthStep = range * widthGain
  const centerStep = range * centerGain

  if (isWindowingUpperBoundOnly) {
    vol.calMax = Math.max(vol.calMin, vol.calMax - deltaY * centerStep)
  } else {
    const width = vol.calMax - vol.calMin
    const center = (vol.calMax + vol.calMin) * 0.5

    const newWidth = Math.max(1, width + deltaX * widthStep)
    const newCenter = center - deltaY * centerStep

    vol.calMin = newCenter - newWidth * 0.5
    vol.calMax = newCenter + newWidth * 0.5
  }
  ctrl.emit('volumeUpdated', {
    volumeIndex: 0,
    volume: vol,
    changes: { calMin: vol.calMin, calMax: vol.calMax },
  })
  ctrl._updateGLChanged().catch((e) => log.error('contrast drag failed', e))
}

/** Helper: pick mm coordinates at a canvas pixel position using cached slice tiles. */
function screenSlicePickAt(
  ctrl: NiiVue,
  px: number,
  py: number,
): [number, number, number] | null {
  if (!ctrl.view || !ctrl.activeTileHit) return null
  return NVSliceLayout.screenSlicePick(
    ctrl.view.screenSlices,
    ctrl.model,
    px,
    py,
    ctrl.activeTileHit,
  )
}

/** mm coordinates of the drag start and end, or null if either misses a slice. */
function dragSpanMM(
  ctrl: NiiVue,
): [[number, number, number], [number, number, number]] | null {
  const startMM = screenSlicePickAt(
    ctrl,
    ctrl.dragStartXY[0],
    ctrl.dragStartXY[1],
  )
  const endMM = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
  return startMM && endMM ? [startMM, endMM] : null
}

/**
 * Store a finished measurement (mm [start, end]) or angle ([arm start, vertex,
 * arm end]) drag as a measure annotation on its tile's slice, through the
 * annotation tools' commit (undoable, emits annotationChanged).
 */
function commitMeasure(
  ctrl: NiiVue,
  mm: [number, number, number][],
  sliceType: number,
): void {
  const cfg = ctrl.model.annotation
  const ann = Annotation.measureAnnotation(
    mm,
    sliceType,
    cfg.style,
    cfg.activeLabel,
    cfg.activeGroup,
  )
  if (ann) ctrl._commitAnnotation(ann)
}

/** A drag measurement's live annotation, as commitMeasure will store it. */
function measurePreview(
  ctrl: NiiVue,
  mm: [number, number, number][],
  sliceType: number,
  type?: 'measureAngle',
): VectorAnnotation | null {
  const cfg = ctrl.model.annotation
  return Annotation.measureAnnotation(
    mm,
    sliceType,
    cfg.style,
    cfg.activeLabel,
    cfg.activeGroup,
    type,
  )
}

/**
 * Show `ann` as the drag modes' live measurement. They own the annotation
 * preview only while it is the one they set (an annotation tool's stays).
 */
export function setDragPreview(
  ctrl: NiiVue,
  ann: VectorAnnotation | null,
): void {
  if (ann || ctrl.model._annotationPreview === ctrl._dragPreview)
    ctrl.model._annotationPreview = ann
  ctrl._dragPreview = ann
}

/**
 * The open angle's first arm in canvas pixels, projected from mm through its
 * tile's current view, so a zoom or pan since it was drawn moves it with the
 * image.
 */
function angleArmOnScreen(ctrl: NiiVue): number[] | null {
  const arm = ctrl._angleArm
  if (!arm) return null
  const tile = ctrl.view?.screenSlices[arm.hit.tileIndex]
  const plane = tile && tilePlane(tile)
  // A slice scroll or layout change took the arm off that tile's plane: drop
  // the angle rather than mix two planes (as saved, it would not show there).
  if (
    !plane ||
    tile.axCorSag !== arm.hit.sliceType ||
    !isOnSlice(arm.mm[1], plane.pn, plane.pp, computeTolerance(ctrl.model))
  ) {
    ctrl._cancelAngle()
    return null
  }
  const { mvp, ltwh } = plane
  return [
    ...projectMMToCanvas(arm.mm[0], mvp, ltwh),
    ...projectMMToCanvas(arm.mm[1], mvp, ltwh),
  ]
}

/**
 * The open angle with its second arm ending at canvas (ex, ey): the end in mm
 * and the angle in degrees, measured in mm on the slice (a sheared or oblique
 * slice is not the screen's plane). Null while that arm is too short, the
 * angle would read 0.0, or the point is off the first arm's tile.
 */
function placeableAngle(
  ctrl: NiiVue,
  ex: number,
  ey: number,
): { end: [number, number, number]; angle: number } | null {
  const arm = ctrl._angleArm
  const fl = angleArmOnScreen(ctrl)
  if (!arm || !fl || !ctrl.view) return null
  if (Math.hypot(ex - fl[2], ey - fl[3]) < crosshairPanThresholdPx(ctrl))
    return null
  const end = NVSliceLayout.screenSlicePick(
    ctrl.view.screenSlices,
    ctrl.model,
    ex,
    ey,
    arm.hit,
  )
  if (!end) return null
  const [a, v] = arm.mm
  const angle =
    (vec3.angle(
      vec3.sub(vec3.create(), a, v),
      vec3.sub(vec3.create(), end, v),
    ) *
      180) /
    Math.PI
  return angle < 0.05 ? null : { end, angle }
}
