// UIKit's own line shaders, mirroring niivue core's (gl/lineShader.ts,
// wgpu/line.wgsl): each package keeps its own renderer. Same wire format as
// `LineData`: instanced quads expanded in the vertex stage from [start, end,
// thickness, color]. Pixel coordinates map to NDC with a Y flip (screen y-down
// -> clip y-up).

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

// MSDF text, for uikit's overlays and NiiVue core's labels alike. One instanced
// quad per glyph (FLOATS_PER_GLYPH floats: rect, uv rect, colour, then atlas
// range, sin and cos - 1 of a rotation about the rect's top-left). All-zero
// rotation floats are exactly unrotated. The anti-aliasing range comes from
// screen-space derivatives, so glyphs stay sharp at any scale or angle.

export const GL_TEXT_VERT = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
in vec4 glyphRect;    // x, y, width, height (pixels)
in vec4 glyphUvRect;  // u, v, width, height (0-1)
in vec4 glyphColor;
in vec4 glyphParams;  // atlas range, sin, cos - 1, unused
out vec2 vUv;
out vec4 vColor;
out float vAtlasRange;

void main() {
  int vIdx = gl_VertexID;
  // Quad corners 0..3 -> (0,0), (1,0), (0,1), (1,1)
  vec2 pos = vec2(0.0);
  if (vIdx == 1) { pos.x = 1.0; }
  else if (vIdx == 2) { pos.y = 1.0; }
  else if (vIdx == 3) { pos = vec2(1.0); }
  vec2 local = pos * glyphRect.zw;
  float s = glyphParams.y;
  float c1 = glyphParams.z;
  vec2 pixelPos = glyphRect.xy + local + vec2(c1 * local.x - s * local.y, s * local.x + c1 * local.y);
  vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = glyphUvRect.xy + pos * glyphUvRect.zw;
  vColor = glyphColor;
  vAtlasRange = glyphParams.x;
}
`

export const GL_TEXT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D fontTexture;
uniform vec2 texSize;
in vec2 vUv;
in vec4 vColor;
in float vAtlasRange;
out vec4 fragColor;

void main() {
  vec3 msd = texture(fontTexture, vUv).rgb;
  float sd = max(min(msd.r, msd.g), min(max(msd.r, msd.g), msd.b));
  vec2 uv_dx = dFdx(vUv);
  vec2 uv_dy = dFdy(vUv);
  vec2 unitRange = vec2(vAtlasRange) / texSize;
  vec2 screenTexSize = inversesqrt(uv_dx * uv_dx + uv_dy * uv_dy);
  float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
  float opacity = clamp(screenPxRange * (sd - 0.5) + 0.5, 0.0, 1.0);
  if (opacity <= 0.0) { discard; }
  fragColor = vec4(vColor.rgb, vColor.a * opacity);
}
`

export const WGSL_TEXT = `
struct TextUniforms {
    canvasSize: vec2f,
};

struct Glyph {
    rect: vec4f,
    uvRect: vec4f,
    color: vec4f,
    distanceRange: f32,
    rotSin: f32,
    rotCosMinus1: f32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> u: TextUniforms;
@group(0) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(0) @binding(2) var fontTex: texture_2d<f32>;
@group(0) @binding(3) var fontSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
    @location(2) atlasRange: f32,
};

@vertex
fn vertex_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32
) -> VertexOutput {
    let glyph = glyphs[iIdx];
    var pos = vec2f(0.0);
    if (vIdx == 1u) { pos.x = 1.0; }
    else if (vIdx == 2u) { pos.y = 1.0; }
    else if (vIdx == 3u) { pos = vec2f(1.0); }
    let local = pos * glyph.rect.zw;
    let s = glyph.rotSin;
    let c1 = glyph.rotCosMinus1;
    let pixelPos = glyph.rect.xy + local + vec2f(c1 * local.x - s * local.y, s * local.x + c1 * local.y);
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = glyph.uvRect.xy + pos * glyph.uvRect.zw;
    out.color = glyph.color;
    out.atlasRange = glyph.distanceRange;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    let msd = textureSample(fontTex, fontSampler, in.uv).rgb;
    let sd = max(min(msd.r, msd.g), min(max(msd.r, msd.g), msd.b));
    let uv_dx = dpdx(in.uv);
    let uv_dy = dpdy(in.uv);
    let texSize = vec2f(textureDimensions(fontTex));
    let unitRange = vec2f(in.atlasRange) / texSize;
    let screenTexSize = inverseSqrt(uv_dx * uv_dx + uv_dy * uv_dy);
    let screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
    let opacity = clamp(screenPxRange * (sd - 0.5) + 0.5, 0.0, 1.0);
    if (opacity <= 0.0) { discard; }
    return vec4f(in.color.rgb, in.color.a * opacity);
}
`

