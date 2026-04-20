import { mat4, vec4 } from "gl-matrix";
import { sliceTypeDim } from "@/NVConstants";
import type {
  AnnotationStats,
  AnnotationTool,
  NVImage,
  VectorAnnotation,
} from "@/NVTypes";
import { getVoxelValue } from "@/volume/utils";
import { pointInRing } from "./pointInRing";
import { slice2DToMM } from "./sliceProjection";

export function isMeasureTool(tool: AnnotationTool): boolean {
  return (
    tool === "measureEllipse" ||
    tool === "measureRect" ||
    tool === "measureLine" ||
    tool === "measureCircle"
  );
}

export function isCircleTool(tool: AnnotationTool): boolean {
  return tool === "circle" || tool === "measureCircle";
}

const IN_PLANE_AXES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

export function computeAnnotationStats(
  annotation: VectorAnnotation,
  volume: NVImage,
): AnnotationStats | null {
  const shape = annotation.shape;
  if (!shape) return null;
  if (!volume.dimsRAS || !volume.pixDimsRAS) return null;

  if (shape.type === "measureLine") {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    return {
      area: 0,
      min: 0,
      mean: 0,
      max: 0,
      stdDev: 0,
      length: Math.sqrt(dx * dx + dy * dy),
    };
  }

  const outerRing = annotation.polygons[0]?.outer;
  if (!outerRing || outerRing.length < 3) return null;

  const sliceType = annotation.sliceType;
  const depthDim = sliceTypeDim(sliceType);
  const dims = volume.dimsRAS;
  const pixDims = volume.pixDimsRAS;
  const [ax0, ax1] = IN_PLANE_AXES[sliceType]!;
  const pixDim0 = pixDims[ax0 + 1];
  const pixDim1 = pixDims[ax1 + 1];

  if (!volume.matRAS) return null;

  // Pre-compute inverted matrix for mm→vox (mm2vox clones+inverts each call)
  const mm2voxMat = mat4.create();
  mat4.transpose(mm2voxMat, volume.matRAS);
  mat4.invert(mm2voxMat, mm2voxMat);
  const tmpVec = vec4.create();

  function mmToVoxCached(mm: ArrayLike<number>): [number, number, number] {
    vec4.set(tmpVec, mm[0], mm[1], mm[2], 1);
    vec4.transformMat4(tmpVec, tmpVec, mm2voxMat);
    return [
      Math.round(tmpVec[0]),
      Math.round(tmpVec[1]),
      Math.round(tmpVec[2]),
    ];
  }

  // Convert polygon from mm-space to voxel-space once (avoids per-voxel transforms)
  const outerRingVox = outerRing.map((pt) => {
    const mm = slice2DToMM(pt, annotation.slicePosition, sliceType);
    const vox = mmToVoxCached(mm);
    return { x: vox[ax0], y: vox[ax1] };
  });

  // Compute bounding box in voxel space
  let minV0 = Infinity,
    minV1 = Infinity,
    maxV0 = -Infinity,
    maxV1 = -Infinity;
  for (const pt of outerRingVox) {
    if (pt.x < minV0) minV0 = pt.x;
    if (pt.y < minV1) minV1 = pt.y;
    if (pt.x > maxV0) maxV0 = pt.x;
    if (pt.y > maxV1) maxV1 = pt.y;
  }

  // Get depth voxel from annotation's slice position
  const mmCenter = slice2DToMM(
    { x: outerRing[0]?.x, y: outerRing[0]?.y },
    annotation.slicePosition,
    sliceType,
  );
  const voxCenter = mmToVoxCached(mmCenter);
  const depthVox = voxCenter[depthDim];

  const r0min = Math.max(0, Math.floor(Math.min(minV0, maxV0)));
  const r0max = Math.min(dims[ax0 + 1] - 1, Math.ceil(Math.max(minV0, maxV0)));
  const r1min = Math.max(0, Math.floor(Math.min(minV1, maxV1)));
  const r1max = Math.min(dims[ax1 + 1] - 1, Math.ceil(Math.max(minV1, maxV1)));

  if (depthVox < 0 || depthVox >= dims[depthDim + 1]) return null;

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i0 = r0min; i0 <= r0max; i0++) {
    for (let i1 = r1min; i1 <= r1max; i1++) {
      // Point-in-polygon test in voxel space (no per-voxel transforms)
      if (!pointInRing({ x: i0, y: i1 }, outerRingVox)) continue;

      const ras: [number, number, number] = [0, 0, 0];
      ras[ax0] = i0;
      ras[ax1] = i1;
      ras[depthDim] = depthVox;

      const val = getVoxelValue(volume, ras[0], ras[1], ras[2]);
      count++;
      sum += val;
      sumSq += val * val;
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }

  if (count === 0) return null;

  const area = count * pixDim0 * pixDim1;
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const stdDev = Math.sqrt(Math.max(0, variance));

  return { area, min, mean, max, stdDev };
}
