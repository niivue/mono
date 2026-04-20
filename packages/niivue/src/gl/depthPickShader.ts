// Depth-pick shaders for WebGL2
// These shaders output depth packed into RGB for readPixels-based depth picking.
// The packDepth encoding uses 24-bit precision across R, G, B channels.

import { fragmentPreamble, volumeVertexShader } from "./volumeShaderLib";

export const depthPickVertexShader = volumeVertexShader;

export const depthPickFragmentShader = `${fragmentPreamble}
uniform float numVolumes;
uniform sampler3D overlay;

vec4 packDepth(float d) {
  d = clamp(d, 0.0, 1.0);
  vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * d);
  enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return vec4(enc, 1.0);
}

void main() {
  vec3 start = vColor;
  vec3 backPosition = GetBackPosition(start);
  vec3 dirVec = backPosition - start;
  float len = length(dirVec);
  vec3 dir = dirVec / len;
  vec3 texVox = vec3(textureSize(volume, 0));
  float lenVox = length(dirVec * texVox);
  if (lenVox < 0.5 || len > 3.0) {
    discard;
  }
  // Save original ray for overlay passes (overlay ignores clip planes)
  vec3 origStart = start;
  float origLen = len;
  float stepSize = len / lenVox;
  vec4 deltaDir = vec4(dir * stepSize, stepSize);
  vec2 sampleRange = vec2(0.0, len);
  bool cutaway = isClipCutaway > 0.5;
  bool hasClip = false;
  for (int i = 0; i < MAX_CLIP_PLANES; i++) {
    clipSampleRange(dir, vec4(start, 0.0), clipPlanes[i], sampleRange, hasClip);
  }
  bool isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));
  // Check if clip plane configuration eliminates background entirely
  bool skipBackground = false;
  if (cutaway) {
    if (hasClip && sampleRange.x <= 0.0 && sampleRange.y >= len) {
      skipBackground = true;
    }
  } else {
    if (sampleRange.x >= sampleRange.y) {
      skipBackground = true;
    }
  }
  // Shared values
  float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
  float stepSizeFast = stepSize * 1.9;
  vec4 deltaDirFast = vec4(dir * stepSizeFast, stepSizeFast);
  // --- Background depth pick ---
  float bgDepth = 1.0;
  bool bgHit = false;
  if (!skipBackground) {
    if (!cutaway && isClip) {
      start += dir * sampleRange.x;
      len = sampleRange.y - sampleRange.x;
    }
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    vec4 samplePosStart = samplePos;
    // Fast pass
    for (int j = 0; j < 1024; j++) {
      if (samplePos.a > len) { break; }
      if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
        samplePos += deltaDirFast;
        continue;
      }
      float alpha = texture(volume, samplePos.xyz).a;
      if (alpha >= 0.01) { break; }
      samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) {
      // Fast pass found nothing — use clip plane depth as fallback
      if (!cutaway && isClip) {
        bgDepth = frac2ndc(start);
        bgHit = true;
      }
    } else {
      // Retract and fine pass
      samplePos -= deltaDirFast;
      if (samplePos.a < 0.0) { samplePos = samplePosStart; }
      for (int fi = 0; fi < 2048; fi++) {
        if (samplePos.a > len) { break; }
        if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
          samplePos += deltaDir;
          continue;
        }
        float alpha = texture(volume, samplePos.xyz).a;
        if (alpha >= 0.01) {
          bgDepth = frac2ndc(samplePos.xyz);
          bgHit = true;
          break;
        }
        samplePos += deltaDir;
      }
      // If fine pass found nothing, use clip plane as fallback
      if (!bgHit && !cutaway && isClip) {
        bgDepth = frac2ndc(start);
        bgHit = true;
      }
    }
  }
  // --- Overlay depth pick (no clip plane) ---
  float overDepth = 1.0;
  bool overHit = false;
  if (numVolumes > 1.0) {
    vec4 overSamplePos = vec4(origStart + dir * (stepSize * ran), stepSize * ran);
    vec4 overSamplePosStart = overSamplePos;
    // Overlay fast pass
    for (int oj = 0; oj < 1024; oj++) {
      if (overSamplePos.a > origLen) { break; }
      float alpha = texture(overlay, overSamplePos.xyz).a;
      if (alpha >= 0.01) { break; }
      overSamplePos += deltaDirFast;
    }
    if (overSamplePos.a < origLen) {
      overSamplePos -= deltaDirFast;
      if (overSamplePos.a < 0.0) { overSamplePos = overSamplePosStart; }
      // Overlay fine pass
      for (int oi = 0; oi < 2048; oi++) {
        if (overSamplePos.a > origLen) { break; }
        float alpha = texture(overlay, overSamplePos.xyz).a;
        if (alpha >= 0.01) {
          overDepth = frac2ndc(overSamplePos.xyz);
          overHit = true;
          break;
        }
        overSamplePos += deltaDir;
      }
    }
  }
  // Output nearest depth from background or overlay
  if (!bgHit && !overHit) {
    discard;
  }
  float finalDepth;
  if (bgHit && overHit) {
    finalDepth = min(bgDepth, overDepth);
  } else if (bgHit) {
    finalDepth = bgDepth;
  } else {
    finalDepth = overDepth;
  }
  FragColor = packDepth(finalDepth);
  gl_FragDepth = finalDepth;
}
`;

// Mesh depth-pick shaders
// The vertex shader matches the mesh VAO layout (position, normal, color at stride 28)
export const meshDepthPickVertexShader = `#version 300 es
precision highp float;
uniform mat4 mvpMtx;
in vec3 position;
in vec3 normal;
in vec4 color;

void main() {
  gl_Position = mvpMtx * vec4(position, 1.0);
}
`;

export const meshDepthPickFragmentShader = `#version 300 es
precision highp float;
out vec4 fragColor;

vec4 packDepth(float d) {
  d = clamp(d, 0.0, 1.0);
  vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * d);
  enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return vec4(enc, 1.0);
}

void main() {
  vec4 packed = packDepth(gl_FragCoord.z);
  // alpha=0.5 signals "mesh" hit (volume uses alpha=1.0)
  fragColor = vec4(packed.xyz, 0.5);
}
`;
