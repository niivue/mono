// Render-specific functions (preamble is prepended by render.ts from volumeShaderLib)

// Fine-march iteration ceiling. Sized for the maximum sample rate (4) at the old
// one-sample-per-voxel budget of 2048 steps; every loop exits on ray length long
// before this, so the ceiling costs nothing at the common rates.
const MAX_FINE_STEPS: i32 = 8192;

// Pipeline-overridable specialization flags (see view/NVRenderVariant.ts). Each
// is ANDed with the runtime test it guards; false lets the compiler drop that
// code. The defaults give the generic shader.
override HAS_CLIP: bool = true;
override IS_CUTAWAY: bool = true;
override IS_MIP: bool = true;
override CUBIC: bool = true;
override NEEDS_GRADIENT: bool = true;
override HAS_OVERLAY: bool = true;
override HAS_PAQD: bool = true;
override HAS_DRAWING: bool = true;
override CHUNKED: bool = true;
override IS_SLICES: bool = true;

// Step-size opacity correction 1 - (1 - a)^e. e is 1 / sampleRate for every
// full sample, so the common rates skip pow().
fn stepCorrectAlpha(a: f32, e: f32) -> f32 {
    if (abs(e - 1.0) < 1e-4) { return a; }
    if (abs(e - 0.5) < 1e-4) { return 1.0 - sqrt(1.0 - a); }
    return 1.0 - pow(1.0 - a, e);
}

// In-shader layer-gradient constants, used by the overlay and drawing passes
// (neither has a precomputed gradient texture the way the background does).
//
// Three estimators, selected at runtime by params.layerGradMode, which the
// controller drives through volumeLayerGradientMode / LAYER_GRADIENT_MODE:
//   0 CENTRAL  the legacy 6-tap central difference at a hand-tuned offset
//   1 BLOB     the Gaussian-blob derivative (see layerGradBlob)
//   2 SOBEL8   the 8-corner Sobel the old niivue precomputes with
//
// The rest are shader authoring choices rather than runtime knobs. SIGMA is the
// width, in voxels, of the Gaussian blob the layer is reconstructed with; it is
// the only knob for mode 1, since both tap radii and their weights derive from
// it. DIAGONALS adds the four body-diagonal directions to the three axes (mode
// 1 only). OFFSET is used by mode 0 only. EPSILON is the magnitude below which
// gradient normalization is unreliable.
const LAYER_GRAD_CENTRAL: i32 = 0;
const LAYER_GRAD_BLOB: i32 = 1;
const LAYER_GRAD_SOBEL8: i32 = 2;
const LAYER_GRAD_SIGMA: f32 = 1.0;
const LAYER_GRAD_DIAGONALS: bool = true;
const LAYER_GRAD_OFFSET: f32 = 1.5;
const LAYER_GRAD_EPSILON: f32 = 1e-6;

// Weighted scalar projection of a layer's RGBA. Luminance weights on RGB
// distinguish distinct label/channel colors; heavy alpha weight (2.0) makes
// background→layer transitions dominate. Switched from length(rgba) which
// missed label-to-label boundaries when two labels had similar-magnitude
// RGBA vectors (common when labels share alpha=255 and differ only in hue).
fn layerScalar(c: vec4f) -> f32 {
    return dot(c, vec4f(0.299, 0.587, 0.114, 2.0));
}

// Central difference of `tex` along one antipodal pair. `off` is a half-offset
// in full-volume [0,1] units; chunkTexCoord maps it into the per-chunk texture
// so the stencil width stays correct for a chunked layer. Sign convention is
// value(+dir) - value(-dir), matching the precomputed volume gradient's
// inward-pointing normals.
fn layerPairDiff(tex: texture_3d<f32>, p: vec3f, off: vec3f) -> f32 {
    let a = layerScalar(textureSampleLevel(tex, tex_sampler, chunkTexCoord(p + off), 0.0));
    let b = layerScalar(textureSampleLevel(tex, tex_sampler, chunkTexCoord(p - off), 0.0));
    return a - b;
}

// Radial envelope of a Gaussian's derivative. For g(r) = exp(-r^2 / (2 s^2)),
// grad g = -(r / s^2) g(r), so the magnitude goes as r * g(r). The 1 / s^2 is
// a common factor over every direction and the result is normalized, so it is
// dropped. Peaks at r == s, which is where the diagonal shell samples.
fn blobWeight(r: f32, s: f32) -> f32 {
    return r * exp(-(r * r) / (2.0 * s * s));
}

// Legacy estimator: a 6-tap central difference at a hand-tuned 1.5-voxel
// offset -- three axes, no diagonals. The default, and what NiiVue has always
// drawn.
fn layerGradCentral(tex: texture_3d<f32>, p: vec3f) -> vec3f {
    let dv = LAYER_GRAD_OFFSET / params.volumeTexDimsFull.xyz;
    return vec3f(
        layerPairDiff(tex, p, vec3f(dv.x, 0.0, 0.0)),
        layerPairDiff(tex, p, vec3f(0.0, dv.y, 0.0)),
        layerPairDiff(tex, p, vec3f(0.0, 0.0, dv.z))
    );
}

