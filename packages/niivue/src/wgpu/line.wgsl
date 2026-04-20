struct LineUniforms {
    canvasSize: vec2f,
};

struct Line {
    start: vec2f,           // Offset 0,  Size 8
    end: vec2f,             // Offset 8,  Size 8
    thickness: f32,         // Offset 16, Size 4
    _pad0: f32,             // Offset 20, Size 4
    _pad1: f32,             // Offset 24, Size 4
    _pad2: f32,             // Offset 28, Size 4
    color: vec4f,           // Offset 32, Size 16
};

@group(0) @binding(0) var<uniform> u: LineUniforms;
@group(0) @binding(1) var<storage, read> lines: array<Line>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vertex_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32
) -> VertexOutput {
    let line = lines[iIdx];
    
    // 1. Calculate line geometry in pixel space
    let delta = line.end - line.start;
    let dir = normalize(delta);
    let perp = vec2f(-dir.y, dir.x);
    let halfThickness = line.thickness * 0.5;
    
    // Define quad vertices (0, 1, 2, 3) around the line segment
    var offset = vec2f(0.0);
    if (vIdx == 0u) { 
        offset = -perp * halfThickness; 
    } else if (vIdx == 1u) { 
        offset = perp * halfThickness; 
    } else if (vIdx == 2u) { 
        offset = -perp * halfThickness + delta; 
    } else { // vIdx == 3u
        offset = perp * halfThickness + delta; 
    }
    let pixelPos = line.start + offset;
    // Map pixel coordinates to NDC (-1 to 1)
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    // Flip Y for NDC: WebGPU Y is up (1.0), screens are down (-1.0)
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.color = line.color;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}