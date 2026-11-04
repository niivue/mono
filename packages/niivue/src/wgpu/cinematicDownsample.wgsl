// One mip level of the extinction chain: mean of the source block. Along an
// axis with an odd source size the destination has floor(n/2) texels, so each
// reads three source texels there; two would drop the last texel and shift
// coarse data away from where it sits, which breaks empty-space skipping.

@group(0) @binding(0) var src: texture_3d<f32>;
@group(0) @binding(1) var dst: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let q = vec3i(gid);
  if (any(q >= vec3i(textureDimensions(dst)))) { return; }
  let srcDims = vec3i(textureDimensions(src));
  let last = srcDims - 1;
  let taps = vec3i(2) + (srcDims & vec3i(1));
  var sum = 0.0;
  for (var z = 0; z < taps.z; z++) {
    for (var y = 0; y < taps.y; y++) {
      for (var x = 0; x < taps.x; x++) {
        sum += textureLoad(src, min(2 * q + vec3i(x, y, z), last), 0).r;
      }
    }
  }
  textureStore(dst, q, vec4f(sum / f32(taps.x * taps.y * taps.z), 0.0, 0.0, 0.0));
}
