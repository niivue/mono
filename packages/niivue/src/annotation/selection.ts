import type { AnnotationPoint, AnnotationTool } from "@/NVTypes";

export type AnnotationSelection = {
  annotationId: string;
  controlPoints: AnnotationPoint[];
};

export type ShapeBoundsUpdate = {
  start: AnnotationPoint;
  end: AnnotationPoint;
  width?: number;
};

/**
 * Returns control points placed directly on the shape.
 *
 * Rectangle (8): 4 corners + 4 edge midpoints
 * Ellipse (4): cardinal points on the ellipse curve
 * Line/Arrow (3): start, end, + side handle for thickness
 */
export function getControlPoints(shape: {
  type: AnnotationTool;
  start: AnnotationPoint;
  end: AnnotationPoint;
  width?: number;
}): AnnotationPoint[] {
  switch (shape.type) {
    case "rectangle":
    case "measureRect": {
      const minX = Math.min(shape.start.x, shape.end.x);
      const maxX = Math.max(shape.start.x, shape.end.x);
      const minY = Math.min(shape.start.y, shape.end.y);
      const maxY = Math.max(shape.start.y, shape.end.y);
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      return [
        { x: minX, y: minY }, // 0: TL
        { x: maxX, y: minY }, // 1: TR
        { x: maxX, y: maxY }, // 2: BR
        { x: minX, y: maxY }, // 3: BL
        { x: midX, y: minY }, // 4: top-mid
        { x: maxX, y: midY }, // 5: right-mid
        { x: midX, y: maxY }, // 6: bottom-mid
        { x: minX, y: midY }, // 7: left-mid
      ];
    }
    case "ellipse":
    case "measureEllipse":
    case "circle":
    case "measureCircle": {
      const cx = (shape.start.x + shape.end.x) / 2;
      const cy = (shape.start.y + shape.end.y) / 2;
      const rx = Math.abs(shape.end.x - shape.start.x) / 2;
      const ry = Math.abs(shape.end.y - shape.start.y) / 2;
      return [
        { x: cx, y: cy - ry }, // 0: top
        { x: cx + rx, y: cy }, // 1: right
        { x: cx, y: cy + ry }, // 2: bottom
        { x: cx - rx, y: cy }, // 3: left
      ];
    }
    case "line":
    case "arrow":
    case "measureLine": {
      const hw = (shape.width ?? 2) / 2;
      const midX = (shape.start.x + shape.end.x) / 2;
      const midY = (shape.start.y + shape.end.y) / 2;
      const dx = shape.end.x - shape.start.x;
      const dy = shape.end.y - shape.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      // Perpendicular offset for the width handle
      const px = len > 1e-9 ? (-dy / len) * hw : hw;
      const py = len > 1e-9 ? (dx / len) * hw : 0;
      return [
        { x: shape.start.x, y: shape.start.y }, // 0: start/tail
        { x: shape.end.x, y: shape.end.y }, // 1: end/tip
        { x: midX + px, y: midY + py }, // 2: width handle
      ];
    }
    default:
      return [];
  }
}

export function hitTestControlPoint(
  point: AnnotationPoint,
  controlPoints: AnnotationPoint[],
  hitRadius: number,
): number {
  for (let i = 0; i < controlPoints.length; i++) {
    const cp = controlPoints[i]!;
    const dx = point.x - cp.x;
    const dy = point.y - cp.y;
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return i;
  }
  return -1;
}

/**
 * Recompute shape bounds when a control point is dragged.
 *
 * Rectangle corners (0-3): opposite corner stays fixed.
 * Rectangle sides (4-7): constrain one axis.
 * Ellipse cardinals (0-3): move the corresponding edge.
 * Line/Arrow 0-1: move that endpoint.
 * Line/Arrow 2: adjust width (perpendicular distance to line).
 */
