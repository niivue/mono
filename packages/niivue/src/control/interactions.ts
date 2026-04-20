import * as Annotation from "@/annotation";
import * as DragModes from "@/control/dragModes";
import * as Drawing from "@/drawing";
import { computeSlicePointerEvent } from "@/extension/context";
import { log } from "@/logger";
import * as NVTransforms from "@/math/NVTransforms";
import * as NVConstants from "@/NVConstants";
import { DRAG_MODE, sliceTypeDim } from "@/NVConstants";
import type NiiVueGPU from "@/NVControl";
import type {
  PolygonWithHoles,
  VectorAnnotation,
  ViewHitTest,
} from "@/NVTypes";
import { computeTolerance } from "@/view/NVAnnotation";
import { type GraphLayout, graphHitTest } from "@/view/NVGraph";
import type { LegendEntry, LegendLayout } from "@/view/NVLegend";
import * as NVSliceLayout from "@/view/NVSliceLayout";

function startAnnotationDrag(ctrl: NiiVueGPU, evt: PointerEvent): void {
  ctrl.isDragging = true;
  ctrl.activeButton = evt.button;
  ctrl.lastPointerX = evt.clientX;
  ctrl.lastPointerY = evt.clientY;
  ctrl.canvas?.setPointerCapture(evt.pointerId);
}

function clientToCanvasPixel(
  ctrl: NiiVueGPU,
  clientX: number,
  clientY: number,
): [number, number] {
  const rect = ctrl.canvas?.getBoundingClientRect();
  let dpr = window.devicePixelRatio || 1;
  const forcedDpr = ctrl.opts.forceDevicePixelRatio ?? -1;
  if (forcedDpr > 0) {
    dpr = forcedDpr;
  }
  const x = (clientX - rect.left) * dpr;
  const y = (clientY - rect.top) * dpr;
  return [x, y];
}

/** Convert client coords to bounds-local pixel coords. Returns null if outside bounds. */
function clientToBoundsPixel(
  ctrl: NiiVueGPU,
  clientX: number,
  clientY: number,
): [number, number] | null {
  const [canvasX, canvasY] = clientToCanvasPixel(ctrl, clientX, clientY);
  const bounds = ctrl.opts.bounds;
  if (
    !bounds ||
    (bounds[0][0] === 0 &&
      bounds[0][1] === 0 &&
      bounds[1][0] === 1 &&
      bounds[1][1] === 1)
  ) {
    return [canvasX, canvasY];
  }
  const cw = ctrl.canvas?.width;
  const ch = ctrl.canvas?.height;
  const left = bounds[0][0] * cw;
  const top = (1 - bounds[1][1]) * ch;
  const width = (bounds[1][0] - bounds[0][0]) * cw;
  const height = (bounds[1][1] - bounds[0][1]) * ch;
  const boundsX = canvasX - left;
  const boundsY = canvasY - top;
  if (boundsX < 0 || boundsX >= width || boundsY < 0 || boundsY >= height)
    return null;
  return [boundsX, boundsY];
}

function handleGraphHitTest(ctrl: NiiVueGPU, x: number, y: number): boolean {
  const layout = ctrl.view?.graphLayout as GraphLayout | null;
  const hit = graphHitTest(x, y, layout);
  if (!hit) return false;
  if (hit.type === "deferred") {
    const vol = ctrl.volumes[0];
    if (vol?.id) {
      ctrl.loadDeferred4DVolumes(vol.id);
    }
    return true;
  }
  if (hit.type === "frame" && hit.frame >= 0) {
    const vol = ctrl.volumes[0];
    if (vol?.id) {
      ctrl.setFrame4D(vol.id, hit.frame);
    }
    return true;
  }
  // Inside graph but not on a specific element — consume to prevent tile hit
  return hit.type === "frame";
}

function legendHitTest(
  x: number,
  y: number,
  layout: LegendLayout | null,
): LegendEntry | null {
  if (!layout || layout.entries.length === 0) return null;

  // Check if click is within legend horizontal bounds
  if (x < layout.x || x > layout.x + layout.width) return null;

  // Check if click is within legend vertical bounds
  const entryHeight = layout.boxSize * 1.2; // LINE_HEIGHT_RATIO
  const totalHeight =
    layout.entries.length * entryHeight +
    (layout.entries.length - 1) * layout.gap;

  if (y < layout.y || y > layout.y + totalHeight) return null;

  // Determine which entry was clicked based on Y coordinate
  let yPos = layout.y;
  for (const entry of layout.entries) {
    if (y >= yPos && y < yPos + entryHeight) {
      return entry;
    }
    yPos += entryHeight + layout.gap;
  }

  return null;
}