// Gaussian-blob gradient.
//
// Treat the layer as a sum of radially symmetric Gaussian basis functions
// rather than a lattice of point samples. That reconstruction differentiates
// analytically — d(f * g) = f * dg — so the gradient of the smoothed field
// is a radially weighted sum of directional central differences, with no
// finite-difference stencil left to hand-tune. Every tap radius and weight
// falls out of LAYER_GRAD_SIGMA.
//
// Directions come in antipodal pairs, so each costs 2 fetches and contributes
// dir * (f(p + r*dir) - f(p - r*dir)). Two shells:
//
//   axes (6 fetches). The 1D DoG correlation weight is w(t) = t * g(t), so the
//   taps at t = 1 and t = 2 voxels both carry positive weight. Same-sign
//   neighbouring taps fold into a SINGLE linear fetch: sampling at
//   (1*w1 + 2*w2) / (w1 + w2) with weight (w1 + w2) reproduces both, because
//   the sampler lerps linearly between those two texels. So a 2-tap-per-side
//   DoG costs exactly what the 1-tap central difference did. Worth noting the
//   fold radius at s = 1 is 1.31, which is what the legacy 1.5 was reaching
//   for by hand.
//
//   body diagonals (8 fetches, LAYER_GRAD_DIAGONALS). One tap per side at
//   r = s, the peak of r * g(r). These carry no folding trick: an off-axis
//   trilinear fetch is not a 1D lerp, so the two-into-one identity does not
//   hold. They are what buys isotropy, and they are the whole of the win: on an
//   analytic sphere the axis shell alone only takes the mean angular error from
//   0.80 to 0.62 degrees, while adding the diagonals takes it to 0.20.
//
//   Where that error lives is worth stating precisely, because it is easy to
//   guess wrong. It is NOT largest along the diagonals. Every estimator here is
//   EXACT on the axes, the face diagonals, and the body diagonals alike — those
//   are symmetry directions of both the stencil and the sphere, so the tap
//   errors cancel. The error appears in the generic directions BETWEEN them,
//   and that is what the extra shell suppresses (1.53 to 0.49 degrees on one
//   such direction). So the artifact to look for is not facets pointing down
//   the diagonals but a smooth angular ripple with zeros at the symmetry axes.
//
// Both shells are individually isotropic in their second moment (3 axes give
// I, 4 body diagonals give (4/3)I), so they combine without a correction
// matrix. Each shell is divided by its own radius to put the two finite
// differences on a common scale before they are summed.
//
// The taps always go through the LINEAR sampler, even when the layer itself is
// ray-marched with nearest, so each is a trilinear blend of 8 texels. Note
// that p is an arbitrary ray position rather than a texel center, so the fold
// is an approximation there rather than an identity; the extra smoothing that
// costs is the same smoothing the legacy path already relied on.
fn layerGradBlob(tex: texture_3d<f32>, p: vec3f) -> vec3f {
    let s = LAYER_GRAD_SIGMA;
    // One voxel in full-volume [0,1] units. Componentwise, so a voxel-space
    // direction stays that direction after the anisotropic texture scaling.
    let vox = 1.0 / params.volumeTexDimsFull.xyz;

    let w1 = blobWeight(1.0, s);
    let w2 = blobWeight(2.0, s);
    let rAx = (w1 + 2.0 * w2) / (w1 + w2);
    let kAx = (w1 + w2) / rAx;
    let ax = rAx * vox;
    var grad = kAx * vec3f(
        layerPairDiff(tex, p, vec3f(ax.x, 0.0, 0.0)),
        layerPairDiff(tex, p, vec3f(0.0, ax.y, 0.0)),
        layerPairDiff(tex, p, vec3f(0.0, 0.0, ax.z))
    );

    if (LAYER_GRAD_DIAGONALS) {
        let rDg = s;
        let kDg = blobWeight(rDg, s) / rDg;
        let u = 1.0 / sqrt(3.0);
        let d0 = vec3f(u, u, u);
        let d1 = vec3f(u, u, -u);
        let d2 = vec3f(u, -u, u);
        let d3 = vec3f(u, -u, -u);
        let dg = rDg * vox;
        grad += kDg * (
            d0 * layerPairDiff(tex, p, d0 * dg)
            + d1 * layerPairDiff(tex, p, d1 * dg)
            + d2 * layerPairDiff(tex, p, d2 * dg)
            + d3 * layerPairDiff(tex, p, d3 * dg));
    }
    return grad;
}

// The old niivue's estimator: an 8-corner Sobel, i.e. the four body-diagonal
// antipodal pairs at (+-1,+-1,+-1) voxels and no axis taps at all. It is the
// exact mirror of the legacy central difference, which uses the three axes and
// no diagonals -- and it is the better half of that trade (0.68 vs 0.80 degrees
// mean angular error on an analytic sphere). The blob estimator uses both
// shells, which is where its 0.20 comes from.
//
// One caveat when comparing against upstream. There this stencil does NOT run
// on the raw layer: it runs as a precompute over a 27-tap prepass, and that
// prepass is a BLUR despite its name (its -d and +d terms carry the same sign;
// summing the three directional blurs it writes gives a hollow kernel with
// centre 0, faces 2, edges 4, corners 3). So the old pipeline is already a
// derivative of a smoothed field -- the same idea layerGradBlob derives
// analytically, done as two texture passes instead. That prepass is worth
// 0.68 -> 0.55 degrees, which this in-shader version does not have (216 taps
// per shaded sample is not a thing to do in a ray-march). Mode SOBEL8 is
// therefore slightly harsh on the old method, by a quarter of the gap it
// still loses by.
fn layerGradSobel8(tex: texture_3d<f32>, p: vec3f) -> vec3f {
    let vox = 1.0 / params.volumeTexDimsFull.xyz;
    let d0 = vec3f(1.0, 1.0, 1.0);
    let d1 = vec3f(1.0, 1.0, -1.0);
    let d2 = vec3f(1.0, -1.0, 1.0);
    let d3 = vec3f(1.0, -1.0, -1.0);
    return d0 * layerPairDiff(tex, p, d0 * vox)
        + d1 * layerPairDiff(tex, p, d1 * vox)
        + d2 * layerPairDiff(tex, p, d2 * vox)
        + d3 * layerPairDiff(tex, p, d3 * vox);
}

fn layerGrad(tex: texture_3d<f32>, p: vec3f, mode: i32) -> vec3f {
    if (mode == LAYER_GRAD_SOBEL8) { return layerGradSobel8(tex, p); }
    if (mode == LAYER_GRAD_BLOB) { return layerGradBlob(tex, p); }
    return layerGradCentral(tex, p);
}

