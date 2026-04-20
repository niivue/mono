import { vec3 } from "gl-matrix";
import { packColor } from "@/view/NVCrosshair";

export function getCubeMesh(): { vertices: number[]; indices: number[] } {
  const cubeVertices = [
    1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1,
    0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0,
  ];
  // Each vertex is 3 floats (xyz), so create indices for actual vertices
  const numVertices = cubeVertices.length / 3;
  const cubeIndices = Array.from({ length: numVertices }, (_, i) => i);
  return { vertices: cubeVertices, indices: cubeIndices };
}

function subdivide(vertices: number[], indices: number[]): number[] {
  const numTriangles = indices.length / 3;
  const newIndices = new Array(numTriangles * 12);
  const midpointCache = new Map<number, number>();
  const getMidpoint = (i1: number, i2: number): number => {
    const key = i1 < i2 ? (i1 << 16) | i2 : (i2 << 16) | i1;
    if (midpointCache.has(key)) {
      return midpointCache.get(key)!;
    }
    const idx = vertices.length / 3;
    const x = (vertices[i1 * 3] + vertices[i2 * 3]) / 2;
    const y = (vertices[i1 * 3 + 1] + vertices[i2 * 3 + 1]) / 2;
    const z = (vertices[i1 * 3 + 2] + vertices[i2 * 3 + 2]) / 2;
    const len = Math.sqrt(x * x + y * y + z * z);
    vertices.push(x / len, y / len, z / len);
    midpointCache.set(key, idx);
    return idx;
  };
  let writeIdx = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const v0 = indices[i];
    const v1 = indices[i + 1];
    const v2 = indices[i + 2];
    const m01 = getMidpoint(v0, v1);
    const m12 = getMidpoint(v1, v2);
    const m20 = getMidpoint(v2, v0);
    newIndices[writeIdx++] = v0;
    newIndices[writeIdx++] = m01;
    newIndices[writeIdx++] = m20;
    newIndices[writeIdx++] = m01;
    newIndices[writeIdx++] = v1;
    newIndices[writeIdx++] = m12;
    newIndices[writeIdx++] = m20;
    newIndices[writeIdx++] = m12;
    newIndices[writeIdx++] = v2;
    newIndices[writeIdx++] = m01;
    newIndices[writeIdx++] = m12;
    newIndices[writeIdx++] = m20;
  }
  return newIndices;
}

export function createSphere(
  origin: number[] = [0, 0, 0],
  radius = 1,
  color: number[] = [1, 1, 1, 1],
  subdivisions = 2,
): { positions: number[]; indices: number[]; rgba32: number } {
  const vertices = [
    0.0, 0.0, 1.0, 0.894, 0.0, 0.447, 0.276, 0.851, 0.447, -0.724, 0.526, 0.447,
    -0.724, -0.526, 0.447, 0.276, -0.851, 0.447, 0.724, 0.526, -0.447, -0.276,
    0.851, -0.447, -0.894, 0.0, -0.447, -0.276, -0.851, -0.447, 0.724, -0.526,
    -0.447, 0.0, 0.0, -1.0,
  ];
  let indices = [
    0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 1, 7, 6, 11, 8, 7, 11, 9, 8, 11,
    10, 9, 11, 6, 10, 11, 6, 2, 1, 7, 3, 2, 8, 4, 3, 9, 5, 4, 10, 1, 5, 6, 7, 2,
    7, 8, 3, 8, 9, 4, 9, 10, 5, 10, 6, 1,
  ];
  // Subdivide
  for (let s = 0; s < subdivisions; s++) {
    indices = subdivide(vertices, indices);
  }
  // Apply radius and origin transformation
  const numVerts = vertices.length / 3;
  const positions = new Array(vertices.length);
  for (let i = 0; i < numVerts; i++) {
    const i3 = i * 3;
    positions[i3] = vertices[i3] * radius + origin[0];
    positions[i3 + 1] = vertices[i3 + 1] * radius + origin[1];
    positions[i3 + 2] = vertices[i3 + 2] * radius + origin[2];
  }
  const rgba32 = packColor(color);
  return { positions, indices, rgba32 };
}