function handleKeydown(ctrl: NiiVueGPU, e: KeyboardEvent): void {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const key = e.key.toUpperCase();
  if (key === "V") {
    log.info(`NIIVUE VERSION: 0.1.20260122`);
  } else if (key === "A") {
    ctrl.activeClipPlaneIndex++;
    if (ctrl.activeClipPlaneIndex >= NVConstants.NUM_CLIP_PLANE) {
      ctrl.activeClipPlaneIndex = 0;
    }
  } else if (key === "C") {
    ctrl.currentClipPlaneIndex++;
    if (ctrl.currentClipPlaneIndex > 6) ctrl.currentClipPlaneIndex = 0;
    let clipPlane = [2, 0, 0]; //none
    switch (ctrl.currentClipPlaneIndex) {
      case 3: // left a 270 e 0
        // this.scene.clipPlane = [1, 0, 0, 0];
        clipPlane = [0, 270, 0];
        break;
      case 2: // right a 90 e 0
        clipPlane = [0, 90, 0];
        break;
      case 1: // posterior a 0 e 0
        clipPlane = [0, 0, 0];
        break;
      case 4: // anterior a 0 e 0
        clipPlane = [0, 180, 0];
        break;
      case 5: // inferior a 0 e -90
        clipPlane = [0, 0, -90];
        break;
      case 6: // superior: a 0 e 90'
        clipPlane = [0, 0, 90];
        break;
    }
    ctrl.setClipPlaneDepthAziElev(
      clipPlane[0],
      clipPlane[1],
      clipPlane[2],
      ctrl.activeClipPlaneIndex,
    );
  } else if (ctrl.model.layout.sliceType === NVConstants.SLICE_TYPE.RENDER) {
    if (key === "H") {
      ctrl.model.scene.azimuth =
        (((ctrl.model.scene.azimuth - 1) % 360) + 360) % 360;
      ctrl.drawScene();
    } else if (key === "L") {
      ctrl.model.scene.azimuth =
        (((ctrl.model.scene.azimuth + 1) % 360) + 360) % 360;
      ctrl.drawScene();
    } else if (key === "K") {
      ctrl.model.scene.elevation = Math.max(
        -90,
        Math.min(90, ctrl.model.scene.elevation - 1),
      );
      ctrl.drawScene();
    } else if (key === "J") {
      ctrl.model.scene.elevation = Math.max(
        -90,
        Math.min(90, ctrl.model.scene.elevation + 1),
      );
      ctrl.drawScene();
    }
  } else {
    if (key === "H") ctrl.moveCrosshairInVox(-1, 0, 0);
    else if (key === "L") ctrl.moveCrosshairInVox(1, 0, 0);
    else if (key === "J") ctrl.moveCrosshairInVox(0, -1, 0);
    else if (key === "K") ctrl.moveCrosshairInVox(0, 1, 0);
    else if (key === "U" && e.ctrlKey) ctrl.moveCrosshairInVox(0, 0, 1);
    else if (key === "D" && e.ctrlKey) ctrl.moveCrosshairInVox(0, 0, -1);
  }
}

