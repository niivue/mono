struct FontUniforms {
    canvasSize: vec2f,
};

struct Glyph {
    rect: vec4f,       // x, y, width, height (pixels)
    uvRect: vec4f,     // u, v, width, height (0-1)
    color: vec4f,      // RGBA color
    distanceRange: f32, // The atlas range (usually 2.0 or 4.0)
};

@group(0) @binding(0) var<uniform> u: FontUniforms;
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
    // Define quad vertices: 0, 1, 2, 3 -> (0,0), (1,0), (0,1), (1,1)
    var pos = vec2f(0.0);
    if (vIdx == 1u) { pos.x = 1.0; }
    else if (vIdx == 2u) { pos.y = 1.0; }
    else if (vIdx == 3u) { pos.x = 1.0; pos.y = 1.0; }
    let pixelPos = glyph.rect.xy + pos * glyph.rect.zw;
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    var out: VertexOutput;
    // Flip Y for NDC: WebGPU Y is up (1.0), screens are down
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
    let screenPxDistance = screenPxRange * (sd - 0.5);
    let opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
    if (opacity <= 0.0) { discard; }
    return vec4f(in.color.rgb, in.color.a * opacity);
}