export function createCylinder(
  start: number[],
  dest: number[],
  radius: number,
  color: number[] = [1, 1, 1, 1],
  sides = 20,
  endcaps = true,
): { positions: number[]; indices: number[]; rgba32: number } {
  const positions: number[] = [];
  const indices: number[] = [];
  // Cylinder Axis logic
  const vAxis = vec3.create();
  vec3.subtract(vAxis, dest, start);
  const vZ = vec3.fromValues(0, 0, 1);
  const vNorm = vec3.create();
  vec3.normalize(vNorm, vAxis);
  // Find vectors orthogonal to axis
  const vX = vec3.create();
  if (Math.abs(vec3.dot(vNorm, vZ)) > 0.9) {
    vec3.cross(vX, vNorm, vec3.fromValues(0, 1, 0));
  } else {
    vec3.cross(vX, vNorm, vZ);
  }
  vec3.normalize(vX, vX);
  const vY = vec3.create();
  vec3.cross(vY, vNorm, vX);
  // 1. Build Sides — reuse vertices at the seam so normals smooth across
  for (let i = 0; i < sides; i++) {
    const angle = (i * 2 * Math.PI) / sides;
    const n = vec3.create();
    vec3.scaleAndAdd(n, n, vX, Math.cos(angle));
    vec3.scaleAndAdd(n, n, vY, Math.sin(angle));
    const pStart = vec3.scaleAndAdd(vec3.create(), start, n, radius);
    const pEnd = vec3.scaleAndAdd(vec3.create(), dest, n, radius);
    positions.push(...pStart, ...pEnd);
    const i2 = i * 2;
    const n2 = ((i + 1) % sides) * 2;
    indices.push(i2, n2, i2 + 1, i2 + 1, n2, n2 + 1);
  }
  // 2. Build Endcaps — separate ring vertices (flat normals, not shared with sides)
  if (endcaps) {
    const startCenterIdx = positions.length / 3;
    const endCenterIdx = startCenterIdx + 1;
    positions.push(...start, ...dest);
    const ringStart = positions.length / 3;
    for (let i = 0; i < sides; i++) {
      const angle = (i * 2 * Math.PI) / sides;
      const ringDir = vec3.create();
      vec3.scaleAndAdd(ringDir, ringDir, vX, Math.cos(angle));
      vec3.scaleAndAdd(ringDir, ringDir, vY, Math.sin(angle));
      positions.push(
        ...vec3.scaleAndAdd(vec3.create(), start, ringDir, radius),
      );
      positions.push(...vec3.scaleAndAdd(vec3.create(), dest, ringDir, radius));
      const curr = ringStart + i * 2;
      const next = ringStart + ((i + 1) % sides) * 2;
      indices.push(startCenterIdx, next, curr);
      indices.push(endCenterIdx, curr + 1, next + 1);
    }
  }
  const rgba32 = packColor(color);
  return { positions, indices, rgba32 };
}

