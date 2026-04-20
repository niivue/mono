export const polygon3dVertShader = `#version 300 es
precision highp float;

uniform mat4 mvpMatrix;
uniform float opacityMultiplier;

layout(location = 0) in vec3 position;
layout(location = 1) in vec4 color;

out vec4 vColor;

void main() {
  gl_Position = mvpMatrix * vec4(position, 1.0);
  vColor = vec4(color.rgb, color.a * opacityMultiplier);
}
`;

export const polygon3dFragShader = `#version 300 es
precision highp float;

in vec4 vColor;
out vec4 fragColor;

void main() {
  fragColor = vColor;
}
`;
