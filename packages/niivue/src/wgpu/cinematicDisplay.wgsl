// Resolve a tile's progressive accumulation inside NiiVue's render pass:
// mean, background composite, ACES tone map, sRGB encode. Writes the first
// hit's depth so meshes and the crosshair drawn after it depth-test against
// the volume. The triangle covers the tile's viewport.

struct Display {
  res: vec2f, // tile size, device px
  frames: f32,
  exposure: f32,
  bg: vec4f,
  origin: vec4f, // xy: tile left/top in the render target, device px
}

@group(0) @binding(0) var<storage, read> accum: array<vec4f>;
@group(0) @binding(1) var<uniform> D: Display;
@group(0) @binding(2) var<storage, read> depthIn: array<f32>;

struct FragOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> FragOut {
  let res = vec2u(D.res);
  let p = min(vec2u(max(pos.xy - D.origin.xy, vec2f(0.0))), res - 1u);
  let idx = p.y * res.x + p.x;
  let c = accum[idx] / max(D.frames, 1.0);
  let bgLin = pow(D.bg.rgb, vec3f(2.2)) * D.bg.a;
  let rgb = aces(c.rgb * D.exposure) + bgLin * (1.0 - c.a);
  var out: FragOut;
  out.color = vec4f(pow(rgb, vec3f(1.0 / 2.2)), c.a + D.bg.a * (1.0 - c.a));
  out.depth = depthIn[idx];
  return out;
}
