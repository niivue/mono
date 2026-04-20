import { ANNOTATION_DEFAULTS } from "@/NVConstants";
import type {
  AnnotationPoint,
  AnnotationStyle,
  PolygonWithHoles,
  VectorAnnotation,
} from "@/NVTypes";
import {
  clipperDifference as _clipperDifference,
  clipperIntersects as _clipperIntersects,
  clipperUnion as _clipperUnion,
} from "./clipper";
import { pointInRing } from "./pointInRing";

export {
  clipperDifference,
  clipperInflatePath,
  clipperIntersects,
  clipperSubtractBrush,
  clipperUnion,
} from "./clipper";
export { pointInRing } from "./pointInRing";
export type { AnnotationSelection } from "./selection";
export {
  getControlPoints,
  hitTestControlPoint,
  updateShapeBounds,
} from "./selection";
export { constrainCircleEnd, generateShape } from "./shapes";
export {
  isOnSlice,
  mmToSlice2D,
  slice2DToMM,
  slice2DToMMOnPlane,
} from "./sliceProjection";
export { computeAnnotationStats, isCircleTool, isMeasureTool } from "./stats";
export { triangulatePolygon } from "./triangulate";
export { AnnotationUndoStack } from "./undoRedo";

export type SelfIntersection = {
  intersection: AnnotationPoint;
  segmentStartIndex: number;
};

/**
 * Check if the newest segment (last two points) crosses any prior segment.
 * Used for auto-close polygon mode (brushRadius <= 1).
 */
export function findFirstSelfIntersection(
  points: AnnotationPoint[],
): SelfIntersection | null {
  if (points.length < 4) return null;
  const segStart = points[points.length - 2]!;
  const segEnd = points[points.length - 1]!;
  for (let i = 0; i <= points.length - 4; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ix = _lineIntersection(segStart, segEnd, a, b);
    if (ix) return { intersection: ix, segmentStartIndex: i };
  }
  return null;
}

function _lineIntersection(
  p1: AnnotationPoint,
  p2: AnnotationPoint,
  p3: AnnotationPoint,
  p4: AnnotationPoint,
): AnnotationPoint | null {
  const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(denom) < 1e-7) return null;
  const t =
    ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
  const u =
    ((p1.x - p3.x) * (p1.y - p2.y) - (p1.y - p3.y) * (p1.x - p2.x)) / denom;
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * Extract the closed loop from a self-intersection: from the intersection
 * point through all points up to (but not including) the last segment end.
 */
export function extractClosedLoop(
  points: AnnotationPoint[],
  intersection: SelfIntersection,
): AnnotationPoint[] {
  const loop: AnnotationPoint[] = [{ ...intersection.intersection }];
  for (
    let i = intersection.segmentStartIndex + 1;
    i <= points.length - 2;
    i++
  ) {
    const pt = points[i]!;
    const last = loop[loop.length - 1]!;
    if (Math.abs(last.x - pt.x) > 1e-7 || Math.abs(last.y - pt.y) > 1e-7) {
      loop.push({ ...pt });
    }
  }
  return loop;
}

export function createAnnotation(
  label: number,
  group: string,
  sliceType: number,
  slicePosition: number,
  polygons: PolygonWithHoles[],
  style?: Partial<AnnotationStyle>,
  anchorMM?: [number, number, number],
): VectorAnnotation {
  return {
    id: crypto.randomUUID(),
    label,
    group,
    sliceType,
    slicePosition,
    anchorMM,
    polygons,
    style: {
      fillColor: style?.fillColor ?? [...ANNOTATION_DEFAULTS.style.fillColor],
      strokeColor: style?.strokeColor ?? [
        ...ANNOTATION_DEFAULTS.style.strokeColor,
      ],
      strokeWidth: style?.strokeWidth ?? ANNOTATION_DEFAULTS.style.strokeWidth,
    },
  };
}

/**
 * Returns the index of the first polygon in the annotation that contains the point,
 * or -1 if none match.
 */
export function hitTestAnnotationPolygon(
  point: AnnotationPoint,
  annotation: VectorAnnotation,
): number {
  for (let i = 0; i < annotation.polygons.length; i++) {
    const poly = annotation.polygons[i]!;
    if (pointInRing(point, poly.outer)) {
      let inHole = false;
      for (const hole of poly.holes) {
        if (pointInRing(point, hole)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return i;
    }
  }
  return -1;
}

/**
 * Add new annotation, cutting it from any overlapping annotations with
 * a different label (so labels don't overlap). Same-label annotations
 * that geometrically overlap are merged via boolean union; non-overlapping
 * same-label annotations remain as separate instances.
 */
export function mergeAnnotations(
  existing: VectorAnnotation[],
  newAnnotation: VectorAnnotation,
): VectorAnnotation[] {
  const result: VectorAnnotation[] = [];
  let mergedPolygons: PolygonWithHoles[] = [...newAnnotation.polygons];

  for (const ann of existing) {
    // Non-overlapping slice: pass through
    if (
      ann.sliceType !== newAnnotation.sliceType ||
      Math.abs(ann.slicePosition - newAnnotation.slicePosition) > 0.01
    ) {
      result.push(ann);
      continue;
    }

    if (
      ann.label === newAnnotation.label &&
      ann.group === newAnnotation.group
    ) {
      // Same label+group on same slice: merge only if geometrically overlapping
      const overlaps = ann.polygons.some((existPoly) =>
        mergedPolygons.some((newPoly) =>
          _clipperIntersects(existPoly, newPoly),
        ),
      );
      if (overlaps) {
        mergedPolygons.push(...ann.polygons);
        mergedPolygons = _clipperUnion(mergedPolygons);
      } else {
        result.push(ann);
      }
    } else {
      // Different label: cut new shape from existing
      let cutPolygons: PolygonWithHoles[] = ann.polygons;
      for (const newPoly of newAnnotation.polygons) {
        const nextCut: PolygonWithHoles[] = [];
        for (const existPoly of cutPolygons) {
          nextCut.push(..._clipperDifference(existPoly, newPoly));
        }
        cutPolygons = nextCut;
      }
      if (cutPolygons.length > 0) {
        result.push({ ...ann, polygons: cutPolygons });
      }
    }
  }

  if (mergedPolygons.length > 0) {
    result.push({ ...newAnnotation, polygons: mergedPolygons });
  }

  return result;
}