// Filled rounded rectangles. Same instancing model as the lines (one record per
// instance, a 4-vertex strip expanded in the vertex stage), but the fragment stage
// evaluates a rounded-box signed distance so the corners, the inner border ring
// and a 1px antialiased edge all come from one quad with no extra geometry. The
// quad is grown by one pixel on every side so the antialiased edge has room.

const GLSL_ROUND_BOX = `
float sdRoundBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
`

export const GL_RECT_VERT = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
in vec2 rectPos;
in vec2 rectSize;
in vec2 rectShape; // (cornerRadius, borderWidth)
in vec4 rectFill;
in vec4 rectBorder;
out vec2 vLocal;
out vec2 vHalfSize;
out vec2 vShape;
out vec4 vFill;
out vec4 vBorder;

void main() {
  int vIdx = gl_VertexID;
  // Corner order (0,0) (0,1) (1,0) (1,1): the strip's first triangle winds
  // counter-clockwise in clip space like the line and text quads, so the quad
  // survives when the host leaves back-face culling enabled.
  vec2 corner = vec2(float(vIdx >> 1), float(vIdx & 1));
  vec2 halfSize = rectSize * 0.5;
  vec2 centre = rectPos + halfSize;
  vec2 grown = halfSize + 1.0;
  vec2 local = (corner * 2.0 - 1.0) * grown;
  vec2 pixelPos = centre + local;
  vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vLocal = local;
  vHalfSize = halfSize;
  vShape = rectShape;
  vFill = rectFill;
  vBorder = rectBorder;
}
`

export const GL_RECT_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalfSize;
in vec2 vShape;
in vec4 vFill;
in vec4 vBorder;
out vec4 fragColor;
${GLSL_ROUND_BOX}
void main() {
  float d = sdRoundBox(vLocal, vHalfSize, vShape.x);
  float coverage = 1.0 - smoothstep(-0.5, 0.5, d);
  // The border ring is the band within borderWidth of the outer edge.
  float ring = vShape.y > 0.0 ? smoothstep(-0.5, 0.5, d + vShape.y) : 0.0;
  vec4 color = mix(vFill, vBorder, ring);
  float alpha = color.a * coverage;
  if (alpha <= 0.0) discard;
  fragColor = vec4(color.rgb, alpha);
}
`

export const WGSL_RECT = `
struct RectUniforms {
    canvasSize: vec2f,
};

struct Rect {
    pos: vec2f,
    size: vec2f,
    radius: f32,
    border: f32,
    _pad0: f32,
    _pad1: f32,
    fill: vec4f,
    borderColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: RectUniforms;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) local: vec2f,
    @location(1) halfSize: vec2f,
    @location(2) shape: vec2f,
    @location(3) fill: vec4f,
    @location(4) borderColor: vec4f,
};

@vertex
fn vertex_main(
    @builtin(vertex_index) vIdx: u32,
    @builtin(instance_index) iIdx: u32
) -> VertexOutput {
    let rect = rects[iIdx];
    let corner = vec2f(f32(vIdx >> 1u), f32(vIdx & 1u));
    let halfSize = rect.size * 0.5;
    let centre = rect.pos + halfSize;
    let grown = halfSize + 1.0;
    let local = (corner * 2.0 - 1.0) * grown;
    let pixelPos = centre + local;
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.local = local;
    out.halfSize = halfSize;
    out.shape = vec2f(rect.radius, rect.border);
    out.fill = rect.fill;
    out.borderColor = rect.borderColor;
    return out;
}

fn sdRoundBox(p: vec2f, halfSize: vec2f, r: f32) -> f32 {
    let q = abs(p) - halfSize + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    let d = sdRoundBox(in.local, in.halfSize, in.shape.x);
    let coverage = 1.0 - smoothstep(-0.5, 0.5, d);
    var ring = 0.0;
    if (in.shape.y > 0.0) {
        ring = smoothstep(-0.5, 0.5, d + in.shape.y);
    }
    let color = mix(in.fill, in.borderColor, ring);
    return vec4f(color.rgb, color.a * coverage);
}
`

