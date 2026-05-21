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
uniform vec3 volumeTexDimsFull;
uniform vec3 chunkSubOrigin;
uniform vec3 chunkSubSize;
out vec3 vColor;

void main() {
  // Place this draw's cube into the sub-cube region of the full volume's
  // [0,1] cube. For non-chunked: chunkSubOrigin=0, chunkSubSize=1 so
  // subPos == aPos (unchanged from the legacy path).
  vec3 subPos = chunkSubOrigin + aPos * chunkSubSize;
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
uniform vec4 clipPlanes[MAX_CLIP_PLANES];
uniform sampler3D volume;

// Tiled-volume fields. Pass-through values for non-chunked volumes:
//   volumeTexDimsFull = full RAS volume dims
//   chunkSubOrigin    = (0,0,0)
//   chunkSubSize      = (1,1,1)
//   dataOriginTexFrac = (0,0,0)
//   dataSizeTexFrac   = (1,1,1)
// chunkTexCoord remaps a sample position from full-volume [0,1] cube space
// to the local chunk texture's [dataOrigin, dataOrigin+dataSize] region,
// letting trilinear sampling pull from halo voxels for seam-free chunk joins.
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
  vec3 invR = 1.0 / rayDir;
  vec3 tbot = invR * (subMin - startObj);
  vec3 ttop = invR * (subMax - startObj);
  vec3 tmax = max(ttop, tbot);
  float t = min(tmax.x, min(tmax.y, tmax.z));
  return (startObj + (rayDir * t)) / volScale;
}

vec3 GetFullFrontPosition(vec3 startTex) {
  vec3 startObj = startTex * volScale;
  vec3 invR = 1.0 / -rayDir;
  vec3 tbot = invR * (vec3(0.0) - startObj);
  vec3 ttop = invR * (volScale - startObj);
  vec3 tmax = max(ttop, tbot);
  float t = min(tmax.x, min(tmax.y, tmax.z));
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
