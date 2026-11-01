/**
 * GLSL of VOLUME_RENDER_MODE.CINEMATIC (gl/cinematic.ts), ported statement for
 * statement from wgpu/cinematic*.wgsl. Compute passes become fragment passes:
 * the 3D prep passes draw one fullscreen triangle per output layer, the march
 * one per tile. Uniform blocks use the std140 layouts packed by
 * view/NVCinematic.ts (the same layouts as the WGSL structs).
 */

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp usampler3D;
`

/** Fullscreen triangle; prep passes and the march cover their viewport. */
export const cinematicVertexShader = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// wgpu/cinematicCommon.wgsl. Prepended to the march and extinction passes so
// primary rays and shadows classify identically. tf = (huMin, huMax, gMax
// HU/mm, refStep mm).
const common = `${header}
uniform sampler2D matTable;

vec2 tfUV(float hu, float g, vec4 tf) {
  float x = clamp((hu - tf.x) / (tf.y - tf.x), 0.0, 1.0);
  float y = sqrt(clamp(g / tf.z, 0.0, 1.0));
  return vec2(x * (255.0 / 256.0) + (0.5 / 256.0), y * (63.0 / 64.0) + (0.5 / 64.0));
}

const uint HIDDEN_LABEL = 255u;

vec4 material(uint i) {
  return texelFetch(matTable, ivec2(int(i), 0), 0);
}

float labelAlpha(uint id, float hu) {
  if (id == HIDDEN_LABEL) { return 0.0; }
  vec4 ramp = material(2u * id + 1u);
  return material(2u * id).a * smoothstep(ramp.x, ramp.y, hu);
}

float classifyAlpha(uint id, float tfA, float hu, vec4 info) {
  if (info.x < 0.5) { return tfA; }
  if (id == 0u) { return tfA * info.y; }
  if (info.z > 0.0) { return tfA * material(2u * id).a; }
  return labelAlpha(id, hu);
}

float extinction(float a, float refStep) {
  return -log(1.0 - min(a, 0.9999)) / refStep;
}
`

/** wgpu/cinematicGradient.wgsl: 3D Sobel of HU into layer \`layer\`. */
export const cinematicGradientShader = `${header}
uniform sampler3D huTex;
uniform int layer;
out vec4 outColor;

float hu(ivec3 p, ivec3 dims) {
  return texelFetch(huTex, clamp(p, ivec3(0), dims - 1), 0).r;
}

void main() {
  ivec3 dims = textureSize(huTex, 0);
  ivec3 p = ivec3(ivec2(gl_FragCoord.xy), layer);
  vec3 g = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      float w = float((2 - abs(j)) * (2 - abs(k)));
      g.x += w * (hu(p + ivec3(1, j, k), dims) - hu(p + ivec3(-1, j, k), dims));
      g.y += w * (hu(p + ivec3(j, 1, k), dims) - hu(p + ivec3(j, -1, k), dims));
      g.z += w * (hu(p + ivec3(j, k, 1), dims) - hu(p + ivec3(j, k, -1), dims));
    }
  }
  outColor = vec4(g / 32.0, 0.0);
}`

/** wgpu/cinematicExtinction.wgsl: half-resolution extinction, level 0. */
export const cinematicExtinctionShader = `${common}
layout(std140) uniform ExtParams {
  mat4 gradToMM;
  vec4 tf;
  vec4 labelInfo;
} E;
uniform sampler3D huTex;
uniform sampler3D gradTex;
uniform sampler2D tfColor;
uniform usampler3D matTex;
uniform int layer;
out vec4 outColor;

void main() {
  ivec3 q = ivec3(ivec2(gl_FragCoord.xy), layer);
  ivec3 dims = textureSize(huTex, 0);
  mat3 toMM = mat3(E.gradToMM);
  float sigma = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 p = clamp(2 * q + ivec3(i & 1, (i >> 1) & 1, i >> 2), ivec3(0), dims - 1);
    float hu = texelFetch(huTex, p, 0).r;
    float g = length(toMM * texelFetch(gradTex, p, 0).xyz);
    float a = textureLod(tfColor, tfUV(hu, g, E.tf), 0.0).a;
    uint id = E.labelInfo.x > 0.5 ? texelFetch(matTex, p, 0).r : 0u;
    a = classifyAlpha(id, a, hu, E.labelInfo);
    sigma += extinction(a, E.tf.w);
  }
  outColor = vec4(sigma * 0.125, 0.0, 0.0, 0.0);
}`

/**
 * wgpu/cinematicDownsample.wgsl: one mip level. The caller restricts \`src\`
 * to the previous level (base = max level), so level 0 here is that level and
 * sampling it while rendering the next is not a feedback loop.
 */
export const cinematicDownsampleShader = `${header}
uniform sampler3D src;
uniform int layer;
out vec4 outColor;

