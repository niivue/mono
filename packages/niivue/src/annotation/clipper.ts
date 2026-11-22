import {
  areaPathsD,
  booleanOpD,
  booleanOpWithPolyTree,
  ClipType,
  EndType,
  FillRule,
  inflatePaths,
  isPositive,
  JoinType,
  type Path64,
  type Paths64,
  type PolyPath64,
  PolyTree64,
  trimCollinear,
} from 'clipper2-ts'
import type { AnnotationPoint, PolygonWithHoles } from '@/NVTypes'

const SCALE = 100

function scaled(points: AnnotationPoint[]): Path64 {
  return points.map((p) => ({
    x: Math.round(p.x * SCALE),
    y: Math.round(p.y * SCALE),
  }))
}

// A ring doubling back on itself (a live-wire trace retracing its pixels)
// leaves collinear spikes on which clipper2-ts's sweep never ends.
function toPath64(points: AnnotationPoint[]): Path64 {
  return trimCollinear(scaled(points))
}

function fromPath64(path: Path64): AnnotationPoint[] {
  return path.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE }))
}

function reversePath(path: Path64): Path64 {
  return [...path].reverse()
}

function toSubjectPaths(
  polygons: Array<{ outer: AnnotationPoint[]; holes?: AnnotationPoint[][] }>,
  reverseHoles = false,
): Paths64 {
  const paths: Paths64 = []
  for (const poly of polygons) {
    const outerPath = toPath64(poly.outer)
    if (outerPath.length < 3) continue
    paths.push(isPositive(outerPath) ? outerPath : reversePath(outerPath))
    if (poly.holes) {
      for (const hole of poly.holes) {
        const holePath = toPath64(hole)
        if (holePath.length < 3) continue
        if (reverseHoles) {
          paths.push(isPositive(holePath) ? reversePath(holePath) : holePath)
        } else {
          paths.push(holePath)
        }
      }
    }
  }
  return paths
}

function extractPolyTree(tree: PolyTree64): PolygonWithHoles[] {
  const results: PolygonWithHoles[] = []
  for (let i = 0; i < tree.count; i++) {
    const outerNode = tree.child(i) as PolyPath64
    if (!outerNode.polygon || outerNode.polygon.length < 3) continue
    const holes: AnnotationPoint[][] = []
    for (let j = 0; j < outerNode.count; j++) {
      const holeNode = outerNode.child(j) as PolyPath64
      if (!holeNode.polygon || holeNode.polygon.length < 3) continue
      holes.push(fromPath64(holeNode.polygon))
      if (holeNode.count > 0) {
        const nested = extractPolyTree(holeNode as unknown as PolyTree64)
        results.push(...nested)
      }
    }
    results.push({ outer: fromPath64(outerNode.polygon), holes })
  }
  return results
}

export function clipperUnion(
  polygons: Array<{ outer: AnnotationPoint[]; holes?: AnnotationPoint[][] }>,
): PolygonWithHoles[] {
  if (polygons.length === 0) return []
  if (
    polygons.length === 1 &&
    (!polygons[0]?.holes || polygons[0]?.holes.length === 0)
  ) {
    return [{ outer: [...(polygons[0]?.outer ?? [])], holes: [] }]
  }
  const subject = toSubjectPaths(polygons, true)
  const tree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, subject, null, tree, FillRule.NonZero)
  return extractPolyTree(tree)
}

export function clipperIntersects(
  a: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  b: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
): boolean {
  const subjectPaths = toSubjectPaths([a])
  const clipPaths = toSubjectPaths([b])
  const tree = new PolyTree64()
  booleanOpWithPolyTree(
    ClipType.Intersection,
    subjectPaths,
    clipPaths,
    tree,
    FillRule.EvenOdd,
  )
  return tree.count > 0
}

export function clipperDifference(
  subject: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  clip: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
): PolygonWithHoles[] {
  const subjectPaths = toSubjectPaths([subject])
  const clipPaths = toSubjectPaths([clip])
  const tree = new PolyTree64()
  booleanOpWithPolyTree(
    ClipType.Difference,
    subjectPaths,
    clipPaths,
    tree,
    FillRule.EvenOdd,
  )
  return extractPolyTree(tree)
}

