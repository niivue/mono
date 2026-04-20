struct Uniforms {
  mvpMatrix: mat4x4f,
  opacityMultiplier: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) color: vec4f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vertex_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = u.mvpMatrix * vec4f(in.position, 1.0);
  out.color = vec4f(in.color.rgb, in.color.a * u.opacityMultiplier);
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  return in.color;
}
