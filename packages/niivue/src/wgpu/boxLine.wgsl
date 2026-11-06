// Box edges in world mm, projected per render tile (mirrors gl/boxLineShader.ts).
struct TileUniforms {
    mvp: mat4x4f,
    tileSize: vec2f,
};

// Scalar fields keep the 48-byte layout packBoxEdges writes (a vec3f would
// align to 16).
struct Edge {
    ax: f32, ay: f32, az: f32,
    bx: f32, by: f32, bz: f32,
    thickness: f32,
    _pad: f32,
    color: vec4f,
};

@group(0) @binding(0) var<uniform> u: TileUniforms;
@group(0) @binding(1) var<storage, read> edges: array<Edge>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vertex_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32
) -> VertexOutput {
    let e = edges[iIdx];
    var out: VertexOutput;
    out.color = e.color;
    let a = u.mvp * vec4f(e.ax, e.ay, e.az, 1.0);
    let b = u.mvp * vec4f(e.bx, e.by, e.bz, 1.0);
    // An edge with a corner at or behind the camera is dropped.
    if (a.w <= 1e-6 || b.w <= 1e-6) {
        out.position = vec4f(2.0, 2.0, 0.0, 1.0);
        return out;
    }
    // Thickness is in pixels: expand the quad in tile pixel space.
    let pa = (a.xy / a.w * 0.5 + 0.5) * u.tileSize;
    let delta = (b.xy / b.w * 0.5 + 0.5) * u.tileSize - pa;
    let perp = vec2f(-delta.y, delta.x) / max(length(delta), 1e-6);
    let side = select(-0.5, 0.5, vIdx % 2u == 0u);
    let along = select(vec2f(0.0), delta, vIdx >= 2u);
    let pixelPos = pa + perp * (side * e.thickness) + along;
    out.position = vec4f(pixelPos / u.tileSize * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
