// Shared WGSL snippets for volume ray-casting shaders (render + depth pick).
// Single source of truth for structs, bindings, vertex shader, and fragment helpers.

export const volumeShaderPreamble = /* wgsl */ `
const MAX_CLIP_PLANES: i32 = 6;

struct Params {
    mvpMtx: mat4x4<f32>,
    normMtx: mat4x4<f32>,
    matRAS: mat4x4<f32>,
    volScale: vec4f,
    rayDir: vec4f,
    gradientAmount: f32,
    numVolumes: f32,
    isClipCutaway: f32,
    // 1.0 when this draw is an independent hi-res overlay chunk cube (skip the
    // clip-surface/AO/matcap base treatment, composite as a translucent layer);
    // 0.0 for normal base/non-chunked draws. (Formerly the unused numPaqd.)
    overlayLayerMode: f32,
    clipPlaneColor: vec4f,
    clipPlanes: array<vec4f, 6>,
    paqdUniforms: vec4f,
    earlyTermination: f32,
    // 1.0 to clip the overlay/PAQD/drawing passes with the base (else they ignore
    // the clip plane). Sits in what was implicit padding before _pad0 (WGSL aligns
    // the following vec3f to 16 bytes), so the struct size and all later vec4f
    // offsets are unchanged.
    clipPlaneOverlay: f32,
    // Cross-fade weight in [0,1] for a streaming chunk: the final premultiplied
    // color is multiplied by this so a freshly-resident fine chunk dissolves in
    // over the coarse floor instead of popping. 1.0 for every non-fading draw.
    // Lives in what was _pad0's first lane, so struct size/offsets are unchanged.
    fadeAlpha: f32,
    // Volume render mode: 0 = composite (OVER), 1 = maximum-intensity
    // projection. Sits in the implicit padding f32 between fadeAlpha and the
    // 8-byte-aligned _pad0, so struct size and all later offsets are unchanged.
    renderMode: f32,
    // 0 = hardware trilinear, 1 = tricubic B-spline reconstruction in the
    // background fine pass. Occupies what was _pad0's first lane, so the struct
    // size and every later offset are unchanged.
    cubicFilter: f32,
    // Display gamma exponent for the classified RGB (alpha untouched, so the
    // ray's occlusion is unchanged). Already inverted on the CPU: the shader
    // does pow(rgb, invGamma), where invGamma = 1 / scene.gamma, so gamma > 1
    // brightens. 1.0 is a strict no-op. Occupies what was _pad0, so the struct
    // size and every later offset are unchanged.
    invGamma: f32,
    // Multiplier on this brick's step-size opacity exponent, compensating the
    // fact that a coarse voxel is not homogeneous (so its true transmittance is
    // lower than the homogeneous approximation the step correction assumes).
    // 1.0 is a strict no-op and is the default. Occupies the first of the two
    // implicit padding lanes before the 16-byte-aligned volumeTexDimsFull, so
    // the struct size and every later offset are unchanged. Mirrors
    // lodOpacityScale in gl/renderShader.ts.
    lodOpacityScale: f32,
    // The background volume's own \`opacity\`, scaling every background sample's
    // alpha. The 2D slice shader honours it as a plain uniform. Here a single
    // full-volume draw scales the ACCUMULATED premultiplied result once, giving
    // the same linear fade as the 2D tiles and leaving the depth write and
    // clip-surface shading opacity-independent; chunked draws still scale each
    // sample, because their per-chunk fragments composite with OVER and a
    // per-chunk scale would compound. See gl/renderShader.ts for the full note.
    // Overlays do not use it: their opacity is baked into the overlay texture's
    // alpha by the orient pass. 1.0 is the default and a strict no-op. Occupies the last
    // implicit padding lane before the 16-byte-aligned volumeTexDimsFull, so
    // the struct size and every later offset are unchanged. Mirrors
    // backOpacity in gl/renderShader.ts. The depth-pick shader shares this
    // struct but never reads the field: a pick reads geometry, not colour.
    backOpacity: f32,
    // Tiled-volume fields. Pass-through values for non-chunked volumes:
    //   volumeTexDimsFull = textureDimensions(volume, 0)
    //   chunkSubOrigin    = (0,0,0)
    //   chunkSubSize      = (1,1,1)
    //   dataOriginTexFrac = (0,0,0)
    //   dataSizeTexFrac   = (1,1,1)
    // The vertex shader scales the unit cube into the chunk texture footprint
    // (data plus halo) so separately-rasterized chunk cubes overlap by their
    // halo. The fragment shader then clips ray marching back to the chunk's
    // owned data sub-cube and remaps samples into [dataOrigin, dataOrigin+dataSize],
    // letting trilinear sampling pull from halo voxels without double-counting them.
    volumeTexDimsFull: vec4f,
    chunkSubOrigin: vec4f,
    chunkSubSize: vec4f,
    dataOriginTexFrac: vec4f,
    dataSizeTexFrac: vec4f,
    // Full-volume voxel dims at this brick's source pyramid level, used only for
    // the ray-march step density so a coarse multi-LOD brick steps at its own
    // resolution. Equals volumeTexDimsFull for single-level/non-chunked draws.
    // .w carries samples per voxel along the ray in the fine march. Above 1 it
    // oversamples and converges the ray integral; it does NOT remove concentric
    // "wood grain" banding on smooth structures (measured ring contrast is flat
    // from 1 to 4, because the banding is in the integrand, not the sampling of
    // it). It rides in what was pad, so the struct size and every offset are
    // unchanged.
    rayStepTexVox: vec4f,
    // Which stencil the overlay and drawing passes estimate their own gradient
    // with: LAYER_GRAD_CENTRAL | LAYER_GRAD_BLOB | LAYER_GRAD_SOBEL8. The
    // background volume reads a precomputed gradient texture and ignores this.
    // A trailing f32: the struct's 16-byte alignment absorbs it, so every
    // offset above is unchanged and the uniform slot does not grow. Mirrors
    // layerGradMode in gl/renderShader.ts. The depth-pick shader shares this
    // struct but never reads the field -- a pick reads geometry, not shading.
    layerGradMode: f32,
    // Background-volume gradient opacity and silhouette (Fresnel rim), both 0
    // when off. gradientOpacity scales each background sample's alpha by
    // magnitude^(gradientOpacity*8) -- the analytic form of the old NiiVue's
    // 192-entry LUT, which sampled exactly that function -- and silhouette
    // scales it by (1-|dot(normal,rayDir)|)^silhouette with a cull above
    // 1-silhouette. Both read the PRECOMPUTED gradient texture (rgb = direction,
    // a = magnitude), so they apply to the background pass only. Two more
    // trailing f32s: the struct's 16-byte alignment still rounds the size to the
    // 512 it already occupied, so no offset above moves. Mirror gradientOpacity
    // and silhouettePower in gl/renderShader.ts. The depth-pick shader shares
    // this struct but never reads them -- a pick reads geometry, not opacity.
    gradientOpacity: f32,
    silhouettePower: f32,
}

// Remap a sample position from full-volume [0,1] cube space to the local chunk
// texture's [dataOrigin, dataOrigin+dataSize] region (preserves trilinear halo
// access at chunk seams). Identity for non-chunked volumes.
fn chunkTexCoord(samplePos: vec3f) -> vec3f {
    let chunkLocal = (samplePos - params.chunkSubOrigin.xyz) / params.chunkSubSize.xyz;
    return params.dataOriginTexFrac.xyz + chunkLocal * params.dataSizeTexFrac.xyz;
}

// Display gamma on a classified colour. ALPHA IS DELIBERATELY UNTOUCHED: gamma
// is a brightness control, and raising alpha with it would change how much each
// sample occludes what is behind it (the ray would saturate sooner and the image
// would get flatter, not brighter). e is params.invGamma, already reciprocated
// on the CPU. Mirrors applyGamma in gl/renderShader.ts -- keep the two in step.
fn applyGamma(rgb: vec3f, e: f32) -> vec3f {
    if (e == 1.0) { return rgb; }
    return pow(max(rgb, vec3f(0.0)), vec3f(e));
}

// Tricubic B-spline reconstruction in 8 hardware-trilinear fetches
// (Sigg & Hadwiger, GPU Gems 2 ch. 20; Ruijters & Thevenaz formulation). The
// 4x4x4 kernel has non-negative weights only, so each opposed pair of taps
// collapses into one linear fetch at a weighted offset. Approximating, not
// interpolating: it smooths by design, which is the point here. Requires a
// LINEAR-filtered sampler, which tex_sampler is.
//
// Support reaches 2 texels either side of the sample, so a CHUNKED volume needs
// a brick halo of at least 2 or brick faces read past their owned data and seam.
// See VolumeRenderConfig.isCubicInterpolation. Mirrors sampleTricubic in
// gl/renderShader.ts -- keep the two in step.
//
// coord is already in THIS texture's [0,1] space (post chunkTexCoord).
fn sampleTricubic(tex: texture_3d<f32>, samp: sampler, coord: vec3f) -> vec4f {
    let dims = vec3f(textureDimensions(tex, 0));
    let grid = coord * dims - 0.5;
    let idx = floor(grid);
    let f = grid - idx;
    let g = vec3f(1.0) - f;
    let w0 = (1.0 / 6.0) * g * g * g;
    let w1 = vec3f(2.0 / 3.0) - 0.5 * f * f * (vec3f(2.0) - f);
    let w2 = vec3f(2.0 / 3.0) - 0.5 * g * g * (vec3f(2.0) - g);
    let w3 = (1.0 / 6.0) * f * f * f;
    let s0 = w0 + w1;
    let s1 = w2 + w3;
    let inv = vec3f(1.0) / dims;
    let h0 = inv * ((w1 / s0) - 0.5 + idx);
    let h1 = inv * ((w3 / s1) + 1.5 + idx);
    var c000 = textureSampleLevel(tex, samp, vec3f(h0.x, h0.y, h0.z), 0.0);
    let c100 = textureSampleLevel(tex, samp, vec3f(h1.x, h0.y, h0.z), 0.0);
    c000 = mix(c100, c000, s0.x);
    var c010 = textureSampleLevel(tex, samp, vec3f(h0.x, h1.y, h0.z), 0.0);
    let c110 = textureSampleLevel(tex, samp, vec3f(h1.x, h1.y, h0.z), 0.0);
    c010 = mix(c110, c010, s0.x);
    c000 = mix(c010, c000, s0.y);
    var c001 = textureSampleLevel(tex, samp, vec3f(h0.x, h0.y, h1.z), 0.0);
    let c101 = textureSampleLevel(tex, samp, vec3f(h1.x, h0.y, h1.z), 0.0);
    c001 = mix(c101, c001, s0.x);
    var c011 = textureSampleLevel(tex, samp, vec3f(h0.x, h1.y, h1.z), 0.0);
    let c111 = textureSampleLevel(tex, samp, vec3f(h1.x, h1.y, h1.z), 0.0);
    c011 = mix(c111, c011, s0.x);
    c001 = mix(c011, c001, s0.y);
    return mix(c001, c000, s0.z);
}

fn rayAxisRange(start: f32, dir: f32, boxMin: f32, boxMax: f32) -> vec2f {
    if (abs(dir) < 1e-8) {
        if (start < boxMin || start > boxMax) {
            return vec2f(1e20, -1e20);
        }
        return vec2f(-1e20, 1e20);
    }
    let t0 = (boxMin - start) / dir;
    let t1 = (boxMax - start) / dir;
    return vec2f(min(t0, t1), max(t0, t1));
}

fn rayBoxRange(startObj: vec3f, dir: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec2f {
    let rx = rayAxisRange(startObj.x, dir.x, boxMin.x, boxMax.x);
    let ry = rayAxisRange(startObj.y, dir.y, boxMin.y, boxMax.y);
    let rz = rayAxisRange(startObj.z, dir.z, boxMin.z, boxMax.z);
    return vec2f(max(rx.x, max(ry.x, rz.x)), min(rx.y, min(ry.y, rz.y)));
}

fn chunkDrawOrigin() -> vec3f {
    let dataSize = max(params.dataSizeTexFrac.xyz, vec3f(1e-8));
    return params.chunkSubOrigin.xyz - params.chunkSubSize.xyz * (params.dataOriginTexFrac.xyz / dataSize);
}

fn chunkDrawSize() -> vec3f {
    let dataSize = max(params.dataSizeTexFrac.xyz, vec3f(1e-8));
    return params.chunkSubSize.xyz / dataSize;
}

struct VertexInput {
    @location(0) position: vec3f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) vColor: vec3f,
};

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) fragDepth: f32,
};

@group(0) @binding(0)
var<uniform> params: Params;

@group(0) @binding(1)
var volume: texture_3d<f32>;

@group(0) @binding(2)
var matcap: texture_2d<f32>;

@group(0) @binding(3)
var tex_sampler: sampler;

@group(0) @binding(4)
var volumeGradient: texture_3d<f32>;

@group(0) @binding(5)
var overlay: texture_3d<f32>;

@group(0) @binding(6)
var paqd: texture_3d<f32>;

@group(0) @binding(7)
var drawing: texture_3d<f32>;

@group(0) @binding(8)
var nearest_sampler: sampler;

@group(0) @binding(9)
var paqdLut: texture_2d<f32>;

@vertex
fn vertex_main(vert: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // Place this draw's cube into the chunk texture footprint in the full
    // volume's [0,1] cube. For non-chunked draws, drawOrigin=0 and drawSize=1.
    let subPos = chunkDrawOrigin() + vert.position * chunkDrawSize();
    let texVox = params.volumeTexDimsFull.xyz;
    let voxelSpacePos = (subPos * texVox) - 0.5;
    let vPos = (vec4<f32>(voxelSpacePos, 1.0) * params.matRAS).xyz;
    var gl_pos = vec4<f32>(params.mvpMtx * vec4<f32>(vPos, 1.0));
    out.position = gl_pos;
    out.vColor = subPos;
    return out;
}

// Clip-space position of a point given in full-volume texture fraction. Same
// chain the vertex shader runs, so a fragment can recover where its sample
// landed on screen without a varying.
fn frac2clip(frac: vec3f) -> vec4f {
    var pos: vec4f = vec4f(frac, 1.0);
    let dim: vec4f = vec4f(params.volumeTexDimsFull.xyz, 1.0);
    pos = pos * dim;
    let shim: vec4f = vec4f(-0.5, -0.5, -0.5, 0.0);
    pos += shim;
    // WGSL matrices are column-major.
    // In GLSL 'transpose(matRAS) * pos' is equivalent to 'pos * matRAS' in WGSL
    let mm: vec4f = pos * params.matRAS;
    return params.mvpMtx * vec4f(mm.xyz, 1.0);
}

fn frac2ndc(frac: vec3f) -> f32 {
    let gl_pos: vec4f = frac2clip(frac);
    let z_ndc: f32 = gl_pos.z / gl_pos.w;
    // orthoZO produces clip Z in [0,1], matching WebGPU's native NDC range
    return z_ndc;
}

fn GetBackPosition(startTex: vec3f) -> vec3f {
    let volScale = params.volScale.xyz;
    let rayDir = params.rayDir.xyz;
    // Clip ray to the chunk's sub-cube in object space, not the full cube.
    // For non-chunked: subMin=0, subMax=volScale (identical to original).
    let subMin = params.chunkSubOrigin.xyz * volScale;
    let subMax = (params.chunkSubOrigin.xyz + params.chunkSubSize.xyz) * volScale;
    let startObj = startTex * volScale;
    let range = rayBoxRange(startObj, rayDir, subMin, subMax);
    let t = max(range.y, max(range.x, 0.0));
    return (startObj + (rayDir * t)) / volScale;
}

fn GetFrontPosition(startTex: vec3f) -> vec3f {
    let volScale = params.volScale.xyz;
    let rayDir = params.rayDir.xyz;
    let subMin = params.chunkSubOrigin.xyz * volScale;
    let subMax = (params.chunkSubOrigin.xyz + params.chunkSubSize.xyz) * volScale;
    let startObj = startTex * volScale;
    let t = max(rayBoxRange(startObj, rayDir, subMin, subMax).x, 0.0);
    return (startObj + (rayDir * t)) / volScale;
}

fn GetFullFrontPosition(startTex: vec3f) -> vec3f {
    let volScale = params.volScale.xyz;
    let rayDir = params.rayDir.xyz;
    let startObj = startTex * volScale;
    let t = rayBoxRange(startObj, -rayDir, vec3f(0.0), volScale).y;
    return (startObj - (rayDir * t)) / volScale;
}

fn raySamplePhase(startTex: vec3f, stepSize: f32) -> f32 {
    let fullFront = GetFullFrontPosition(startTex);
    let traveled = length(startTex - fullFront);
    let grid = traveled / max(stepSize, 1e-8);
    // Continue the full-volume centered sample lattice through each chunk.
    // If a global sample lands exactly on a chunk boundary, use the next
    // sample in the nearer chunk so the boundary is not double-counted.
    var phase = floor(grid + 0.5) + 0.5 - grid;
    if (phase <= 0.001) {
        phase += 1.0;
    }
    return clamp(phase, 0.001, 1.0);
}

// Re-anchor a position handed over by the coarse (fast) pass onto the fine
// sample lattice. The fast pass strides 1.9 voxels, which is not a whole number
// of fine steps, so resuming the fine march exactly where the fast pass stopped
// leaves the fine lattice with a phase set by how many fast steps were taken --
// floor(depth / 1.9), a sawtooth in depth-to-first-hit. Snapping back to the
// ray's own phase makes the fine samples land in the same places regardless of
// where the fast pass stopped, so a chunk's samples do not shift when a
// neighbouring chunk changes where empty-space skipping ends.
fn snapToSampleLattice(dist: f32, phase: f32, stepSize: f32) -> f32 {
    let n = floor(dist / max(stepSize, 1e-8) - phase);
    return (phase + max(n, 0.0)) * stepSize;
}

// see if clip plane trims ray sampling range sampleStartEnd.x..y
fn clipSampleRange(dir: vec3f, rayStart: vec4f, clipPlane: vec4f, sampleStartEnd: ptr<function, vec2f>, hasClip: ptr<function, bool>) {
    let CSR_EPS = 1e-6;
    // quick exit: no clip plane
    if (clipPlane.a > 1.0 || clipPlane.a < -1.0) {
        return;
    }
    let depth = - clipPlane.a;
    *hasClip = true;
    // quick exit: empty range
    if (((*sampleStartEnd).y - (*sampleStartEnd).x) <= CSR_EPS) {
        return;
    }
    // Which side does the ray start on? (plane eqn: dot(n, p-0.5) + a = 0)
    let sampleSide = dot(clipPlane.xyz, rayStart.xyz - 0.5) + depth;
    let startsFront = (sampleSide < 0.0);
    var dis = -1.0;
    // plane normal dot ray direction
    let cdot = dot(dir, clipPlane.xyz);
    // avoid division by 0 for near-parallel plane
    if (abs(cdot) >= CSR_EPS) {
        dis = (-depth - dot(clipPlane.xyz, rayStart.xyz - 0.5)) / cdot;
    }
    if (dis < 0.0 || dis > (*sampleStartEnd).y + CSR_EPS) {
        if (startsFront) {
            *sampleStartEnd = vec2f(0.0, 0.0);
        }
        return;
    }
    let frontface = (cdot > 0.0);
    if (frontface) {
        (*sampleStartEnd).x = max((*sampleStartEnd).x, dis);
    } else {
        (*sampleStartEnd).y = min((*sampleStartEnd).y, dis);
    }
    // if nothing remains, mark empty
    if ((*sampleStartEnd).y - (*sampleStartEnd).x <= CSR_EPS) {
        *sampleStartEnd = vec2f(0.0, 0.0);
    }
}
`
