export const fontVertShader = `#version 300 es
precision highp float;

uniform vec2 canvasSize;

// Glyph data passed as vertex attributes (using instancing)
// Each instance is one glyph
in vec4 glyphRect;      // x, y, width, height (pixels)
in vec4 glyphUvRect;    // u, v, width, height (0-1)
in vec4 glyphColor;     // RGBA color
in float glyphRange;    // The atlas distance range

out vec2 vUv;
out vec4 vColor;
out float vAtlasRange;

void main() {
    int vIdx = gl_VertexID;
    
    // Define quad vertices: 0, 1, 2, 3 -> (0,0), (1,0), (0,1), (1,1)
    vec2 pos = vec2(0.0);
    if (vIdx == 1) { pos.x = 1.0; }
    else if (vIdx == 2) { pos.y = 1.0; }
    else if (vIdx == 3) { pos.x = 1.0; pos.y = 1.0; }
    
    vec2 pixelPos = glyphRect.xy + pos * glyphRect.zw;
    vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
    
    // Flip Y for NDC: GL Y is up, screen coords are down
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    
    vUv = glyphUvRect.xy + pos * glyphUvRect.zw;
    vColor = glyphColor;
    vAtlasRange = glyphRange;
}
`;

export const fontFragShader = `#version 300 es
precision highp float;

uniform sampler2D fontTexture;
uniform vec2 texSize;

in vec2 vUv;
in vec4 vColor;
in float vAtlasRange;

out vec4 fragColor;

void main() {
    // Sample MSDF texture
    vec3 msd = texture(fontTexture, vUv).rgb;
    
    // Median of three channels
    float sd = max(min(msd.r, msd.g), min(max(msd.r, msd.g), msd.b));
    
    // Calculate screen-space derivatives for anti-aliasing
    vec2 uv_dx = dFdx(vUv);
    vec2 uv_dy = dFdy(vUv);
    
    vec2 unitRange = vec2(vAtlasRange) / texSize;
    vec2 screenTexSize = inversesqrt(uv_dx * uv_dx + uv_dy * uv_dy);
    float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
    
    float screenPxDistance = screenPxRange * (sd - 0.5);
    float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
    
    if (opacity <= 0.0) { discard; }
    
    fragColor = vec4(vColor.rgb, vColor.a * opacity);
}
`;