export function initInteraction(ctrl: NiiVueGPU): void {
  // Prevent browser default touch gestures so pointer events fire instead
  if (ctrl.canvas) ctrl.canvas.style.touchAction = "none";
  // Store bound handlers for cleanup
  ctrl._eventListeners.contextmenu = (e: Event) => {
    const evt = e as PointerEvent;
    if (!evt.shiftKey) {
      evt.preventDefault();
    }
  };
  ctrl._eventListeners.pointerdown = (e: Event) => {
    const evt = e as PointerEvent;
    // Dismiss thumbnail on click
    if (ctrl.model.ui.isThumbnailVisible) {
      ctrl.isThumbnailVisible = false;
      return;
    }
    // If Shift is held, don't start dragging to allow context menu
    if (evt.shiftKey) {
      ctrl.isDragging = false;
      ctrl.activeTileHit = null;
      return;
    }
    // Perform hit test to determine which tile was clicked
    const boundsHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
    if (!boundsHit) return; // outside this instance's bounds
    const [px, py] = boundsHit;

    // Check for legend click first
    const legendEntry = legendHitTest(px, py, ctrl.view?.legendLayout ?? null);
    if (legendEntry) {
      log.info(`Legend clicked: ${legendEntry.label}`);
      if (legendEntry.centroid) {
        ctrl.setCrosshairPos(legendEntry.centroid);
      }
      return; // Don't process tile interactions if legend was clicked
    }

    // Check for graph click
    const graphHit = handleGraphHitTest(ctrl, px, py);
    if (graphHit) return;

    ctrl.activeTileHit = ctrl.view?.hitTest(px, py) ?? null;
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
      );
      if (mm) {
        const vol = ctrl.model.getVolumes()[0];
        if (vol) {
          // Save undo state before first stroke
          const undoResult = Drawing.addUndoBitmap({
            drawBitmap: Drawing.getDrawingBitmap(ctrl.model.drawingVolume!),
            drawUndoBitmaps: ctrl.drawUndoBitmaps,
            currentDrawUndoBitmap: ctrl.currentDrawUndoBitmap,
            maxDrawUndoBitmaps: ctrl.maxDrawUndoBitmaps,
            drawFillOverwrites: ctrl.model.draw.isFillOverwriting,
          });
          ctrl.drawUndoBitmaps = undoResult.drawUndoBitmaps;
          ctrl.currentDrawUndoBitmap = undoResult.currentDrawUndoBitmap;
          if (undoResult.drawBitmap)
            ctrl.model.drawingVolume!.img = undoResult.drawBitmap;
          // Convert screen → mm → voxel
          const vox = NVTransforms.mm2vox(vol, mm);
          const pt = [
            Math.round(vox[0]),
            Math.round(vox[1]),
            Math.round(vox[2]),
          ];
          ctrl._drawPenLocation = pt;
          ctrl._drawPenAxCorSag = ctrl.activeTileHit.sliceType;
          ctrl._drawPenFillPts = [pt.slice()];
          Drawing.drawPoint({
            x: pt[0],
            y: pt[1],
            z: pt[2],
            penValue: ctrl.model.draw.penValue,
            drawBitmap: Drawing.getDrawingBitmap(ctrl.model.drawingVolume!),
            dims: vol.dimsRAS!,
            penSize: ctrl.model.draw.penSize,
            penAxCorSag: ctrl._drawPenAxCorSag,
            penOverwrites: ctrl.model.draw.isFillOverwriting,
          });
          ctrl.refreshDrawing();
          ctrl.setCrosshairPos(mm);
        }
      }
      ctrl.isDragging = true;
      ctrl.activeButton = evt.button;
      ctrl.lastPointerX = evt.clientX;
      ctrl.lastPointerY = evt.clientY;
      ctrl.canvas?.setPointerCapture(evt.pointerId);
      return;
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
      );
      if (mm) {
        const sliceType = ctrl.activeTileHit.sliceType;
        const depthDim = sliceTypeDim(sliceType);
        const slicePosition = mm[depthDim];
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          sliceType,
        );
        ctrl._annotationSliceType = sliceType;
        ctrl._annotationSlicePosition = slicePosition;
        ctrl._annotationAnchorMM = mm as [number, number, number];

        const cfg = ctrl.model.annotation;
        const tool = cfg.tool;

        // A) Selection/resize check for shape annotations
        if (!cfg.isErasing && tool !== "freehand") {
          // Check control point hit on current selection
          if (ctrl.model._annotationSelection) {
            const cpIdx = Annotation.hitTestControlPoint(
              pt2d,
              ctrl.model._annotationSelection.controlPoints,
              2.0,
            );
            if (cpIdx >= 0) {
              const ann = ctrl.model.annotations.find(
                (a) => a.id === ctrl.model._annotationSelection?.annotationId,
              );
              if (ann?.shape) {
                ctrl._annotationUndoStack.push(ctrl.model.annotations);
                ctrl._resizingControlPoint = cpIdx;
                ctrl._resizeOriginalShape = {
                  start: { ...ann.shape.start },
                  end: { ...ann.shape.end },
                  width: ann.shape.width,
                };
                ctrl._resizingAnnotation = ann;
                startAnnotationDrag(ctrl, evt);
                return;
              }
            }
          }
          // Hit-test existing shape annotations for selection
          const selTile = (ctrl.view?.screenSlices ?? [])[
            ctrl.activeTileHit.tileIndex
          ];
          const selTolerance = computeTolerance(ctrl.model);
          for (const ann of ctrl.model.annotations) {
            if (!ann.shape) continue;
            if (ann.sliceType !== sliceType) continue;
            const anchor = ann.anchorMM;
            const onSlice =
              anchor && selTile?.planeNormal && selTile?.planePoint
                ? Annotation.isOnSlice(
                    anchor,
                    selTile.planeNormal,
                    selTile.planePoint,
                    selTolerance,
                  )
                : Math.abs(ann.slicePosition - slicePosition) <= selTolerance;
            if (!onSlice) continue;
            if (Annotation.hitTestAnnotationPolygon(pt2d, ann) !== -1) {
              ctrl.model._annotationSelection = {
                annotationId: ann.id,
                controlPoints: Annotation.getControlPoints(ann.shape),
              };
              ctrl.drawScene();
              return;
            }
          }
          // No selection hit — clear selection and start new shape
          ctrl.model._annotationSelection = null;
          ctrl._annotationShapeStart = pt2d;
          startAnnotationDrag(ctrl, evt);
          return;
        }

        // C) Freehand / eraser mode
        ctrl._annotationBrushPath = [pt2d];
        startAnnotationDrag(ctrl, evt);
        return;
      }
    }
    ctrl.isDragging = true;
    ctrl.activeButton = evt.button;
    // 2D slice tile: dispatch through drag mode system
    if (ctrl.activeTileHit && !ctrl.activeTileHit.isRender) {
      const mode = DragModes.getDragModeForButton(ctrl, evt.button);
      ctrl._activeDragMode = mode;
      ctrl.dragStartXY = [px, py];
      ctrl.dragEndXY = [px, py];
      // Clear any previous overlay and reset stale angle state
      ctrl.model._dragOverlay = null;
      if (mode !== DRAG_MODE.angle) {
        ctrl._angleState = "none";
      }
      if (mode === DRAG_MODE.crosshair) {
        const mm = NVSliceLayout.screenSlicePick(
          ctrl.view?.screenSlices ?? [],
          ctrl.model,
          px,
          py,
          ctrl.activeTileHit,
        );
        if (mm) ctrl.setCrosshairPos(mm);
      } else if (mode === DRAG_MODE.pan || mode === DRAG_MODE.slicer3D) {
        const p = ctrl.model.scene.pan2Dxyzmm;
        ctrl._pan2DxyzmmAtDragStart = [p[0], p[1], p[2], p[3]];
      } else if (mode === DRAG_MODE.angle) {
        if (ctrl._angleState !== "drawing_second_line") {
          ctrl._angleState = "drawing_first_line";
        }
      }
    }
    ctrl.lastPointerX = evt.clientX;
    ctrl.lastPointerY = evt.clientY;
    // Capture the pointer so pointermove/pointerup fire on the canvas
    // even when the pointer moves outside it
    ctrl.canvas?.setPointerCapture(evt.pointerId);
  };
  ctrl._eventListeners.pointerup = (e: Event) => {
    // Finalize drawing stroke on mouse-up
    if (
      ctrl.model.draw.isEnabled &&
      ctrl._drawPenFillPts.length > 0 &&
      ctrl.model.drawingVolume
    ) {
      const vol = ctrl.model.getVolumes()[0];
      if (vol?.dimsRAS) {
        if (ctrl.drawPenAutoClose && ctrl._drawPenFillPts.length > 2) {
          Drawing.drawLine({
            ptA: ctrl._drawPenLocation,
            ptB: ctrl._drawPenFillPts[0],
            penValue: ctrl.model.draw.penValue,
            drawBitmap: Drawing.getDrawingBitmap(ctrl.model.drawingVolume!),
            dims: vol.dimsRAS,
            penSize: ctrl.model.draw.penSize,
            penAxCorSag: ctrl._drawPenAxCorSag,
            penOverwrites: ctrl.model.draw.isFillOverwriting,
          });
        }
        if (ctrl.drawPenFilled && ctrl._drawPenFillPts.length > 2) {
          const currentUndo =
            ctrl.drawUndoBitmaps[ctrl.currentDrawUndoBitmap] ?? null;
          const fillResult = Drawing.drawPenFilled({
            penFillPts: ctrl._drawPenFillPts,
            penAxCorSag: ctrl._drawPenAxCorSag,
            drawBitmap: Drawing.getDrawingBitmap(ctrl.model.drawingVolume!),
            dims: vol.dimsRAS,
            penValue: ctrl.model.draw.penValue,
            fillOverwrites: ctrl.model.draw.isFillOverwriting,
            currentUndoBitmap: currentUndo,
          });
          if (fillResult.success) {
            ctrl.model.drawingVolume!.img = fillResult.drawBitmap;
          }
        }
        ctrl.refreshDrawing();
      }
      ctrl._drawPenLocation = [NaN, NaN, NaN];
      ctrl._drawPenAxCorSag = -1;
      ctrl._drawPenFillPts = [];
      ctrl.emit("drawingChanged", { action: "stroke" });
    }
    // Finalize resize on mouse-up
    if (ctrl.model.annotation.isEnabled && ctrl._resizingControlPoint >= 0) {
      const sel = ctrl.model._annotationSelection;
      if (sel) {
        const ann = ctrl._resizingAnnotation;
        if (ann?.shape) {
          const cfg = ctrl.model.annotation;
          const shapeWidth = ann.shape.width ?? cfg.style.strokeWidth;
          const polygons = Annotation.generateShape(
            ann.shape.type,
            ann.shape.start,
            ann.shape.end,
            shapeWidth,
          );
          if (polygons.length > 0) {
            ann.polygons = polygons;
            sel.controlPoints = Annotation.getControlPoints(ann.shape);
          }
          if (Annotation.isMeasureTool(ann.shape.type)) {
            const vol = ctrl.model.getVolumes()[0];
            if (vol)
              ann.stats =
                Annotation.computeAnnotationStats(ann, vol) ?? undefined;
          }
          ctrl.emit("annotationChanged", { action: "resize" });
        }
      }
      ctrl._resizingControlPoint = -1;
      ctrl._resizeOriginalShape = null;
      ctrl._resizingAnnotation = null;
      ctrl.model._annotationPreview = null;
      ctrl.drawScene();
    }
    // Finalize shape creation on mouse-up
    if (ctrl.model.annotation.isEnabled && ctrl._annotationShapeStart) {
      const evt2 = e as PointerEvent;
      const shapeHit = clientToBoundsPixel(ctrl, evt2.clientX, evt2.clientY);
      if (shapeHit && ctrl.activeTileHit && !ctrl.activeTileHit.isRender) {
        const mm = NVSliceLayout.screenSlicePick(
          ctrl.view?.screenSlices ?? [],
          ctrl.model,
          shapeHit[0],
          shapeHit[1],
          ctrl.activeTileHit,
        );
        if (mm) {
          let pt2d = Annotation.mmToSlice2D(
            mm as [number, number, number],
            ctrl._annotationSliceType,
          );
          const cfg = ctrl.model.annotation;
          if (Annotation.isCircleTool(cfg.tool)) {
            pt2d = Annotation.constrainCircleEnd(
              ctrl._annotationShapeStart,
              pt2d,
            );
          }
          const polygons = Annotation.generateShape(
            cfg.tool,
            ctrl._annotationShapeStart,
            pt2d,
            cfg.style.strokeWidth,
          );
          if (polygons.length > 0) {
            ctrl._annotationUndoStack.push(ctrl.model.annotations);
            const newAnn = Annotation.createAnnotation(
              cfg.activeLabel,
              cfg.activeGroup,
              ctrl._annotationSliceType,
              ctrl._annotationSlicePosition,
              polygons,
              cfg.style,
              ctrl._annotationAnchorMM,
            );
            const shapeData: typeof newAnn.shape = {
              type: cfg.tool,
              start: ctrl._annotationShapeStart,
              end: pt2d,
            };
            if (
              cfg.tool === "line" ||
              cfg.tool === "arrow" ||
              cfg.tool === "measureLine"
            ) {
              shapeData.width = cfg.style.strokeWidth;
            }
            newAnn.shape = shapeData;
            if (Annotation.isMeasureTool(cfg.tool)) {
              const vol = ctrl.model.getVolumes()[0];
              if (vol)
                newAnn.stats =
                  Annotation.computeAnnotationStats(newAnn, vol) ?? undefined;
            }
            ctrl.model.annotations = Annotation.mergeAnnotations(
              ctrl.model.annotations,
              newAnn,
            );
            ctrl.emit("annotationAdded", { annotation: newAnn });
            ctrl.emit("annotationChanged", { action: "draw" });
          }
        }
      }
      ctrl._annotationShapeStart = null;
      ctrl.model._annotationPreview = null;
      ctrl.drawScene();
    }
    // Finalize annotation stroke on mouse-up (freehand/eraser)
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._annotationBrushPath.length > 0
    ) {
      if (ctrl._annotationBrushPath.length > 1) {
        // Save undo snapshot before modifying annotations
        ctrl._annotationUndoStack.push(ctrl.model.annotations);
        const cfg = ctrl.model.annotation;
        if (cfg.isErasing) {
          // Commit the erase preview (already computed during pointermove)
          if (ctrl.model._annotationErasePreview) {
            ctrl.model.annotations = ctrl.model._annotationErasePreview;
          }
          ctrl.emit("annotationChanged", { action: "erase" });
        } else {
          const usePolygonMode = cfg.brushRadius <= 1;
          let polygons: PolygonWithHoles[] = [];
          if (usePolygonMode) {
            // Polygon mode: use frozen loop or auto-close path
            const pts = ctrl._frozenLoopPoints ?? ctrl._annotationBrushPath;
            if (pts.length >= 3) {
              polygons = [{ outer: pts, holes: [] }];
            }
          } else {
            // Brush mode: inflate path
            polygons = Annotation.clipperInflatePath(
              ctrl._annotationBrushPath,
              cfg.brushRadius,
            );
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
            );
            ctrl.model.annotations = Annotation.mergeAnnotations(
              ctrl.model.annotations,
              newAnn,
            );
            ctrl.emit("annotationAdded", { annotation: newAnn });
            ctrl.emit("annotationChanged", { action: "draw" });
          }
        }
        ctrl.drawScene();
      }
      ctrl._annotationBrushPath = [];
      ctrl._frozenLoopPoints = null;
      ctrl.model._annotationPreview = null;
      ctrl.model._annotationErasePreview = null;
    }
    // Handle drag mode release for 2D slices
    if (ctrl._activeDragMode !== DRAG_MODE.none) {
      DragModes.handleDragRelease(ctrl);
    }
    ctrl.isDragging = false;
    ctrl.activeTileHit = null;
    const evt = e as PointerEvent;
    // Emit high-level slice pointer event for extensions
    const sliceEvt = computeSlicePointerEvent(ctrl, evt);
    if (sliceEvt) {
      ctrl.emit(
        "slicePointerUp" as keyof import("@/NVEvents").NVEventMap,
        sliceEvt as never,
      );
    }
    ctrl.emit("pointerUp", {
      x: evt.offsetX,
      y: evt.offsetY,
      button: evt.button,
    });
    try {
      ctrl.canvas?.releasePointerCapture(evt.pointerId);
    } catch {
      /* already released */
    }
  };
  ctrl._eventListeners.pointermove = (e: Event) => {
    const evt = e as PointerEvent;
    // Annotation brush cursor preview (hover, no drag required)
    if (ctrl.model.annotation.isEnabled && !ctrl.isDragging) {
      const hit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (hit) {
        const tileHit = ctrl.view?.hitTest(hit[0], hit[1]) ?? null;
        if (tileHit && !tileHit.isRender) {
          const mm = NVSliceLayout.screenSlicePick(
            ctrl.view?.screenSlices ?? [],
            ctrl.model,
            hit[0],
            hit[1],
            tileHit,
          );
          if (mm) {
            const sliceType = tileHit.sliceType;
            const depthDim = sliceTypeDim(sliceType);
            ctrl.model._annotationCursor = {
              mm: mm as [number, number, number],
              sliceType,
              slicePosition: mm[depthDim],
            };
            ctrl.drawScene();
            return;
          }
        }
      }
      if (ctrl.model._annotationCursor) {
        ctrl.model._annotationCursor = null;
        ctrl.drawScene();
      }
      return;
    }
    if (!ctrl.isDragging) {
      // Emit high-level slice pointer event for extensions
      const sliceEvt = computeSlicePointerEvent(ctrl, evt);
      if (sliceEvt) {
        ctrl.emit(
          "slicePointerMove" as keyof import("@/NVEvents").NVEventMap,
          sliceEvt as never,
        );
      }
      return;
    }
    const deltaX = evt.clientX - ctrl.lastPointerX;
    const deltaY = evt.clientY - ctrl.lastPointerY;
    if (deltaX === 0 && deltaY === 0) return;
    ctrl.lastPointerX = evt.clientX;
    ctrl.lastPointerY = evt.clientY;
    // Drawing drag: paint along stroke
    if (
      ctrl.model.draw.isEnabled &&
      ctrl._drawPenAxCorSag >= 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      ctrl.model.drawingVolume
    ) {
      const drawHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (!drawHit) return;
      const [px, py] = drawHit;
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      );
      if (mm) {
        const vol = ctrl.model.getVolumes()[0];
        if (vol?.dimsRAS) {
          const vox = NVTransforms.mm2vox(vol, mm);
          const newPt = [
            Math.round(vox[0]),
            Math.round(vox[1]),
            Math.round(vox[2]),
          ];
          if (!Drawing.isSamePoint(ctrl._drawPenLocation, newPt)) {
            Drawing.drawLine({
              ptA: ctrl._drawPenLocation,
              ptB: newPt,
              penValue: ctrl.model.draw.penValue,
              drawBitmap: Drawing.getDrawingBitmap(ctrl.model.drawingVolume!),
              dims: vol.dimsRAS,
              penSize: ctrl.model.draw.penSize,
              penAxCorSag: ctrl._drawPenAxCorSag,
              penOverwrites: ctrl.model.draw.isFillOverwriting,
            });
            ctrl._drawPenLocation = newPt;
            ctrl._drawPenFillPts.push(newPt.slice());
            ctrl.refreshDrawing();
            ctrl.setCrosshairPos(mm);
          }
        }
      }
      return;
    }
    // Annotation resize drag
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._resizingControlPoint >= 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const resHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (!resHit) return;
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        resHit[0],
        resHit[1],
        ctrl.activeTileHit,
      );
      if (mm && ctrl._resizeOriginalShape && ctrl.model._annotationSelection) {
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          ctrl._annotationSliceType,
        );
        const ann = ctrl._resizingAnnotation;
        if (ann?.shape) {
          const newBox = Annotation.updateShapeBounds(
            ann.shape.type,
            ctrl._resizeOriginalShape,
            ctrl._resizingControlPoint,
            pt2d,
          );
          ann.shape.start = newBox.start;
          ann.shape.end = newBox.end;
          if (newBox.width !== undefined) ann.shape.width = newBox.width;
          const shapeWidth =
            ann.shape.width ?? ctrl.model.annotation.style.strokeWidth;
          const polygons = Annotation.generateShape(
            ann.shape.type,
            newBox.start,
            newBox.end,
            shapeWidth,
          );
          if (polygons.length > 0) {
            ann.polygons = polygons;
            ctrl.model._annotationSelection.controlPoints =
              Annotation.getControlPoints(ann.shape);
          }
          ctrl.drawScene();
        }
      }
      return;
    }
    // Annotation shape drag: preview shape from start to current
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._annotationShapeStart &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const shpHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (!shpHit) return;
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        shpHit[0],
        shpHit[1],
        ctrl.activeTileHit,
      );
      if (mm) {
        let pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          ctrl._annotationSliceType,
        );
        const cfg = ctrl.model.annotation;
        if (Annotation.isCircleTool(cfg.tool)) {
          pt2d = Annotation.constrainCircleEnd(
            ctrl._annotationShapeStart,
            pt2d,
          );
        }
        const polygons = Annotation.generateShape(
          cfg.tool,
          ctrl._annotationShapeStart,
          pt2d,
          cfg.style.strokeWidth,
        );
        if (polygons.length > 0) {
          const preview = Annotation.createAnnotation(
            cfg.activeLabel,
            cfg.activeGroup,
            ctrl._annotationSliceType,
            ctrl._annotationSlicePosition,
            polygons,
            cfg.style,
            ctrl._annotationAnchorMM,
          );
          preview.shape = {
            type: cfg.tool,
            start: ctrl._annotationShapeStart,
            end: pt2d,
          };
          if (cfg.tool === "measureLine") {
            const dx = pt2d.x - ctrl._annotationShapeStart.x;
            const dy = pt2d.y - ctrl._annotationShapeStart.y;
            preview.stats = {
              area: 0,
              min: 0,
              mean: 0,
              max: 0,
              stdDev: 0,
              length: Math.sqrt(dx * dx + dy * dy),
            };
          }
          ctrl.model._annotationPreview = preview;
        } else {
          ctrl.model._annotationPreview = null;
        }
        ctrl.drawScene();
      }
      return;
    }
    // Annotation drag: accumulate brush path (freehand/eraser)
    if (
      ctrl.model.annotation.isEnabled &&
      ctrl._annotationBrushPath.length > 0 &&
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender
    ) {
      const annHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (!annHit) return;
      const [px, py] = annHit;
      const mm = NVSliceLayout.screenSlicePick(
        ctrl.view?.screenSlices ?? [],
        ctrl.model,
        px,
        py,
        ctrl.activeTileHit,
      );
      if (mm) {
        const sliceType = ctrl.activeTileHit.sliceType;
        const depthDim = sliceTypeDim(sliceType);
        ctrl.model._annotationCursor = {
          mm: mm as [number, number, number],
          sliceType,
          slicePosition: mm[depthDim],
        };
        const pt2d = Annotation.mmToSlice2D(
          mm as [number, number, number],
          sliceType,
        );
        const lastPt =
          ctrl._annotationBrushPath[ctrl._annotationBrushPath.length - 1];
        if (lastPt) {
          const dist = Math.sqrt(
            (pt2d.x - lastPt.x) ** 2 + (pt2d.y - lastPt.y) ** 2,
          );
          if (dist > 0.1) {
            ctrl._annotationBrushPath.push(pt2d);
            if (ctrl._annotationBrushPath.length > 1) {
              const cfg = ctrl.model.annotation;
              const usePolygonMode = cfg.brushRadius <= 1;
              if (cfg.isErasing) {
                // Erase preview
                const erasePreview: VectorAnnotation[] = [];
                const eraseTile = (ctrl.view?.screenSlices ?? [])[
                  ctrl.activeTileHit?.tileIndex
                ];
                const eraseTolerance = computeTolerance(ctrl.model);
                for (const ann of ctrl.model.annotations) {
                  const anchor = ann.anchorMM;
                  const onSlice =
                    anchor && eraseTile?.planeNormal && eraseTile?.planePoint
                      ? Annotation.isOnSlice(
                          anchor,
                          eraseTile.planeNormal,
                          eraseTile.planePoint,
                          eraseTolerance,
                        )
                      : Math.abs(
                          ann.slicePosition - ctrl._annotationSlicePosition,
                        ) <= eraseTolerance;
                  if (ann.sliceType !== ctrl._annotationSliceType || !onSlice) {
                    erasePreview.push(ann);
                    continue;
                  }
                  const newPolys = [];
                  for (const poly of ann.polygons) {
                    newPolys.push(
                      ...Annotation.clipperSubtractBrush(
                        poly,
                        ctrl._annotationBrushPath,
                        cfg.brushRadius,
                      ),
                    );
                  }
                  if (newPolys.length > 0) {
                    erasePreview.push({ ...ann, polygons: newPolys });
                  }
                }
                ctrl.model._annotationErasePreview = erasePreview;
              } else if (usePolygonMode) {
                // Polygon mode: detect self-intersection for auto-close
                if (
                  !ctrl._frozenLoopPoints &&
                  ctrl._annotationBrushPath.length >= 4
                ) {
                  const ix = Annotation.findFirstSelfIntersection(
                    ctrl._annotationBrushPath,
                  );
                  if (ix) {
                    ctrl._frozenLoopPoints = Annotation.extractClosedLoop(
                      ctrl._annotationBrushPath,
                      ix,
                    );
                  }
                }
                // Preview: use frozen loop or auto-close the current path
                const previewPts =
                  ctrl._frozenLoopPoints ?? ctrl._annotationBrushPath;
                if (previewPts.length >= 3) {
                  const poly: PolygonWithHoles = {
                    outer: previewPts,
                    holes: [],
                  };
                  ctrl.model._annotationPreview = Annotation.createAnnotation(
                    cfg.activeLabel,
                    cfg.activeGroup,
                    ctrl._annotationSliceType,
                    ctrl._annotationSlicePosition,
                    [poly],
                    cfg.style,
                    ctrl._annotationAnchorMM,
                  );
                }
              } else {
                // Brush mode: inflate path
                const inflated = Annotation.clipperInflatePath(
                  ctrl._annotationBrushPath,
                  cfg.brushRadius,
                );
                if (inflated.length > 0) {
                  ctrl.model._annotationPreview = Annotation.createAnnotation(
                    cfg.activeLabel,
                    cfg.activeGroup,
                    ctrl._annotationSliceType,
                    ctrl._annotationSlicePosition,
                    inflated,
                    cfg.style,
                    ctrl._annotationAnchorMM,
                  );
                }
              }
              ctrl.drawScene();
            }
          }
        }
      }
      return;
    }
    // 2D slice tiles: dispatch through drag mode system
    if (
      ctrl.activeTileHit &&
      !ctrl.activeTileHit.isRender &&
      ctrl._activeDragMode !== DRAG_MODE.none
    ) {
      const sliceHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
      if (!sliceHit) return;
      const [px, py] = sliceHit;
      ctrl.dragEndXY = [px, py];

      switch (ctrl._activeDragMode) {
        case DRAG_MODE.crosshair: {
          const mm = NVSliceLayout.screenSlicePick(
            ctrl.view?.screenSlices ?? [],
            ctrl.model,
            px,
            py,
            ctrl.activeTileHit,
          );
          if (mm) ctrl.setCrosshairPos(mm);
          break;
        }
        case DRAG_MODE.pan:
          DragModes.dragForPanZoom(ctrl);
          ctrl.drawScene();
          break;
        case DRAG_MODE.slicer3D:
          DragModes.dragForSlicer3D(ctrl);
          ctrl.drawScene();
          break;
        case DRAG_MODE.windowing:
          DragModes.dragForWindowing(ctrl, deltaX, deltaY);
          ctrl.drawScene();
          break;
        case DRAG_MODE.contrast:
        case DRAG_MODE.measurement:
        case DRAG_MODE.callbackOnly:
        case DRAG_MODE.roiSelection:
        case DRAG_MODE.angle:
          DragModes.updateDragOverlay(ctrl);
          ctrl.drawScene();
          break;
        // DRAG_MODE.none: do nothing
      }
      return;
    }
    // 3D render tiles: existing rotation/clip behavior
    if (ctrl.activeButton === 2) {
      const dae = ctrl.getClipPlaneDepthAziElev(ctrl.activeClipPlaneIndex);
      dae[1] += deltaX;
      dae[2] -= deltaY;
      ctrl.setClipPlaneDepthAziElev(
        dae[0],
        dae[1],
        dae[2],
        ctrl.activeClipPlaneIndex,
      );
      ctrl.drawScene();
      return;
    }
    const sensitivity = 0.5;
    ctrl.model.scene.azimuth =
      (((ctrl.model.scene.azimuth + deltaX * sensitivity) % 360) + 360) % 360;
    ctrl.model.scene.elevation = Math.max(
      -90,
      Math.min(90, ctrl.model.scene.elevation + deltaY * sensitivity),
    );
    ctrl.drawScene();
  };
  ctrl._eventListeners.wheel = (e: Event) => {
    const evt = e as WheelEvent;
    // Perform hit test to determine which tile the wheel event is on
    const wheelHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
    if (!wheelHit) return; // outside this instance's bounds
    evt.preventDefault();
    const [px, py] = wheelHit;
    const hit = ctrl.view?.hitTest(px, py);
    if (!hit) return;
    // 2D slice: zoom when pan/slicer3D mode, otherwise step crosshair
    if (!hit.isRender) {
      const isPanZoomMode =
        ctrl.model.interaction.primaryDragMode === DRAG_MODE.pan ||
        ctrl.model.interaction.primaryDragMode === DRAG_MODE.slicer3D ||
        ctrl.model.interaction.secondaryDragMode === DRAG_MODE.pan ||
        ctrl.model.interaction.secondaryDragMode === DRAG_MODE.slicer3D;
      if (isPanZoomMode) {
        const zoomDirection = evt.deltaY < 0 ? 1 : -1;
        let zoom = ctrl.model.scene.pan2Dxyzmm[3] * (1.0 + 0.1 * zoomDirection);
        zoom = Math.round(zoom * 10) / 10;
        zoom = Math.max(0.1, Math.min(10.0, zoom));
        const zoomChange = ctrl.model.scene.pan2Dxyzmm[3] - zoom;
        if (ctrl.model.interaction.isYoked3DTo2DZoom) {
          ctrl.model.scene.scaleMultiplier = zoom;
        }
        ctrl.model.scene.pan2Dxyzmm[3] = zoom;
        // Adjust pan so zoom centers on the crosshair
        const mm = ctrl.model.scene2mm(ctrl.model.scene.crosshairPos);
        ctrl.model.scene.pan2Dxyzmm[0] += zoomChange * mm[0];
        ctrl.model.scene.pan2Dxyzmm[1] += zoomChange * mm[1];
        ctrl.model.scene.pan2Dxyzmm[2] += zoomChange * mm[2];
        ctrl.drawScene();
        return;
      }
      const delta = evt.deltaY > 0 ? 1 : -1;
      const volumes = ctrl.model.getVolumes();
      if (volumes.length > 0) {
        const depthAxis = sliceTypeDim(hit.sliceType);
        const step: [number, number, number] = [0, 0, 0];
        step[depthAxis] = delta;
        ctrl.moveCrosshairInVox(step[0], step[1], step[2]);
      } else {
        // Mesh-only: step in scene fraction via mm
        const depthDim = sliceTypeDim(hit.sliceType);
        const mm = ctrl.model.scene2mm(ctrl.model.scene.crosshairPos);
        const range =
          ctrl.model.extentsMax[depthDim] - ctrl.model.extentsMin[depthDim];
        mm[depthDim] += delta * range * 0.01;
        ctrl.setCrosshairPos([mm[0], mm[1], mm[2]]);
      }
      return;
    }
    const dae = ctrl.getClipPlaneDepthAziElev(ctrl.activeClipPlaneIndex);
    if (dae[0] > -1 && dae[0] < 1) {
      const clipSpeed = 0.00005;
      dae[0] += evt.deltaY * clipSpeed;
      dae[0] = Math.max(-0.49, Math.min(0.49, dae[0]));
      ctrl.setClipPlaneDepthAziElev(
        dae[0],
        dae[1],
        dae[2],
        ctrl.activeClipPlaneIndex,
      );
      ctrl.drawScene();
      return;
    }
    const zoomSpeed = 0.001;
    ctrl.model.scene.scaleMultiplier =
      ctrl.model.scene.scaleMultiplier + evt.deltaY * zoomSpeed;
    ctrl.model.scene.scaleMultiplier = Math.max(
      0.5,
      Math.min(2.0, ctrl.model.scene.scaleMultiplier),
    );
    ctrl.drawScene();
  };
  ctrl._eventListeners.keydown = (e: Event) =>
    handleKeydown(ctrl, e as KeyboardEvent);
  ctrl._eventListeners.dblclick = async (e: Event) => {
    const evt = e as PointerEvent;
    const dblHit = clientToBoundsPixel(ctrl, evt.clientX, evt.clientY);
    if (!dblHit) return; // outside this instance's bounds
    const [px, py] = dblHit;
    const mm = (await ctrl.view?.depthPick(px, py)) ?? null;
    if (mm) {
      ctrl.setCrosshairPos(mm);
    } else {
      // Redraw to fix any pixel artifacts from the depth-pick shader
      ctrl.drawScene();
    }
  };
  ctrl._eventListeners.pointerleave = () => {
    if (ctrl.model._annotationCursor) {
      ctrl.model._annotationCursor = null;
      ctrl.drawScene();
    }
    ctrl.emit(
      "slicePointerLeave" as keyof import("@/NVEvents").NVEventMap,
      undefined as never,
    );
  };
  // Add event listeners (pointer events on canvas with capture for drag tracking)
  ctrl.canvas?.addEventListener(
    "contextmenu",
    ctrl._eventListeners.contextmenu,
  );
  ctrl.canvas?.addEventListener(
    "pointerdown",
    ctrl._eventListeners.pointerdown,
  );
  ctrl.canvas?.addEventListener("pointerup", ctrl._eventListeners.pointerup);
  ctrl.canvas?.addEventListener(
    "pointermove",
    ctrl._eventListeners.pointermove,
  );
  ctrl.canvas?.addEventListener(
    "pointerleave",
    ctrl._eventListeners.pointerleave,
  );
  ctrl.canvas?.addEventListener("wheel", ctrl._eventListeners.wheel, {
    passive: false,
  });
  window.addEventListener("keydown", ctrl._eventListeners.keydown);
  ctrl.canvas?.addEventListener("dblclick", ctrl._eventListeners.dblclick);
}

