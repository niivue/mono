// Shared GLSL snippets for volume ray-casting shaders (render + depth pick).
// Single source of truth for vertex shader and fragment helper functions.

export const volumeVertexShader = `#version 300 es
precision highp float;
precision highp sampler3D;

layout(location = 0) in vec3 aPos;

uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform sampler3D volume;
out vec3 vColor;

void main() {
  vec3 pos = aPos;
  vec3 texVox = vec3(textureSize(volume, 0));
  vec3 voxelSpacePos = (pos * texVox) - 0.5;
  vec3 vPos = (vec4(voxelSpacePos, 1.0) * matRAS).xyz;
  gl_Position = mvpMtx * vec4(vPos, 1.0);
  vColor = aPos;
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

in vec3 vColor;
out vec4 FragColor;

float frac2ndc(vec3 frac) {
  vec4 pos = vec4(frac.xyz, 1.0);
  vec4 dim = vec4(vec3(textureSize(volume, 0)), 1.0);
  pos = pos * dim;
  vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
  pos += shim;
  vec4 mm = transpose(matRAS) * pos;
  vec4 clipPos = mvpMtx * vec4(mm.xyz, 1.0);
  float z_ndc = clipPos.z / clipPos.w;
  return (z_ndc + 1.0) / 2.0;
}

vec3 GetBackPosition(vec3 startTex) {
  vec3 startObj = startTex * volScale;
  vec3 invR = 1.0 / rayDir;
  vec3 tbot = invR * (-startObj);
  vec3 ttop = invR * (volScale - startObj);
  vec3 tmax = max(ttop, tbot);
  float t = min(tmax.x, min(tmax.y, tmax.z));
  return (startObj + (rayDir * t)) / volScale;
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
