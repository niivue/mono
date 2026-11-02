// 3D Sobel of raw HU: derivative along one axis, [1,2,1] smoothing across the
// other two. Output is dHU/dvoxel in RAS texture axes, unnormalised, so the
// render pass can classify by calibrated gradient magnitude (HU/mm).

@group(0) @binding(0) var huTex: texture_3d<f32>;
@group(0) @binding(1) var outTex: texture_storage_3d<rgba16float, write>;

fn hu(p: vec3i, dims: vec3i) -> f32 {
  return textureLoad(huTex, clamp(p, vec3i(0), dims - 1), 0).r;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec3i(textureDimensions(huTex));
  let p = vec3i(gid);
  if (any(p >= dims)) { return; }
  var g = vec3f(0.0);
  for (var k = -1; k <= 1; k++) {
    for (var j = -1; j <= 1; j++) {
      let w = f32((2 - abs(j)) * (2 - abs(k)));
      g.x += w * (hu(p + vec3i(1, j, k), dims) - hu(p + vec3i(-1, j, k), dims));
      g.y += w * (hu(p + vec3i(j, 1, k), dims) - hu(p + vec3i(j, -1, k), dims));
      g.z += w * (hu(p + vec3i(j, k, 1), dims) - hu(p + vec3i(j, k, -1), dims));
    }
  }
  // Weights sum to 16, central difference spans 2 voxels.
  textureStore(outTex, p, vec4f(g / 32.0, 0.0));
}
