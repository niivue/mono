import type { vec3 } from "gl-matrix";
import { SLICE_TYPE, sliceTypeDim } from "@/NVConstants";
import type { AnnotationPoint } from "@/NVTypes";

/**
 * Project a 3D mm-space point to 2D slice-plane coordinates.
 * AXIAL: x=mm[0], y=mm[1], depth=mm[2]
 * CORONAL: x=mm[0], y=mm[2], depth=mm[1]
 * SAGITTAL: x=mm[1], y=mm[2], depth=mm[0]
 */
export function mmToSlice2D(
  mm: [number, number, number],
  sliceType: number,
): AnnotationPoint {
  if (sliceType === SLICE_TYPE.CORONAL) return { x: mm[0], y: mm[2] };
  if (sliceType === SLICE_TYPE.SAGITTAL) return { x: mm[1], y: mm[2] };
  return { x: mm[0], y: mm[1] }; // AXIAL
}

/**
 * Project a 2D slice-plane point back to 3D mm-space.
 */
export function slice2DToMM(
  point: AnnotationPoint,
  slicePosition: number,
  sliceType: number,
): [number, number, number] {
  if (sliceType === SLICE_TYPE.CORONAL)
    return [point.x, slicePosition, point.y];
  if (sliceType === SLICE_TYPE.SAGITTAL)
    return [slicePosition, point.x, point.y];
  return [point.x, point.y, slicePosition]; // AXIAL
}

const _inPlane: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
]; // AXIAL, CORONAL, SAGITTAL
const _mmScratch: [number, number, number] = [0, 0, 0];

/**
 * Project a 2D slice-plane point back to 3D mm-space using the actual plane
 * equation. Unlike `slice2DToMM` which assumes constant depth, this computes
 * the correct depth for each point on a (possibly tilted) slice plane.
 * For axis-aligned volumes this produces the same result as `slice2DToMM`.
 */
export function slice2DToMMOnPlane(
  point: AnnotationPoint,
  sliceType: number,
  planeNormal: vec3 | Float32Array,
  planePoint: vec3 | Float32Array,
): [number, number, number] {
  const depthIdx = sliceTypeDim(sliceType);
  const [inPlane0, inPlane1] = _inPlane[sliceType]!;
  _mmScratch[0] = 0;
  _mmScratch[1] = 0;
  _mmScratch[2] = 0;
  _mmScratch[inPlane0] = point.x;
  _mmScratch[inPlane1] = point.y;

  // Solve: dot(mm - planePoint, planeNormal) = 0 for mm[depthIdx]
  const normalDepth = planeNormal[depthIdx];
  if (Math.abs(normalDepth) > 1e-10) {
    const inPlaneDot =
      planeNormal[inPlane0] * (point.x - planePoint[inPlane0]) +
      planeNormal[inPlane1] * (point.y - planePoint[inPlane1]);
    _mmScratch[depthIdx] = planePoint[depthIdx] - inPlaneDot / normalDepth;
  } else {
    _mmScratch[depthIdx] = planePoint[depthIdx];
  }
  return [_mmScratch[0], _mmScratch[1], _mmScratch[2]];
}

/**
 * Test whether a 3D mm-space point lies on the given plane within tolerance.
 * Used to check if an annotation belongs to the currently visible slice.
 */
export function isOnSlice(
  mmPoint: ArrayLike<number>,
  planeNormal: ArrayLike<number>,
  planePoint: ArrayLike<number>,
  tolerance: number,
): boolean {
  return (
    Math.abs(
      (mmPoint[0] - planePoint[0]) * planeNormal[0] +
        (mmPoint[1] - planePoint[1]) * planeNormal[1] +
        (mmPoint[2] - planePoint[2]) * planeNormal[2],
    ) <= tolerance
  );
}
