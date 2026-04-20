// Unified orient compute shader: transforms a scalar volume to RGBA8 via matrix,
// calibration, and colormap lookup. Handles both base volumes and overlays.
// Matches the WebGL2 orientOverlay fragment shader for identical results.

struct Uniforms {
  mtxRow0   : vec4<f32>,  // transformation matrix row 0 (output → input texture coords)
  mtxRow1   : vec4<f32>,  // transformation matrix row 1
  mtxRow2   : vec4<f32>,  // transformation matrix row 2
  mtxRow3   : vec4<f32>,  // transformation matrix row 3
  params    : vec4<f32>,  // slope, intercept, cal_min, cal_max
  negParams : vec4<f32>,  // cal_minNeg, cal_maxNeg, isAlphaThreshold, isColorbarFromZero
  flags     : vec4<f32>,  // overlayOpacity, isLabel, labelMin, labelWidth
};

@group(0) @binding(0) var<uniform> u : Uniforms;

// The host replaces "texture_3d<u32>" with "texture_3d<f32>" or "texture_3d<i32>"
@group(0) @binding(1) var scalarTex : texture_3d<u32>;
@group(0) @binding(2) var colorMap  : texture_2d<f32>;
@group(0) @binding(3) var rgbaOut   : texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(4) var samp      : sampler;
@group(0) @binding(5) var colorMapNeg : texture_2d<f32>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let outX = i32(gid.x);
  let outY = i32(gid.y);
  let outZ = i32(gid.z);

  let dimsOut = textureDimensions(rgbaOut);
  if (outX >= i32(dimsOut.x) || outY >= i32(dimsOut.y) || outZ >= i32(dimsOut.z)) {
    return;
  }

  // Convert output voxel to normalized texture coordinates (0-1), center of voxel
  let outUVW = (vec3<f32>(f32(outX), f32(outY), f32(outZ)) + 0.5) / vec3<f32>(dimsOut);

  // Transform from output texture space to input texture space via matrix
  let outPos = vec4<f32>(outUVW, 1.0);
  let inU = dot(u.mtxRow0, outPos);
  let inV = dot(u.mtxRow1, outPos);
  let inW = dot(u.mtxRow2, outPos);

  // Check bounds - set transparent if outside input volume
  if (inU < 0.0 || inU > 1.0 ||
      inV < 0.0 || inV > 1.0 ||
      inW < 0.0 || inW > 1.0) {
    textureStore(rgbaOut, vec3<i32>(outX, outY, outZ), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  // Convert normalized coords to texel indices (nearest neighbor, matching WebGL2)
  let dimsIn = vec3<f32>(textureDimensions(scalarTex));
  let texelCoord = vec3<i32>(clamp(vec3<f32>(inU, inV, inW) * dimsIn, vec3<f32>(0.0), dimsIn - vec3<f32>(1.0)));

  // Fetch scalar and cast to f32
  let texel = textureLoad(scalarTex, texelCoord, 0);
  let val = f32(texel.r);

  // Calibration: calibrated = raw * slope + intercept
  let slope = u.params.x;
  let intercept = u.params.y;
  let calmin = u.params.z;
  let calmax = u.params.w;
  let calminNeg = u.negParams.x;
  let calmaxNeg = u.negParams.y;
  let isAlphaThreshold = u.negParams.z;
  let isColorbarFromZero = u.negParams.w;
  let f = val * slope + intercept;

  // Label colormap: discrete integer index → LUT color
  let isLabel = u.flags.y;
  if (isLabel > 0.5) {
    let rawLabel = i32(round(f));
    // Index 0 is always unlabeled (air/background) → transparent
    if (rawLabel == 0) {
      textureStore(rgbaOut, vec3<i32>(outX, outY, outZ), vec4<f32>(0.0));
      return;
    }
    let labelMin = u.flags.z;
    let labelWidth = u.flags.w;
    let labelIdx = rawLabel - i32(labelMin);
    let clampedIdx = clamp(labelIdx, 0, i32(labelWidth) - 1);
    let texCoord = (f32(clampedIdx) + 0.5) / labelWidth;
    var labelColor = textureSampleLevel(colorMap, samp, vec2<f32>(clamp(texCoord, 0.0, 1.0), 0.5), 0.0);
    let overlayOpacityLabel = u.flags.x;
    if (overlayOpacityLabel > 0.0) {
      labelColor.a *= overlayOpacityLabel;
    }
    textureStore(rgbaOut, vec3<i32>(outX, outY, outZ), labelColor);
    return;
  }

  // Positive colormap
  var mn = calmin;
  var mx = calmax;
  if (isAlphaThreshold > 0.5 || isColorbarFromZero > 0.5) {
    mn = 0.0;
  }
  var r = max(0.00001, abs(mx - mn));
  mn = min(mn, mx);
  var txl = (f - mn) / r;
  if (f > mn) {
    txl = max(txl, 2.0 / 256.0);
  }
  var color = textureSampleLevel(colorMap, samp, vec2<f32>(clamp(txl, 0.0, 1.0), 0.5), 0.0);

  // Negative colormap
  mn = calminNeg;
  mx = calmaxNeg;
  if (isAlphaThreshold > 0.5 || isColorbarFromZero > 0.5) {
    mx = 0.0;
  }
  if (calminNeg < calmaxNeg && f < mx) {
    r = max(0.00001, abs(mx - mn));
    mn = min(mn, mx);
    txl = 1.0 - (f - mn) / r;
    txl = max(txl, 2.0 / 256.0);
    color = textureSampleLevel(colorMapNeg, samp, vec2<f32>(clamp(txl, 0.0, 1.0), 0.5), 0.0);
  }

  // Overlay: make alpha binary (fully opaque or fully transparent)
  let overlayOpacity = u.flags.x;
  if (overlayOpacity > 0.0) {
    color.a = step(0.00001, color.a);
  }

  // Alpha threshold effects
  if (isAlphaThreshold > 0.5) {
    if (calminNeg != calmaxNeg && f < 0.0 && f > calmaxNeg) {
      color.a = pow(-f / -calmaxNeg, 2.0);
    } else if (f > 0.0 && calmin > 0.0) {
      color.a *= pow(f / calmin, 2.0);
    }
  } else if (isColorbarFromZero > 0.5) {
    if (calminNeg != calmaxNeg && f < 0.0 && f > calmaxNeg) {
      color.a = 0.0;
    } else if (f > 0.0 && calmin > 0.0 && f < calmin) {
      color.a = 0.0;
    }
  }

  // Bake overlay opacity into alpha for pre-integration
  if (overlayOpacity > 0.0) {
    color.a *= overlayOpacity;
  }

  textureStore(rgbaOut, vec3<i32>(outX, outY, outZ), color);
}
