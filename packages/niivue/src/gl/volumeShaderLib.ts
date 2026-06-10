// Shared GLSL snippets for volume ray-casting shaders (render + depth pick).
// Single source of truth for vertex shader and fragment helper functions.

export const volumeVertexShader = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4 mvpMtx;
uniform mat4 matRAS;
// Tiled-volume fields. Pass-through values for non-chunked volumes:
//   volumeTexDimsFull = full RAS volume dims
//   chunkSubOrigin    = (0,0,0)
//   chunkSubSize      = (1,1,1)
//   dataOriginTexFrac = (0,0,0)
//   dataSizeTexFrac   = (1,1,1)
uniform vec3 volumeTexDimsFull;
uniform vec3 chunkSubOrigin;
uniform vec3 chunkSubSize;
uniform vec3 dataOriginTexFrac;
uniform vec3 dataSizeTexFrac;
out vec3 vColor;

void main() {
  // Place this draw's cube into the chunk texture footprint in the full
  // volume's [0,1] cube. For non-chunked draws, drawOrigin=0 and drawSize=1.
  vec3 safeDataSize = max(dataSizeTexFrac, vec3(1e-8));
  vec3 drawOrigin = chunkSubOrigin - chunkSubSize * (dataOriginTexFrac / safeDataSize);
  vec3 drawSize = chunkSubSize / safeDataSize;
  vec3 subPos = drawOrigin + aPos * drawSize;
  vec3 texVox = volumeTexDimsFull;
  vec3 voxelSpacePos = (subPos * texVox) - 0.5;
  vec3 vPos = (vec4(voxelSpacePos, 1.0) * matRAS).xyz;
  gl_Position = mvpMtx * vec4(vPos, 1.0);
  vColor = subPos;
}
`

// Fragment preamble: version, precision, constants, shared uniforms, varyings,
// and helper functions used by both the render and depth-pick fragment shaders.
export const fragmentPreamble = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp sampler2D;

const int MAX_CLIP_PLANES = 6;

uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec3 volScale;
uniform vec3 rayDir;
uniform float isClipCutaway;
uniform float clipPlaneOverlay;
uniform vec4 clipPlanes[MAX_CLIP_PLANES];
uniform sampler3D volume;

// Tiled-volume fields. Pass-through values for non-chunked volumes:
//   volumeTexDimsFull = full RAS volume dims
//   chunkSubOrigin    = (0,0,0)
//   chunkSubSize      = (1,1,1)
//   dataOriginTexFrac = (0,0,0)
//   dataSizeTexFrac   = (1,1,1)
// The vertex shader scales the unit cube into the chunk texture footprint
// (data plus halo) so separately-rasterized chunk cubes overlap by their
// halo. The fragment shader clips ray marching back to the chunk's owned
// data sub-cube, and chunkTexCoord remaps samples into
// [dataOrigin, dataOrigin+dataSize], letting trilinear sampling pull from
// halo voxels without double-counting them.
uniform vec3 volumeTexDimsFull;
uniform vec3 chunkSubOrigin;
uniform vec3 chunkSubSize;
uniform vec3 dataOriginTexFrac;
uniform vec3 dataSizeTexFrac;

in vec3 vColor;
out vec4 FragColor;

vec3 chunkTexCoord(vec3 samplePos) {
  vec3 chunkLocal = (samplePos - chunkSubOrigin) / chunkSubSize;
  return dataOriginTexFrac + chunkLocal * dataSizeTexFrac;
}

vec2 rayAxisRange(float start, float dir, float boxMin, float boxMax) {
  if (abs(dir) < 1e-8) {
    if (start < boxMin || start > boxMax) {
      return vec2(1e20, -1e20);
    }
    return vec2(-1e20, 1e20);
  }
  float t0 = (boxMin - start) / dir;
  float t1 = (boxMax - start) / dir;
  return vec2(min(t0, t1), max(t0, t1));
}

vec2 rayBoxRange(vec3 startObj, vec3 dir, vec3 boxMin, vec3 boxMax) {
  vec2 rx = rayAxisRange(startObj.x, dir.x, boxMin.x, boxMax.x);
  vec2 ry = rayAxisRange(startObj.y, dir.y, boxMin.y, boxMax.y);
  vec2 rz = rayAxisRange(startObj.z, dir.z, boxMin.z, boxMax.z);
  return vec2(max(rx.x, max(ry.x, rz.x)), min(rx.y, min(ry.y, rz.y)));
}

float frac2ndc(vec3 frac) {
  vec4 pos = vec4(frac.xyz, 1.0);
  vec4 dim = vec4(volumeTexDimsFull, 1.0);
  pos = pos * dim;
  vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
  pos += shim;
  vec4 mm = transpose(matRAS) * pos;
  vec4 clipPos = mvpMtx * vec4(mm.xyz, 1.0);
  float z_ndc = clipPos.z / clipPos.w;
  return (z_ndc + 1.0) / 2.0;
}

vec3 GetBackPosition(vec3 startTex) {
  // Clip ray to the chunk's sub-cube in object space, not the full cube.
  // For non-chunked: subMin=0, subMax=volScale (identical to original).
  vec3 subMin = chunkSubOrigin * volScale;
  vec3 subMax = (chunkSubOrigin + chunkSubSize) * volScale;
  vec3 startObj = startTex * volScale;
  vec2 range = rayBoxRange(startObj, rayDir, subMin, subMax);
  float t = max(range.y, max(range.x, 0.0));
  return (startObj + (rayDir * t)) / volScale;
}

vec3 GetFrontPosition(vec3 startTex) {
  vec3 subMin = chunkSubOrigin * volScale;
  vec3 subMax = (chunkSubOrigin + chunkSubSize) * volScale;
  vec3 startObj = startTex * volScale;
  float t = max(rayBoxRange(startObj, rayDir, subMin, subMax).x, 0.0);
  return (startObj + (rayDir * t)) / volScale;
}

vec3 GetFullFrontPosition(vec3 startTex) {
  vec3 startObj = startTex * volScale;
  float t = rayBoxRange(startObj, -rayDir, vec3(0.0), volScale).y;
  return (startObj - (rayDir * t)) / volScale;
}

float raySamplePhase(vec3 startTex, float stepSize) {
  vec3 fullFront = GetFullFrontPosition(startTex);
  float traveled = length(startTex - fullFront);
  float grid = traveled / max(stepSize, 1e-8);
  // Continue the full-volume centered sample lattice through each chunk.
  // If a global sample lands exactly on a chunk boundary, use the next
  // sample in the nearer chunk so the boundary is not double-counted.
  float phase = floor(grid + 0.5) + 0.5 - grid;
  if (phase <= 0.001) {
    phase = 1.0;
  }
  return clamp(phase, 0.001, 1.0);
}

// see if clip plane trims ray sampling range sampleStartEnd.x..y
void clipSampleRange(vec3 dir, vec4 rayStart, vec4 clipPlane, inout vec2 sampleStartEnd, inout bool hasClip) {
  const float CSR_EPS = 1e-6;
  // quick exit: no clip plane
  if (clipPlane.a > 1.0 || clipPlane.a < -1.0) {
    return;
  }
  float depth = - clipPlane.a;
  hasClip = true;
  // quick exit: empty range
  if ((sampleStartEnd.y - sampleStartEnd.x) <= CSR_EPS) {
    return;
  }
  // Which side does the ray start on? (plane eqn: dot(n, p-0.5) + a = 0)
  float sampleSide = dot(clipPlane.xyz, rayStart.xyz - 0.5) + depth;
  bool startsFront = (sampleSide < 0.0);
  float dis = -1.0;
  // plane normal dot ray direction
  float cdot = dot(dir, clipPlane.xyz);
  // avoid division by 0 for near-parallel plane
  if (abs(cdot) >= CSR_EPS) {
    dis = (-depth - dot(clipPlane.xyz, rayStart.xyz - 0.5)) / cdot;
  }
  if (dis < 0.0 || dis > sampleStartEnd.y + CSR_EPS) {
    if (startsFront) {
      sampleStartEnd = vec2(0.0, 0.0);
    }
    return;
  }
  bool frontface = (cdot > 0.0);
  if (frontface) {
    sampleStartEnd.x = max(sampleStartEnd.x, dis);
  } else {
    sampleStartEnd.y = min(sampleStartEnd.y, dis);
  }
  // if nothing remains, mark empty
  if (sampleStartEnd.y - sampleStartEnd.x <= CSR_EPS) {
    sampleStartEnd = vec2(0.0, 0.0);
  }
}
`
