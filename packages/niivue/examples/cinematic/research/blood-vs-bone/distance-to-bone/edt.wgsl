// One axis of a separable squared Euclidean distance transform (brute-force
// 1D window, exact within `cap` mm). Three dispatches (x, y, z) give the
// squared distance in mm^2 to the nearest seed voxel, capped at cap^2.
// mode 0 seeds: src > thresh is distance 0, else far (first axis).
// mode 1 propagates: src is the previous axis's squared distance.

struct Params {
  axis: u32,
  mode: u32,
  window: i32, // half window in voxels along `axis`
  pad: u32,
  spacing: f32, // mm per voxel along `axis`
  thresh: f32,
  cap2: f32, // cap^2
  pad2: f32,
}

@group(0) @binding(0) var src: texture_3d<f32>;
@group(0) @binding(1) var dst: texture_storage_3d<r32float, write>;
@group(0) @binding(2) var<uniform> U: Params;

fn value(p: vec3i) -> f32 {
  let v = textureLoad(src, p, 0).r;
  if (U.mode == 0u) { return select(U.cap2, 0.0, v > U.thresh); }
  return v;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec3i(textureDimensions(src));
  let p = vec3i(gid);
  if (any(p >= dims)) { return; }
  var step = vec3i(0);
  step[U.axis] = 1;
  var best = min(value(p), U.cap2);
  for (var k = 1; k <= U.window; k++) {
    let d2 = f32(k) * U.spacing * f32(k) * U.spacing;
    if (d2 >= best) { break; }
    let a = p + k * step;
    let b = p - k * step;
    if (a[U.axis] < dims[U.axis]) { best = min(best, value(a) + d2); }
    if (b[U.axis] >= 0) { best = min(best, value(b) + d2); }
  }
  textureStore(dst, p, vec4f(best, 0.0, 0.0, 0.0));
}
