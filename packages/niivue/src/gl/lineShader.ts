export const lineVertShader = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
// Line data passed as vertex attributes (using instancing)
// Each instance is one line
in vec2 lineStart;
in vec2 lineEnd;
in float lineThickness;
in vec4 lineColor;
out vec4 vColor;

void main() {
  int vIdx = gl_VertexID;
  // Calculate line geometry in pixel space
  vec2 delta = lineEnd - lineStart;
  vec2 dir = normalize(delta);
  vec2 perp = vec2(-dir.y, dir.x);
  float halfThickness = lineThickness * 0.5;
  // Define quad vertices (0, 1, 2, 3) around the line segment
  vec2 offset;
  if (vIdx == 0) { 
      offset = -perp * halfThickness; 
  } else if (vIdx == 1) { 
      offset = perp * halfThickness; 
  } else if (vIdx == 2) { 
      offset = -perp * halfThickness + delta; 
  } else { // vIdx == 3
      offset = perp * halfThickness + delta; 
  }
  vec2 pixelPos = lineStart + offset;
  // Map pixel coordinates to NDC (-1 to 1)
  vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
  // Flip Y for NDC: GL Y is up, screen coords are down
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vColor = lineColor;
}
`

export const lineFragShader = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;

void main() {
  fragColor = vColor;
}
`
