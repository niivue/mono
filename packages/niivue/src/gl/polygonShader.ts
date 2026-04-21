export const polygonVertShader = `#version 300 es
precision highp float;

uniform vec2 canvasSize;

layout(location = 0) in vec2 position;
layout(location = 1) in vec4 color;

out vec4 vColor;

void main() {
  vec2 ndc = (position / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vColor = color;
}
`

export const polygonFragShader = `#version 300 es
precision highp float;

in vec4 vColor;
out vec4 fragColor;

void main() {
  fragColor = vColor;
}
`
