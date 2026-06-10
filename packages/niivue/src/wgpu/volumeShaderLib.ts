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
    _pad0: vec2f,
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
}

// Remap a sample position from full-volume [0,1] cube space to the local chunk
// texture's [dataOrigin, dataOrigin+dataSize] region (preserves trilinear halo
// access at chunk seams). Identity for non-chunked volumes.
fn chunkTexCoord(samplePos: vec3f) -> vec3f {
    let chunkLocal = (samplePos - params.chunkSubOrigin.xyz) / params.chunkSubSize.xyz;
    return params.dataOriginTexFrac.xyz + chunkLocal * params.dataSizeTexFrac.xyz;
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

fn frac2ndc(frac: vec3f) -> f32 {
    var pos: vec4f = vec4f(frac, 1.0);
    let dim: vec4f = vec4f(params.volumeTexDimsFull.xyz, 1.0);
    pos = pos * dim;
    let shim: vec4f = vec4f(-0.5, -0.5, -0.5, 0.0);
    pos += shim;
    // WGSL matrices are column-major.
    // In GLSL 'transpose(matRAS) * pos' is equivalent to 'pos * matRAS' in WGSL
    let mm: vec4f = pos * params.matRAS;
    let gl_pos: vec4f = params.mvpMtx * vec4f(mm.xyz, 1.0);
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
        phase = 1.0;
    }
    return clamp(phase, 0.001, 1.0);
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
