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

// An RGB slide's channel windows on its bitmap tiles (NVSlide.rgbWindow), as
// a scale and offset per component. A variant again, so the default draw is
// unchanged; fused tiles were windowed on the fuse and draw with the identity.
// It runs before applyColorLut: the windows are in stored (device) units, as
// a fused tile's are before the table.

/** GLSL `vec3 applyRgbWindow(vec3)`; with `on`, also `uniform vec4 rgbScale, rgbOffset`. */
export const rgbWindowGlsl = (on: boolean): string =>
  on
    ? `
uniform vec4 rgbScale;
uniform vec4 rgbOffset;
vec3 applyRgbWindow(vec3 c) { return clamp(c * rgbScale.rgb + rgbOffset.rgb, 0.0, 1.0); }
`
    : `
vec3 applyRgbWindow(vec3 c) { return c; }
`

/** WGSL `applyRgbWindow(vec3f)`; with `on`, reads `u.rgbScale` and `u.rgbOffset`. */
export const rgbWindowWgsl = (on: boolean): string =>
  on
    ? `
fn applyRgbWindow(c: vec3f) -> vec3f {
  return clamp(c * u.rgbScale.rgb + u.rgbOffset.rgb, vec3f(0.0), vec3f(1.0));
}
`
    : `
fn applyRgbWindow(c: vec3f) -> vec3f { return c; }
`