// Matcap shade factor from the layer's own gradient at `p`. Returns
// vec3f(1.0) (no shading) when the gradient is degenerate.
fn layerShade(tex: texture_3d<f32>, p: vec3f, amount: f32) -> vec3f {
    let grad = layerGrad(tex, p, i32(params.layerGradMode));
    if (length(grad) <= LAYER_GRAD_EPSILON) { return vec3f(1.0); }
    let localNormal = normalize(grad);
    let norm3 = mat3x3f(params.normMtx[0].xyz, params.normMtx[1].xyz, params.normMtx[2].xyz);
    let n = norm3 * localNormal;
    // Flip X, not y. The gradient pass writes value(+dir) - value(-dir), which
    // points from dark to bright -- INTO the volume at a surface -- so the eye
    // -space normal here is the inward one, and u must count back from it.
    // v is already correct: v=0 is the image's top row (neither backend flips
    // on upload) and an inward normal at the top of an object has n.y < 0,
    // which lands on that row.
    //
    // Render a sphere with the matcap, which IS a photograph of a sphere, and
    // the screen must reproduce the image exactly. `examples/vox.matcap.html`
    // is set up to do that. Flipping y instead (as this did until 2026-09-22)
    // rotates the lighting 180 degrees; it reads as "lit from below" only
    // because the bundled matcaps are near left-right symmetric.
    let uv = vec2f(-n.x, n.y) * 0.5 + 0.5;
    let mc_rgb = textureSampleLevel(matcap, tex_sampler, uv, 0.0).rgb * (1.0 + (amount / 3.0));
    return mix(vec3f(1.0), mc_rgb, amount);
}

struct RayMarchResult {
    color: vec4f,
    firstHit: vec4f,
    farthest: f32,
}

