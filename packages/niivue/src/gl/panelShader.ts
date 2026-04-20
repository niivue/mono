export const panelVertShader = `#version 300 es
precision highp float;
uniform vec2 canvasSize;
in vec4 panelRect;
in vec4 panelColor;
in float panelRadius;
out vec4 vColor;
out vec2 vLocalPos;
out vec2 vSize;
out float vRadius;

void main() {
  int vIdx = gl_VertexID;
  vec2 pos = vec2(0.0);
  if (vIdx == 1) { pos.x = 1.0; }
  else if (vIdx == 2) { pos.y = 1.0; }
  else if (vIdx == 3) { pos = vec2(1.0); }
  vec2 pixelPos = panelRect.xy + pos * panelRect.zw;
  vec2 ndc = (pixelPos / canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vColor = panelColor;
  vLocalPos = pos * panelRect.zw;
  vSize = panelRect.zw;
  vRadius = panelRadius;
}
`;

export const panelFragShader = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vLocalPos;
in vec2 vSize;
in float vRadius;
out vec4 fragColor;

float roundedRectDistance(vec2 localPos, vec2 size, float radius) {
  float r = max(radius, 0.0);
  vec2 halfSize = size * 0.5;
  vec2 q = abs(localPos - halfSize) - (halfSize - vec2(r));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float dist = roundedRectDistance(vLocalPos, vSize, vRadius);
  float aa = fwidth(dist);
  float alpha = 1.0 - smoothstep(-aa, aa, dist);
  if (alpha <= 0.0) { discard; }
  fragColor = vec4(vColor.rgb, vColor.a * alpha);
}
`;