// Orientation cube: 6 colored faces + P/A/S/I/L/R letter geometry.
// Raw data is TRIANGLE_STRIP with degenerate separators (168 vertices, 6 floats each: xyzrgb).
// Converts to indexed TRIANGLE_LIST with per-vertex packed RGBA32 colors.
export function createOrientCube(): {
  positions: number[];
  indices: number[];
  colors: Uint32Array;
} {
  // prettier-ignore
  const strip = new Float32Array([
    -1, -1, -1, 0.28, 0.28, 0.28, -1, -1, -1, 0.28, 0.28, 0.28, -1, 1, -1, 0.28,
    0.28, 0.28, 1, -1, -1, 0.28, 0.28, 0.28, 1, 1, -1, 0.28, 0.28, 0.28, 1, 1,
    -1, 0.28, 0.28, 0.28, -1, -1, 1, 0.8, 0.8, 0.8, -1, -1, 1, 0.8, 0.8, 0.8, 1,
    -1, 1, 0.8, 0.8, 0.8, -1, 1, 1, 0.8, 0.8, 0.8, 1, 1, 1, 0.8, 0.8, 0.8, 1, 1,
    1, 0.8, 0.8, 0.8, -1, 1, -1, 0, 0, 0.74, -1, 1, -1, 0, 0, 0.74, -1, 1, 1, 0,
    0, 0.74, 1, 1, -1, 0, 0, 0.74, 1, 1, 1, 0, 0, 0.74, 1, 1, 1, 0, 0, 0.74, -1,
    -1, -1, 0.42, 0, 0.42, -1, -1, -1, 0.42, 0, 0.42, 1, -1, -1, 0.42, 0, 0.42,
    -1, -1, 1, 0.42, 0, 0.42, 1, -1, 1, 0.42, 0, 0.42, 1, -1, 1, 0.42, 0, 0.42,
    -1, -1, -1, 0.64, 0, 0, -1, -1, -1, 0.64, 0, 0, -1, -1, 1, 0.64, 0, 0, -1,
    1, -1, 0.64, 0, 0, -1, 1, 1, 0.64, 0, 0, -1, 1, 1, 0.64, 0, 0, 1, -1, -1, 0,
    0.5, 0, 1, -1, -1, 0, 0.5, 0, 1, 1, -1, 0, 0.5, 0, 1, -1, 1, 0, 0.5, 0, 1,
    1, 1, 0, 0.5, 0, 1, 1, 1, 0, 0.5, 0,
    // P
    -0.45, 1, -0.8, 0, 0, 0, -0.45, 1, -0.8, 0, 0, 0, -0.45, 1, 0.8, 0, 0, 0,
    -0.25, 1, -0.8, 0, 0, 0, -0.25, 1, 0.8, 0, 0, 0, -0.25, 1, 0.8, 0, 0, 0,
    -0.25, 1, 0.6, 0, 0, 0, -0.25, 1, 0.6, 0, 0, 0, -0.25, 1, 0.8, 0, 0, 0,
    0.45, 1, 0.6, 0, 0, 0, 0.25, 1, 0.8, 0, 0, 0, 0.25, 1, 0.8, 0, 0, 0, 0.25,
    1, 0.1, 0, 0, 0, 0.25, 1, 0.1, 0, 0, 0, 0.25, 1, 0.6, 0, 0, 0, 0.45, 1, 0.1,
    0, 0, 0, 0.45, 1, 0.6, 0, 0, 0, 0.45, 1, 0.6, 0, 0, 0, -0.25, 1, -0.1, 0, 0,
    0, -0.25, 1, -0.1, 0, 0, 0, -0.25, 1, 0.1, 0, 0, 0, 0.25, 1, -0.1, 0, 0, 0,
    0.45, 1, 0.1, 0, 0, 0, 0.45, 1, 0.1, 0, 0, 0,
    // A
    0.45, -1, -0.8, 0, 0, 0, 0.45, -1, -0.8, 0, 0, 0, 0.05, -1, 0.8, 0, 0, 0,
    0.25, -1, -0.8, 0, 0, 0, -0.15, -1, 0.8, 0, 0, 0, -0.15, -1, 0.8, 0, 0, 0,
    -0.25, -1, -0.8, 0, 0, 0, -0.25, -1, -0.8, 0, 0, 0, 0.05, -1, 0.8, 0, 0, 0,
    -0.45, -1, -0.8, 0, 0, 0, -0.15, -1, 0.8, 0, 0, 0, -0.15, -1, 0.8, 0, 0, 0,
    0.13, -1, -0.3, 0, 0, 0, 0.13, -1, -0.3, 0, 0, 0, 0.07, -1, -0.1, 0, 0, 0,
    -0.33, -1, -0.3, 0, 0, 0, -0.27, -1, -0.1, 0, 0, 0, -0.27, -1, -0.1, 0, 0,
    0,
    // S
    -0.45, 0.6, 1, 0, 0, 0, -0.45, 0.6, 1, 0, 0, 0, -0.45, 0.4, 1, 0, 0, 0,
    -0.25, 0.8, 1, 0, 0, 0, -0.25, 0.4, 1, 0, 0, 0, -0.25, 0.4, 1, 0, 0, 0,
    -0.25, 0.8, 1, 0, 0, 0, -0.25, 0.8, 1, 0, 0, 0, -0.25, 0.6, 1, 0, 0, 0,
    0.25, 0.8, 1, 0, 0, 0, 0.45, 0.6, 1, 0, 0, 0, 0.45, 0.6, 1, 0, 0, 0, 0.25,
    0.8, 1, 0, 0, 0, 0.25, 0.8, 1, 0, 0, 0, 0.25, -0.1, 1, 0, 0, 0, 0.45, 0.6,
    1, 0, 0, 0, 0.45, 0.1, 1, 0, 0, 0, 0.45, 0.1, 1, 0, 0, 0, -0.25, 0.1, 1, 0,
    0, 0, -0.25, 0.1, 1, 0, 0, 0, -0.45, -0.1, 1, 0, 0, 0, 0.25, 0.1, 1, 0, 0,
    0, 0.25, -0.1, 1, 0, 0, 0, 0.25, -0.1, 1, 0, 0, 0, -0.45, -0.1, 1, 0, 0, 0,
    -0.45, -0.1, 1, 0, 0, 0, -0.45, -0.6, 1, 0, 0, 0, -0.25, -0.1, 1, 0, 0, 0,
    -0.25, -0.8, 1, 0, 0, 0, -0.25, -0.8, 1, 0, 0, 0, -0.25, -0.6, 1, 0, 0, 0,
    -0.25, -0.6, 1, 0, 0, 0, -0.25, -0.8, 1, 0, 0, 0, 0.45, -0.6, 1, 0, 0, 0,
    0.25, -0.8, 1, 0, 0, 0, 0.25, -0.8, 1, 0, 0, 0, 0.25, -0.4, 1, 0, 0, 0,
    0.25, -0.4, 1, 0, 0, 0, 0.25, -0.6, 1, 0, 0, 0, 0.45, -0.4, 1, 0, 0, 0,
    0.45, -0.6, 1, 0, 0, 0, 0.45, -0.6, 1, 0, 0, 0,
    // I
    -0.1, -0.8, -1, 0, 0, 0, -0.1, -0.8, -1, 0, 0, 0, -0.1, 0.8, -1, 0, 0, 0,
    0.1, -0.8, -1, 0, 0, 0, 0.1, 0.8, -1, 0, 0, 0, 0.1, 0.8, -1, 0, 0, 0,
    // L
    -1, -0.45, -0.8, 0, 0, 0, -1, -0.45, -0.8, 0, 0, 0, -1, -0.45, 0.8, 0, 0, 0,
    -1, -0.25, -0.8, 0, 0, 0, -1, -0.25, 0.8, 0, 0, 0, -1, -0.25, 0.8, 0, 0, 0,
    -1, -0.25, -0.8, 0, 0, 0, -1, -0.25, -0.8, 0, 0, 0, -1, -0.25, -0.6, 0, 0,
    0, -1, 0.45, -0.8, 0, 0, 0, -1, 0.45, -0.6, 0, 0, 0, -1, 0.45, -0.6, 0, 0,
    0,
    // R
    1, 0.45, -0.8, 0, 0, 0, 1, 0.45, -0.8, 0, 0, 0, 1, 0.45, 0.8, 0, 0, 0, 1,
    0.25, -0.8, 0, 0, 0, 1, 0.25, 0.8, 0, 0, 0, 1, 0.25, 0.8, 0, 0, 0, 1, 0.25,
    0.6, 0, 0, 0, 1, 0.25, 0.6, 0, 0, 0, 1, 0.25, 0.8, 0, 0, 0, 1, -0.45, 0.6,
    0, 0, 0, 1, -0.25, 0.8, 0, 0, 0, 1, -0.25, 0.8, 0, 0, 0, 1, -0.25, 0.1, 0,
    0, 0, 1, -0.25, 0.1, 0, 0, 0, 1, -0.25, 0.6, 0, 0, 0, 1, -0.45, 0.1, 0, 0,
    0, 1, -0.45, 0.6, 0, 0, 0, 1, -0.45, 0.6, 0, 0, 0, 1, 0.25, -0.1, 0, 0, 0,
    1, 0.25, -0.1, 0, 0, 0, 1, 0.25, 0.1, 0, 0, 0, 1, -0.25, -0.1, 0, 0, 0, 1,
    -0.45, 0.1, 0, 0, 0, 1, -0.45, 0.1, 0, 0, 0, 1, -0.25, -0.8, 0, 0, 0, 1,
    -0.25, -0.8, 0, 0, 0, 1, -0.05, -0.1, 0, 0, 0, 1, -0.45, -0.8, 0, 0, 0, 1,
    -0.25, -0.1, 0, 0, 0, 1, -0.25, -0.1, 0, 0, 0,
  ]);
  const vertMap = new Map<string, number>();
  const positions: number[] = [];
  const colorList: number[] = [];
  const indices: number[] = [];
  const numVerts = strip.length / 6;

  function getVertexIndex(i: number): number {
    const base = i * 6;
    const x = strip[base],
      y = strip[base + 1],
      z = strip[base + 2];
    const r = strip[base + 3],
      g = strip[base + 4],
      b = strip[base + 5];
    const key = `${x},${y},${z},${r},${g},${b}`;
    let idx = vertMap.get(key);
    if (idx !== undefined) return idx;
    idx = positions.length / 3;
    vertMap.set(key, idx);
    positions.push(x, y, z);
    const ri = Math.round(r * 255);
    const gi = Math.round(g * 255);
    const bi = Math.round(b * 255);
    colorList.push((255 << 24) | (bi << 16) | (gi << 8) | ri);
    return idx;
  }

  function posEqual(a: number, b: number): boolean {
    const ax = strip[a * 6],
      ay = strip[a * 6 + 1],
      az = strip[a * 6 + 2];
    const bx = strip[b * 6],
      by = strip[b * 6 + 1],
      bz = strip[b * 6 + 2];
    return ax === bx && ay === by && az === bz;
  }

  for (let i = 0; i < numVerts - 2; i++) {
    if (posEqual(i, i + 1) || posEqual(i + 1, i + 2) || posEqual(i, i + 2))
      continue;
    const a = getVertexIndex(i);
    const b = getVertexIndex(i + 1);
    const c = getVertexIndex(i + 2);
    if (i % 2 === 0) {
      indices.push(a, b, c);
    } else {
      indices.push(b, a, c);
    }
  }
  return { positions, indices, colors: new Uint32Array(colorList) };
}
