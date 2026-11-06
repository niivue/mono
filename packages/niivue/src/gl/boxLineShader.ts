// Box edges in world mm, projected per render tile (mirrors wgpu/boxLine.wgsl).
export const boxLineVertShader = `#version 300 es
precision highp float;
uniform mat4 mvp;
uniform vec2 tileSize;
in vec3 lineStart;
in vec3 lineEnd;
in float lineThickness;
in vec4 lineColor;
out vec4 vColor;

void main() {
  vColor = lineColor;
  vec4 a = mvp * vec4(lineStart, 1.0);
  vec4 b = mvp * vec4(lineEnd, 1.0);
  // An edge with a corner at or behind the camera is dropped.
  if (a.w <= 1e-6 || b.w <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  // Thickness is in pixels: expand the quad in tile pixel space.
  vec2 pa = (a.xy / a.w * 0.5 + 0.5) * tileSize;
  vec2 delta = (b.xy / b.w * 0.5 + 0.5) * tileSize - pa;
  vec2 perp = vec2(-delta.y, delta.x) / max(length(delta), 1e-6);
  float side = (gl_VertexID % 2 == 0) ? 0.5 : -0.5;
  vec2 pixelPos = pa + perp * (side * lineThickness) + (gl_VertexID >= 2 ? delta : vec2(0.0));
  gl_Position = vec4(pixelPos / tileSize * 2.0 - 1.0, 0.0, 1.0);
}
`

export const boxLineFragShader = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;

void main() {
  fragColor = vColor;
}
`
