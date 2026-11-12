import { colorLutGlsl } from '@/slide/colorLutShader'

// One static unit quad (corner 0 or 1 per axis); the rect and UVs are
// uniforms. A bvec mix selects exactly, so corners land where the CPU put them.
export const slideVertShader = `#version 300 es
layout(location=0) in vec2 corner;
uniform vec4 rect; // clip-space x0, y0, x1, y1
uniform vec4 uvRect; // u0, v0 (top), u1, v1 (bottom)

out vec2 uv;
out vec2 local;

void main(void) {
  bvec2 c = bvec2(corner);
  gl_Position = vec4(mix(rect.xy, rect.zw, c), 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, c);
  local = corner;
}
`

/** The slide fragment shader, with or without the colour table lookup. */
export const slideFragShader = (lut: boolean): string => `#version 300 es
precision highp float;

uniform sampler2D slideTexture;
// A mixed fused tile's label channels (slideFuse.ts fuseTarget), combined
// nearest with the intensity: 0 none, 1 max, 2 saturating sum.
uniform sampler2D labelTexture;
uniform int labelBlend;
${colorLutGlsl(lut)}
uniform float opacity;
uniform int isPlaceholder;
uniform int showGrid;
uniform int isNearest;
uniform vec4 placeholderColor;
uniform vec4 gridColor;

in vec2 uv;
in vec2 local;
out vec4 color;

void main(void) {
  vec4 base = placeholderColor;
  if (isPlaceholder != 1) {
    // Tile textures carry a 1-texel gutter (slide/tileGutter.ts): sample the interior.
    vec2 size = vec2(textureSize(slideTexture, 0));
    vec2 texel = uv * (size - 2.0) + 1.0;
    // Nearest skips the gutter copies, yet an edge sample (uv at 0 or 1, or
    // past it under MSAA) would read the gutter: clamp to the edge texels.
    if (isNearest == 1) texel = clamp(texel, vec2(1.5), size - 1.5);
    base = texture(slideTexture, texel / size);
    if (labelBlend != 0) {
      vec3 l = texelFetch(labelTexture, clamp(ivec2(texel), ivec2(1), ivec2(size) - 2), 0).rgb;
      base.rgb = labelBlend == 2 ? min(base.rgb + l, 1.0) : max(base.rgb, l);
    }
    base.rgb = applyColorLut(base.rgb);
  }
  base.a *= opacity;
  if (showGrid == 1) {
    // Quad-local: a cropped or flipped tile's grid still runs along its edges.
    float edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
    float border = 1.0 - smoothstep(0.0, 0.018, edge);
    base = mix(base, vec4(gridColor.rgb, max(base.a, gridColor.a)), border * gridColor.a);
  }
  color = base;
}
`
