import {
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
} from "clipper2-ts";
import type { AnnotationPoint, PolygonWithHoles } from "@/NVTypes";

const SCALE = 100;

function toPath64(points: AnnotationPoint[]): Path64 {
  return points.map((p) => ({
    x: Math.round(p.x * SCALE),
    y: Math.round(p.y * SCALE),
  }));
}

function fromPath64(path: Path64): AnnotationPoint[] {
  return path.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE }));
}

function reversePath(path: Path64): Path64 {
  return [...path].reverse();
}

function toSubjectPaths(
  polygons: Array<{ outer: AnnotationPoint[]; holes?: AnnotationPoint[][] }>,
  reverseHoles = false,
): Paths64 {
  const paths: Paths64 = [];
  for (const poly of polygons) {
    const outerPath = toPath64(poly.outer);
    paths.push(isPositive(outerPath) ? outerPath : reversePath(outerPath));
    if (poly.holes) {
      for (const hole of poly.holes) {
        const holePath = toPath64(hole);
        if (reverseHoles) {
          paths.push(isPositive(holePath) ? reversePath(holePath) : holePath);
        } else {
          paths.push(holePath);
        }
      }
    }
  }
  return paths;
}

function extractPolyTree(tree: PolyTree64): PolygonWithHoles[] {
  const results: PolygonWithHoles[] = [];
  for (let i = 0; i < tree.count; i++) {
    const outerNode = tree.child(i) as PolyPath64;
    if (!outerNode.polygon || outerNode.polygon.length < 3) continue;
    const holes: AnnotationPoint[][] = [];
    for (let j = 0; j < outerNode.count; j++) {
      const holeNode = outerNode.child(j) as PolyPath64;
      if (!holeNode.polygon || holeNode.polygon.length < 3) continue;
      holes.push(fromPath64(holeNode.polygon));
      if (holeNode.count > 0) {
        const nested = extractPolyTree(holeNode as unknown as PolyTree64);
        results.push(...nested);
      }
    }
    results.push({ outer: fromPath64(outerNode.polygon), holes });
  }
  return results;
}

export function clipperUnion(
  polygons: Array<{ outer: AnnotationPoint[]; holes?: AnnotationPoint[][] }>,
): PolygonWithHoles[] {
  if (polygons.length === 0) return [];
  if (
    polygons.length === 1 &&
    (!polygons[0]?.holes || polygons[0]?.holes.length === 0)
  ) {
    return [{ outer: [...(polygons[0]?.outer ?? [])], holes: [] }];
  }
  const subject = toSubjectPaths(polygons, true);
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, subject, null, tree, FillRule.NonZero);
  return extractPolyTree(tree);
}

export function clipperIntersects(
  a: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  b: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
): boolean {
  const subjectPaths = toSubjectPaths([a]);
  const clipPaths = toSubjectPaths([b]);
  const tree = new PolyTree64();
  booleanOpWithPolyTree(
    ClipType.Intersection,
    subjectPaths,
    clipPaths,
    tree,
    FillRule.EvenOdd,
  );
  return tree.count > 0;
}

export function clipperDifference(
  subject: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  clip: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
): PolygonWithHoles[] {
  const subjectPaths = toSubjectPaths([subject]);
  const clipPaths = toSubjectPaths([clip]);
  const tree = new PolyTree64();
  booleanOpWithPolyTree(
    ClipType.Difference,
    subjectPaths,
    clipPaths,
    tree,
    FillRule.EvenOdd,
  );
  return extractPolyTree(tree);
}

export function clipperInflatePath(
  brushPath: AnnotationPoint[],
  radius: number,
): PolygonWithHoles[] {
  if (brushPath.length === 0 || radius <= 0) return [];
  const scaledRadius = Math.round(radius * SCALE);
  const scaledBrush = toPath64(brushPath);
  const inflated = inflatePaths(
    [scaledBrush],
    scaledRadius,
    JoinType.Round,
    EndType.Round,
  );
  if (inflated.length === 0) return [];
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, inflated, null, tree, FillRule.NonZero);
  return extractPolyTree(tree);
}

export function clipperSubtractBrush(
  subject: { outer: AnnotationPoint[]; holes?: AnnotationPoint[][] },
  brushPath: AnnotationPoint[],
  radius: number,
): PolygonWithHoles[] {
  if (brushPath.length === 0 || radius <= 0) {
    return [{ outer: [...subject.outer], holes: [...(subject.holes ?? [])] }];
  }
  const scaledRadius = Math.round(radius * SCALE);
  const scaledBrush = toPath64(brushPath);
  const inflated = inflatePaths(
    [scaledBrush],
    scaledRadius,
    JoinType.Round,
    EndType.Round,
  );
  if (inflated.length === 0) {
    return [{ outer: [...subject.outer], holes: [...(subject.holes ?? [])] }];
  }
  const subjectPaths = toSubjectPaths([subject]);
  const tree = new PolyTree64();
  booleanOpWithPolyTree(
    ClipType.Difference,
    subjectPaths,
    inflated,
    tree,
    FillRule.EvenOdd,
  );
  return extractPolyTree(tree);
}
