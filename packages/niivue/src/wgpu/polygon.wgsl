struct PolygonUniforms {
  canvasSize: vec2f,
};

@group(0) @binding(0) var<uniform> u: PolygonUniforms;

struct VertexInput {
  @location(0) position: vec2f,
  @location(1) color: vec4f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vertex_main(in: VertexInput) -> VertexOutput {
  let ndc = (in.position / u.canvasSize) * 2.0 - 1.0;
  var out: VertexOutput;
  out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  return in.color;
}
