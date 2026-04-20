export const colorbarVertShader = `#version 300 es
precision highp float;

uniform vec2 canvasSize;
uniform float opacity;
uniform vec4 rect;  // x, y, width, height in pixels
uniform float radiusPx;
uniform float borderPx;
uniform vec4 borderColor;

out vec2 vUv;
out vec2 vLocalPos;

void main() {
    int vIdx = gl_VertexID;
    
    // Define quad vertices: 0, 1, 2, 3 -> (0,0), (1,0), (0,1), (1,1)
    vec2 pos = vec2(0.0);
    if (vIdx == 1) { pos.x = 1.0; }
    else if (vIdx == 2) { pos.y = 1.0; }
    else if (vIdx == 3) { pos.x = 1.0; pos.y = 1.0; }
    
    // Map to pixel position using rect
    vec2 pixelPos = rect.xy + pos * rect.zw;
    
    // Convert to NDC
    vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
    
    // Flip Y for NDC
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    
    // Sample horizontally across colormap
    vUv = vec2(pos.x, 0.5);
    vLocalPos = pos;
}
`;

export const colorbarFragShader = `#version 300 es
precision highp float;

uniform sampler2D colormapTex;
uniform float opacity;
uniform vec4 rect;  // x, y, width, height in pixels
uniform float radiusPx;
uniform float borderPx;
uniform vec4 borderColor;

in vec2 vUv;
in vec2 vLocalPos;
out vec4 fragColor;

float roundedRectDistance(vec2 localPos, vec2 size, float radius) {
    float r = max(radius, 0.0);
    vec2 halfSize = size * 0.5;
    vec2 q = abs(localPos - halfSize) - (halfSize - vec2(r));
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
    vec2 size = rect.zw;
    vec2 local = vLocalPos * size;
    float dist = roundedRectDistance(local, size, radiusPx);
    if (dist > 0.0) {
        discard;
    }
    vec4 color = texture(colormapTex, vUv);
    if (borderPx > 0.0) {
        vec2 innerSize = size - vec2(2.0 * borderPx);
        if (innerSize.x > 0.0 && innerSize.y > 0.0) {
            vec2 innerLocal = local - vec2(borderPx);
            float innerRadius = max(radiusPx - borderPx, 0.0);
            float innerDist = roundedRectDistance(innerLocal, innerSize, innerRadius);
            if (innerDist > 0.0) {
                fragColor = vec4(borderColor.rgb, borderColor.a * opacity);
                return;
            }
        } else {
            fragColor = vec4(borderColor.rgb, borderColor.a * opacity);
            return;
        }
    }
    fragColor = vec4(color.rgb, opacity);
}
`;