void main() {
  ivec3 q = ivec3(ivec2(gl_FragCoord.xy), layer);
  ivec3 srcDims = textureSize(src, 0);
  ivec3 last = srcDims - 1;
  ivec3 taps = ivec3(2) + (srcDims & ivec3(1));
  float sum = 0.0;
  for (int z = 0; z < taps.z; z++) {
    for (int y = 0; y < taps.y; y++) {
      for (int x = 0; x < taps.x; x++) {
        sum += texelFetch(src, min(2 * q + ivec3(x, y, z), last), 0).r;
      }
    }
  }
  outColor = vec4(sum / float(taps.x * taps.y * taps.z), 0.0, 0.0, 0.0);
}`

/**
 * wgpu/cinematic.wgsl: one progressive frame of one tile. Writes this frame's
 * sample (blended into the running mean by the caller) and, on frame 0, the
 * first hit's depth to the second target.
 */
export const cinematicMarchShader = `${common}
layout(std140) uniform Params {
  mat4 mm2frac;
  mat4 gradToMM;
  mat4 invMVP;
  vec4 view;
  vec4 light;
  vec4 tf;
  vec4 march;
  vec4 ao;
  vec4 ext;
  vec4 clip[6];
  vec4 clipN[6];
  vec4 clipInfo;
  vec4 labelInfo;
  vec4 overlayInfo;
  vec4 lighting;
} P;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
uniform sampler3D huTex;
uniform sampler3D gradTex;
uniform sampler2D tfColor;
uniform sampler2D tfMat;
uniform sampler2D tfMaxA;
uniform sampler3D extTex;
uniform sampler3D overlayTex;
uniform usampler3D matTex;
layout(location = 0) out vec4 accumOut;
layout(location = 1) out float depthOut;

uint rng;

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

float rand() {
  rng = pcg(rng);
  return float(rng) * (1.0 / 4294967296.0);
}

vec3 gradMM(vec3 pf) {
  vec3 gv = textureLod(gradTex, pf, 0.0).xyz;
  return mat3(P.gradToMM) * gv;
}

float stepAlpha(float a, float stepMM) {
  return 1.0 - exp(-extinction(a, P.tf.w) * stepMM);
}

bool inBox(vec3 p) {
  return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0)));
}

bool isVisible(vec3 p) {
  int count = int(P.clipInfo.x);
  if (count == 0) { return true; }
  bool inAll = true;
  for (int i = 0; i < count; i++) {
    inAll = inAll && (dot(P.clip[i].xyz, p) - P.clip[i].w >= 0.0);
  }
  return inAll != (P.clipInfo.y > 0.5);
}

float coneTransmittance(vec3 pf, vec3 dirMM, float tanHalf, float maxMM) {
  vec3 df = (P.mm2frac * vec4(dirMM, 0.0)).xyz;
  float base = P.ext.x;
  float t = base * (0.5 + 0.5 * rand());
  float tau = 0.0;
  for (int i = 0; i < 128; i++) {
    if (t > maxMM) { break; }
    vec3 p = pf + df * t;
    if (!inBox(p)) { break; }
    float diam = max(base, 2.0 * t * tanHalf);
    float dt = 0.5 * diam;
    if (isVisible(p)) {
      tau += textureLod(extTex, p, log2(diam / base)).r * dt;
    }
    if (tau > 6.0) { break; }
    t += dt;
  }
  return exp(-tau);
}

uint materialId(vec3 pf) {
  ivec3 dims = textureSize(matTex, 0);
  vec3 jitter = vec3(rand(), rand(), rand()) - 0.5;
  ivec3 v = clamp(ivec3(floor(pf * vec3(dims) + jitter)), ivec3(0), dims - 1);
  return texelFetch(matTex, v, 0).r;
}

