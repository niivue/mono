@group(0) @binding(0) var inputTex: texture_3d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec3<i32>(textureDimensions(inputTex));
  let pos = vec3<i32>(id);
  if (pos.x >= size.x || pos.y >= size.y || pos.z >= size.z) { return; }
  var total_color = vec4<f32>(0.0);
  // Using the 1.0, 0.5, 0.25, 0.125 weights (normalized sum is 8.0)
  //let weights = array<f32, 4>(8.0, 0.0, 0.0, 0.0);
  let weights = array<f32, 4>(1.0, 0.5, 0.25, 0.125);
  for (var dz: i32 = -1; dz <= 1; dz++) {
      for (var dy: i32 = -1; dy <= 1; dy++) {
          for (var dx: i32 = -1; dx <= 1; dx++) {
              let neighbor_pos = clamp(pos + vec3<i32>(dx, dy, dz), vec3<i32>(0), size - 1);
              let dist_idx = abs(dx) + abs(dy) + abs(dz);
              let w = weights[dist_idx];
              total_color += textureLoad(inputTex, neighbor_pos, 0) * w;
          }
      }
  }
  // Divide by the sum of weights (8.0)
  textureStore(outputTex, id, total_color * 0.125);
}