// Depth-pick shaders for WebGL2
// These shaders output depth packed into RGB for readPixels-based depth picking.
// The packDepth encoding uses 24-bit precision across R, G, B channels.

import { fragmentPreamble, volumeVertexShader } from './volumeShaderLib'

export const depthPickVertexShader = volumeVertexShader

export const depthPickFragmentShader = `${fragmentPreamble}
uniform float numVolumes;
uniform sampler3D overlay;
uniform vec4 paqdUniforms;
uniform sampler3D paqd;
uniform sampler3D drawing;

// The layers sampleSlice (gl/renderShader.ts) composites on a plane over the
// base and the overlay: a PAQD label with a non-zero eased alpha, or a painted
// drawing voxel, is drawn even where both of those are transparent, so it has
// to be pickable there too. Same nearest texel, same thresholds as the render.
// A missing layer is the 2-voxel placeholder, which the size guard skips.
// Mirrored in wgpu/depthPick.ts and, for chunked volumes the GPU pick cannot
// sample, in view/planeVisibility.ts.
bool planeLayerVisible(vec3 volCoord) {
  if (textureSize(paqd, 0).x > 2) {
    ivec3 pDims = textureSize(paqd, 0);
    vec4 raw = texelFetch(paqd, clamp(ivec3(volCoord * vec3(pDims)), ivec3(0), pDims - 1), 0);
    if (raw.b + raw.a > 0.004 && paqdEaseAlpha(raw.b, paqdUniforms) > 0.0) { return true; }
  }
  if (textureSize(drawing, 0).x > 2) {
    ivec3 dDims = textureSize(drawing, 0);
    vec4 dc = texelFetch(drawing, clamp(ivec3(volCoord * vec3(dDims)), ivec3(0), dDims - 1), 0);
    if (dc.a > 0.0) { return true; }
  }
  return false;
}

vec4 packDepth(float d) {
  d = clamp(d, 0.0, 1.0);
  vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * d);
  enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return vec4(enc, 1.0);
}

void main() {
  vec3 rayStart = vColor;
  vec3 start = GetFrontPosition(rayStart);
  vec3 backPosition = GetBackPosition(rayStart);
  vec3 dirVec = backPosition - start;
  float len = length(dirVec);
  if (!(len > 0.0) || len > 3.0) {
    discard;
  }
  vec3 dir = dirVec / len;
  vec3 texVox = volumeTexDimsFull;
  float lenVox = length(dirVec * texVox);
  if (lenVox < 0.5) {
    discard;
  }
  // SLICES mode draws three planes, not a marched surface, so the pick lands on
  // the nearest VISIBLE plane hit. Visibility must be the same rule the render
  // uses (background baked alpha, the overlay, a PAQD label or the drawing), or
  // a double-click lands somewhere the user cannot see. Mirrored in
  // wgpu/depthPick.ts.
  if (isRenderMode(RENDER_MODE_SLICES)) {
    float best = -1.0;
    for (int k = 0; k < 3; k++) {
      if (abs(dir[k]) < 1e-8) { continue; }
      float tk = (sliceFrac[k] - start[k]) / dir[k];
      if (tk < 0.0 || tk >= len) { continue; }
      if (best >= 0.0 && tk >= best) { continue; }
      vec3 pos = start + dir * tk;
      // The same visibility rule sampleSlice draws with: without alpha clipping
      // the whole plane is a solid slab, so every in-cube hit is pickable.
      bool visible = isAlphaClipDark <= 0.5;
      if (!visible) visible = texture(volume, chunkTexCoord(pos)).a > 0.0;
      if (!visible && numVolumes > 1.0) {
        visible = texture(overlay, chunkTexCoord(pos)).a > 0.0;
      }
      if (!visible) { visible = planeLayerVisible(chunkTexCoord(pos)); }
      if (visible) { best = tk; }
    }
    if (best < 0.0) {
      discard;
    }
    float sliceDepth = frac2ndc(start + dir * best);
    FragColor = packDepth(sliceDepth);
    gl_FragDepth = sliceDepth;
    return;
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
  // Match the visual renderer's full-volume ray-sample phase.
  float origRan = raySamplePhase(origStart, stepSize);
  float ran = origRan;
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
    ran = raySamplePhase(start, stepSize);
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    vec4 samplePosStart = samplePos;
    // Fast pass
    for (int j = 0; j < 1024; j++) {
      if (samplePos.a > len) { break; }
      if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
        samplePos += deltaDirFast;
        continue;
      }
      float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;
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
        float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;
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
  // --- Overlay depth pick. Overlays ignore the clip plane by default, but
  // when clipPlaneOverlay is set the RENDER clips them with the base (solid
  // keeps [sampleRange.x, sampleRange.y], cutaway skips it; see
  // renderShader.ts clipPassSkip). The pick must march the same clipped ray,
  // or a double-click lands on invisible cut-away voxels in front of the
  // plane. Gate on hasClip, matching the render. ---
  float overDepth = 1.0;
  bool overHit = false;
  bool clipOverlay = (clipPlaneOverlay > 0.5) && hasClip;
  if (numVolumes > 1.0) {
    vec4 overSamplePos = vec4(origStart + dir * (stepSize * origRan), stepSize * origRan);
    vec4 overSamplePosStart = overSamplePos;
    // Overlay fast pass
    for (int oj = 0; oj < 1024; oj++) {
      if (overSamplePos.a > origLen) { break; }
      if (clipOverlay && !cutaway && overSamplePos.a > sampleRange.y) { break; }
      bool ovInRange = overSamplePos.a >= sampleRange.x && overSamplePos.a <= sampleRange.y;
      if (clipOverlay && (cutaway ? ovInRange : !ovInRange)) {
        overSamplePos += deltaDirFast;
        continue;
      }
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
        if (clipOverlay && !cutaway && overSamplePos.a > sampleRange.y) { break; }
        bool ovInRange = overSamplePos.a >= sampleRange.x && overSamplePos.a <= sampleRange.y;
        if (clipOverlay && (cutaway ? ovInRange : !ovInRange)) {
          overSamplePos += deltaDir;
          continue;
        }
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
`

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
`

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
`