export function removeInteractionListeners(ctrl: NiiVueGPU): void {
  if (ctrl._eventListeners.contextmenu) {
    ctrl.canvas?.removeEventListener(
      "contextmenu",
      ctrl._eventListeners.contextmenu,
    );
  }
  if (ctrl._eventListeners.pointerdown) {
    ctrl.canvas?.removeEventListener(
      "pointerdown",
      ctrl._eventListeners.pointerdown,
    );
  }
  if (ctrl._eventListeners.pointerup) {
    ctrl.canvas?.removeEventListener(
      "pointerup",
      ctrl._eventListeners.pointerup,
    );
  }
  if (ctrl._eventListeners.pointermove) {
    ctrl.canvas?.removeEventListener(
      "pointermove",
      ctrl._eventListeners.pointermove,
    );
  }
  if (ctrl._eventListeners.wheel) {
    ctrl.canvas?.removeEventListener("wheel", ctrl._eventListeners.wheel);
  }
  if (ctrl._eventListeners.keydown) {
    window.removeEventListener("keydown", ctrl._eventListeners.keydown);
  }
  if (ctrl._eventListeners.dragover) {
    ctrl.canvas?.removeEventListener("dragover", ctrl._eventListeners.dragover);
  }
  if (ctrl._eventListeners.drop) {
    ctrl.canvas?.removeEventListener("drop", ctrl._eventListeners.drop);
  }
  if (ctrl._eventListeners.dblclick) {
    ctrl.canvas?.removeEventListener("dblclick", ctrl._eventListeners.dblclick);
  }
  if (ctrl._eventListeners.pointerleave) {
    ctrl.canvas?.removeEventListener(
      "pointerleave",
      ctrl._eventListeners.pointerleave,
    );
  }
  if (ctrl.canvas) {
    ctrl.canvas.style.touchAction = "";
  }
}

