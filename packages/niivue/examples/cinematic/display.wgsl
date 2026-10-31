// Resolve the progressive accumulation: mean, background composite, ACES
// tone map, sRGB encode.

struct Display {
  res: vec2f,
  frames: f32,
  exposure: f32,
  bg: vec4f,
}

@group(0) @binding(0) var<storage, read> accum: array<vec4f>;
@group(0) @binding(1) var<uniform> D: Display;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2u(pos.xy);
  let c = accum[p.y * u32(D.res.x) + p.x] / max(D.frames, 1.0);
  let bgLin = pow(D.bg.rgb, vec3f(2.2));
  let rgb = aces(c.rgb * D.exposure) + bgLin * (1.0 - c.a);
  return vec4f(pow(rgb, vec3f(1.0 / 2.2)), 1.0);
}
