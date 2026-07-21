// UIKit's own line shaders, duplicated from niivue core (gl/lineShader.ts,
// wgpu/line.wgsl) during the bake-in phase so UIKit renders without reaching into
// core. Same wire format as `LineData`: instanced quads expanded in the vertex
// stage from [start, end, thickness, color]. Pixel coordinates map to NDC with a
// Y flip (screen y-down -> clip y-up). See docs/ruler-port.md in @niivue/niivue.

export const GL_LINE_VERT = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
in vec2 lineStart;
in vec2 lineEnd;
in float lineThickness;
in vec4 lineColor;
out vec4 vColor;

void main() {
  int vIdx = gl_VertexID;
  vec2 delta = lineEnd - lineStart;
  vec2 dir = normalize(delta);
  vec2 perp = vec2(-dir.y, dir.x);
  float halfThickness = lineThickness * 0.5;
  vec2 offset;
  if (vIdx == 0) {
    offset = -perp * halfThickness;
  } else if (vIdx == 1) {
    offset = perp * halfThickness;
  } else if (vIdx == 2) {
    offset = -perp * halfThickness + delta;
  } else {
    offset = perp * halfThickness + delta;
  }
  vec2 pixelPos = lineStart + offset;
  vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vColor = lineColor;
}
`

export const GL_LINE_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;

void main() {
  fragColor = vColor;
}
`

export const WGSL_LINE = `
struct LineUniforms {
    canvasSize: vec2f,
};

struct Line {
    start: vec2f,
    end: vec2f,
    thickness: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    color: vec4f,
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
    let delta = line.end - line.start;
    let dir = normalize(delta);
    let perp = vec2f(-dir.y, dir.x);
    let halfThickness = line.thickness * 0.5;
    var offset = vec2f(0.0);
    if (vIdx == 0u) {
        offset = -perp * halfThickness;
    } else if (vIdx == 1u) {
        offset = perp * halfThickness;
    } else if (vIdx == 2u) {
        offset = -perp * halfThickness + delta;
    } else {
        offset = perp * halfThickness + delta;
    }
    let pixelPos = line.start + offset;
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.color = line.color;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
`