export function setupDragAndDrop(ctrl: NiiVueGPU): void {
  ctrl._eventListeners.dragover = (event: Event) => {
    const evt = event as DragEvent;
    evt.preventDefault();
    if (evt.dataTransfer) {
      evt.dataTransfer.dropEffect = "copy";
    }
  };

  ctrl._eventListeners.drop = async (event: Event) => {
    const evt = event as DragEvent;
    evt.preventDefault();
    if (!ctrl.opts.isDragDropEnabled) return;
    const files = evt.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      try {
        // Check if it's a NiiVue document file
        if (file.name.toLowerCase().endsWith(".nvd")) {
          await ctrl.loadDocument(file);
        } else {
          await ctrl.loadImage(file);
        }
      } catch (err) {
        log.error("Failed to load dropped file:", err);
      }
    }
  };

  ctrl.canvas?.addEventListener("dragover", ctrl._eventListeners.dragover);
  ctrl.canvas?.addEventListener("drop", ctrl._eventListeners.drop);
}

export function setupResizeHandler(ctrl: NiiVueGPU): void {
  if (ctrl.resizeObserver) {
    ctrl.resizeObserver.disconnect();
  }
  ctrl.resizeObserver = new ResizeObserver(() => {
    ctrl.view?.resize();
    if (ctrl.canvas) {
      ctrl.emit("canvasResize", {
        width: ctrl.canvas.clientWidth,
        height: ctrl.canvas.clientHeight,
      });
    }
  });
  try {
    ctrl.resizeObserver.observe(ctrl.canvas!, {
      box: "device-pixel-content-box",
    });
  } catch {
    ctrl.resizeObserver.observe(ctrl.canvas!);
  }
}

export function hitTest(
  ctrl: NiiVueGPU,
  x: number,
  y: number,
): ViewHitTest | null {
  return ctrl.view?.hitTest(x, y) ?? null;
}
