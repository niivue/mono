import { ANNOTATION_DEFAULTS } from '@/NVConstants'
import type {
  AnnotationPoint,
  AnnotationStyle,
  PolygonWithHoles,
  VectorAnnotation,
} from '@/NVTypes'
import {
  clipperDifference as _clipperDifference,
  clipperIntersects as _clipperIntersects,
  clipperUnion as _clipperUnion,
  clipperInflatePath,
  clipperSubtractBrush,
} from './clipper'
import { livewireBacktrack, livewireFieldScissors } from './livewire'
import {
  extractLivewireSlice,
  gridToSlice2D,
  slice2DToGrid,
} from './livewireSlice'
import { pointInRing } from './pointInRing'
import {
  getControlPoints,
  hitTestControlPoint,
  isTwoLineShape,
  resizePolygons,
  updateShapeBounds,
} from './selection'
import {
  bidirectionalShortAxis,
  dragCorners,
  generateLine,
  generatePolygonFromPoints,
  generateShape,
  generateSplineFromPoints,
  isAnnotationErased,
} from './shapes'
import {
  isOnSlice,
  mmToSlice2D,
  slice2DToMM,
  slice2DToMMOnPlane,
} from './sliceProjection'
import { computeAnnotationStats, isMeasureTool, shapeAngle } from './stats'

export {
  bidirectionalShortAxis,
  clipperInflatePath,
  clipperSubtractBrush,
  computeAnnotationStats,
  dragCorners,
  extractLivewireSlice,
  generateLine,
  generatePolygonFromPoints,
  generateShape,
  generateSplineFromPoints,
  getControlPoints,
  gridToSlice2D,
  hitTestControlPoint,
  isAnnotationErased,
  isMeasureTool,
  isOnSlice,
  isTwoLineShape,
  livewireBacktrack,
  livewireFieldScissors,
  mmToSlice2D,
  resizePolygons,
  shapeAngle,
  slice2DToGrid,
  slice2DToMM,
  slice2DToMMOnPlane,
  updateShapeBounds,
}

export type SelfIntersection = {
  intersection: AnnotationPoint
  segmentStartIndex: number
}

/**
 * Check if the newest segment (last two points) crosses any prior segment.
 * Used for auto-close polygon mode (brushRadius <= 1).
 */
export function findFirstSelfIntersection(
  points: AnnotationPoint[],
): SelfIntersection | null {
  if (points.length < 4) return null
  const segStart = points[points.length - 2] as AnnotationPoint
  const segEnd = points[points.length - 1] as AnnotationPoint
  for (let i = 0; i <= points.length - 4; i++) {
    const a = points[i] as AnnotationPoint
    const b = points[i + 1] as AnnotationPoint
    const ix = _lineIntersection(segStart, segEnd, a, b)
    if (ix) return { intersection: ix, segmentStartIndex: i }
  }
  return null
}

function _lineIntersection(
  p1: AnnotationPoint,
  p2: AnnotationPoint,
  p3: AnnotationPoint,
  p4: AnnotationPoint,
): AnnotationPoint | null {
  const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x)
  if (Math.abs(denom) < 1e-7) return null
  const t =
    ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom
  const u =
    ((p1.x - p3.x) * (p1.y - p2.y) - (p1.y - p3.y) * (p1.x - p2.x)) / denom
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return null
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }
}

/**
 * Extract the closed loop from a self-intersection: from the intersection
 * point through all points up to (but not including) the last segment end.
 */
export function extractClosedLoop(
  points: AnnotationPoint[],
  intersection: SelfIntersection,
): AnnotationPoint[] {
  const loop: AnnotationPoint[] = [{ ...intersection.intersection }]
  for (
    let i = intersection.segmentStartIndex + 1;
    i <= points.length - 2;
    i++
  ) {
    const pt = points[i] as AnnotationPoint
    const last = loop[loop.length - 1] as AnnotationPoint
    if (Math.abs(last.x - pt.x) > 1e-7 || Math.abs(last.y - pt.y) > 1e-7) {
      loop.push({ ...pt })
    }
  }
  return loop
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
  }
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
    const poly = annotation.polygons[i] as PolygonWithHoles
    if (pointInRing(point, poly.outer)) {
      let inHole = false
      for (const hole of poly.holes) {
        if (pointInRing(point, hole)) {
          inHole = true
          break
        }
      }
      if (!inHole) return i
    }
  }
  return -1
}

