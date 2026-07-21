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

// MSDF text. Vertices are pre-transformed screen-pixel triangles (rotation baked
// in by the CPU layout); the shader only maps pixels to NDC and samples the atlas.
// screenPxRange is a uniform (precomputed from font size + distance range), so no
// screen-space derivatives are needed. Duplicated in spirit from niivue core
// (gl/fontShader.ts, wgpu/font.wgsl) but simplified for the baked-vertex model.

export const GL_TEXT_VERT = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
in vec2 pos;
in vec2 uv;
in vec4 color;
out vec2 vUv;
out vec4 vColor;

void main() {
  vec2 ndc = (pos / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = uv;
  vColor = color;
}
`

export const GL_TEXT_FRAG = `#version 300 es
precision highp float;
uniform highp sampler2D fontTexture;
uniform float screenPxRange;
uniform vec4 outlineColor;
uniform float outlineWidthPx;
in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

void main() {
  vec3 msd = texture(fontTexture, vUv).rgb;
  float sd = median(msd.r, msd.g, msd.b);
  // Signed distance to the glyph edge in screen pixels (+ inside).
  float d = screenPxRange * (sd - 0.5);
  float fillA = clamp(d + 0.5, 0.0, 1.0);
  if (outlineWidthPx <= 0.0) {
    if (fillA <= 0.0) discard;
    fragColor = vec4(vColor.rgb, fillA * vColor.a);
    return;
  }
  // Expand the coverage by the outline width to get the outline+fill silhouette,
  // then draw the fill over the outline. The band is clamped to the atlas SDF
  // range (screenPxRange/2), beyond which the MSDF saturates and can't be offset.
  float w = min(outlineWidthPx, screenPxRange * 0.5);
  float outA = clamp(d + w + 0.5, 0.0, 1.0);
  if (outA <= 0.0) discard;
  vec3 rgb = mix(outlineColor.rgb, vColor.rgb, fillA);
  float a = outA * mix(outlineColor.a, vColor.a, fillA);
  fragColor = vec4(rgb, a);
}
`

export const WGSL_TEXT = `
struct TextUniforms {
    canvasSize: vec2f,
    screenPxRange: f32,
    outlineWidthPx: f32,
    outlineColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: TextUniforms;
@group(0) @binding(1) var fontTex: texture_2d<f32>;
@group(0) @binding(2) var fontSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
};

@vertex
fn vertex_main(
    @location(0) pos: vec2f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f
) -> VertexOutput {
    var out: VertexOutput;
    let ndc = (pos / u.canvasSize) * 2.0 - 1.0;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = uv;
    out.color = color;
    return out;
}

fn median(r: f32, g: f32, b: f32) -> f32 {
    return max(min(r, g), min(max(r, g), b));
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    let msd = textureSample(fontTex, fontSampler, in.uv).rgb;
    let sd = median(msd.r, msd.g, msd.b);
    let d = u.screenPxRange * (sd - 0.5); // signed px distance (+ inside)
    let fillA = clamp(d + 0.5, 0.0, 1.0);
    if (u.outlineWidthPx <= 0.0) {
        return vec4f(in.color.rgb, fillA * in.color.a);
    }
    // Expand coverage by the outline width (clamped to the atlas SDF range),
    // then draw the fill over the outline.
    let w = min(u.outlineWidthPx, u.screenPxRange * 0.5);
    let outA = clamp(d + w + 0.5, 0.0, 1.0);
    let rgb = mix(u.outlineColor.rgb, in.color.rgb, fillA);
    let a = outA * mix(u.outlineColor.a, in.color.a, fillA);
    return vec4f(rgb, a);
}
`