// One textured quad (an image placed at a canvas-pixel box), e.g. the slide
// minimap thumbnail. Same corner order and pixel-to-NDC mapping as the rects;
// uv (0,0) is the image's top-left row as uploaded (no unpack flip).

export const GL_IMAGE_VERT = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
uniform vec4 box; // (x, y, width, height) in canvas pixels
out vec2 vUv;

void main() {
  vec2 corner = vec2(float(gl_VertexID >> 1), float(gl_VertexID & 1));
  vec2 ndc = ((box.xy + corner * box.zw) / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = corner;
}
`

export const GL_IMAGE_FRAG = `#version 300 es
precision highp float;
uniform highp sampler2D image;
in vec2 vUv;
out vec4 fragColor;

void main() {
  fragColor = texture(image, vUv);
}
`

export const WGSL_IMAGE = `
struct ImageUniforms {
    canvasSize: vec2f,
    _pad: vec2f,
    box: vec4f,
};

@group(0) @binding(0) var<uniform> u: ImageUniforms;
@group(0) @binding(1) var imageTex: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    let corner = vec2f(f32(vIdx >> 1u), f32(vIdx & 1u));
    let ndc = ((u.box.xy + corner * u.box.zw) / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    return textureSample(imageTex, imageSampler, in.uv);
}
`

// Magnifier lens: the image quad over the lens's bounding square, cut to a
// circle, sampling the captured frame enlarged about the lens centre. Outside
// the frame it shows `fill`. Drawn without blending so a transparent scene
// pixel stays transparent: the capture is already premultiplied.
// shortcut: hard circle edge (blending would need a second draw to keep alpha),
// hidden by the default 2 px ring; anti-alias it if borderless lenses matter.
export const GL_LENS_FRAG = `#version 300 es
precision highp float;
uniform highp sampler2D image;
uniform vec4 box; // lens bounding square, canvas px
uniform vec4 lens; // centre x, y, radius (canvas px), zoom
uniform vec4 fill;
uniform vec2 imageSize;
uniform vec4 imageRect; // bounds rect's x and bottom-up y in the texture, texture size
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 d = box.xy + vUv * box.zw - lens.xy;
  if (length(d) > lens.z) discard;
  vec2 s = (lens.xy + d / lens.w) / imageSize;
  bool inside = all(greaterThanEqual(s, vec2(0.0))) && all(lessThanEqual(s, vec2(1.0)));
  // The blitted frame's rows are bottom-up, at the bounds rect's own place.
  vec2 t = (imageRect.xy + vec2(s.x, 1.0 - s.y) * imageSize) / imageRect.zw;
  // Off the canvas nothing was copied: fill it, as outside the image.
  inside = inside && all(greaterThanEqual(t, vec2(0.0))) && all(lessThanEqual(t, vec2(1.0)));
  fragColor = inside ? texture(image, t) : vec4(fill.rgb * fill.a, fill.a);
}
`
export const WGSL_LENS = `
struct LensUniforms {
    canvasSize: vec2f,
    imageSize: vec2f,
    box: vec4f,
    lens: vec4f,
    fill: vec4f,
};

@group(0) @binding(0) var<uniform> u: LensUniforms;
@group(0) @binding(1) var imageTex: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    let corner = vec2f(f32(vIdx >> 1u), f32(vIdx & 1u));
    let ndc = ((u.box.xy + corner * u.box.zw) / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    let d = u.box.xy + in.uv * u.box.zw - u.lens.xy;
    let s = (u.lens.xy + d / u.lens.w) / u.imageSize;
    // Sampled before any branch: textureSample needs uniform control flow.
    let c = textureSample(imageTex, imageSampler, s);
    if (length(d) > u.lens.z) { discard; }
    let inside = all(s >= vec2f(0.0)) && all(s <= vec2f(1.0));
    return select(vec4f(u.fill.rgb * u.fill.a, u.fill.a), c, inside);
}
`
