export const sliceVertShader = `#version 300 es
layout(location=0) in vec3 pos;
uniform int axCorSag;
uniform mat4 mvpMtx;
uniform mat4 frac2mm;
uniform float slice;
out vec3 texPos;

void main(void) {
  // Construct texture position based on slice orientation
  // pos.xy are in 0-1 range, slice determines depth along the slice axis
  texPos = vec3(pos.x, pos.y, slice);
  if (axCorSag > 1) {
    // Sagittal: slice is X axis
    texPos = vec3(slice, pos.x, pos.y);
  } else if (axCorSag > 0) {
    // Coronal: slice is Y axis
    texPos = vec3(pos.x, slice, pos.y);
  }
  // Axial: slice is Z axis (default)

  // Transform from fractional to mm space, then apply MVP
  vec4 mm = frac2mm * vec4(texPos, 1.0);
  gl_Position = mvpMtx * mm;
}
`

export const sliceFragShader = `#version 300 es
precision highp int;
precision highp float;

uniform highp sampler3D volume;
uniform highp sampler3D overlay;
uniform float opacity;
uniform float overlayAlphaShader;
uniform float overlayOpacity;  // opacity of overlay volume (0-1)
uniform int isAlphaClipDark;
uniform float numVolumes;  // number of loaded volumes (1 = no overlay, 2+ = has overlay)
uniform highp sampler3D drawing;
uniform float drawRimOpacity;
uniform float numPaqd;
uniform vec4 paqdUniforms;
uniform highp sampler3D paqd;
uniform highp sampler2D paqdLut;
uniform int axCorSag;
uniform int isV1SliceShader;
uniform float overlayOutlineWidth;

in vec3 texPos;
out vec4 color;

// PAQD easing function — piecewise linear alpha from primary probability.
float paqdEaseAlpha(float alpha, vec4 pu) {
    float t0 = pu[0];
    float t1 = 0.5 * (pu[0] + pu[1]);
    float t2 = pu[1];
    float y0 = 0.0;
    float y1 = abs(pu[2]);
    float y2 = abs(pu[3]);
    if (alpha <= t0) { return y0; }
    if (alpha <= t1) { return mix(y0, y1, (alpha - t0) / (t1 - t0)); }
    if (alpha <= t2) { return mix(y1, y2, (alpha - t1) / (t2 - t1)); }
    return y2;
}

void main() {
  // Sample background volume
  vec4 background = texture(volume, texPos);
  color = vec4(background.rgb, opacity);

  // Handle alpha clipping for dark values (FSLeyes style)
  if ((isAlphaClipDark != 0) && (background.a == 0.0)) {
    color.a = 0.0;
  }

  // Apply overlay alpha modulation
  color.a *= overlayAlphaShader;

  // Overlay blending (only when overlay volumes are loaded)
  if (numVolumes > 1.0) {
    {
      vec4 ocolor = texture(overlay, texPos);
      ocolor.a *= overlayOpacity;
      // V1 fiber line visualization: render colored line along fiber direction within each voxel
      if ((isV1SliceShader != 0) && (ocolor.a > 0.0)) {
        uint alpha = uint(ocolor.a * 255.0);
        vec3 xyzFlip = vec3(float((uint(1) & alpha) > uint(0)), float((uint(2) & alpha) > uint(0)), float((uint(4) & alpha) > uint(0)));
        xyzFlip = (xyzFlip * 2.0) - 1.0;
        vec3 v1 = ocolor.rgb;
        v1 = normalize(v1 * xyzFlip);
        vec3 vxl = fract(texPos * vec3(textureSize(volume, 0))) - 0.5;
        vxl.x = -vxl.x;
        float t = dot(vxl, v1);
        vec3 P = t * v1;
        float dx = length(P - vxl);
        ocolor.a = 1.0 - smoothstep(0.2, 0.25, dx);
        ocolor.a *= length(ocolor.rgb);
        ocolor.rgb = normalize(ocolor.rgb);
        float pan = 0.5;
        if (axCorSag == 0) vxl.z -= pan;
        if (axCorSag == 1) vxl.y -= pan;
        if (axCorSag == 2) vxl.x += pan;
        t = dot(vxl, v1);
        P = t * v1;
        float dx2 = length(P - vxl);
        ocolor.rgb += (dx2 - dx - 0.5 * pan);
      }
      // Overlay outline: draw black border at threshold boundary
      if (overlayOutlineWidth > 0.0) {
        vec3 vx = overlayOutlineWidth / vec3(textureSize(overlay, 0));
        vec3 vxR = vec3(texPos.x+vx.x, texPos.y, texPos.z);
        vec3 vxL = vec3(texPos.x-vx.x, texPos.y, texPos.z);
        vec3 vxA = vec3(texPos.x, texPos.y+vx.y, texPos.z);
        vec3 vxP = vec3(texPos.x, texPos.y-vx.y, texPos.z);
        vec3 vxS = vec3(texPos.x, texPos.y, texPos.z+vx.z);
        vec3 vxI = vec3(texPos.x, texPos.y, texPos.z-vx.z);
        if (ocolor.a < 1.0) {
          // Sub-threshold voxel: check if any in-plane neighbor is supra-threshold
          float na = 0.0;
          if (axCorSag != 2) { na = max(na, texture(overlay, vxR).a); na = max(na, texture(overlay, vxL).a); }
          if (axCorSag != 1) { na = max(na, texture(overlay, vxA).a); na = max(na, texture(overlay, vxP).a); }
          if (axCorSag != 0) { na = max(na, texture(overlay, vxS).a); na = max(na, texture(overlay, vxI).a); }
          // In-plane diagonal corners
          if (axCorSag == 0) { na = max(na, texture(overlay, vec3(texPos.x+vx.x, texPos.y+vx.y, texPos.z)).a); na = max(na, texture(overlay, vec3(texPos.x-vx.x, texPos.y+vx.y, texPos.z)).a); na = max(na, texture(overlay, vec3(texPos.x+vx.x, texPos.y-vx.y, texPos.z)).a); na = max(na, texture(overlay, vec3(texPos.x-vx.x, texPos.y-vx.y, texPos.z)).a); }
          if (axCorSag == 1) { na = max(na, texture(overlay, vec3(texPos.x+vx.x, texPos.y, texPos.z+vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x-vx.x, texPos.y, texPos.z+vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x+vx.x, texPos.y, texPos.z-vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x-vx.x, texPos.y, texPos.z-vx.z)).a); }
          if (axCorSag == 2) { na = max(na, texture(overlay, vec3(texPos.x, texPos.y+vx.y, texPos.z+vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x, texPos.y-vx.y, texPos.z+vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x, texPos.y+vx.y, texPos.z-vx.z)).a); na = max(na, texture(overlay, vec3(texPos.x, texPos.y-vx.y, texPos.z-vx.z)).a); }
          if (na >= 1.0) { ocolor = vec4(0.0, 0.0, 0.0, 1.0); }
        } else {
          // Supra-threshold voxel: check if any in-plane neighbor is sub-threshold
          float na = 1.0;
          if (axCorSag != 2) { na = min(na, texture(overlay, vxR).a); na = min(na, texture(overlay, vxL).a); }
          if (axCorSag != 1) { na = min(na, texture(overlay, vxA).a); na = min(na, texture(overlay, vxP).a); }
          if (axCorSag != 0) { na = min(na, texture(overlay, vxS).a); na = min(na, texture(overlay, vxI).a); }
          if (na < 1.0) { ocolor = vec4(0.0, 0.0, 0.0, 1.0); }
        }
      }
      float a = color.a + ocolor.a * (1.0 - color.a);
      if (a > 0.0) {
        color.rgb = mix(color.rgb, ocolor.rgb, ocolor.a / a);
        color.a = a;
      }
    }
  }

  // PAQD blending (raw data with GPU-side LUT lookup + easing)
  // Label indices use nearest-neighbor (texelFetch); probabilities use linear
  // interpolation (texture()) for smooth distance-field boundaries.
  if (numPaqd > 0.0) {
    ivec3 pDims = textureSize(paqd, 0);
    if (pDims.x > 2) {
      // Nearest: label indices (R,G) — interpolating discrete indices is meaningless
      ivec3 pCoord = clamp(ivec3(texPos * vec3(pDims)), ivec3(0), pDims - 1);
      vec4 raw = texelFetch(paqd, pCoord, 0);
      // Linear: probabilities (B,A) — smooth distance-field-like alpha
      vec4 smoothProb = texture(paqd, texPos);
      float prob1 = smoothProb.b;
      float prob2 = smoothProb.a;
      float total = prob1 + prob2;
      if (total > 0.004) {
        int idx1 = int(round(raw.r * 255.0));
        int idx2 = int(round(raw.g * 255.0));
        vec4 c1 = texelFetch(paqdLut, ivec2(clamp(idx1, 0, 255), 0), 0);
        vec4 c2 = texelFetch(paqdLut, ivec2(clamp(idx2, 0, 255), 0), 0);
        float w = prob2 / total;
        vec3 prgb = mix(c1.rgb, c2.rgb, w);
        float palpha = paqdEaseAlpha(prob1, paqdUniforms);
        if (palpha > 0.0) {
          // Always blend PAQD in front for 2D slices (background is typically opaque)
          float a = palpha + color.a * (1.0 - palpha);
          color = vec4(mix(color.rgb, prgb, palpha / max(a, 0.001)), a);
        }
      }
    }
  }

  // Discard fully transparent pixels so they don't write to the depth buffer
  // (allows meshes behind transparent slice areas to show through)
  if (color.a <= 0.0) {
    discard;
  }

  // Drawing overlay (nearest-neighbor via texelFetch) — always runs
  ivec3 drawDims = textureSize(drawing, 0);
  ivec3 drawCoord = clamp(ivec3(texPos * vec3(drawDims)), ivec3(0), drawDims - 1);
  vec4 drawColor = texelFetch(drawing, drawCoord, 0);
  if (drawColor.a > 0.0) {
    float da = drawColor.a;
    if (drawRimOpacity >= 0.0) {
      vec3 offsetX = dFdx(texPos);
      vec3 offsetY = dFdy(texPos);
      vec3 L = texture(drawing, texPos - offsetX).rgb;
      vec3 R = texture(drawing, texPos + offsetX).rgb;
      vec3 T = texture(drawing, texPos - offsetY).rgb;
      vec3 B = texture(drawing, texPos + offsetY).rgb;
      vec3 drawV = drawColor.rgb;
      if (any(notEqual(L, drawV)) || any(notEqual(R, drawV)) ||
          any(notEqual(T, drawV)) || any(notEqual(B, drawV)))
        da = drawRimOpacity;
    }
    color.rgb = mix(color.rgb, drawColor.rgb, da);
    color.a = max(color.a, drawColor.a);
  }
}
`
