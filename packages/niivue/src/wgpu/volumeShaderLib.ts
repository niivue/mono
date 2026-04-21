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
    numPaqd: f32,
    clipPlaneColor: vec4f,
    clipPlanes: array<vec4f, 6>,
    paqdUniforms: vec4f,
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
    var pos = vert.position;
    let texVox = vec3<f32>(textureDimensions(volume, 0));
    let voxelSpacePos = (pos * texVox) - 0.5;
    let vPos = (vec4<f32>(voxelSpacePos, 1.0) * params.matRAS).xyz;
    var gl_pos = vec4<f32>(params.mvpMtx * vec4<f32>(vPos, 1.0));
    out.position = gl_pos;
    out.vColor = vert.position;
    return out;
}

fn frac2ndc(frac: vec3f) -> f32 {
    var pos: vec4f = vec4f(frac, 1.0);
    let dim: vec4f = vec4f(vec3f(textureDimensions(volume, 0)), 1.0);
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
    let startObj = startTex * volScale;
    let invR = 1.0 / rayDir;
    let tbot = invR * (-startObj);
    let ttop = invR * (volScale - startObj);
    let tmax = max(ttop, tbot);
    let t = min(tmax.x, min(tmax.y, tmax.z));
    return (startObj + (rayDir * t)) / volScale;
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