mat3 orthoBasis(vec3 n) {
  vec3 a = abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, n));
  return mat3(t, cross(n, t), n);
}

vec3 sampleCosineHemisphere(vec3 n) {
  float r = sqrt(rand());
  float phi = 6.2831853 * rand();
  return orthoBasis(n) * vec3(r * cos(phi), r * sin(phi), sqrt(max(1.0 - r * r, 0.0)));
}

vec3 srgbToLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

vec3 secondaryLoss(vec3 lift, vec3 n, vec3 A, vec3 B) {
  float shadow = 1.0;
  if (P.march.z > 0.0 && any(greaterThan(B, vec3(0.0)))) {
    shadow = mix(1.0, coneTransmittance(lift, P.light.xyz, P.light.w, 1e5), P.march.z);
  }
  float occl = 1.0;
  if (P.ao.x > 0.0) {
    vec3 aoDir = sampleCosineHemisphere(n);
    occl = mix(1.0, coneTransmittance(lift, aoDir, P.ext.w, P.ao.y), P.ao.x);
  }
  return A * (1.0 - occl) + B * (1.0 - shadow);
}

void main() {
  vec2 res = P.view.xy;
  uvec2 gid = uvec2(gl_FragCoord.xy);
  uint frame = uint(P.march.y);
  rng = pcg(gid.x + pcg(gid.y + pcg(frame)));

  vec2 jitter = vec2(rand(), rand());
  // gl_FragCoord is bottom-up, so unlike WGSL there is no y flip.
  vec2 ndc = ((vec2(gid) + jitter) / res) * 2.0 - 1.0;
  // Unproject GL's NDC depth range (-1..1), whatever the projection's own
  // convention: t / |far - near| is then the window depth gl_FragDepth takes.
  vec4 nearW = P.invMVP * vec4(ndc, -1.0, 1.0);
  vec4 farW = P.invMVP * vec4(ndc, 1.0, 1.0);
  vec3 origin = nearW.xyz / nearW.w;
  vec3 farMM = farW.xyz / farW.w;
  vec3 dir = normalize(farMM - origin);
  float depthPerMM = 1.0 / max(length(farMM - origin), 1e-6);
  float depth = 1.0;

  vec3 ro = (P.mm2frac * vec4(origin, 1.0)).xyz;
  vec3 df = (P.mm2frac * vec4(dir, 0.0)).xyz;
  vec3 inv = 1.0 / df;
  vec3 ta = (vec3(0.0) - ro) * inv;
  vec3 tb = (vec3(1.0) - ro) * inv;
  float tNear = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), max(min(ta.z, tb.z), 0.0));
  float tFar = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  float rayNear = tNear;
  float rayFar = tFar;

  float clipLo = -1e30;
  float clipHi = 1e30;
  vec3 loN = vec3(0.0);
  vec3 hiN = vec3(0.0);
  for (int i = 0; i < int(P.clipInfo.x); i++) {
    float f0 = dot(P.clip[i].xyz, ro) - P.clip[i].w;
    float fd = dot(P.clip[i].xyz, df);
    if (abs(fd) < 1e-8) {
      if (f0 < 0.0) { clipHi = -1e30; }
      continue;
    }
    float tc = -f0 / fd;
    if (fd > 0.0 && tc > clipLo) { clipLo = tc; loN = P.clipN[i].xyz; }
    if (fd < 0.0 && tc < clipHi) { clipHi = tc; hiN = P.clipN[i].xyz; }
  }
  bool isCutaway = P.clipInfo.y > 0.5 && P.clipInfo.x > 0.5;
  float faceT = -1e30;
  vec3 faceN = vec3(0.0);
  if (!isCutaway) {
    if (clipLo > tNear) { faceT = clipLo; faceN = loN; }
    tNear = max(tNear, clipLo);
    tFar = min(tFar, clipHi);
  } else if (clipLo < clipHi) {
    faceT = clipHi;
    faceN = hiN;
  }

  float stepMM = P.march.x;
  float ambient = P.march.w;
  float lightI = P.ao.z;
  float shininess = P.ao.w;
  float volTerm = P.view.z;

  // A hidden background marches no anatomy; overlays below still draw.
  if (P.labelInfo.w < 0.5) { tFar = tNear; }
  vec4 acc = vec4(0.0);
  float prevMag = 0.0;
  vec3 prevN = vec3(0.0);
  vec3 L = P.light.xyz;
  bool isStochastic = P.lighting.x > 0.5;
  float pickSum = 0.0;
  float pickLum = 0.0;
  vec3 pickLift = vec3(0.0);
  vec3 pickN = vec3(0.0);
  vec3 pickA = vec3(0.0);
  vec3 pickB = vec3(0.0);
  float rayJitter = rand();
  float t = tNear + stepMM * rayJitter;
  for (int i = 0; i < 8192; i++) {
    if (isCutaway && t >= clipLo && t < clipHi) {
      t += ceil((clipHi - t) / stepMM) * stepMM;
    }
    if (t >= tFar) { break; }
    float tSample = t;
    vec3 pf = ro + df * t;
    t += stepMM;
    bool onCut = tSample >= faceT && tSample - faceT < 1.5 * P.tf.w;
    float hu = textureLod(huTex, pf, 0.0).r;
    float x = tfUV(hu, 0.0, P.tf).x;
    bool isLabelOn = P.labelInfo.x > 0.5;
    uint id = 0u;
    if (isLabelOn) { id = materialId(pf); }
    float maxA = textureLod(tfMaxA, vec2(x, 0.5), 0.0).r;
    if (classifyAlpha(id, maxA, hu, P.labelInfo) < 0.001) {
      prevMag = 0.0;
      if (textureLod(extTex, pf, P.ext.y).r <= 0.0) { t += P.ext.z; }
      continue;
    }
    vec3 g = gradMM(pf);
    float mag = length(g);
    vec2 uv = tfUV(hu, onCut ? P.tf.z : mag, P.tf);
    vec4 m = textureLod(tfMat, uv, 0.0);
    vec4 c = textureLod(tfColor, uv, 0.0);
    float specular = m.r;
    float surfBase = m.g;
    c.a = classifyAlpha(id, c.a, hu, P.labelInfo);
    if (id != 0u && P.labelInfo.z > 0.0) {
      c = vec4(mix(c.rgb, material(2u * id).rgb, P.labelInfo.z), c.a);
    } else if (id != 0u) {
      c = vec4(material(2u * id).rgb, c.a);
      vec4 mat = material(2u * id + 1u);
      surfBase = max(m.g, mat.w);
      specular = mat.z * surfBase;
    }
    if (depth >= 1.0 && c.a >= 0.01) { depth = tSample * depthPerMM; }
    float a = stepAlpha(c.a, stepMM);
    if (a < 0.0005) {
      prevMag = 0.0;
      continue;
    }
    vec3 n = -g / max(mag, 1e-6);
    if (mag < prevMag) { n = prevN; }
    if (onCut) { n = faceN; }
    prevMag = mag;
    prevN = n;
    if (dot(n, dir) > 0.0) { n = -n; }

    float spec = specular * P.view.w;
    float surf = onCut ? 1.0 : surfBase;
    float weight = (1.0 - acc.a) * a;
    vec3 albedo = srgbToLinear(c.rgb);
    float ndl = max(dot(n, L), 0.0);
    float diffuse = mix(volTerm, ndl, surf);
    vec3 h = normalize(L - dir);
    float sp = spec * pow(max(dot(n, h), 0.0), shininess) * step(0.0, dot(n, L));
    vec3 A = albedo * ambient;
    vec3 B = albedo * (lightI * diffuse) + vec3(lightI * sp);
    if (onCut) {
      A = albedo * 0.6;
      B = vec3(0.0);
    }
    vec3 lift = pf + (P.mm2frac * vec4(n * (1.5 * P.ext.x), 0.0)).xyz;
    acc += vec4((A + B) * weight, weight);
    if (isStochastic) {
      float lum = dot(A + B, LUMA) + 1e-6;
      pickSum += weight * lum;
      if (rand() * pickSum < weight * lum) {
        pickLum = lum;
        pickLift = lift;
        pickN = n;
        pickA = A;
        pickB = B;
      }
    } else if (weight > 0.002) {
      acc = vec4(acc.rgb - weight * secondaryLoss(lift, n, A, B), acc.a);
    }
    if (acc.a > 0.995) { break; }
  }
  if (pickSum > 0.0) {
    acc = vec4(acc.rgb - (pickSum / pickLum) * secondaryLoss(pickLift, pickN, pickA, pickB), acc.a);
  }
  // Standard overlay texture and depth-aware mix; mirrors cinematic.wgsl.
  if (P.overlayInfo.x > 0.5) {
    float overlayStep = max(stepMM, P.tf.w);
    float overlayVoxels = overlayStep * length(df * vec3(textureSize(overlayTex, 0)));
    float start = rayNear + overlayStep * rayJitter;
    float overlayT = start;
    float fastStep = 1.9 * overlayStep;
    for (int i = 0; i < 8192 && overlayT < rayFar; i++) {
      vec3 p = ro + df * overlayT;
      if ((P.overlayInfo.y < 0.5 || isVisible(p)) && textureLod(overlayTex, p, 0.0).a >= 0.01) { break; }
      overlayT += fastStep;
    }
    overlayT = start + max(0.0, floor((overlayT - fastStep - start) / overlayStep)) * overlayStep;
    vec4 overlay = vec4(0.0);
    float first = 1e30;
    float farthest = 0.0;
    for (int i = 0; i < 8192 && overlayT < rayFar; i++) {
      vec3 p = ro + df * overlayT;
      if (P.overlayInfo.y < 0.5 || isVisible(p)) {
        vec4 c = textureLod(overlayTex, p, 0.0);
        if (c.a >= 0.01) {
          first = min(first, overlayT);
          farthest = overlayT;
          // Correct per overlay voxel crossed along the ray, like the classic
          // renderer; the anatomy's refStep (smallest voxel edge) would
          // over-darken thick-slice axes.
          float a = P.overlayInfo.w > 0.5 ? 1.0 - pow(1.0 - min(c.a, 0.9999), overlayVoxels) : c.a;
          vec3 rgb = srgbToLinear(pow(c.rgb, vec3(P.overlayInfo.z)));
          overlay += (1.0 - overlay.a) * vec4(rgb * a, a);
          if (overlay.a > 0.995) { break; }
        }
      }
      overlayT += overlayStep;
    }
    if (overlay.a > 0.001) {
      float amount = overlay.a;
      float behind = max(0.0, farthest - depth / depthPerMM) * length(df);
      if (acc.a <= 0.0) { amount = 1.0; }
      else { amount *= 1.0 - acc.a * pow(min(behind / 0.5, 1.0), 0.3); }
      acc = vec4(mix(acc.rgb, overlay.rgb, amount), max(acc.a, overlay.a));
      depth = min(depth, first * depthPerMM);
    }
  }
  accumOut = acc;
  depthOut = depth;
}`

/**
 * wgpu/cinematicDisplay.wgsl: resolve a tile inside NiiVue's frame. The
 * accumulation already holds the mean (frames = 1). Writes the first hit's
 * depth so meshes and the crosshair drawn after it depth-test against it.
 */
export const cinematicDisplayShader = `${header}
layout(std140) uniform Display {
  vec2 res;
  float frames;
  float exposure;
  vec4 bg;
  vec4 origin; // xy: tile viewport origin, GL window px (bottom-left)
} D;
uniform sampler2D accum;
uniform sampler2D depthIn;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3(0.0), vec3(1.0));
}

void main() {
  ivec2 res = ivec2(D.res);
  ivec2 p = min(ivec2(max(gl_FragCoord.xy - D.origin.xy, vec2(0.0))), res - 1);
  vec4 c = texelFetch(accum, p, 0) / max(D.frames, 1.0);
  vec3 bgLin = pow(D.bg.rgb, vec3(2.2)) * D.bg.a;
  vec3 rgb = aces(c.rgb * D.exposure) + bgLin * (1.0 - c.a);
  outColor = vec4(pow(rgb, vec3(1.0 / 2.2)), c.a + D.bg.a * (1.0 - c.a));
  gl_FragDepth = texelFetch(depthIn, p, 0).r;
}`