// Shared fast+fine ray-march for overlay and drawing textures.
// Samples `tex` using `samp` (linear or nearest depending on caller).
// Sample positions are remapped through chunkTexCoord so a chunked layer
// (drawing) reads its per-chunk texture; identity for non-chunked layers.
// clipMode: 0 = ignore clip plane; 1 = solid clip (keep only [clipLo,clipHi]);
// 2 = cutaway clip (skip [clipLo,clipHi]). Lets the optional overlay passes be
// clipped with the base when clipPlaneOverlay is set, matching the background.
fn clipPassSkip(sampleA: f32, clipLo: f32, clipHi: f32, clipMode: f32) -> bool {
    if (clipMode < 0.5) { return false; }
    let inRange = (sampleA >= clipLo) && (sampleA <= clipHi);
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
fn rayMarchPass(
    tex: texture_3d<f32>, samp: sampler,
    start: vec3f, dir: vec3f, len: f32,
    deltaDir: vec4f, deltaDirFast: vec4f,
    ran: f32, earlyTermination: f32,
    clipLo: f32, clipHi: f32, clipMode: f32,
    shadeAmount: f32,
    // Display-gamma exponent for this layer's classified colour. Intensity-
    // derived layers pass params.invGamma; the drawing layer passes 1.0,
    // because its colours are categorical label swatches, not brightness.
    gammaExp: f32,
    mip: bool
) -> RayMarchResult {
    var result: RayMarchResult;
    result.color = vec4f(0.0);
    result.firstHit = vec4f(2.0 * len);
    result.farthest = 0.0;

    let stepSize = deltaDir.w;
    var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
    let samplePosStart = samplePos;
    // The skip probes one stride PAST the segment end (see fastLimit in main).
    let fastLimit = len + deltaDirFast.w;

    // Fast pass
    for (var j: i32 = 0; j < 1024; j++) {
        if (samplePos.a > fastLimit) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDirFast; continue; }
        let alpha = textureSampleLevel(tex, samp, chunkTexCoord(samplePos.xyz), 0.0).a;
        if (alpha >= 0.01) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a > fastLimit) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }
    // Put the fine march back on the ray's deterministic lattice; the 1.9-voxel
    // fast stride would otherwise set its phase from the depth of the first hit.
    let snapped = snapToSampleLattice(samplePos.a, ran, stepSize);
    samplePos = vec4f(start + dir * snapped, snapped);

    // Fine pass
    for (var i: i32 = 0; i < MAX_FINE_STEPS; i++) {
        if (samplePos.a > len) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDir; continue; }
        let colorSample = textureSampleLevel(tex, samp, chunkTexCoord(samplePos.xyz), 0.0);
        if (colorSample.a >= 0.01) {
            if (result.firstHit.a > len) {
                result.firstHit = samplePos;
            }
            result.farthest = samplePos.a;
            var rgb = applyGamma(colorSample.rgb, gammaExp);
            if (shadeAmount > 0.0) {
                // colorSample.rgb is straight (non-premultiplied) here, so
                // clamping the lit colour to 1.0 keeps the premultiplied
                // product below alpha once it is multiplied in.
                rgb = min(rgb * layerShade(tex, samplePos.xyz, shadeAmount), vec3f(1.0));
            }
            let premultiplied = vec4f(rgb * colorSample.a, colorSample.a);
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

// Specialized PAQD ray-march: samples raw PAQD data (nearest-neighbor),
// performs LUT lookup, probability blending, and alpha easing per sample.
fn rayMarchPaqd(
    tex: texture_3d<f32>, lut: texture_2d<f32>,
    start: vec3f, dir: vec3f, len: f32,
    deltaDir: vec4f, deltaDirFast: vec4f,
    ran: f32, earlyTermination: f32,
    paqdUni: vec4f,
    clipLo: f32, clipHi: f32, clipMode: f32,
    mip: bool
) -> RayMarchResult {
    var result: RayMarchResult;
    result.color = vec4f(0.0);
    result.firstHit = vec4f(2.0 * len);
    result.farthest = 0.0;

    let texDims = vec3f(textureDimensions(tex, 0));
    let stepSize = deltaDir.w;
    var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
    let samplePosStart = samplePos;
    // The skip probes one stride PAST the segment end (see fastLimit in main).
    let fastLimit = len + deltaDirFast.w;

    // Fast pass: skip until prob1 > easing threshold t0
    let t0 = paqdUni[0];
    for (var j: i32 = 0; j < 1024; j++) {
        if (samplePos.a > fastLimit) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDirFast; continue; }
        // chunkTexCoord remaps into the per-chunk PAQD texture (identity when not chunked).
        let coord = vec3i(clamp(chunkTexCoord(samplePos.xyz) * texDims, vec3f(0.0), texDims - 1.0));
        let raw = textureLoad(tex, coord, 0);
        if (raw.b > t0) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a > fastLimit) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }
    // Put the fine march back on the ray's deterministic lattice; the 1.9-voxel
    // fast stride would otherwise set its phase from the depth of the first hit.
    let snapped = snapToSampleLattice(samplePos.a, ran, stepSize);
    samplePos = vec4f(start + dir * snapped, snapped);

    // Fine pass: decode and accumulate PAQD colors
    for (var i: i32 = 0; i < MAX_FINE_STEPS; i++) {
        if (samplePos.a > len) { break; }
        if (clipMode > 0.5 && clipMode < 1.5 && samplePos.a > clipHi) { break; }
        if (clipPassSkip(samplePos.a, clipLo, clipHi, clipMode)) { samplePos += deltaDir; continue; }
        let coord = vec3i(clamp(chunkTexCoord(samplePos.xyz) * texDims, vec3f(0.0), texDims - 1.0));
        let raw = textureLoad(tex, coord, 0);
        let prob1 = raw.b;
        let prob2 = raw.a;
        let total = prob1 + prob2;
        if (total > 0.004) {
            let idx1 = i32(round(raw.r * 255.0));
            let idx2 = i32(round(raw.g * 255.0));
            let c1 = textureLoad(lut, vec2i(clamp(idx1, 0, 255), 0), 0);
            let c2 = textureLoad(lut, vec2i(clamp(idx2, 0, 255), 0), 0);
            let w = prob2 / total;
            let rgb = mix(c1.rgb, c2.rgb, w);
            let alpha = paqdEaseAlpha(prob1, paqdUni);
            if (alpha >= 0.01) {
                if (result.firstHit.a > len) {
                    result.firstHit = samplePos;
                }
                result.farthest = samplePos.a;
                let premultiplied = vec4f(rgb * alpha, alpha);
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
fn depthAwareMix(
    colAcc: ptr<function, vec4f>,
    result: RayMarchResult,
    backNearest: f32,
    fragDepth: ptr<function, f32>,
    depthFactor: f32,
    mip: bool
) {
    if (result.color.a <= 0.001) { return; }
    // Maximum projection: the layers combine by the same max operation that
    // built each layer's own accumulation, so depth-weighted mixing (which
    // assumes OVER) does not apply. Depth still tracks the nearest hit.
    if (mip) {
        *colAcc = max(*colAcc, result.color);
        *fragDepth = min(*fragDepth, frac2ndc(result.firstHit.xyz));
        return;
    }
    var mixFactor = result.color.a;
    if ((*colAcc).a <= 0.0) {
        mixFactor = 1.0;
    } else if (result.farthest > backNearest) {
        var dx = min((result.farthest - backNearest) / 0.5, 1.0);
        dx = (*colAcc).a * pow(dx, depthFactor);
        mixFactor *= 1.0 - dx;
    }
    *colAcc = vec4f(mix((*colAcc).rgb, result.color.rgb, mixFactor), max((*colAcc).a, result.color.a));
    let passDepth = frac2ndc(result.firstHit.xyz);
    *fragDepth = min(*fragDepth, passDepth);
}

fn distance2Plane(samplePos: vec4f, clipPlane: vec4f) -> f32 {
    // treat clipPlane.a > 1 as "no clip" sentinel
    if (clipPlane.a > 1.0) {
        return 1000.0;
    }
    let n = clipPlane.xyz;
    let EPS = 1e-6;
    let nlen = length(n);
    if (nlen < EPS) {
        return 1000.0; // invalid plane normal
    }
    // signed plane value: dot(n, p-0.5) + a
    let signedDist = dot(n, samplePos.xyz - 0.5) - clipPlane.a;
    // perpendicular (Euclidean) distance is |signedDist| / |n|
    return abs(signedDist) / nlen;
}

// One layer-stack sample at a plane hit, blended in the order the 2D tiles use
// (see wgpu/slice.wgsl). Returns PREMULTIPLIED rgba; alpha 0 means the plane is
// transparent here, so whatever lies behind it shows through. Mirrored in
// gl/renderShader.ts -- keep the two in step.
// `isLayer` is the independent hi-res overlay cube draw: the bound texture is a
// LAYER, not the background, and the orient pass has already baked its opacity
// into the alpha -- so take the sample's own alpha rather than the background
// volume's `opacity`, which that draw passes as 1.
fn sampleSlice(pos: vec3f, isLayer: bool) -> vec4f {
    let volCoord = chunkTexCoord(pos);
    let bg = textureSampleLevel(volume, tex_sampler, volCoord, 0.0);
    // Exactly the 2D tiles' rule (slice.wgsl): the volume's own opacity, with a
    // voxel the colormap made fully transparent knocked out only under
    // isAlphaClipDark. Off, a plane is a solid slab and the nearest one wins,
    // which is what 0.6 always drew; on, only tissue is drawn and the planes
    // behind it show through.
    var a = params.backOpacity;
    if (alphaClipDark() && bg.a == 0.0) { a = 0.0; }
    // A layer carries its own baked opacity, and 2D clips dark on the
    // background only.
    if (isLayer) { a = bg.a; }
    var rgb = applyGamma(bg.rgb, params.invGamma);
    if (HAS_OVERLAY && textureDimensions(overlay, 0).x > 2) {
        let ov = textureSampleLevel(overlay, tex_sampler, volCoord, 0.0);
        let oa = a + ov.a * (1.0 - a);
        if (oa > 0.0) {
            rgb = mix(rgb, applyGamma(ov.rgb, params.invGamma), ov.a / oa);
            a = oa;
        }
    }
    if (HAS_PAQD && textureDimensions(paqd, 0).x > 2) {
        let pDims = vec3f(textureDimensions(paqd, 0));
        // Nearest for BOTH the label indices and the probabilities. The 2D tiles
        // sample the probabilities linearly, but the GL PAQD texture is
        // NEAREST-filtered, so a linear tap there would silently be nearest and
        // the two backends would drift.
        let raw = textureLoad(paqd, vec3i(clamp(volCoord * pDims, vec3f(0.0), pDims - 1.0)), 0);
        let total = raw.b + raw.a;
        if (total > 0.004) {
            let c1 = textureLoad(paqdLut, vec2i(clamp(i32(round(raw.r * 255.0)), 0, 255), 0), 0);
            let c2 = textureLoad(paqdLut, vec2i(clamp(i32(round(raw.g * 255.0)), 0, 255), 0), 0);
            let prgb = mix(c1.rgb, c2.rgb, raw.a / total);
            let palpha = paqdEaseAlpha(raw.b, params.paqdUniforms);
            if (palpha > 0.0) {
                let na = palpha + a * (1.0 - palpha);
                rgb = mix(rgb, prgb, palpha / max(na, 0.001));
                a = na;
            }
        }
    }
    if (HAS_DRAWING && textureDimensions(drawing, 0).x > 2) {
        let dDims = vec3f(textureDimensions(drawing, 0));
        let dc = textureLoad(drawing, vec3i(clamp(volCoord * dDims, vec3f(0.0), dDims - 1.0)), 0);
        if (dc.a > 0.0) {
            rgb = mix(rgb, dc.rgb, dc.a);
            a = max(a, dc.a);
        }
    }
    return vec4f(rgb * a, a);
}

@fragment
fn fragment_main(in: VertexOutput) -> FragmentOutput {
	let rayStart = in.vColor;
	var start = GetFrontPosition(rayStart);
	let backPosition = GetBackPosition(rayStart);
	let dirVec = backPosition - start;
	var len = length(dirVec);
	if (!(len > 0.0) || len > 3.0) {
		discard;
	}
	let dir = dirVec / len;
	// Step size is per-voxel of this brick's source level across the FULL cube
	// (not the chunk texture, which may include halo). Equals volumeTexDimsFull
	// for non-chunked/single-level draws; coarser for multi-LOD bricks so each
	// steps at its own resolution. sampleRate subdivides that step further to
	// keep the march above the reconstruction's Nyquist rate.
	let sampleRate = max(params.rayStepTexVox.w, 1.0);
	let texVox = params.rayStepTexVox.xyz * sampleRate;
	let lenVox = length(dirVec * texVox);
	if (lenVox < 0.5) {
		discard;
	}
	// Opacity (step-size) correction. A coarse multi-LOD brick takes fewer
	// samples along the ray, so without this it accumulates less alpha and
	// renders dimmer/more transparent than a fine brick of the same material —
	// a visible brightness seam at LOD boundaries. Rescale per-sample alpha to a
	// fixed reference density, the finest level at one sample per voxel, so
	// brightness is independent of both the brick's level and the sample rate.
	let fineLenVox = length(dirVec * params.volumeTexDimsFull.xyz);
	// refPerLen converts a ray-length thickness into reference steps (the finest
	// level at one sample per voxel). A coarse multi-LOD brick owns longer slabs
	// and needs its alpha scaled up; oversampling owns shorter ones and needs it
	// scaled down. Both directions are correct, so this is not clamped -- only
	// guarded away from zero for the pow() below.
	let refPerLen = max(fineLenVox, 1e-6) / max(len, 1e-6);
	// Save original ray for overlay passes (overlay ignores clip planes)
	let origStart = start;
	let origLen = len;
	// Handle clip plane color (negative alpha means color plane is inside volume)
	var clipPlaneColorX = params.clipPlaneColor;
	if (clipPlaneColorX.a < 0.0) {
		clipPlaneColorX.a = 0.0;
	}
	let chunkedDraw = CHUNKED && any(params.chunkSubSize.xyz < vec3f(0.999));
	// Independent hi-res overlay cube draw: composite as a flat translucent
	// layer over the base. Skip the opaque clip-surface treatment (AO, clip
	// plane colour) and matcap lighting; still respect clip-plane ray trimming
	// so the overlay is clipped together with the base.
	let overlayMode = CHUNKED && params.overlayLayerMode > 0.5;
	// Maximum-intensity projection: every pass takes a component-wise max of the
	// premultiplied sample instead of compositing OVER, and no pass may early-
	// terminate (the maximum can lie anywhere along the ray).
	let mip = IS_MIP && isRenderMode(RENDER_MODE_MAXIMUM);
	// --- Orthogonal slices (VOLUME_RENDER_MODE.SLICES) ---
	// No march: intersect the ray with the three crosshair planes and composite
	// the hits front to back. start/dir/len already come from this chunk's own
	// cube, so a chunked draw needs nothing extra. Mirrored in
	// gl/renderShader.ts -- keep the two in step.
	if (IS_SLICES && isRenderMode(RENDER_MODE_SLICES)) {
		let planes = sliceFrac();
		let NO_HIT = 1e20;
		var t = vec3f(NO_HIT);
		for (var k: i32 = 0; k < 3; k++) {
			if (abs(dir[k]) < 1e-8) { continue; }
			let tk = (planes[k] - start[k]) / dir[k];
			// Half-open [0, len): a hit on a chunk's exit face belongs to the
			// next chunk along the ray, not to both. The two cubes compute that
			// boundary from different ends, so the rule is only exact up to
			// rounding -- which never bites, because a crosshair plane sits at a
			// voxel CENTRE fraction and a chunk face sits on a voxel boundary.
			if (tk >= 0.0 && tk < len) { t[k] = tk; }
		}
		// Sorting network, nearest first.
		if (t.x > t.y) { let s = t.x; t.x = t.y; t.y = s; }
		if (t.y > t.z) { let s = t.y; t.y = t.z; t.z = s; }
		if (t.x > t.y) { let s = t.x; t.x = t.y; t.y = s; }
		var acc = vec4f(0.0);
		var firstHit = vec3f(0.0);
		var hasHit = false;
		for (var i: i32 = 0; i < 3; i++) {
			if (t[i] >= NO_HIT) { break; }
			let pos = start + dir * t[i];
			let c = sampleSlice(pos, overlayMode);
			if (c.a > 0.0) {
				if (!hasHit) { hasHit = true; firstHit = pos; }
				acc += (1.0 - acc.a) * c;
				if (acc.a > 0.999) { break; }
			}
		}
		if (!hasHit) { discard; }
		var sliceOut: FragmentOutput;
		sliceOut.color = acc * params.fadeAlpha;
		sliceOut.fragDepth = frac2ndc(firstHit);
		return sliceOut;
	}
	let stepSize = len / lenVox;
	let deltaDir = vec4f(dir * stepSize, stepSize);
	var localGradientAmount = select(params.gradientAmount, 0.0, overlayMode);
	var sampleRange = vec2f(0.0, len);
	let cutaway = IS_CUTAWAY && params.isClipCutaway > 0.5;
	var hasClip = false;
	if (HAS_CLIP) {
		for (var i: i32 = 0; i < MAX_CLIP_PLANES; i++) {
			clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);
		}
	}
	let isClip = HAS_CLIP && ((sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0)));
	// Check if clip plane configuration eliminates background entirely
	var skipBackground = false;
	if (cutaway) {
		if (hasClip && sampleRange.x <= 0.0 && sampleRange.y >= len) {
			skipBackground = true;
		}
	} else {
		if (sampleRange.x >= sampleRange.y) {
			skipBackground = true;
		}
	}
	// A fully transparent background contributes no colour, so marching it
	// would only cost time and still claim the depth buffer and the clip
	// surface.
	if (params.backOpacity < (1.0 / 255.0)) {
		skipBackground = true;
	}
	// Shared values for all passes. Keep samples on a centered full-volume
	// lattice so adjacent chunks do not reset the ray phase at their seams.
	let origRan = raySamplePhase(origStart, stepSize);
	var ran = origRan;
	// The empty-space skip keeps striding ~1.9 voxels whatever the sample rate,
	// so oversampling does not also slow the skip and blow the iteration budget.
	let stepSizeFast = stepSize * 1.9 * sampleRate;
	let deltaDirFast = vec4f(dir * stepSizeFast, stepSizeFast);
	let earlyTermination = select(params.earlyTermination, 1.0, chunkedDraw);
	// --- Background passes ---
	var colAcc = vec4f(0.0);
	var firstHit = vec4f(2.0 * origLen);
	var bgHasHit = false;
	var fragDepth = 0.9999;
	var clipOffset = 0.0;
	var clipSurfaceHit = false;
	if (!skipBackground) {
		if (!cutaway && isClip && !overlayMode) {
			clipOffset = sampleRange.x;
			start += dir * sampleRange.x;
			len = sampleRange.y - sampleRange.x;
			let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(start.xyz), 0.0).a;
			let alpha1 = textureSampleLevel(volume, tex_sampler, chunkTexCoord(start.xyz - deltaDir.xyz), 0.0).a;
			if ((alpha > 0.01) && (alpha1 > 0.01)) {
				clipSurfaceHit = true;
			}
		}
		ran = raySamplePhase(start, stepSize);
		var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
		// --- Background Fast Pass ---
		// The skip probes one stride PAST the segment end. Without this a chunk
		// whose only material lies in the last <1 fast stride never registers a
		// hit, so the whole cube contributes nothing and its exit face draws as a
		// dark line -- the seam grid at chunk / floor-cube boundaries. Probing
		// past the face reads halo (or clamp-to-edge) texels, which is safe: it
		// can only ever cause a false HIT, and the fine march that follows is
		// still clipped to [0, len], so an over-eager probe costs a few empty
		// samples and changes no output.
		let fastLimit = len + stepSizeFast;
		let samplePosStart = samplePos;
		for (var j: i32 = 0; j < 1024; j++) {
			if (samplePos.a > fastLimit) { break; }
			if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
				samplePos += deltaDirFast;
				continue;
			}
			let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(samplePos.xyz), 0.0).a;
			if (alpha >= 0.01) {
				break;
			}
			samplePos += deltaDirFast;
		}
		if (samplePos.a > fastLimit) {
			// Background fast pass found nothing — use clip plane color as fallback
			if (isClip && !chunkedDraw) {
				let clipAlpha = clipPlaneColorX.a;
				colAcc = vec4f(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
			}
		} else {
			// Background fast pass found something
			if (cutaway && isClip && !overlayMode) {
				let dx = abs(sampleRange.x - samplePos.a);
				let dx2 = abs(sampleRange.y - samplePos.a);
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
			// 1.9-voxel fast stride would otherwise set its phase from the depth
			// of the first hit.
			let snappedBg = snapToSampleLattice(samplePos.a, ran, stepSize);
			samplePos = vec4f(start + dir * snappedBg, snappedBg);
			// --- Background Fine Pass ---
			// Each sample owns the slab [bLo, bHi) it is the midpoint of, clipped
			// to this brick's segment. The slabs therefore tile [0, len] EXACTLY,
			// so a brick contributes the optical depth of the ray length it
			// actually owns no matter where its sample lattice falls. Attributing
			// a fixed stepSize per sample instead only tiles when neighbouring
			// bricks share a lattice; at a LOD interface the step-D and step-2D
			// lattices do not nest and the boundary gains or loses up to ~1.5 fine
			// steps of material -- the bright and dark seams along level boundaries.
			var bLo = select(max(snappedBg - 0.5 * stepSize, 0.0), 0.0, snappedBg <= stepSize);
			let norm3 = mat3x3f(params.normMtx[0].xyz, params.normMtx[1].xyz, params.normMtx[2].xyz);
			// Three features read the precomputed gradient texture, and NONE of
			// them is on by default. Hoisted out of the loop because all three
			// terms are uniform over the draw (localGradientAmount is settled by
			// the fast pass above), so the branch is fully coherent -- every
			// fragment takes the same side. Skipping the fetch + normalize +
			// matcap tap when they are all off measures ~20% of the render.
			// Mirrored in gl/renderShader.ts.
			let needsGradient = NEEDS_GRADIENT && ((localGradientAmount > 0.0) || (params.gradientOpacity > 0.0) || (params.silhouettePower > 0.0));
			for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {
				if (bLo >= len) { break; }
				// Clipped to len, so the final sample covers the trailing sliver
				// past the last lattice point; it reads into the halo, which
				// exists for it.
				let bHi = min(samplePos.a + 0.5 * stepSize, len);
				let slab = max(bHi - bLo, 0.0);
				bLo = bHi;
				if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
					samplePos += deltaDir;
					continue;
				}
				let volCoord = chunkTexCoord(samplePos.xyz);
				// Fine pass only. The fast skip pass stays trilinear: it only needs a
				// coarse alpha test, so paying 8 fetches there would be waste.
				var colorSample = textureSampleLevel(volume, tex_sampler, volCoord, 0.0);
				if (CUBIC && params.cubicFilter > 0.5) {
					colorSample = sampleTricubic(volume, tex_sampler, volCoord);
				}
				// Chunked draws only -- see the scaling note after this block.
				if (chunkedDraw) {
					colorSample.a *= params.backOpacity;
				}
				if (colorSample.a >= 0.01) {
					if (!bgHasHit) {
						bgHasHit = true;
						firstHit = samplePos;
					}
					// Identity defaults, so the branch below is the only thing that
					// has to know about the gradient: a magnitude of 1 is a no-op in
					// the gradient-opacity pow(), and localNormal is read only under
					// silhouettePower > 0, which implies needsGradient.
					var gradMagnitude = 1.0;
					var localNormal = vec3f(0.0);
					var finalRGB = applyGamma(colorSample.rgb, params.invGamma);
					if (needsGradient) {
						let gradSample = textureSampleLevel(volumeGradient, tex_sampler, volCoord, 0.0);
						gradMagnitude = gradSample.a;
						// Guarded normalize: the precompute writes 0.5 (a zero vector
						// once decoded) wherever the data is flat, and normalize(0) is
						// NaN -- which would poison the matcap lookup and, below, the
						// silhouette dot. The guarded form leaves both defined.
						let gradVec = gradSample.rgb * 2.0 - 1.0;
						localNormal = gradVec / max(length(gradVec), 1e-6);
						let lightingAmount = localGradientAmount;
						if (lightingAmount > 0.0) {
							let n = norm3 * localNormal;
							// See layerShade() for why x is flipped, not y.
							let uv = vec2f(-n.x, n.y) * 0.5 + 0.5;
							let mc_rgb = textureSampleLevel(matcap, tex_sampler, uv, 0.0).rgb * (1.0 + (lightingAmount / 3.0));
							finalRGB *= mix(vec3f(1.0), mc_rgb, lightingAmount);
						}
					}
					// Step-size correction compensates a coarse brick's sparser
					// sampling in an OVER accumulation. A max projection reads
					// each sample independently, so correcting it would brighten
					// coarse bricks instead of matching them.
					var correctedA = select(stepCorrectAlpha(colorSample.a, max(slab * refPerLen * params.lodOpacityScale, 1e-3)), colorSample.a, mip);
					// Gradient opacity: scale alpha by the gradient magnitude raised to
					// gradientOpacity*8. This is the analytic form of the old NiiVue's
					// 192-entry LUT, which held exactly pow(i/191, opacity*8) -- so
					// there is no table to upload and 0 is a no-op by construction
					// (pow(m, 0) == 1) rather than by a special case. Homogeneous
					// interior has magnitude ~0 and fades out; edges keep their alpha.
					if (params.gradientOpacity > 0.0) {
						correctedA *= pow(gradMagnitude, params.gradientOpacity * 8.0);
					}
					// Silhouette: fade material whose surface faces the camera and keep
					// material seen edge-on, so a surface reads as a rim. The hard cull
					// above 1-silhouette is what opens the interior at higher settings.
					if (params.silhouettePower > 0.0) {
						let viewAlign = abs(dot(localNormal, dir));
						correctedA *= pow(1.0 - viewAlign, params.silhouettePower);
						if (viewAlign > 1.0 - params.silhouettePower) { correctedA = 0.0; }
					}
					let premultiplied = vec4f(finalRGB * correctedA, correctedA);
					if (mip) {
						colAcc = max(colAcc, premultiplied);
					} else {
						colAcc = (1.0 - colAcc.a) * premultiplied + colAcc;
						if (colAcc.a > earlyTermination) { break; }
					}
				}
				samplePos += deltaDir;
			}
			// Clip surface ambient occlusion
			if (clipSurfaceHit) {
				var min1 = 1000.0;
				var min2 = 1000.0;
				let firstHit1 = firstHit - deltaDir;
				for (var ci: i32 = 0; ci < MAX_CLIP_PLANES; ci++) {
					let d = distance2Plane(firstHit1, params.clipPlanes[ci]);
					if (d < min1) {
						min2 = min1;
						min1 = d;
					} else if (d < min2) {
						min2 = d;
					}
				}
				let thresh = 1.2 * stepSize;
				if (cutaway && min2 < thresh && sampleRange.x > 0.0) {
					if (abs(sampleRange.x - firstHit.a) > (2.0 * thresh) && abs(sampleRange.y - firstHit.a) > (2.0 * thresh)) {
						min2 = thresh;
					}
				}
				let aoFrac = 0.5;
				let factor = (1.0 - aoFrac) + aoFrac * clamp(min2 / thresh, 0.0, 1.0);
				colAcc = vec4f(colAcc.rgb * factor, colAcc.a);
			}
			if (clipSurfaceHit && params.clipPlaneColor.a < 0.0) {
				colAcc = vec4f(mix(colAcc.rgb, clipPlaneColorX.rgb, abs(params.clipPlaneColor.a)), colAcc.a);
			}
			// If fine pass produced nothing, use clip plane color as fallback
			if (colAcc.a <= 0.001 || !bgHasHit) {
				if (isClip && !chunkedDraw) {
					let clipAlpha = clipPlaneColorX.a;
					colAcc = vec4f(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
				}
			} else {
				fragDepth = frac2ndc(firstHit.xyz);
			}
		}
	}
	// Scale the ACCUMULATED background once, not each sample -- see the matching
	// comment in gl/renderShader.ts. Per-sample alpha is an absorption
	// coefficient, so scaling it barely moves a ray that saturates anyway.
	// colAcc is premultiplied, so this scales colour and alpha together.
	// Single full-volume draws only -- see the matching note in gl/renderShader.ts.
	if (!chunkedDraw) {
		colAcc *= params.backOpacity;
	}
	// --- Optional passes. By default overlays ignore the clip plane (march the
	// full original ray); when clipPlaneOverlay is set they are clipped with the
	// base: solid clip keeps [sampleRange.x, sampleRange.y], cutaway skips it. ---
	let backNearest = clipOffset + firstHit.a;
	let depthFactor = 0.3;
	// Clip the optional passes with the base when clipPlaneOverlay is set. Gate on
	// hasClip (a clip plane is active), NOT isClip (this chunk's ray straddles the
	// plane): a chunked draw splits the volume into cubes, and a cube lying wholly
	// on the removed side has sampleRange == (0,0) with isClip == false. Using
	// isClip there left ovClipMode == 0, so the overlay rendered the full cube and
	// leaked through the clipped-away region. With hasClip the solid range maps
	// every case correctly: full-keep -> (0,len) keeps all, straddle -> partial,
	// wholly-removed -> (0,0) keeps nothing.
	let clipOverlay = params.clipPlaneOverlay > 0.5 && hasClip;
	let ovClipMode = select(0.0, select(1.0, 2.0, cutaway), clipOverlay);
	let ovClipLo = sampleRange.x;
	let ovClipHi = sampleRange.y;
	// Overlay pass. Overlays carry no precomputed gradient texture (the combined
	// overlay texture is rebuilt whenever any overlay changes, e.g. an opacity
	// drag, so a cached gradient would thrash), so lighting comes from the
	// in-shader stencil — per sample, since an overlay stack is translucent.
	if (HAS_OVERLAY && textureDimensions(overlay, 0).x > 2) {
		let result = rayMarchPass(overlay, tex_sampler, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, earlyTermination, ovClipLo, ovClipHi, ovClipMode, params.gradientAmount, params.invGamma, mip);
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor, mip);
	}
	// PAQD pass (raw data with GPU-side LUT lookup + easing)
	if (HAS_PAQD && textureDimensions(paqd, 0).x > 2) {
		let result = rayMarchPaqd(paqd, paqdLut, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, earlyTermination, params.paqdUniforms, ovClipLo, ovClipHi, ovClipMode, mip);
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor, mip);
	}
	// Drawing pass (nearest-neighbor sampling for ray-march, linear for gradient)
	if (HAS_DRAWING && textureDimensions(drawing, 0).x > 2) {
		var result = rayMarchPass(drawing, nearest_sampler, origStart, dir, origLen, deltaDir, deltaDirFast, origRan, earlyTermination, ovClipLo, ovClipHi, ovClipMode, 0.0, 1.0, mip);
		// Matcap lighting at FIRST HIT only (unlike the overlay, which shades
		// every sample): a drawing is a label mask read as an opaque surface,
		// so one shade for the whole ray is both correct and far cheaper.
		if (result.color.a > 0.001 && params.gradientAmount > 0.0) {
			let shade = layerShade(drawing, result.firstHit.xyz, params.gradientAmount);
			// result.color is premultiplied (rgb = actualColor * alpha).
			// Clamp to alpha so the shade (which can exceed 1.0 via the
			// matcap brighten) can't push rgb > alpha and break the
			// premultiplied-alpha invariant that depthAwareMix and
			// framebuffer blending assume.
			let shadedRgb = min(result.color.rgb * shade, vec3f(result.color.a));
			result.color = vec4f(shadedRgb, result.color.a);
		}
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor, mip);
	}
	// Final output
	if (colAcc.a <= 0.001) {
		discard;
	}
	var output: FragmentOutput;
	// Single full-volume draws can present an early-terminated ray as opaque.
	// Chunked draws must emit the true per-segment premultiplied alpha so the
	// back-to-front chunk blend reconstructs the full ray without over-occluding
	// deeper chunks.
	// A max projection never early-terminates, so a high alpha means "the
	// brightest sample was nearly opaque", not "the ray saturated". Promoting it
	// to fully opaque would throw away that modulation.
	if (chunkedDraw || mip) {
		output.color = colAcc;
	} else if (colAcc.a >= earlyTermination) {
		output.color = vec4f(colAcc.rgb / colAcc.a, 1.0);
	} else {
		output.color = colAcc;
	}
	// Cross-fade a streaming chunk in over the coarse floor (premultiplied, so
	// scaling the whole vec4 fades presence + coverage together). 1.0 = no-op.
	output.color = output.color * params.fadeAlpha;
	output.fragDepth = fragDepth;
	return output;
}
