// Shader text that applies a slide's ICC -> sRGB table (NVSlide.displayColorLut)
// to a decoded tile colour, shared by the slide and slide-plane renderers. Each
// renderer compiles both variants and uses the plain one when the table is the
// identity: the extra 3D fetch costs ~45% of a full-canvas draw on SwiftShader.
// Node centres of an n^3 table: (n - 1) / n scale, 0.5 / n offset.

/** GLSL `vec3 applyColorLut(vec3)`; with `lut`, also `uniform highp sampler3D colorLut`. */
export const colorLutGlsl = (lut: boolean): string =>
  lut
    ? `
uniform highp sampler3D colorLut;
vec3 applyColorLut(vec3 c) {
  float n = float(textureSize(colorLut, 0).x);
  return texture(colorLut, c * ((n - 1.0) / n) + 0.5 / n).rgb;
}
`
    : `
vec3 applyColorLut(vec3 c) { return c; }
`

/** WGSL `applyColorLut(vec3f)`; with `lut`, the table and sampler in bind group `group`. */
export const colorLutWgsl = (group: number, lut: boolean): string =>
  lut
    ? `
@group(${group}) @binding(0) var colorLut: texture_3d<f32>;
@group(${group}) @binding(1) var colorLutSampler: sampler;
fn applyColorLut(c: vec3f) -> vec3f {
  let n = f32(textureDimensions(colorLut).x);
  // The table has no mips: sample level 0, independent of control-flow uniformity.
  return textureSampleLevel(colorLut, colorLutSampler, c * ((n - 1.0) / n) + 0.5 / n, 0.0).rgb;
}
`
    : `
fn applyColorLut(c: vec3f) -> vec3f { return c; }
`