export function updateShapeBounds(
  shapeType: AnnotationTool,
  original: { start: AnnotationPoint; end: AnnotationPoint; width?: number },
  controlPointIndex: number,
  newPosition: AnnotationPoint,
): ShapeBoundsUpdate {
  switch (shapeType) {
    case "rectangle":
    case "measureRect":
      return _updateRectangle(original, controlPointIndex, newPosition);
    case "ellipse":
    case "measureEllipse":
      return _updateEllipse(original, controlPointIndex, newPosition);
    case "circle":
    case "measureCircle":
      return _updateCircle(original, controlPointIndex, newPosition);
    case "line":
    case "arrow":
    case "measureLine":
      return _updateLineArrow(original, controlPointIndex, newPosition);
    default:
      return { start: { ...original.start }, end: { ...original.end } };
  }
}

function _updateRectangle(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const minX = Math.min(original.start.x, original.end.x);
  const maxX = Math.max(original.start.x, original.end.x);
  const minY = Math.min(original.start.y, original.end.y);
  const maxY = Math.max(original.start.y, original.end.y);
  switch (idx) {
    case 0:
      return { start: { x: maxX, y: maxY }, end: pos };
    case 1:
      return { start: { x: minX, y: maxY }, end: pos };
    case 2:
      return { start: { x: minX, y: minY }, end: pos };
    case 3:
      return { start: { x: maxX, y: minY }, end: pos };
    case 4:
      return { start: { x: minX, y: pos.y }, end: { x: maxX, y: maxY } };
    case 5:
      return { start: { x: minX, y: minY }, end: { x: pos.x, y: maxY } };
    case 6:
      return { start: { x: minX, y: minY }, end: { x: maxX, y: pos.y } };
    case 7:
      return { start: { x: pos.x, y: minY }, end: { x: maxX, y: maxY } };
    default:
      return { start: { ...original.start }, end: { ...original.end } };
  }
}

function _updateEllipse(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const minX = Math.min(original.start.x, original.end.x);
  const maxX = Math.max(original.start.x, original.end.x);
  const minY = Math.min(original.start.y, original.end.y);
  const maxY = Math.max(original.start.y, original.end.y);
  switch (idx) {
    case 0:
      return { start: { x: minX, y: pos.y }, end: { x: maxX, y: maxY } };
    case 1:
      return { start: { x: minX, y: minY }, end: { x: pos.x, y: maxY } };
    case 2:
      return { start: { x: minX, y: minY }, end: { x: maxX, y: pos.y } };
    case 3:
      return { start: { x: pos.x, y: minY }, end: { x: maxX, y: maxY } };
    default:
      return { start: { ...original.start }, end: { ...original.end } };
  }
}

function _updateCircle(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const cx = (original.start.x + original.end.x) / 2;
  const cy = (original.start.y + original.end.y) / 2;
  let newRadius: number;
  switch (idx) {
    case 0: // top
    case 2: // bottom
      newRadius = Math.abs(pos.y - cy);
      break;
    case 1: // right
    case 3: // left
      newRadius = Math.abs(pos.x - cx);
      break;
    default:
      return { start: { ...original.start }, end: { ...original.end } };
  }
  return {
    start: { x: cx - newRadius, y: cy - newRadius },
    end: { x: cx + newRadius, y: cy + newRadius },
  };
}

function _updateLineArrow(
  original: { start: AnnotationPoint; end: AnnotationPoint; width?: number },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const w = original.width ?? 2;
  if (idx === 0) return { start: pos, end: { ...original.end }, width: w };
  if (idx === 1) return { start: { ...original.start }, end: pos, width: w };
  if (idx === 2) {
    // Width handle: compute perpendicular distance from pos to the line
    const dx = original.end.x - original.start.x;
    const dy = original.end.y - original.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    let newWidth = w;
    if (len > 1e-9) {
      // Signed perpendicular distance, take absolute * 2 for full width
      const perpDist = Math.abs(
        (pos.x - original.start.x) * (-dy / len) +
          (pos.y - original.start.y) * (dx / len),
      );
      newWidth = Math.max(0.5, perpDist * 2);
    }
    return {
      start: { ...original.start },
      end: { ...original.end },
      width: newWidth,
    };
  }
  return { start: { ...original.start }, end: { ...original.end }, width: w };
}
