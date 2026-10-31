// Blood-likelihood weight into grad.w: ramps up with distance to dense bone
// (HU > T) and is zero inside the morphological closing of dense bone by a
// ball of radius rc (cancellous interiors enclosed by cortex). Only the
// preset's blood band is attenuated; bone and soft tissue keep w = 1.
// d1sq: squared distance (mm^2) to HU > T; d2sq: squared distance to voxels
// farther than rc from dense bone (so d2sq >= rc^2 means inside the closing).

struct Params {
  d0: f32, // mm, weight 0 below
  d1: f32, // mm, weight 1 above
  rc2: f32, // rc^2, 0 disables the closing term
  pad: f32,
  band: vec4f, // HU ramp in (lo0, lo1) and out (hi0, hi1) of the blood band
}

@group(0) @binding(0) var d1sq: texture_3d<f32>;
@group(0) @binding(1) var d2sq: texture_3d<f32>;
@group(0) @binding(2) var gradTex: texture_3d<f32>;
@group(0) @binding(3) var outTex: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var<uniform> U: Params;
@group(0) @binding(5) var huTex: texture_3d<f32>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let p = vec3i(gid);
  if (any(p >= vec3i(textureDimensions(gradTex)))) { return; }
  var w = smoothstep(U.d0, U.d1, sqrt(textureLoad(d1sq, p, 0).r));
  if (U.rc2 > 0.0 && textureLoad(d2sq, p, 0).r >= U.rc2) { w = 0.0; }
  let hu = textureLoad(huTex, p, 0).r;
  let band = smoothstep(U.band.x, U.band.y, hu) * (1.0 - smoothstep(U.band.z, U.band.w, hu));
  textureStore(outTex, p, vec4f(textureLoad(gradTex, p, 0).xyz, 1.0 - band * (1.0 - w)));
}
