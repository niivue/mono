import { vec3 } from "gl-matrix"
import * as NVTransforms from "@/math/NVTransforms"
import { DRAG_MODE, SLICE_TYPE } from "@/NVConstants"
import type NiiVueGPU from "@/NVControlBase"
import type { DragOverlay, DragReleaseInfo } from "@/NVTypes"
import * as NVSliceLayout from "@/view/NVSliceLayout"

/** Return the DRAG_MODE for a given mouse button on 2D slice tiles. */
export function getDragModeForButton(ctrl: NiiVueGPU, button: number): number {
  if (button === 0) return ctrl.model.interaction.primaryDragMode
  if (button === 2) return ctrl.model.interaction.secondaryDragMode
  return DRAG_MODE.none
}

/**
 * Calculate new cal_min/cal_max from voxel intensities within a drag box.
 * Uses direct array iteration with hoisted index math for cache efficiency.
 * Returns null if no variability or outside volume.
 */
export function calculateNewRange(
  ctrl: NiiVueGPU,
  volIdx = 0,
): { calMin: number; calMax: number } | null {
  const model = ctrl.model
  const volumes = model.getVolumes()
  const vol = volumes[volIdx]
  if (!vol?.img || !vol.dimsRAS || !vol.img2RASstep || !vol.img2RASstart)
    return null

  const startMM = screenSlicePickAt(
    ctrl,
    ctrl.dragStartXY[0],
    ctrl.dragStartXY[1],
  )
  const endMM = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
  if (!startMM || !endMM) return null

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

  let lo = Number.MAX_VALUE
  let hi = -Number.MAX_VALUE
  for (let z = zMin; z <= zMax; z++) {
    const zi = start[2] + z * step[2]
    for (let y = yMin; y <= yMax; y++) {
      const yzi = zi + start[1] + y * step[1]
      for (let x = xMin; x <= xMax; x++) {
        const idx = yzi + start[0] + x * step[0]
        if (idx >= 0 && idx < imgData.length) {
          const raw = imgData[idx]
          if (raw < lo) lo = raw
          if (raw > hi) hi = raw
        }
      }
    }
  }
  if (lo >= hi) return null
  return { calMin: lo * slope + inter, calMax: hi * slope + inter }
}

/** Build DragReleaseInfo from current drag state. */
export function buildDragReleaseInfo(ctrl: NiiVueGPU): DragReleaseInfo | null {
  const startMM = screenSlicePickAt(
    ctrl,
    ctrl.dragStartXY[0],
    ctrl.dragStartXY[1],
  )
  const endMM = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
  const tileHit = ctrl.activeTileHit
  if (!startMM || !endMM || !tileHit) return null

  const vol = ctrl.model.getVolumes()[0]
  let voxStart: [number, number, number] = [0, 0, 0]
  let voxEnd: [number, number, number] = [0, 0, 0]
  if (vol) {
    const sv = NVTransforms.mm2vox(vol, startMM)
    const ev = NVTransforms.mm2vox(vol, endMM)
    voxStart = [Math.round(sv[0]), Math.round(sv[1]), Math.round(sv[2])]
    voxEnd = [Math.round(ev[0]), Math.round(ev[1]), Math.round(ev[2])]
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
export function updateDragOverlay(ctrl: NiiVueGPU): void {
  const mode = ctrl._activeDragMode
  const [sx, sy] = ctrl.dragStartXY
  const [ex, ey] = ctrl.dragEndXY
  const ui = ctrl.model.ui
  const lineColor = ui.measureLineColor
  const lineWidth = ui.rulerWidth
  const textColor = ui.measureTextColor
  const textBack =
    textColor[0] + textColor[1] + textColor[2] > 0.8
      ? [0, 0, 0, 0.5]
      : [1, 1, 1, 0.5]

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
    const overlay: DragOverlay = {
      lines: [
        {
          startXY: [sx, sy],
          endXY: [ex, ey],
          color: lineColor,
          thickness: lineWidth,
        },
      ],
      text: [],
    }
    // End caps: perpendicular segments at start and end
    const capLen = 6
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > 0) {
      const px = (-dy / len) * capLen
      const py = (dx / len) * capLen
      overlay.lines?.push(
        {
          startXY: [sx - px, sy - py],
          endXY: [sx + px, sy + py],
          color: lineColor,
          thickness: lineWidth,
        },
        {
          startXY: [ex - px, ey - py],
          endXY: [ex + px, ey + py],
          color: lineColor,
          thickness: lineWidth,
        },
      )
    }
    // Distance text at line midpoint
    const startMM = screenSlicePickAt(ctrl, sx, sy)
    const endMM = screenSlicePickAt(ctrl, ex, ey)
    if (startMM && endMM) {
      const dist = vec3.distance(
        vec3.fromValues(startMM[0], startMM[1], startMM[2]),
        vec3.fromValues(endMM[0], endMM[1], endMM[2]),
      )
      let decimals = 2
      if (dist > 9) decimals = 1
      if (dist > 99) decimals = 0
      let label = dist.toFixed(decimals)
      if (ui.isMeasureUnitsVisible) label += " mm"
      const mx = (sx + ex) * 0.5
      const my = (sy + ey) * 0.5
      overlay.text?.push({
        str: label,
        x: mx,
        y: my,
        scale: 0.8,
        color: textColor,
        anchorX: 0.5,
        anchorY: 1,
        backColor: textBack,
      })
    }
    ctrl.model._dragOverlay = overlay
  } else if (mode === DRAG_MODE.angle) {
    const overlay: DragOverlay = { lines: [], text: [] }
    if (ctrl._angleState === "drawing_first_line") {
      overlay.lines?.push({
        startXY: [sx, sy],
        endXY: [ex, ey],
        color: lineColor,
        thickness: lineWidth,
      })
    } else if (ctrl._angleState === "drawing_second_line") {
      const fl = ctrl._angleFirstLine
      overlay.lines?.push(
        {
          startXY: [fl[0], fl[1]],
          endXY: [fl[2], fl[3]],
          color: lineColor,
          thickness: lineWidth,
        },
        {
          startXY: [fl[2], fl[3]],
          endXY: [ex, ey],
          color: lineColor,
          thickness: lineWidth,
        },
      )
      // Angle text at intersection
      const line2 = [fl[2], fl[3], ex, ey]
      const angle = calculateAngleBetweenLines(fl, line2)
      overlay.text?.push({
        str: `${angle.toFixed(1)}\u00B0`,
        x: fl[2],
        y: fl[3],
        scale: 0.8,
        color: textColor,
        anchorX: 0.5,
        anchorY: 1,
        backColor: textBack,
      })
    }
    ctrl.model._dragOverlay = overlay
  } else {
    ctrl.model._dragOverlay = null
  }
}

