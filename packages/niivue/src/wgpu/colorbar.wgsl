struct ColorbarUniforms {
    canvasSize: vec2f,
    opacity: f32,
    radiusPx: f32,
    rect: vec4f,  // x, y, width, height in pixels
    borderColor: vec4f,
    borderPx: f32,
    _pad0: vec3f,
};

@group(0) @binding(0) var<uniform> u: ColorbarUniforms;
@group(0) @binding(1) var colormapTex: texture_2d<f32>;
@group(0) @binding(2) var colormapSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) localPos: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    // Define quad vertices: 0, 1, 2, 3 -> (0,0), (1,0), (0,1), (1,1)
    var pos = vec2f(0.0);
    if (vIdx == 1u) { pos.x = 1.0; }
    else if (vIdx == 2u) { pos.y = 1.0; }
    else if (vIdx == 3u) { pos.x = 1.0; pos.y = 1.0; }
    
    // Map to pixel position using rect
    let pixelPos = u.rect.xy + pos * u.rect.zw;
    
    // Convert to NDC
    let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
    
    var out: VertexOutput;
    // Flip Y for NDC
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = vec2f(pos.x, 0.5);  // Sample horizontally across colormap
    out.localPos = pos;
    return out;
}

fn roundedRectDistance(localPos: vec2f, size: vec2f, radius: f32) -> f32 {
    let r = max(radius, 0.0);
    let halfSize = size * 0.5;
    let q = abs(localPos - halfSize) - (halfSize - vec2f(r));
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    let size = u.rect.zw;
    let local = in.localPos * size;
    let dist = roundedRectDistance(local, size, u.radiusPx);
    if (dist > 0.0) {
        discard;
    }
    let color = textureSample(colormapTex, colormapSampler, in.uv);
    if (u.borderPx > 0.0) {
        let innerSize = size - vec2f(2.0 * u.borderPx);
        if (innerSize.x > 0.0 && innerSize.y > 0.0) {
            let innerLocal = local - vec2f(u.borderPx);
            let innerRadius = max(u.radiusPx - u.borderPx, 0.0);
            let innerDist = roundedRectDistance(innerLocal, innerSize, innerRadius);
            if (innerDist > 0.0) {
                return vec4f(u.borderColor.rgb, u.borderColor.a * u.opacity);
            }
        } else {
            return vec4f(u.borderColor.rgb, u.borderColor.a * u.opacity);
        }
    }
    return vec4f(color.rgb, u.opacity);
}