/**
 * Add new annotation, cutting it from any overlapping annotations with
 * a different label (so labels don't overlap). Same-label annotations
 * that geometrically overlap are merged via boolean union; non-overlapping
 * same-label annotations remain as separate instances. Only annotations of
 * the new one's group take part. One `isEditable` refuses is neither merged
 * nor cut: a new shape of another label is clipped around it instead (a
 * locked segment). A shape of another label `isCut` refuses overlaps the new
 * one untouched, in either direction.
 */
function mergeAnnotations(
  existing: VectorAnnotation[],
  newAnnotation: VectorAnnotation,
  isEditable: (a: VectorAnnotation) => boolean,
  isSameSlice: (a: VectorAnnotation, b: VectorAnnotation) => boolean,
  isCut: (a: VectorAnnotation) => boolean,
): VectorAnnotation[] {
  const result: VectorAnnotation[] = []
  let mergedPolygons: PolygonWithHoles[] = [...newAnnotation.polygons]

  for (const ann of existing) {
    // Another slice or group: pass through
    if (
      ann.group !== newAnnotation.group ||
      !isSameSlice(ann, newAnnotation) ||
      (ann.label !== newAnnotation.label && !isCut(ann))
    ) {
      result.push(ann)
      continue
    }
    if (!isEditable(ann)) {
      result.push(ann)
      if (ann.label !== newAnnotation.label)
        for (const locked of ann.polygons)
          mergedPolygons = mergedPolygons.flatMap((p) =>
            _clipperDifference(p, locked),
          )
      continue
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
      )
      if (overlaps) {
        mergedPolygons.push(...ann.polygons)
        mergedPolygons = _clipperUnion(mergedPolygons)
      } else {
        result.push(ann)
      }
    } else {
      // Different label: cut new shape from existing. An untouched annotation
      // keeps its identity, so change events do not report it as updated.
      const touches = ann.polygons.some((existPoly) =>
        newAnnotation.polygons.some((newPoly) =>
          _clipperIntersects(existPoly, newPoly),
        ),
      )
      if (!touches) {
        result.push(ann)
        continue
      }
      let cutPolygons: PolygonWithHoles[] = ann.polygons
      for (const newPoly of newAnnotation.polygons) {
        const nextCut: PolygonWithHoles[] = []
        for (const existPoly of cutPolygons) {
          nextCut.push(..._clipperDifference(existPoly, newPoly))
        }
        cutPolygons = nextCut
      }
      if (cutPolygons.length > 0) {
        result.push({ ...ann, polygons: cutPolygons })
      }
    }
  }

  if (mergedPolygons.length > 0) {
    result.push({ ...newAnnotation, polygons: mergedPolygons })
  }

  return result
}

/**
 * Store a completed vector annotation using the configured overlap policy.
 * Measurement hosts list only their segment groups in `mergedGroups` (or none)
 * so every measurement keeps its own id, geometry and statistics.
 */
export function storeAnnotation(
  existing: VectorAnnotation[],
  newAnnotation: VectorAnnotation,
  policy: {
    /** Groups whose shapes merge (null: every group; []: none). */
    mergedGroups?: readonly string[] | null
    /** False for a shape no merge or cut may change (a locked segment). */
    isEditable?: (a: VectorAnnotation) => boolean
    /** Whether two shapes lie on one slice (default: equal slicePosition). */
    isSameSlice?: (a: VectorAnnotation, b: VectorAnnotation) => boolean
    /** False for a shape of another label the new one overlaps uncut. */
    isCut?: (a: VectorAnnotation) => boolean
  } = {},
): VectorAnnotation[] {
  const {
    mergedGroups = null,
    isEditable = () => true,
    isSameSlice = (a, b) =>
      a.sliceType === b.sliceType &&
      Math.abs(a.slicePosition - b.slicePosition) <= 0.01,
    isCut = () => true,
  } = policy
  const isMark = (a: VectorAnnotation) =>
    UNMERGED_SHAPES.has(a.shape?.type ?? '')
  if (
    isMark(newAnnotation) ||
    (mergedGroups && !mergedGroups.includes(newAnnotation.group))
  )
    return [...existing, newAnnotation]
  const marks = existing.filter(isMark)
  return marks.length === 0
    ? mergeAnnotations(existing, newAnnotation, isEditable, isSameSlice, isCut)
    : [
        ...mergeAnnotations(
          existing.filter((a) => !isMark(a)),
          newAnnotation,
          isEditable,
          isSameSlice,
          isCut,
        ),
        ...marks,
      ]
}

// Probes and line-style measurements mark points and lengths, not regions:
// never unioned with or cut by an ROI, in either direction.
const UNMERGED_SHAPES = new Set<string>([
  'measurePoint',
  'measureLine',
  'measureAngle',
  'measureCobbAngle',
  'bidirectional',
  'measureBidirectional',
])
