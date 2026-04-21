import { fragmentPreamble, volumeVertexShader } from "./volumeShaderLib"

export const vertexShader = volumeVertexShader

export const fragmentShader = `${fragmentPreamble}
uniform mat4 normMtx;
uniform float gradientAmount;
uniform float numVolumes;  // number of loaded volumes (1 = no overlay, 2+ = has overlay)
uniform float numPaqd;
uniform vec4 clipPlaneColor;
uniform vec4 paqdUniforms;
uniform sampler2D matcap;
uniform sampler3D volumeGradient;
uniform sampler3D overlay;
uniform sampler3D paqd;
uniform sampler2D paqdLut;
uniform sampler3D drawing;

struct RayResult {
  vec4 color;
  vec4 firstHit;
  float farthest;
};

// Shared fast+fine ray-march for overlay, PAQD, and drawing textures.
RayResult rayMarchPass(
    sampler3D tex, vec3 start, vec3 dir, float len,
    vec4 deltaDir, vec4 deltaDirFast,
    float ran, float earlyTermination
) {
    RayResult result;
    result.color = vec4(0.0);
    result.firstHit = vec4(0.0, 0.0, 0.0, 2.0 * len);
    result.farthest = 0.0;

    float stepSize = deltaDir.w;
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    vec4 samplePosStart = samplePos;

    // Fast pass
    for (int j = 0; j < 1024; j++) {
        if (samplePos.a > len) { break; }
        float alpha = texture(tex, samplePos.xyz).a;
        if (alpha >= 0.01) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }

    // Fine pass
    for (int i = 0; i < 2048; i++) {
        if (samplePos.a > len) { break; }
        vec4 colorSample = texture(tex, samplePos.xyz);
        if (colorSample.a >= 0.01) {
            if (result.firstHit.a > len) {
                result.firstHit = samplePos;
            }
            result.farthest = samplePos.a;
            vec4 premultiplied = vec4(colorSample.rgb * colorSample.a, colorSample.a);
            result.color = (1.0 - result.color.a) * premultiplied + result.color;
            if (result.color.a > earlyTermination) { break; }
        }
        samplePos += deltaDir;
    }
    return result;
}

// PAQD easing function — piecewise linear alpha from primary probability.
float paqdEaseAlpha(float alpha, vec4 u) {
    float t0 = u[0];
    float t1 = 0.5 * (u[0] + u[1]);
    float t2 = u[1];
    float y0 = 0.0;
    float y1 = abs(u[2]);
    float y2 = abs(u[3]);
    if (alpha <= t0) { return y0; }
    if (alpha <= t1) { return mix(y0, y1, (alpha - t0) / (t1 - t0)); }
    if (alpha <= t2) { return mix(y1, y2, (alpha - t1) / (t2 - t1)); }
    return y2;
}

// Specialized PAQD ray-march: samples raw PAQD data (nearest-neighbor),
// performs LUT lookup, probability blending, and alpha easing per sample.
RayResult rayMarchPaqd(
    sampler3D tex, sampler2D lut,
    vec3 start, vec3 dir, float len,
    vec4 deltaDir, vec4 deltaDirFast,
    float ran, float earlyTermination,
    vec4 paqdUni
) {
    RayResult result;
    result.color = vec4(0.0);
    result.firstHit = vec4(0.0, 0.0, 0.0, 2.0 * len);
    result.farthest = 0.0;

    ivec3 texDims = textureSize(tex, 0);
    vec3 texDimsF = vec3(texDims);
    float stepSize = deltaDir.w;
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    vec4 samplePosStart = samplePos;

    // Fast pass: skip until prob1 > easing threshold t0
    float t0 = paqdUni[0];
    for (int j = 0; j < 1024; j++) {
        if (samplePos.a > len) { break; }
        ivec3 coord = clamp(ivec3(samplePos.xyz * texDimsF), ivec3(0), texDims - 1);
        vec4 raw = texelFetch(tex, coord, 0);
        if (raw.b > t0) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }

    // Fine pass: decode and accumulate PAQD colors
    for (int i = 0; i < 2048; i++) {
        if (samplePos.a > len) { break; }
        ivec3 coord = clamp(ivec3(samplePos.xyz * texDimsF), ivec3(0), texDims - 1);
        vec4 raw = texelFetch(tex, coord, 0);
        float prob1 = raw.b;
        float prob2 = raw.a;
        float total = prob1 + prob2;
        if (total > 0.004) {
            int idx1 = int(round(raw.r * 255.0));
            int idx2 = int(round(raw.g * 255.0));
            vec4 c1 = texelFetch(lut, ivec2(clamp(idx1, 0, 255), 0), 0);
            vec4 c2 = texelFetch(lut, ivec2(clamp(idx2, 0, 255), 0), 0);
            float w = prob2 / total;
            vec3 rgb = mix(c1.rgb, c2.rgb, w);
            float alpha = paqdEaseAlpha(prob1, paqdUni);
            if (alpha >= 0.01) {
                if (result.firstHit.a > len) {
                    result.firstHit = samplePos;
                }
                result.farthest = samplePos.a;
                vec4 premultiplied = vec4(rgb * alpha, alpha);
                result.color = (1.0 - result.color.a) * premultiplied + result.color;
                if (result.color.a > earlyTermination) { break; }
            }
        }
        samplePos += deltaDir;
    }
    return result;
}

// Depth-aware mixing of a ray-march result into the accumulated color.
void depthAwareMix(
    inout vec4 colAcc, RayResult result,
    float backNearest, inout float fragDepth, float depthFactor
) {
    if (result.color.a <= 0.001) { return; }
    float mixFactor = result.color.a;
    if (colAcc.a <= 0.0) {
        mixFactor = 1.0;
    } else if (result.farthest > backNearest) {
        float dx = min((result.farthest - backNearest) / 0.5, 1.0);
        dx = colAcc.a * pow(dx, depthFactor);
        mixFactor *= 1.0 - dx;
    }
    colAcc = vec4(mix(colAcc.rgb, result.color.rgb, mixFactor), max(colAcc.a, result.color.a));
    float passDepth = frac2ndc(result.firstHit.xyz);
    fragDepth = min(fragDepth, passDepth);
}

float distance2Plane(vec4 samplePos, vec4 clipPlane) {
  // treat clipPlane.a > 1 as "no clip" sentinel
  if (clipPlane.a > 1.0) {
    return 1000.0;
  }
  vec3 n = clipPlane.xyz;
  const float EPS = 1e-6;
  float nlen = length(n);
  if (nlen < EPS) {
    return 1000.0; // invalid plane normal
  }
  // signed plane value: dot(n, p-0.5) + a
  float signedDist = dot(n, samplePos.xyz - 0.5) - clipPlane.a;
  // perpendicular (Euclidean) distance is |signedDist| / |n|
  return abs(signedDist) / nlen;
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
  // Handle clip plane color (negative alpha means color plane is inside volume)
  vec4 clipPlaneColorX = clipPlaneColor;
  if (clipPlaneColorX.a < 0.0) {
    clipPlaneColorX.a = 0.0;
  }
  float stepSize = len / lenVox;
  vec4 deltaDir = vec4(dir * stepSize, stepSize);
  float localGradientAmount = gradientAmount;
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
  // Shared values for all passes
  float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
  float stepSizeFast = stepSize * 1.9;
  vec4 deltaDirFast = vec4(dir * stepSizeFast, stepSizeFast);
  const float earlyTermination = 0.95;
  // --- Background passes ---
  vec4 colAcc = vec4(0.0);
  vec4 firstHit = vec4(0.0, 0.0, 0.0, 2.0 * origLen);
  bool bgHasHit = false;
  float fragDepth = 0.9999;
  float clipOffset = 0.0;
  bool clipSurfaceHit = false;
  if (!skipBackground) {
    if (!cutaway && isClip) {
      clipOffset = sampleRange.x;
      start += dir * sampleRange.x;
      len = sampleRange.y - sampleRange.x;
      float alpha = texture(volume, start.xyz).a;
      float alpha1 = texture(volume, start.xyz - deltaDir.xyz).a;
      if ((alpha > 0.01) && (alpha1 > 0.01)) {
        clipSurfaceHit = true;
      }
    }
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    // --- Background Fast Pass ---
    vec4 samplePosStart = samplePos;
    for (int j = 0; j < 1024; j++) {
      if (samplePos.a > len) { break; }
      if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
        samplePos += deltaDirFast;
        continue;
      }
      float alpha = texture(volume, samplePos.xyz).a;
      if (alpha >= 0.01) {
        break;
      }
      samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) {
      // Background fast pass found nothing — use clip plane color as fallback
      if (isClip) {
        float clipAlpha = clipPlaneColorX.a;
        colAcc = vec4(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
      }
    } else {
      // Background fast pass found something
      if (cutaway && isClip) {
        float dx = abs(sampleRange.x - samplePos.a);
        float dx2 = abs(sampleRange.y - samplePos.a);
        if (min(dx, dx2) < stepSizeFast) {
          clipSurfaceHit = true;
        }
      }
      if (clipSurfaceHit) {
        localGradientAmount = 0.0;
      }
      samplePos -= deltaDirFast;
      if (samplePos.a < 0.0) {
        samplePos = samplePosStart;
      }
      // --- Background Fine Pass ---
      mat3 norm3 = mat3(normMtx);
      float brighten = 1.0 + (localGradientAmount / 3.0);
      for (int fi = 0; fi < 2048; fi++) {
        if (samplePos.a > len) { break; }
        if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
          samplePos += deltaDir;
          continue;
        }
        vec4 colorSample = texture(volume, samplePos.xyz);
        if (colorSample.a >= 0.01) {
          if (!bgHasHit) {
            bgHasHit = true;
            firstHit = samplePos;
          }
          vec3 gradRaw = texture(volumeGradient, samplePos.xyz).rgb;
          vec3 localNormal = normalize(gradRaw * 2.0 - 1.0);
          vec3 n = norm3 * localNormal;
          vec2 uv = n.xy * 0.5 + 0.5;
          vec3 mc_rgb = texture(matcap, uv).rgb * brighten;
          vec3 blendedRGB = mix(vec3(1.0), mc_rgb, localGradientAmount);
          vec3 finalRGB = blendedRGB * colorSample.rgb;
          vec4 premultiplied = vec4(finalRGB * colorSample.a, colorSample.a);
          colAcc = (1.0 - colAcc.a) * premultiplied + colAcc;
          if (colAcc.a > earlyTermination) { break; }
        }
        samplePos += deltaDir;
      }
      // Clip surface ambient occlusion
      if (clipSurfaceHit) {
        float min1 = 1000.0;
        float min2 = 1000.0;
        vec4 firstHit1 = firstHit - deltaDir;
        for (int ci = 0; ci < MAX_CLIP_PLANES; ci++) {
          float d = distance2Plane(firstHit1, clipPlanes[ci]);
          if (d < min1) {
            min2 = min1;
            min1 = d;
          } else if (d < min2) {
            min2 = d;
          }
        }
        float thresh = 1.2 * stepSize;
        if (cutaway && min2 < thresh && sampleRange.x > 0.0) {
          if (abs(sampleRange.x - firstHit.a) > (2.0 * thresh) && abs(sampleRange.y - firstHit.a) > (2.0 * thresh)) {
            min2 = thresh;
          }
        }
        const float aoFrac = 0.5;
        float factor = (1.0 - aoFrac) + aoFrac * clamp(min2 / thresh, 0.0, 1.0);
        colAcc.rgb *= factor;
      }
      if (clipSurfaceHit && clipPlaneColor.a < 0.0) {
        colAcc.rgb = mix(colAcc.rgb, clipPlaneColorX.rgb, abs(clipPlaneColor.a));
      }
      // If fine pass produced nothing, use clip plane color as fallback
      if (colAcc.a <= 0.001 || !bgHasHit) {
        if (isClip) {
          float clipAlpha = clipPlaneColorX.a;
          colAcc = vec4(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
        }
      } else {
        fragDepth = frac2ndc(firstHit.xyz);
      }
    }
  }
  // --- Optional passes (no clip plane) ---
  float backNearest = clipOffset + firstHit.a;
  float depthFactor = 0.3;
  // Overlay pass
  if (textureSize(overlay, 0).x > 2) {
    RayResult result = rayMarchPass(overlay, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination);
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor);
  }
  // PAQD pass (raw data with GPU-side LUT lookup + easing)
  if (textureSize(paqd, 0).x > 2) {
    RayResult result = rayMarchPaqd(paqd, paqdLut, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination, paqdUniforms);
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor);
  }
  // Drawing pass (nearest-neighbor sampling — NEAREST filter set by CPU)
  if (textureSize(drawing, 0).x > 2) {
    RayResult result = rayMarchPass(drawing, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination);
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor);
  }
  // Final output
  if (colAcc.a <= 0.001) {
    discard;
  }
  FragColor = vec4(colAcc.rgb, colAcc.a / earlyTermination);
  gl_FragDepth = fragDepth;
}
`
