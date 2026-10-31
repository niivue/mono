// Classify the volume once per transfer function (tfcommon.wgsl is prepended): extinction (per mm) averaged
// over each 2x2x2 block into a half-resolution texture. Its mip chain lets
// shadow and AO rays cone-trace: one fetch per step, coarser with distance.

struct ExtParams {
  gradToMM: mat4x4f,
  tf: vec4f, // huMin, huMax, gMax, refStep
}

@group(0) @binding(0) var huTex: texture_3d<f32>;
@group(0) @binding(1) var gradTex: texture_3d<f32>;
@group(0) @binding(2) var tfColor: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> E: ExtParams;
@group(0) @binding(5) var outTex: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let q = vec3i(gid);
  if (any(q >= vec3i(textureDimensions(outTex)))) { return; }
  let dims = vec3i(textureDimensions(huTex));
  let toMM = mat3x3f(E.gradToMM[0].xyz, E.gradToMM[1].xyz, E.gradToMM[2].xyz);
  var sigma = 0.0;
  for (var i = 0; i < 8; i++) {
    let p = clamp(2 * q + vec3i(i & 1, (i >> 1) & 1, i >> 2), vec3i(0), dims - 1);
    let hu = textureLoad(huTex, p, 0).r;
    let g = length(toMM * textureLoad(gradTex, p, 0).xyz);
    let a = textureSampleLevel(tfColor, samp, tfUV(hu, g, E.tf), 0.0).a;
    sigma += extinction(a, E.tf.w);
  }
  textureStore(outTex, q, vec4f(sigma * 0.125, 0.0, 0.0, 0.0));
}
