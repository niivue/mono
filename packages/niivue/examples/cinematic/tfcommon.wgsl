// Prepended to the march and extinction passes so primary rays and shadows
// classify identically. tf = (huMin, huMax, gMax HU/mm, refStep mm).

// Texel-centre mapping onto the 256 x 64 table. The gradient axis is
// sqrt-spaced to spend rows on the small gradients where tissue lives.
fn tfUV(hu: f32, g: f32, tf: vec4f) -> vec2f {
  let x = clamp((hu - tf.x) / (tf.y - tf.x), 0.0, 1.0);
  let y = sqrt(clamp(g / tf.z, 0.0, 1.0));
  return vec2f(x * (255.0 / 256.0) + (0.5 / 256.0), y * (63.0 / 64.0) + (0.5 / 64.0));
}

// Labels pick the material; the intensity still shapes it. `materials` (two
// vec4 per label: rgb + opacity, then HU ramp lo/hi, specular, -) and
// `matTex` (material id per voxel, 255 = hidden) are declared by each pass.
const HIDDEN_LABEL: u32 = 255u;

// Table alpha (per refStep) of a labelled sample: the label's opacity times
// its HU ramp, so the surface sits within the partial-volume voxels.
fn labelAlpha(id: u32, hu: f32) -> f32 {
  if (id == HIDDEN_LABEL) { return 0.0; }
  let ramp = materials[2u * id + 1u];
  return materials[2u * id].a * smoothstep(ramp.x, ramp.y, hu);
}

// Extinction per mm of a table alpha defined per refStep mm. The clamp keeps
// fully opaque entries finite.
fn extinction(a: f32, refStep: f32) -> f32 {
  return -log(1.0 - min(a, 0.9999)) / refStep;
}
