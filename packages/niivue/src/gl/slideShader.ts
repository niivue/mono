export const slideVertShader = `#version 300 es
layout(location=0) in vec2 pos;
layout(location=1) in vec2 uvIn;

out vec2 uv;

void main(void) {
  gl_Position = vec4(pos, 0.0, 1.0);
  uv = uvIn;
}
`

export const slideFragShader = `#version 300 es
precision highp float;

uniform sampler2D slideTexture;
uniform float opacity;
uniform int isPlaceholder;
uniform int showGrid;
uniform vec4 placeholderColor;
uniform vec4 gridColor;

in vec2 uv;
out vec4 color;

void main(void) {
  vec4 base = isPlaceholder == 1 ? placeholderColor : texture(slideTexture, uv);
  base.a *= opacity;
  if (showGrid == 1) {
    float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    float border = 1.0 - smoothstep(0.0, 0.018, edge);
    base = mix(base, vec4(gridColor.rgb, max(base.a, gridColor.a)), border * gridColor.a);
  }
  color = base;
}
`
