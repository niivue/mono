import { vec3 } from "gl-matrix";
import * as NVMeshUtils from "@/mesh/NVMesh";
import * as NVShapes from "@/mesh/NVShapes";
import * as NVConstants from "@/NVConstants";

export const CYLINDER_SIDES = 20;
export const CYLINDER_ENDCAPS = true;
export const VERTS_PER_CYLINDER =
  (CYLINDER_SIDES + 1) * 2 + 2 + (CYLINDER_SIDES + 1) * 2;
export const BYTES_PER_VERTEX = 28; // position(12) + normal(12) + color(4)

// Pre-computed index buffer (same topology for all cylinders)
let cachedIndices: Uint32Array | null = null;

export function getCylinderIndices(): Uint32Array {
  if (cachedIndices) return cachedIndices;
  const dummy = NVShapes.createCylinder(
    [0, 0, 0],
    [1, 0, 0],
    1,
    [1, 1, 1, 1],
    CYLINDER_SIDES,
    CYLINDER_ENDCAPS,
  );
  cachedIndices = new Uint32Array(dummy.indices);
  return cachedIndices;
}

export function packColor(rgba: number[]): number {
  const [r, g, b, a] = rgba.map((v) => Math.round(v * 255));
  return (a << 24) | (b << 16) | (g << 8) | r;
}

export function buildVertexData(
  start: vec3,
  end: vec3,
  radius: number,
  colorPacked: number,
): ArrayBuffer {
  const cylData = NVShapes.createCylinder(
    Array.from(start) as number[],
    Array.from(end) as number[],
    radius,
    [1, 1, 1, 1],
    CYLINDER_SIDES,
    CYLINDER_ENDCAPS,
  );
  const positions = new Float32Array(cylData.positions);
  const normals = NVMeshUtils.generateNormals(
    positions,
    new Uint32Array(cylData.indices),
  );
  const numVerts = positions.length / 3;

  const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX);
  const f32 = new Float32Array(vertexData);
  const u32 = new Uint32Array(vertexData);

  for (let i = 0; i < numVerts; i++) {
    const offset = (i * BYTES_PER_VERTEX) / 4;
    f32[offset] = positions[i * 3];
    f32[offset + 1] = positions[i * 3 + 1];
    f32[offset + 2] = positions[i * 3 + 2];
    f32[offset + 3] = normals[i * 3];
    f32[offset + 4] = normals[i * 3 + 1];
    f32[offset + 5] = normals[i * 3 + 2];
    u32[offset + 6] = colorPacked;
  }

  return vertexData;
}

export function calculateCrosshairSegments(
  extentsMin: ArrayLike<number>,
  extentsMax: ArrayLike<number>,
  crosshairPos: ArrayLike<number>,
  gap: number,
): [vec3, vec3][] {
  const center = vec3.create();
  for (let i = 0; i < 3; i++) {
    center[i] =
      extentsMin[i] + crosshairPos[i] * (extentsMax[i] - extentsMin[i]);
  }
  const halfGap = gap / 2;
  return [
    // X axis
    [
      vec3.fromValues(extentsMin[0], center[1], center[2]),
      vec3.fromValues(center[0] - halfGap, center[1], center[2]),
    ],
    [
      vec3.fromValues(center[0] + halfGap, center[1], center[2]),
      vec3.fromValues(extentsMax[0], center[1], center[2]),
    ],
    // Y axis
    [
      vec3.fromValues(center[0], extentsMin[1], center[2]),
      vec3.fromValues(center[0], center[1] - halfGap, center[2]),
    ],
    [
      vec3.fromValues(center[0], center[1] + halfGap, center[2]),
      vec3.fromValues(center[0], extentsMax[1], center[2]),
    ],
    // Z axis
    [
      vec3.fromValues(center[0], center[1], extentsMin[2]),
      vec3.fromValues(center[0], center[1], center[2] - halfGap),
    ],
    [
      vec3.fromValues(center[0], center[1], center[2] + halfGap),
      vec3.fromValues(center[0], center[1], extentsMax[2]),
    ],
  ];
}

export function shouldCullCylinder(cylIdx: number, sliceType: number): boolean {
  const axisIndex = Math.floor(cylIdx / 2);
  if (sliceType === NVConstants.SLICE_TYPE.AXIAL && axisIndex === 2)
    return true;
  if (sliceType === NVConstants.SLICE_TYPE.CORONAL && axisIndex === 1)
    return true;
  if (sliceType === NVConstants.SLICE_TYPE.SAGITTAL && axisIndex === 0)
    return true;
  return false;
}