/** Handle drag release: perform mode-specific action and fire callback. */
export function handleDragRelease(ctrl: NiiVueGPU): void {
  const mode = ctrl._activeDragMode

  // Angle state machine
  if (mode === DRAG_MODE.angle) {
    if (ctrl._angleState === "drawing_first_line") {
      ctrl._angleFirstLine = [
        ctrl.dragStartXY[0],
        ctrl.dragStartXY[1],
        ctrl.dragEndXY[0],
        ctrl.dragEndXY[1],
      ]
      ctrl._angleState = "drawing_second_line"
      // Keep dragging for second line — don't clear
      return
    }
    if (ctrl._angleState === "drawing_second_line") {
      ctrl._angleState = "none"
      // Save completed angle in mm-space
      const fl = ctrl._angleFirstLine
      const fl0 = screenSlicePickAt(ctrl, fl[0], fl[1])
      const fl1 = screenSlicePickAt(ctrl, fl[2], fl[3])
      const sl0 = screenSlicePickAt(ctrl, fl[2], fl[3])
      const sl1 = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
      if (fl0 && fl1 && sl0 && sl1) {
        const line2 = [fl[2], fl[3], ctrl.dragEndXY[0], ctrl.dragEndXY[1]]
        const angle = calculateAngleBetweenLines(fl, line2)
        const sliceInfo = getSliceInfo(ctrl)
        const completedAngle = {
          firstLine: {
            startMM: [...fl0] as [number, number, number],
            endMM: [...fl1] as [number, number, number],
          },
          secondLine: {
            startMM: [...sl0] as [number, number, number],
            endMM: [...sl1] as [number, number, number],
          },
          angle,
          ...sliceInfo,
        }
        ctrl.model.completedAngles.push(completedAngle)
        ctrl.emit("angleCompleted", completedAngle)
      }
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
          ctrl.emit("volumeUpdated", {
            volumeIndex: 0,
            volume: vol,
            changes: { calMin: range.calMin, calMax: range.calMax },
          })
          ctrl.updateGLVolume()
        }
      }
    }
  }

  // Measurement: save completed measurement in mm-space
  if (mode === DRAG_MODE.measurement) {
    const startMM = screenSlicePickAt(
      ctrl,
      ctrl.dragStartXY[0],
      ctrl.dragStartXY[1],
    )
    const endMM = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
    if (startMM && endMM) {
      const dist = vec3.distance(
        vec3.fromValues(startMM[0], startMM[1], startMM[2]),
        vec3.fromValues(endMM[0], endMM[1], endMM[2]),
      )
      const sliceInfo = getSliceInfo(ctrl)
      const completedMeasurement = {
        startMM: [...startMM] as [number, number, number],
        endMM: [...endMM] as [number, number, number],
        distance: dist,
        ...sliceInfo,
      }
      ctrl.model.completedMeasurements.push(completedMeasurement)
      ctrl.emit("measurementCompleted", completedMeasurement)
    }
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
function fireDragRelease(ctrl: NiiVueGPU): void {
  const info = buildDragReleaseInfo(ctrl)
  if (info) ctrl.emit("dragRelease", info)
}

/** Clear all drag state and overlay. */
export function clearDragState(ctrl: NiiVueGPU): void {
  ctrl._activeDragMode = DRAG_MODE.none
  ctrl._pan2DxyzmmAtDragStart = null
  ctrl.model._dragOverlay = null
  ctrl.drawScene()
}

/** Pan 2D view based on drag delta in mm space. */
export function dragForPanZoom(ctrl: NiiVueGPU): void {
  const saved = ctrl._pan2DxyzmmAtDragStart
  if (!saved) return

  const startMM = screenSlicePickAt(
    ctrl,
    ctrl.dragStartXY[0],
    ctrl.dragStartXY[1],
  )
  const endMM = screenSlicePickAt(ctrl, ctrl.dragEndXY[0], ctrl.dragEndXY[1])
  if (!startMM || !endMM) return

  ctrl.model.scene.pan2Dxyzmm[0] = saved[0] + (endMM[0] - startMM[0])
  ctrl.model.scene.pan2Dxyzmm[1] = saved[1] + (endMM[1] - startMM[1])
  ctrl.model.scene.pan2Dxyzmm[2] = saved[2] + (endMM[2] - startMM[2])
}

/** Zoom 2D view based on vertical drag delta. */
export function dragForSlicer3D(ctrl: NiiVueGPU): void {
  const saved = ctrl._pan2DxyzmmAtDragStart
  if (!saved) return

  const dy = ctrl.dragEndXY[1] - ctrl.dragStartXY[1]
  let zoom = saved[3] + dy * 0.01
  zoom = Math.max(0.1, Math.min(10.0, zoom))
  const zoomChange = ctrl.model.scene.pan2Dxyzmm[3] - zoom
  ctrl.model.scene.pan2Dxyzmm[3] = zoom
  if (ctrl.model.interaction.isYoked3DTo2DZoom) {
    ctrl.model.scene.scaleMultiplier = zoom
  }

  const mm = ctrl.model.scene2mm(ctrl.model.scene.crosshairPos)
  ctrl.model.scene.pan2Dxyzmm[0] += zoomChange * mm[0]
  ctrl.model.scene.pan2Dxyzmm[1] += zoomChange * mm[1]
  ctrl.model.scene.pan2Dxyzmm[2] += zoomChange * mm[2]
}

/** Windowing: horizontal drag adjusts range width, vertical adjusts center. */
export function dragForWindowing(
  ctrl: NiiVueGPU,
  deltaX: number,
  deltaY: number,
): void {
  const vol = ctrl.model.getVolumes()[0]
  if (!vol) return

  const range = vol.robustMax - vol.robustMin
  const widthStep = range * 0.005
  const centerStep = range * 0.005

  const width = vol.calMax - vol.calMin
  const center = (vol.calMax + vol.calMin) * 0.5

  const newWidth = Math.max(1, width + deltaX * widthStep)
  const newCenter = center - deltaY * centerStep

  vol.calMin = newCenter - newWidth * 0.5
  vol.calMax = newCenter + newWidth * 0.5
  ctrl.emit("volumeUpdated", {
    volumeIndex: 0,
    volume: vol,
    changes: { calMin: vol.calMin, calMax: vol.calMax },
  })
  ctrl.updateGLVolume()
}

/** Helper: pick mm coordinates at a canvas pixel position using cached slice tiles. */
function screenSlicePickAt(
  ctrl: NiiVueGPU,
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

/** Get slice info for persisting a measurement/angle. */
function getSliceInfo(ctrl: NiiVueGPU): {
  sliceIndex: number
  sliceType: number
  slicePosition: number
} {
  const tileHit = ctrl.activeTileHit
  const cp = ctrl.model.scene.crosshairPos
  const sliceIndex = tileHit?.tileIndex ?? 0
  const sliceType = tileHit?.sliceType ?? 0
  let slicePosition = 0
  if (sliceType === SLICE_TYPE.AXIAL) slicePosition = cp[2]
  else if (sliceType === SLICE_TYPE.CORONAL) slicePosition = cp[1]
  else if (sliceType === SLICE_TYPE.SAGITTAL) slicePosition = cp[0]
  return { sliceIndex, sliceType, slicePosition }
}

/** Calculate angle between two lines (in degrees). */
export function calculateAngleBetweenLines(
  line1: number[],
  line2: number[],
): number {
  const ix = line1[2]
  const iy = line1[3]
  const v1x = line1[0] - ix
  const v1y = line1[1] - iy
  const v2x = line2[2] - ix
  const v2y = line2[3] - iy
  const dot = v1x * v2x + v1y * v2y
  const mag1 = Math.sqrt(v1x * v1x + v1y * v1y)
  const mag2 = Math.sqrt(v2x * v2x + v2y * v2y)
  if (mag1 === 0 || mag2 === 0) return 0
  const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)))
  return Math.acos(cosAngle) * (180 / Math.PI)
}