export function clipperInflatePath(
  brushPath: AnnotationPoint[],
  radius: number,
): PolygonWithHoles[] {
  if (brushPath.length === 0 || radius <= 0) return []
  const scaledRadius = Math.round(radius * SCALE)
  const scaledBrush = scaled(brushPath)
  const inflated = inflatePaths(
    [scaledBrush],
    scaledRadius,
    JoinType.Round,
    EndType.Round,
  )
  if (inflated.length === 0) return []
  const tree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, inflated, null, tree, FillRule.NonZero)
  return extractPolyTree(tree)
}

export function clipperSubtractBrush(
  subject: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  brushPath: AnnotationPoint[],
  radius: number,
): PolygonWithHoles[] {
  if (brushPath.length === 0 || radius <= 0) {
    return [{ outer: [...subject.outer], holes: [...(subject.holes ?? [])] }]
  }
  const scaledRadius = Math.round(radius * SCALE)
  const scaledBrush = scaled(brushPath)
  const inflated = inflatePaths(
    [scaledBrush],
    scaledRadius,
    JoinType.Round,
    EndType.Round,
  )
  if (inflated.length === 0) {
    return [{ outer: [...subject.outer], holes: [...(subject.holes ?? [])] }]
  }
  const subjectPaths = toSubjectPaths([subject])
  // A brush that misses the subject leaves it as given: a Difference would
  // still snap every vertex to the clipper grid, and isAnnotationErased would
  // then read an untouched shape as erased.
  const hit = new PolyTree64()
  booleanOpWithPolyTree(
    ClipType.Intersection,
    subjectPaths,
    inflated,
    hit,
    FillRule.EvenOdd,
  )
  if (hit.count === 0) {
    return [{ outer: [...subject.outer], holes: [...(subject.holes ?? [])] }]
  }
  const tree = new PolyTree64()
  booleanOpWithPolyTree(
    ClipType.Difference,
    subjectPaths,
    inflated,
    tree,
    FillRule.EvenOdd,
  )
  return extractPolyTree(tree)
}

/**
 * Area of an ROI as the voxel mask reads it: the union of its pieces, each
 * inside its outer ring by even-odd (pointInRing's rule, so a self-crossing
 * ring's lobes add instead of cancelling as in a signed shoelace sum) and
 * inside none of its holes.
 */
export function clipperRegionArea(polygons: PolygonWithHoles[]): number {
  // precision 4: 0.1 um in mm, while scaled products stay exact in doubles.
  const region = (ring: AnnotationPoint[]) =>
    booleanOpD(ClipType.Union, [ring], null, FillRule.EvenOdd, 4)
  // Clipper's output rings wind consistently, so NonZero unions overlapping
  // holes, and overlapping pieces.
  const pieces = polygons.flatMap((poly) =>
    booleanOpD(
      ClipType.Difference,
      region(poly.outer),
      poly.holes.flatMap(region),
      FillRule.NonZero,
      4,
    ),
  )
  return Math.abs(
    areaPathsD(booleanOpD(ClipType.Union, pieces, null, FillRule.NonZero, 4)),
  )
}

/**
 * A polygon set operation on two sets of polygons with holes (slice-2D mm):
 * union, difference (a minus b), intersection or xor. Overlaps within a set
 * union first (non-zero), so each set is a region.
 */
export function polygonBoolean(
  op: 'union' | 'difference' | 'intersection' | 'xor',
  a: readonly PolygonWithHoles[],
  b: readonly PolygonWithHoles[],
): PolygonWithHoles[] {
  const type = {
    union: ClipType.Union,
    difference: ClipType.Difference,
    intersection: ClipType.Intersection,
    xor: ClipType.Xor,
  }[op]
  const tree = new PolyTree64()
  booleanOpWithPolyTree(
    type,
    toSubjectPaths([...a], true),
    toSubjectPaths([...b], true),
    tree,
    FillRule.NonZero,
  )
  return extractPolyTree(tree)
}
