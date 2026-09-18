import { fragmentPreamble, volumeVertexShader } from './volumeShaderLib'

export const vertexShader = volumeVertexShader

export const fragmentShader = `${fragmentPreamble}
// Fine-march iteration ceiling. Sized for the maximum sample rate (4) at the
// old one-sample-per-voxel budget of 2048 steps; every loop exits on ray length
// long before this, so the ceiling costs nothing at the common rates.
const int MAX_FINE_STEPS = 8192;

// Step-size opacity correction 1 - (1 - a)^e. e is 1 / sampleRate for every
// full sample, so the common rates skip pow(). Mirrored in wgpu/render.wgsl.
float stepCorrectAlpha(float a, float e) {
  if (abs(e - 1.0) < 1e-4) return a;
  if (abs(e - 0.5) < 1e-4) return 1.0 - sqrt(1.0 - a);
  return 1.0 - pow(1.0 - a, e);
}

uniform mat4 normMtx;
uniform float gradientAmount;
uniform float numVolumes;  // number of loaded volumes (1 = no overlay, 2+ = has overlay)
// 1.0 when this draw is an independent hi-res overlay chunk cube (skip the
// clip-surface/AO/matcap base treatment, composite as a translucent layer);
// 0.0 for normal base/non-chunked draws. (Formerly the unused numPaqd.)
uniform float overlayLayerMode;
// Cross-fade weight in [0,1] for a streaming chunk: the final premultiplied
// color is multiplied by this so a freshly-resident fine chunk dissolves in
// over the coarse floor instead of popping. 1.0 for every non-fading draw.
uniform float fadeAlpha;
// Volume render mode: 0 = composite (OVER), 1 = maximum-intensity projection.
uniform float renderMode;
uniform float earlyTermination;
// Per-brick source-level voxel dims for the ray-step density (multi-LOD). Equals
// volumeTexDimsFull for single-level/non-chunked draws.
uniform vec3 rayStepTexVox;
// Samples per voxel along the ray in the fine march. Values above 1 oversample
// and converge the ray integral. This does NOT remove concentric "wood grain"
// banding on smooth structures: measured relative ring contrast is flat from 1
// to 4, because the banding is in the integrand rather than in how densely the
// ray samples it. Keep it for integral accuracy, not as an anti-banding knob.
uniform float rayVoxSampleRate;
// 0 = hardware trilinear, 1 = tricubic B-spline reconstruction in the background
// fine pass (mirrored in wgpu/volumeShaderLib.ts + wgpu/render.wgsl). Trilinear is
// only C0, so its slope creases show as a blocky texel staircase along band edges;
// the cubic filter is C2 and removes that. It does not touch the wood-grain rings,
// which survive a C2 reconstruction unchanged.
uniform float cubicFilter;
// Display gamma exponent for the classified RGB (alpha untouched, so the ray's
// occlusion is unchanged). Already inverted on the CPU: the shader does
// pow(rgb, invGamma), where invGamma = 1 / scene.gamma, so gamma > 1 brightens.
// 1.0 is a strict no-op. Mirrors invGamma in wgpu/volumeShaderLib.ts.
uniform float invGamma;
// Multiplier on this brick's step-size opacity exponent, compensating the fact
// that a coarse voxel is not homogeneous (so its true transmittance is lower
// than the homogeneous approximation the step correction assumes). 1.0 is a
// strict no-op and is the default. Mirrors lodOpacityScale in
// wgpu/volumeShaderLib.ts.
uniform float lodOpacityScale;
// The background volume's own \`opacity\`, scaling every background sample's
// alpha. The 2D slice shader honours it as a plain uniform. Here a single
// full-volume draw scales the ACCUMULATED premultiplied result once, after the
// background block: per-sample alpha is an absorption coefficient, so scaling
// it barely moves a ray that saturates anyway, which left the volume opaque for
// every value above the 1/255 early-out. Scaling the accumulation gives the
// linear fade the 2D tiles have, and leaves the depth write and the
// clip-surface shading opacity-independent (as pre-1.0 did). Chunked draws
// cannot do this -- their per-chunk fragments composite with OVER, which is not
// linear in this factor -- so they still scale each sample. Overlays do not use
// it at all: their opacity is baked into the overlay texture's alpha by the
// orient pass. 1.0 is the default and a strict no-op. Mirrors backOpacity in
// wgpu/volumeShaderLib.ts.
uniform float backOpacity;
uniform vec4 clipPlaneColor;
uniform vec4 paqdUniforms;
uniform sampler2D matcap;
uniform sampler3D volumeGradient;
uniform sampler3D overlay;
uniform sampler3D paqd;
uniform sampler2D paqdLut;
uniform sampler3D drawing;
uniform sampler3D drawingLinear;
// Which stencil the overlay and drawing passes estimate their own gradient
// with (LAYER_GRAD_CENTRAL | LAYER_GRAD_BLOB | LAYER_GRAD_SOBEL8). The
// background volume reads a precomputed gradient texture and ignores this.
// Mirrors params.layerGradMode in wgpu/volumeShaderLib.ts.
uniform float layerGradMode;
// Background-volume gradient opacity and silhouette (Fresnel rim), both 0 when
// off. gradientOpacity scales each background sample's alpha by
// magnitude^(gradientOpacity*8) -- the analytic form of the old niivue's
// 192-entry LUT, which sampled exactly that function -- and silhouettePower
// scales it by (1-|dot(normal,rayDir)|)^silhouettePower with a cull above
// 1-silhouettePower. Both read the PRECOMPUTED gradient texture (rgb =
// direction, a = magnitude), so they apply to the background pass only. Mirror
// params.gradientOpacity / params.silhouettePower in wgpu/volumeShaderLib.ts.
uniform float gradientOpacity;
uniform float silhouettePower;

// In-shader layer-gradient constants, used by the overlay and drawing passes
// (neither has a precomputed gradient texture the way the background does).
//
// Three estimators, selected at runtime by the layerGradMode uniform, which the
// controller drives through volumeLayerGradientMode / LAYER_GRADIENT_MODE:
//   0 CENTRAL  the legacy 6-tap central difference at a hand-tuned offset
//   1 BLOB     the Gaussian-blob derivative (see layerGradBlob)
//   2 SOBEL8   the 8-corner Sobel the old niivue precomputes with
//
// The rest are shader authoring choices rather than runtime knobs. SIGMA is the
// width, in voxels, of the Gaussian blob the layer is reconstructed with; it is
// the only knob for mode 1, since both tap radii and their weights derive from
// it. DIAGONALS adds the four body-diagonal directions to the three axes (mode
// 1 only). OFFSET is used by mode 0 only, and its non-integer value exploits
// the LINEAR sampler — each tap is a trilinear blend of 8 texels, giving a
// Gaussian-like smoothing for free. EPSILON is the magnitude below which the
// gradient is too small to normalize reliably.
//
// Mirrors the LAYER_GRAD_* block in wgpu/render.wgsl — keep the two in step.
const int LAYER_GRAD_CENTRAL = 0;
const int LAYER_GRAD_BLOB = 1;
const int LAYER_GRAD_SOBEL8 = 2;
const float LAYER_GRAD_SIGMA = 1.0;
const bool LAYER_GRAD_DIAGONALS = true;
const float LAYER_GRAD_OFFSET = 1.5;
const float LAYER_GRAD_EPSILON = 1e-6;
// Weighted scalar projection of a layer's RGBA → f32. Luminance weights on
// RGB distinguish distinct label/channel colors; heavy alpha weight (2.0) makes
// background→layer transitions dominate. Switched from length(rgba) which
// missed label-to-label boundaries when two labels had similar-magnitude
// RGBA vectors (common when labels share alpha=255 and differ only in hue).
float layerScalar(vec4 c) {
  return dot(c, vec4(0.299, 0.587, 0.114, 2.0));
}

// Central difference of tex along one antipodal pair. off is a half-offset in
// full-volume [0,1] units, so the stencil width stays correct for a chunked
// layer (chunk texDims differ from the full volume); chunkTexCoord then maps
// each tap into the chunk texture. Sign: value(+dir) - value(-dir), matching
// the precomputed volume gradient's inward-pointing normals.
float layerPairDiff(sampler3D tex, vec3 p, vec3 off) {
  float a = layerScalar(texture(tex, chunkTexCoord(p + off)));
  float b = layerScalar(texture(tex, chunkTexCoord(p - off)));
  return a - b;
}

// Radial envelope of a Gaussian's derivative. For g(r) = exp(-r^2 / (2 s^2)),
// grad g = -(r / s^2) g(r), so the magnitude goes as r * g(r). The 1 / s^2 is a
// common factor over every direction and the result is normalized, so it is
// dropped. Peaks at r == s, which is where the diagonal shell samples.
float blobWeight(float r, float s) {
  return r * exp(-(r * r) / (2.0 * s * s));
}

// Legacy estimator: a 6-tap central difference at a hand-tuned 1.5-voxel
// offset — three axes, no diagonals. The default, and what NiiVue has always
// drawn.
vec3 layerGradCentral(sampler3D tex, vec3 p) {
  vec3 dv = LAYER_GRAD_OFFSET / volumeTexDimsFull;
  return vec3(
    layerPairDiff(tex, p, vec3(dv.x, 0.0, 0.0)),
    layerPairDiff(tex, p, vec3(0.0, dv.y, 0.0)),
    layerPairDiff(tex, p, vec3(0.0, 0.0, dv.z)));
}

// Gaussian-blob gradient. Treat the layer as a sum of radially symmetric
// Gaussian basis functions rather than a lattice of point samples. That
// reconstruction differentiates analytically — d(f * g) = f * dg — so the
// gradient of the smoothed field is a radially weighted sum of directional
// central differences, with no finite-difference stencil left to hand-tune.
// Every tap radius and weight falls out of LAYER_GRAD_SIGMA. Two shells: the
// axes (whose two same-sign DoG taps at 1 and 2 voxels fold into ONE linear
// fetch, so they cost what the central difference did) and the body diagonals
// (which do not fold, and which buy the isotropy). See the full derivation in
// the layerGradBlob comment in wgpu/render.wgsl.
vec3 layerGradBlob(sampler3D tex, vec3 p) {
  float s = LAYER_GRAD_SIGMA;
  // One voxel in full-volume [0,1] units. Componentwise, so a voxel-space
  // direction stays that direction after the anisotropic texture scaling.
  vec3 vox = 1.0 / volumeTexDimsFull;

  float w1 = blobWeight(1.0, s);
  float w2 = blobWeight(2.0, s);
  float rAx = (w1 + 2.0 * w2) / (w1 + w2);
  float kAx = (w1 + w2) / rAx;
  vec3 ax = rAx * vox;
  vec3 grad = kAx * vec3(
    layerPairDiff(tex, p, vec3(ax.x, 0.0, 0.0)),
    layerPairDiff(tex, p, vec3(0.0, ax.y, 0.0)),
    layerPairDiff(tex, p, vec3(0.0, 0.0, ax.z)));

  if (LAYER_GRAD_DIAGONALS) {
    float rDg = s;
    float kDg = blobWeight(rDg, s) / rDg;
    float u = 1.0 / sqrt(3.0);
    vec3 d0 = vec3(u, u, u);
    vec3 d1 = vec3(u, u, -u);
    vec3 d2 = vec3(u, -u, u);
    vec3 d3 = vec3(u, -u, -u);
    vec3 dg = rDg * vox;
    grad += kDg * (
      d0 * layerPairDiff(tex, p, d0 * dg)
      + d1 * layerPairDiff(tex, p, d1 * dg)
      + d2 * layerPairDiff(tex, p, d2 * dg)
      + d3 * layerPairDiff(tex, p, d3 * dg));
  }
  return grad;
}

// The old niivue's estimator: an 8-corner Sobel, i.e. the four body-diagonal
// antipodal pairs at (+-1,+-1,+-1) voxels and no axis taps at all. The exact
// mirror of the legacy central difference, and the better half of that trade
// (0.68 vs 0.80 degrees mean angular error on an analytic sphere). Upstream it
// runs as a precompute over a 27-tap blur prepass, which this in-shader version
// does not have; see the wgpu/render.wgsl comment for what that costs.
vec3 layerGradSobel8(sampler3D tex, vec3 p) {
  vec3 vox = 1.0 / volumeTexDimsFull;
  vec3 d0 = vec3(1.0, 1.0, 1.0);
  vec3 d1 = vec3(1.0, 1.0, -1.0);
  vec3 d2 = vec3(1.0, -1.0, 1.0);
  vec3 d3 = vec3(1.0, -1.0, -1.0);
  return d0 * layerPairDiff(tex, p, d0 * vox)
    + d1 * layerPairDiff(tex, p, d1 * vox)
    + d2 * layerPairDiff(tex, p, d2 * vox)
    + d3 * layerPairDiff(tex, p, d3 * vox);
}

vec3 layerGrad(sampler3D tex, vec3 p, int mode) {
  if (mode == LAYER_GRAD_SOBEL8) { return layerGradSobel8(tex, p); }
  if (mode == LAYER_GRAD_BLOB) { return layerGradBlob(tex, p); }
  return layerGradCentral(tex, p);
}

// Matcap shade factor from the layer's own gradient at p. Pass a
// LINEARLY-filtered sampler (the drawing pass uses drawingLinear, its
// nearest-filtered texture rebound with LINEAR) so each tap is a trilinear
// blend of 8 texels. Returns vec3(1.0) — no shading — when the gradient is
// degenerate.
vec3 layerShade(sampler3D tex, vec3 p, float amount) {
  vec3 grad = layerGrad(tex, p, int(layerGradMode));
  if (length(grad) <= LAYER_GRAD_EPSILON) { return vec3(1.0); }
  vec3 localNormal = normalize(grad);
  mat3 norm3 = mat3(normMtx);
  vec3 n = norm3 * localNormal;
  // Flip y for the lookup. A matcap PNG is a lit sphere whose light sits near
  // the TOP of the image, and v=0 is the image's top row (neither backend
  // flips on upload), so v must count DOWN from the eye-space +y a normal
  // pointing up produces. Without this the volume is lit from below.
  vec2 uv = vec2(n.x, -n.y) * 0.5 + 0.5;
  vec3 mc_rgb = texture(matcap, uv).rgb * (1.0 + (amount / 3.0));
  return mix(vec3(1.0), mc_rgb, amount);
}

// Display gamma on a classified colour. ALPHA IS DELIBERATELY UNTOUCHED: gamma
// is a brightness control, and raising alpha with it would change how much each
// sample occludes what is behind it (the ray would saturate sooner and the image
// would get flatter, not brighter). Mirrors applyGamma in wgpu/volumeShaderLib.ts
// -- keep the two in step.
vec3 applyGamma(vec3 rgb, float e) {
  if (e == 1.0) { return rgb; }
  return pow(max(rgb, vec3(0.0)), vec3(e));
}

// Tricubic B-spline reconstruction in 8 hardware-trilinear fetches
// (Sigg & Hadwiger, GPU Gems 2 ch. 20; Ruijters & Thevenaz formulation). The
// 4x4x4 kernel has non-negative weights only, so each opposed pair of taps
// collapses into one linear fetch at a weighted offset. Approximating, not
// interpolating: it smooths by design, which is the point here. Requires the
// texture to be LINEAR-filtered, which the orient prepass already guarantees.
//
// Support reaches 2 texels either side of the sample, so a CHUNKED volume needs
// a brick halo of at least 2 or brick faces read past their owned data and seam.
// See VolumeRenderConfig.isCubicInterpolation.
//
// coord is already in THIS texture's [0,1] space (post chunkTexCoord).
vec4 sampleTricubic(sampler3D tex, vec3 coord) {
  vec3 dims = vec3(textureSize(tex, 0));
  vec3 grid = coord * dims - 0.5;
  vec3 idx = floor(grid);
  vec3 f = grid - idx;
  vec3 g = 1.0 - f;
  vec3 w0 = (1.0 / 6.0) * g * g * g;
  vec3 w1 = 2.0 / 3.0 - 0.5 * f * f * (2.0 - f);
  vec3 w2 = 2.0 / 3.0 - 0.5 * g * g * (2.0 - g);
  vec3 w3 = (1.0 / 6.0) * f * f * f;
  vec3 s0 = w0 + w1;
  vec3 s1 = w2 + w3;
  vec3 inv = 1.0 / dims;
  vec3 h0 = inv * ((w1 / s0) - 0.5 + idx);
  vec3 h1 = inv * ((w3 / s1) + 1.5 + idx);
  vec4 c000 = texture(tex, vec3(h0.x, h0.y, h0.z));
  vec4 c100 = texture(tex, vec3(h1.x, h0.y, h0.z));
  c000 = mix(c100, c000, s0.x);
  vec4 c010 = texture(tex, vec3(h0.x, h1.y, h0.z));
  vec4 c110 = texture(tex, vec3(h1.x, h1.y, h0.z));
  c010 = mix(c110, c010, s0.x);
  c000 = mix(c010, c000, s0.y);
  vec4 c001 = texture(tex, vec3(h0.x, h0.y, h1.z));
  vec4 c101 = texture(tex, vec3(h1.x, h0.y, h1.z));
  c001 = mix(c101, c001, s0.x);
  vec4 c011 = texture(tex, vec3(h0.x, h1.y, h1.z));
  vec4 c111 = texture(tex, vec3(h1.x, h1.y, h1.z));
  c011 = mix(c111, c011, s0.x);
  c001 = mix(c011, c001, s0.y);
  return mix(c001, c000, s0.z);
}

struct RayResult {
  vec4 color;
  vec4 firstHit;
  float farthest;
};

// Shared fast+fine ray-march for overlay and drawing textures. Samples are
// remapped through chunkTexCoord so a chunked layer (drawing) reads its
// per-chunk texture; for non-chunked layers chunkTexCoord is the identity.
// clipMode: 0 = ignore clip plane; 1 = solid clip (keep only [clipLo,clipHi]);
// 2 = cutaway clip (skip [clipLo,clipHi]). Lets the optional overlay passes be
// clipped with the base when clipPlaneOverlay is set, matching the background.
bool clipPassSkip(float sampleA, float clipLo, float clipHi, float clipMode) {
    if (clipMode < 0.5) { return false; }
    bool inRange = (sampleA >= clipLo) && (sampleA <= clipHi);
    if (clipMode < 1.5) { return !inRange; } // solid: drop samples outside
    return inRange;                          // cutaway: drop samples inside
}

// shadeAmount > 0 lights every accumulated sample with a matcap driven by the
// layer's own in-shader gradient (see layerShade). Volumetric rather than
// surface shading: a translucent stack (e.g. many microscopy channels) needs
// each sample lit, not just the first hit. 0 leaves the layer unshaded, which
// is both the default and the drawing pass's behaviour (it shades at first hit
// after this returns).
// mip replaces OVER-compositing with a component-wise max on the premultiplied
// sample — maximum-intensity projection. Early termination is skipped in that
// mode since the whole ray must be marched to find the maximum.
RayResult rayMarchPass(
    sampler3D tex, vec3 start, vec3 dir, float len,
    vec4 deltaDir, vec4 deltaDirFast,
    float ran, float earlyTermination,
    float clipLo, float clipHi, float clipMode,
    float shadeAmount,
    // Display-gamma exponent for this layer's classified colour. Intensity-
    // derived layers pass invGamma; the drawing layer passes 1.0, because its
    // colours are categorical label swatches, not brightness.
    float gammaExp, bool mip
) {
    RayResult result;
    result.color = vec4(0.0);
    result.firstHit = vec4(0.0, 0.0, 0.0, 2.0 * len);
    result.farthest = 0.0;

    float stepSize = deltaDir.w;
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    vec4 samplePosStart = samplePos;
    // The skip probes one stride PAST the segment end (see fastLimit in main).
    float fastLimit = len + deltaDirFast.w;

    // Fast pass
    for (int j = 0; j < 1024; j++) {
        if (samplePos.a > fastLimit) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDirFast; continue; }
        float alpha = texture(tex, chunkTexCoord(samplePos.xyz)).a;
        if (alpha >= 0.01) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a > fastLimit) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }
    // Put the fine march back on the ray's deterministic lattice; the 1.9-voxel
    // fast stride would otherwise set its phase from the depth of the first hit.
    float snapped = snapToSampleLattice(samplePos.a, ran, stepSize);
    samplePos = vec4(start + dir * snapped, snapped);

    // Fine pass
    for (int i = 0; i < MAX_FINE_STEPS; i++) {
        if (samplePos.a > len) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDir; continue; }
        vec4 colorSample = texture(tex, chunkTexCoord(samplePos.xyz));
        if (colorSample.a >= 0.01) {
            if (result.firstHit.a > len) {
                result.firstHit = samplePos;
            }
            result.farthest = samplePos.a;
            vec3 rgb = applyGamma(colorSample.rgb, gammaExp);
            if (shadeAmount > 0.0) {
                // colorSample.rgb is straight (non-premultiplied) here, so
                // clamping the lit colour to 1.0 keeps the premultiplied
                // product below alpha once it is multiplied in.
                rgb = min(rgb * layerShade(tex, samplePos.xyz, shadeAmount), vec3(1.0));
            }
            vec4 premultiplied = vec4(rgb * colorSample.a, colorSample.a);
            if (mip) {
                result.color = max(result.color, premultiplied);
            } else {
                result.color = (1.0 - result.color.a) * premultiplied + result.color;
                if (result.color.a > earlyTermination) { break; }
            }
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
    vec4 paqdUni,
    float clipLo, float clipHi, float clipMode,
    bool mip
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
    // The skip probes one stride PAST the segment end (see fastLimit in main).
    float fastLimit = len + deltaDirFast.w;

    // Fast pass: skip until prob1 > easing threshold t0
    float t0 = paqdUni[0];
    for (int j = 0; j < 1024; j++) {
        if (samplePos.a > fastLimit) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDirFast; continue; }
        // chunkTexCoord remaps into the per-chunk PAQD texture (identity when not chunked).
        ivec3 coord = clamp(ivec3(chunkTexCoord(samplePos.xyz) * texDimsF), ivec3(0), texDims - 1);
        vec4 raw = texelFetch(tex, coord, 0);
        if (raw.b > t0) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a > fastLimit) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }
    // Put the fine march back on the ray's deterministic lattice; the 1.9-voxel
    // fast stride would otherwise set its phase from the depth of the first hit.
    float snapped = snapToSampleLattice(samplePos.a, ran, stepSize);
    samplePos = vec4(start + dir * snapped, snapped);

    // Fine pass: decode and accumulate PAQD colors
    for (int i = 0; i < MAX_FINE_STEPS; i++) {
        if (samplePos.a > len) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDir; continue; }
        ivec3 coord = clamp(ivec3(chunkTexCoord(samplePos.xyz) * texDimsF), ivec3(0), texDims - 1);
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
                if (mip) {
                    result.color = max(result.color, premultiplied);
                } else {
                    result.color = (1.0 - result.color.a) * premultiplied + result.color;
                    if (result.color.a > earlyTermination) { break; }
                }
            }
        }
        samplePos += deltaDir;
    }
    return result;
}

// Depth-aware mixing of a ray-march result into the accumulated color.
void depthAwareMix(
    inout vec4 colAcc, RayResult result,
    float backNearest, inout float fragDepth, float depthFactor,
    bool mip
) {
    if (result.color.a <= 0.001) { return; }
    // Maximum projection: the layers combine by the same max operation that
    // built each layer's own accumulation, so depth-weighted mixing (which
    // assumes OVER) does not apply. Depth still tracks the nearest hit.
    if (mip) {
        colAcc = max(colAcc, result.color);
        fragDepth = min(fragDepth, frac2ndc(result.firstHit.xyz));
        return;
    }
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
  vec3 rayStart = vColor;
  vec3 start = GetFrontPosition(rayStart);
  vec3 backPosition = GetBackPosition(rayStart);
  vec3 dirVec = backPosition - start;
  float len = length(dirVec);
  if (!(len > 0.0) || len > 3.0) {
    discard;
  }
  vec3 dir = dirVec / len;
  // Step size is per-voxel of this brick's source level (rayStepTexVox); equals
  // volumeTexDimsFull for non-chunked/single-level draws, coarser for multi-LOD
  // bricks so each steps at its own resolution. rayVoxSampleRate subdivides that
  // step further to keep the march above the reconstruction's Nyquist rate.
  vec3 texVox = rayStepTexVox * max(rayVoxSampleRate, 1.0);
  float lenVox = length(dirVec * texVox);
  if (lenVox < 0.5) {
    discard;
  }
  // Opacity (step-size) correction: a coarse multi-LOD brick takes fewer samples
  // along the ray, so without this it accumulates less alpha and renders dimmer —
  // a brightness seam at LOD boundaries. Rescale per-sample alpha to a fixed
  // reference density, the finest level at one sample per voxel, so brightness is
  // independent of both the brick's level and rayVoxSampleRate.
  float fineLenVox = length(dirVec * volumeTexDimsFull);
  // refPerLen converts a ray-length thickness into reference steps (the finest
  // level at one sample per voxel). A coarse multi-LOD brick owns longer slabs
  // and needs its alpha scaled up; oversampling owns shorter ones and needs it
  // scaled down. Both directions are correct, so this is not clamped -- only
  // guarded away from zero for the pow() below.
  float refPerLen = max(fineLenVox, 1e-6) / max(len, 1e-6);
  // Save original ray for overlay passes (overlay ignores clip planes)
  vec3 origStart = start;
  float origLen = len;
  // Handle clip plane color (negative alpha means color plane is inside volume)
  vec4 clipPlaneColorX = clipPlaneColor;
  if (clipPlaneColorX.a < 0.0) {
    clipPlaneColorX.a = 0.0;
  }
  bool chunkedDraw = CHUNKED && any(lessThan(chunkSubSize, vec3(0.999)));
  // Independent hi-res overlay cube draw: composite as a flat translucent layer
  // over the base. Skip the opaque clip-surface treatment (AO, clip plane
  // colour) and matcap lighting; still respect clip-plane ray trimming.
  bool overlayMode = CHUNKED && overlayLayerMode > 0.5;
  // Maximum-intensity projection: every pass takes a component-wise max of the
  // premultiplied sample instead of compositing OVER, and no pass may early-
  // terminate (the maximum can lie anywhere along the ray).
  bool mip = IS_MIP && renderMode > 0.5;
  float stepSize = len / lenVox;
  vec4 deltaDir = vec4(dir * stepSize, stepSize);
  float localGradientAmount = overlayMode ? 0.0 : gradientAmount;
  vec2 sampleRange = vec2(0.0, len);
  bool cutaway = IS_CUTAWAY && isClipCutaway > 0.5;
  bool hasClip = false;
  if (HAS_CLIP) {
    for (int i = 0; i < MAX_CLIP_PLANES; i++) {
      clipSampleRange(dir, vec4(start, 0.0), clipPlanes[i], sampleRange, hasClip);
    }
  }
  bool isClip = HAS_CLIP && ((sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0)));
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
  // A fully transparent background contributes no colour, so marching it would
  // only cost time and still claim the depth buffer and the clip surface.
  if (backOpacity < (1.0 / 255.0)) {
    skipBackground = true;
  }
  // Shared values for all passes. Keep samples on a centered full-volume
  // lattice so adjacent chunks do not reset the ray phase at their seams.
  float origRan = raySamplePhase(origStart, stepSize);
  float ran = origRan;
  float stepSizeFast = stepSize * 1.9 * max(rayVoxSampleRate, 1.0);
  vec4 deltaDirFast = vec4(dir * stepSizeFast, stepSizeFast);
  float localEarlyTermination = chunkedDraw ? 1.0 : earlyTermination;
  // --- Background passes ---
  vec4 colAcc = vec4(0.0);
  vec4 firstHit = vec4(0.0, 0.0, 0.0, 2.0 * origLen);
  bool bgHasHit = false;
  float fragDepth = 0.9999;
  float clipOffset = 0.0;
  bool clipSurfaceHit = false;
  if (!skipBackground) {
    if (!cutaway && isClip && !overlayMode) {
      clipOffset = sampleRange.x;
      start += dir * sampleRange.x;
      len = sampleRange.y - sampleRange.x;
      float alpha = texture(volume, chunkTexCoord(start.xyz)).a;
      float alpha1 = texture(volume, chunkTexCoord(start.xyz - deltaDir.xyz)).a;
      if ((alpha > 0.01) && (alpha1 > 0.01)) {
        clipSurfaceHit = true;
      }
    }
    ran = raySamplePhase(start, stepSize);
    vec4 samplePos = vec4(start + dir * (stepSize * ran), stepSize * ran);
    // --- Background Fast Pass ---
    // The skip probes one stride PAST the segment end. Without this a chunk
    // whose only material lies in the last <1 fast stride never registers a
    // hit, so the whole cube contributes nothing and its exit face draws as a
    // dark line -- the seam grid at chunk / floor-cube boundaries. Probing past
    // the face reads halo (or clamp-to-edge) texels, which is safe: it can only
    // ever cause a false HIT, and the fine march that follows is still clipped
    // to [0, len], so an over-eager probe costs a few empty samples and changes
    // no output.
    float fastLimit = len + stepSizeFast;
    vec4 samplePosStart = samplePos;
    for (int j = 0; j < 1024; j++) {
      if (samplePos.a > fastLimit) { break; }
      if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
        samplePos += deltaDirFast;
        continue;
      }
      float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;
      if (alpha >= 0.01) {
        break;
      }
      samplePos += deltaDirFast;
    }
    if (samplePos.a > fastLimit) {
      // Background fast pass found nothing — use clip plane color as fallback
      if (isClip && !chunkedDraw) {
        float clipAlpha = clipPlaneColorX.a;
        colAcc = vec4(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
      }
    } else {
      // Background fast pass found something
      if (cutaway && isClip && !overlayMode) {
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
      // Put the fine march back on the ray's deterministic lattice; the
      // 1.9-voxel fast stride would otherwise set its phase from the depth of
      // the first hit.
      float snappedBg = snapToSampleLattice(samplePos.a, ran, stepSize);
      samplePos = vec4(start + dir * snappedBg, snappedBg);
      // --- Background Fine Pass ---
      // Each sample owns the slab [bLo, bHi) it is the midpoint of, clipped to
      // this brick's segment. The slabs therefore tile [0, len] EXACTLY, so a
      // brick contributes the optical depth of the ray length it actually owns
      // no matter where its sample lattice falls. Attributing a fixed stepSize
      // per sample instead only tiles when neighbouring bricks share a lattice;
      // at a LOD interface the step-D and step-2D lattices do not nest and the
      // boundary gains or loses up to ~1.5 fine steps of material -- the bright
      // and dark seams along level boundaries.
      float bLo = (snappedBg <= stepSize) ? 0.0 : max(snappedBg - 0.5 * stepSize, 0.0);
      mat3 norm3 = mat3(normMtx);
      // Three features read the precomputed gradient texture, and NONE of them
      // is on by default. Hoisted out of the loop because all three terms are
      // uniform over the draw (localGradientAmount is settled by the fast pass
      // above), so the branch is fully coherent -- every fragment takes the
      // same side. Skipping the fetch + normalize + matcap tap when they are
      // all off measures ~20% of the render. Mirrored in wgpu/render.wgsl.
      bool needsGradient = NEEDS_GRADIENT && ((localGradientAmount > 0.0) || (gradientOpacity > 0.0) || (silhouettePower > 0.0));
      for (int fi = 0; fi < MAX_FINE_STEPS; fi++) {
        if (bLo >= len) { break; }
        // Clipped to len, so the final sample covers the trailing sliver past
        // the last lattice point; it reads into the halo, which exists for it.
        float bHi = min(samplePos.a + 0.5 * stepSize, len);
        float slab = max(bHi - bLo, 0.0);
        bLo = bHi;
        if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
          samplePos += deltaDir;
          continue;
        }
        vec3 volCoord = chunkTexCoord(samplePos.xyz);
        // Fine pass only. The fast skip pass stays trilinear: it only needs a
        // coarse alpha test, so paying 8 fetches there would be waste.
        vec4 colorSample = (CUBIC && cubicFilter > 0.5)
          ? sampleTricubic(volume, volCoord)
          : texture(volume, volCoord);
        // Chunked draws only -- see the scaling note after this block.
        if (chunkedDraw) {
          colorSample.a *= backOpacity;
        }
        if (colorSample.a >= 0.01) {
          if (!bgHasHit) {
            bgHasHit = true;
            firstHit = samplePos;
          }
          // Identity defaults, so the branch below is the only thing that has
          // to know about the gradient: a magnitude of 1 is a no-op in the
          // gradient-opacity pow(), and localNormal is read only under
          // silhouettePower > 0, which implies needsGradient.
          float gradMagnitude = 1.0;
          vec3 localNormal = vec3(0.0);
          vec3 finalRGB = applyGamma(colorSample.rgb, invGamma);
          if (needsGradient) {
            vec4 gradSample = texture(volumeGradient, volCoord);
            gradMagnitude = gradSample.a;
            // Guarded normalize: the precompute writes 0.5 (a zero vector once
            // decoded) wherever the data is flat, and normalize(0) is undefined
            // -- which would poison the matcap lookup and, below, the silhouette
            // dot. The guarded form leaves both defined.
            vec3 gradVec = gradSample.rgb * 2.0 - 1.0;
            localNormal = gradVec / max(length(gradVec), 1e-6);
            float lightingAmount = localGradientAmount;
            if (lightingAmount > 0.0) {
              vec3 n = norm3 * localNormal;
              // See layerShade() for why y is flipped: the matcap's light is at
              // the top of the PNG and v=0 is the top row, so v counts down from +y.
              vec2 uv = vec2(n.x, -n.y) * 0.5 + 0.5;
              vec3 mc_rgb = texture(matcap, uv).rgb * (1.0 + (lightingAmount / 3.0));
              finalRGB *= mix(vec3(1.0), mc_rgb, lightingAmount);
            }
          }
          // Step-size correction compensates a coarse brick's sparser sampling
          // in an OVER accumulation. A max projection reads each sample
          // independently, so correcting it would brighten coarse bricks
          // instead of matching them.
          float correctedA = mip ? colorSample.a : stepCorrectAlpha(colorSample.a, max(slab * refPerLen * lodOpacityScale, 1e-3));
          // Gradient opacity: scale alpha by the gradient magnitude raised to
          // gradientOpacity*8. This is the analytic form of the old niivue's
          // 192-entry LUT, which held exactly pow(i/191, opacity*8) -- so there
          // is no table to upload and 0 is a no-op by construction
          // (pow(m, 0) == 1) rather than by a special case. Homogeneous interior
          // has magnitude ~0 and fades out; edges keep their alpha.
          if (gradientOpacity > 0.0) {
            correctedA *= pow(gradMagnitude, gradientOpacity * 8.0);
          }
          // Silhouette: fade material whose surface faces the camera and keep
          // material seen edge-on, so a surface reads as a rim. The hard cull
          // above 1-silhouettePower is what opens the interior at higher settings.
          if (silhouettePower > 0.0) {
            float viewAlign = abs(dot(localNormal, dir));
            correctedA *= pow(1.0 - viewAlign, silhouettePower);
            if (viewAlign > 1.0 - silhouettePower) { correctedA = 0.0; }
          }
          vec4 premultiplied = vec4(finalRGB * correctedA, correctedA);
          if (mip) {
            colAcc = max(colAcc, premultiplied);
          } else {
            colAcc = (1.0 - colAcc.a) * premultiplied + colAcc;
            if (colAcc.a > localEarlyTermination) { break; }
          }
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
        if (isClip && !chunkedDraw) {
          float clipAlpha = clipPlaneColorX.a;
          colAcc = vec4(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
        }
      } else {
        fragDepth = frac2ndc(firstHit.xyz);
      }
    }
  }
  // Scale the ACCUMULATED background once, not each sample. Per-sample alpha is
  // an absorption coefficient: scaling it barely moves the accumulated alpha of
  // a ray that saturates anyway, so the volume stayed opaque for every
  // backOpacity above 1/255. colAcc is premultiplied, so this scales colour and
  // alpha together -- a linear fade, matching the pre-1.0 behaviour. Applied
  // before the overlay passes so overlays are not dimmed with the background.
  // Only for a single full-volume draw. A chunked draw emits one fragment per
  // chunk cube and those are composited with OVER, which is not linear in this
  // factor: scaling each chunk under-occludes the chunks behind it, so the fade
  // compounds with the number of chunks a ray crosses (4 chunks at 0.5 render
  // near-opaque). Chunked volumes therefore keep the per-sample behaviour until
  // the chunk cubes can be composited into a tile and scaled once.
  if (!chunkedDraw) {
    colAcc *= backOpacity;
  }
  // --- Optional passes. By default overlays ignore the clip plane (march the
  // full original ray); when clipPlaneOverlay is set they are clipped with the
  // base: solid clip keeps [sampleRange.x, sampleRange.y], cutaway skips it. ---
  float backNearest = clipOffset + firstHit.a;
  float depthFactor = 0.3;
  // Gate on hasClip (clip plane active), not isClip (chunk straddles the plane):
  // a chunked cube wholly on the removed side has sampleRange == (0,0) and
  // isClip == false, which left the overlay unclipped and leaking through the
  // clipped-away region. hasClip + the solid range covers every case.
  bool clipOverlay = (clipPlaneOverlay > 0.5) && hasClip;
  float ovClipMode = clipOverlay ? (cutaway ? 2.0 : 1.0) : 0.0;
  float ovClipLo = sampleRange.x;
  float ovClipHi = sampleRange.y;
  // Overlay pass. Overlays carry no precomputed gradient texture (the combined
  // overlay texture is rebuilt whenever any overlay changes, e.g. an opacity
  // drag, so a cached gradient would thrash), so lighting comes from the
  // in-shader stencil — per sample, since an overlay stack is translucent.
  if (HAS_OVERLAY && textureSize(overlay, 0).x > 2) {
    RayResult result = rayMarchPass(overlay, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, localEarlyTermination, ovClipLo, ovClipHi, ovClipMode, gradientAmount, invGamma, mip);
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor, mip);
  }
  // PAQD pass (raw data with GPU-side LUT lookup + easing)
  if (HAS_PAQD && textureSize(paqd, 0).x > 2) {
    RayResult result = rayMarchPaqd(paqd, paqdLut, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, localEarlyTermination, paqdUniforms, ovClipLo, ovClipHi, ovClipMode, mip);
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor, mip);
  }
  // Drawing pass (nearest-neighbor sampling — NEAREST filter set by CPU)
  if (HAS_DRAWING && textureSize(drawing, 0).x > 2) {
    RayResult result = rayMarchPass(drawing, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, localEarlyTermination, ovClipLo, ovClipHi, ovClipMode, 0.0, 1.0, mip);
    // Matcap lighting at FIRST HIT only (unlike the overlay, which shades every
    // sample): a drawing is a label mask read as an opaque surface, so one
    // shade for the whole ray is both correct and far cheaper. The gradient is
    // taken through drawingLinear — the same texture rebound with LINEAR
    // filtering, since the ray-march itself samples it NEAREST.
    if (result.color.a > 0.001 && gradientAmount > 0.0) {
      vec3 shade = layerShade(drawingLinear, result.firstHit.xyz, gradientAmount);
      // result.color is premultiplied (rgb = actualColor * alpha).
      // Clamp to alpha so the shade (which can exceed 1.0 via the matcap
      // brighten) can't push rgb > alpha and break the premultiplied-alpha
      // invariant that depthAwareMix and framebuffer blending assume.
      result.color.rgb = min(result.color.rgb * shade, vec3(result.color.a));
    }
    depthAwareMix(colAcc, result, backNearest, fragDepth, depthFactor, mip);
  }
  // Final output
  if (colAcc.a <= 0.001) {
    discard;
  }
  // Single full-volume draws can present an early-terminated ray as opaque.
  // Chunked draws must emit the true per-segment premultiplied alpha so the
  // back-to-front chunk blend reconstructs the full ray without over-occluding
  // deeper chunks.
  // A max projection never early-terminates, so a high alpha means "the
  // brightest sample was nearly opaque", not "the ray saturated". Promoting it
  // to fully opaque would throw away that modulation.
  if (chunkedDraw || mip) {
    FragColor = colAcc;
  } else if (colAcc.a >= localEarlyTermination) {
    FragColor = vec4(colAcc.rgb / colAcc.a, 1.0);
  } else {
    FragColor = colAcc;
  }
  // Cross-fade a streaming chunk in over the coarse floor (premultiplied, so
  // scaling the whole vec4 fades presence + coverage together). 1.0 = no-op.
  FragColor = FragColor * fadeAlpha;
  gl_FragDepth = fragDepth;
}
`
