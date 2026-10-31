// Progressive cinematic ray march (VOLUME_RENDER_MODE.CINEMATIC) of one
// render tile; cinematicCommon.wgsl is prepended. One sample per pixel per
// frame: jittered ray start, sub-pixel offset, soft light cone and a random AO
// direction all change every frame, so the running sum in `accum` converges
// to an anti-aliased image with soft shadows. Frame 0 also stores the first
// hit's depth, which the display pass writes so meshes composite by depth.

struct Params {
  mm2frac: mat4x4f,
  gradToMM: mat4x4f, // upper 3x3: dHU/dvoxel (RAS texture axes) -> dHU/dmm
  invMVP: mat4x4f, // the render tile's MVP, inverted: NDC -> mm
  view: vec4f, // resX, resY, volumetric (normal-free) diffuse term, specular scale
  light: vec4f, // xyz toward light (world), w = tan(cone half angle)
  tf: vec4f, // huMin, huMax, gMax (HU/mm), refStep (mm)
  march: vec4f, // stepMM, frame, shadow strength, ambient
  ao: vec4f, // strength, radius (mm), light intensity, shininess
  ext: vec4f, // extinction voxel (mm), empty-skip lod, empty-skip distance (mm), tan(AO cone)
  // NiiVue clip planes in texture space, scaled so dot(xyz, p) - w is mm from
  // the plane; >= 0 is the side a solid clip keeps.
  clip: array<vec4f, 6>,
  clipN: array<vec4f, 6>, // unit plane normals in mm space
  clipInfo: vec4f, // active plane count, cutaway (0/1), -, -
  labelInfo: vec4f, // labels on (0/1), unlabeled tissue scale, label colour blend (0 = label materials), background visible (0/1)
  overlayInfo: vec4f, // standard overlays on, clip with anatomy, inverse gamma, correct step opacity
}

@group(0) @binding(0) var huTex: texture_3d<f32>;
@group(0) @binding(1) var gradTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tfColor: texture_2d<f32>;
@group(0) @binding(4) var tfMat: texture_2d<f32>;
@group(0) @binding(5) var tfMaxA: texture_2d<f32>;
@group(0) @binding(6) var<uniform> P: Params;
@group(0) @binding(7) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(8) var extTex: texture_3d<f32>; // extinction per mm, half res + mips
@group(0) @binding(9) var matTex: texture_3d<u32>;
@group(0) @binding(10) var matTable: texture_2d<f32>;
@group(0) @binding(11) var<storage, read_write> depthOut: array<f32>; // NDC depth of the first hit, frame 0
@group(0) @binding(12) var overlayTex: texture_3d<f32>;

var<private> rng: u32;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rand() -> f32 {
  rng = pcg(rng);
  return f32(rng) * (1.0 / 4294967296.0);
}

fn gradMM(pf: vec3f) -> vec3f {
  let gv = textureSampleLevel(gradTex, samp, pf, 0.0).xyz;
  return mat3x3f(P.gradToMM[0].xyz, P.gradToMM[1].xyz, P.gradToMM[2].xyz) * gv;
}

// Opacity of one step of `stepMM`, from the per-refStep table alpha.
fn stepAlpha(a: f32, stepMM: f32) -> f32 {
  return 1.0 - exp(-extinction(a, P.tf.w) * stepMM);
}

fn inBox(p: vec3f) -> bool {
  return all(p >= vec3f(0.0)) && all(p <= vec3f(1.0));
}

// Solid clip keeps the intersection of the planes' kept sides; cutaway removes
// exactly that intersection (NiiVue's convention).
fn isVisible(p: vec3f) -> bool {
  let count = i32(P.clipInfo.x);
  if (count == 0) { return true; }
  var inAll = true;
  for (var i = 0; i < count; i++) {
    inAll = inAll && (dot(P.clip[i].xyz, p) - P.clip[i].w >= 0.0);
  }
  return inAll != (P.clipInfo.y > 0.5);
}

// Cone-traced transmittance: the step and the mip level grow with the cone
// footprint, so a ray across the body costs ~tens of fetches, not ~1000.
fn coneTransmittance(pf: vec3f, dirMM: vec3f, tanHalf: f32, maxMM: f32) -> f32 {
  let df = (P.mm2frac * vec4f(dirMM, 0.0)).xyz;
  let base = P.ext.x;
  var t = base * (0.5 + 0.5 * rand());
  var tau = 0.0;
  for (var i = 0; i < 128; i++) {
    if (t > maxMM) { break; }
    let p = pf + df * t;
    if (!inBox(p)) { break; }
    let diam = max(base, 2.0 * t * tanHalf);
    let dt = 0.5 * diam;
    // Clipped-away material casts no shadow.
    if (isVisible(p)) {
      tau += textureSampleLevel(extTex, samp, p, log2(diam / base)).r * dt;
    }
    if (tau > 6.0) { break; } // transmittance < 0.25%: fully shadowed
    t += dt;
  }
  return exp(-tau);
}

// Nearest label at a point jittered by up to half a voxel: across frames the
// pick follows trilinear weights, so label boundaries average out smoothly.
fn materialId(pf: vec3f) -> u32 {
  let dims = vec3i(textureDimensions(matTex));
  let jitter = vec3f(rand(), rand(), rand()) - 0.5;
  let v = clamp(vec3i(floor(pf * vec3f(dims) + jitter)), vec3i(0), dims - 1);
  return textureLoad(matTex, v, 0).r;
}

fn orthoBasis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(a, n));
  return mat3x3f(t, cross(n, t), n);
}

fn sampleCosineHemisphere(n: vec3f) -> vec3f {
  let r = sqrt(rand());
  let phi = 6.2831853 * rand();
  return orthoBasis(n) * vec3f(r * cos(phi), r * sin(phi), sqrt(max(1.0 - r * r, 0.0)));
}

fn srgbToLinear(c: vec3f) -> vec3f {
  return pow(c, vec3f(2.2));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = vec2u(P.view.xy);
  if (gid.x >= res.x || gid.y >= res.y) { return; }
  let frame = u32(P.march.y);
  rng = pcg(gid.x + pcg(gid.y + pcg(frame)));

  let jitter = vec2f(rand(), rand());
  var ndc = ((vec2f(gid.xy) + jitter) / vec2f(res)) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  // Orthographic: unproject the near and far planes (WebGPU NDC depth 0..1).
  let nearW = P.invMVP * vec4f(ndc, 0.0, 1.0);
  let farW = P.invMVP * vec4f(ndc, 1.0, 1.0);
  let origin = nearW.xyz / nearW.w;
  let farMM = farW.xyz / farW.w;
  let dir = normalize(farMM - origin);
  // Orthographic depth is linear in distance from the near plane.
  let depthPerMM = 1.0 / max(length(farMM - origin), 1e-6);
  var depth = 1.0;

  let ro = (P.mm2frac * vec4f(origin, 1.0)).xyz;
  let df = (P.mm2frac * vec4f(dir, 0.0)).xyz;
  let inv = 1.0 / df;
  let ta = (vec3f(0.0) - ro) * inv;
  let tb = (vec3f(1.0) - ro) * inv;
  var tNear = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), max(min(ta.z, tb.z), 0.0));
  var tFar = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  let rayNear = tNear;
  let rayFar = tFar;

  // Clip planes as a ray interval [clipLo, clipHi] (t in mm): a solid clip
  // marches only inside it, a cutaway jumps over it. Either way the ray gets
  // shorter. The plane bounding what is visible gives the cut face's normal.
  var clipLo = -1e30;
  var clipHi = 1e30;
  var loN = vec3f(0.0);
  var hiN = vec3f(0.0);
  for (var i = 0; i < i32(P.clipInfo.x); i++) {
    let f0 = dot(P.clip[i].xyz, ro) - P.clip[i].w;
    let fd = dot(P.clip[i].xyz, df);
    if (abs(fd) < 1e-8) {
      if (f0 < 0.0) { clipHi = -1e30; }
      continue;
    }
    let tc = -f0 / fd;
    if (fd > 0.0 && tc > clipLo) { clipLo = tc; loN = P.clipN[i].xyz; }
    if (fd < 0.0 && tc < clipHi) { clipHi = tc; hiN = P.clipN[i].xyz; }
  }
  // With no active plane there is nothing to cut away.
  let isCutaway = P.clipInfo.y > 0.5 && P.clipInfo.x > 0.5;
  var faceT = -1e30; // samples within a voxel past faceT lie on the cut face
  var faceN = vec3f(0.0);
  if (!isCutaway) {
    if (clipLo > tNear) { faceT = clipLo; faceN = loN; }
    tNear = max(tNear, clipLo);
    tFar = min(tFar, clipHi);
  } else if (clipLo < clipHi) {
    faceT = clipHi;
    faceN = hiN;
  }

  let stepMM = P.march.x;
  let shadowStrength = P.march.z;
  let ambient = P.march.w;
  let aoStrength = P.ao.x;
  let lightI = P.ao.z;
  let shininess = P.ao.w;
  let volTerm = P.view.z;

  // A hidden background marches no anatomy; overlays below still draw.
  if (P.labelInfo.w < 0.5) { tFar = tNear; }
  var acc = vec4f(0.0);
  var prevMag = 0.0;
  var prevN = vec3f(0.0);
  let rayJitter = rand();
  var t = tNear + stepMM * rayJitter;
  for (var i = 0; i < 8192; i++) {
    if (isCutaway && t >= clipLo && t < clipHi) {
      // Keep the jittered lattice so the cut face is sampled like any surface.
      t += ceil((clipHi - t) / stepMM) * stepMM;
    }
    if (t >= tFar) { break; }
    let tSample = t;
    let pf = ro + df * t;
    t += stepMM;
    // Samples just past the cut face. Clipping can leave a face through
    // translucent, low-gradient tissue (white matter, CSF) that would read as
    // wrinkled interior noise, so these samples classify at the transfer
    // function's top (maximum gradient) row: edge alpha E, surface specular,
    // surfaceness 1, as if a steep boundary were there. Air (E = 0) stays empty.
    let onCut = tSample >= faceT && tSample - faceT < 1.5 * P.tf.w;
    let hu = textureSampleLevel(huTex, samp, pf, 0.0).r;
    let x = tfUV(hu, 0.0, P.tf).x;
    let isLabelOn = P.labelInfo.x > 0.5;
    var id = 0u;
    if (isLabelOn) { id = materialId(pf); }
    // Skip the gradient fetch where nothing can show: tfMaxA is the most
    // opaque this HU gets at any gradient in the base table.
    let maxA = textureSampleLevel(tfMaxA, samp, vec2f(x, 0.5), 0.0).r;
    if (classifyAlpha(id, maxA, hu, P.labelInfo) < 0.001) {
      prevMag = 0.0;
      // Empty-space skip: zero extinction at a coarse mip means the block
      // around this point is empty, so jump half a coarse texel.
      if (textureSampleLevel(extTex, samp, pf, P.ext.y).r <= 0.0) { t += P.ext.z; }
      continue;
    }
    let g = gradMM(pf);
    let mag = length(g);
    let uv = tfUV(hu, select(mag, P.tf.z, onCut), P.tf);
    // m.g is surfaceness from the gradient ramp; labelled tissue uses it too.
    let m = textureSampleLevel(tfMat, samp, uv, 0.0);
    var c = textureSampleLevel(tfColor, samp, uv, 0.0);
    var specular = m.r;
    var surfBase = m.g;
    c.a = classifyAlpha(id, c.a, hu, P.labelInfo);
    if (id != 0u && P.labelInfo.z > 0.0) {
      // Blend: the label only tints, for a softer, volumetric look.
      c = vec4f(mix(c.rgb, material(2u * id).rgb, P.labelInfo.z), c.a);
    } else if (id != 0u) {
      c = vec4f(material(2u * id).rgb, c.a);
      // A label boundary is a surface even where the HU step is modest
      // (organ against fat): the label's surfaceness floor keeps it glossy.
      let mat = material(2u * id + 1u);
      surfBase = max(m.g, mat.w);
      specular = mat.z * surfBase;
    }
    // First hit, as the classic renderer's (table alpha >= 0.01).
    if (depth >= 1.0 && c.a >= 0.01) { depth = tSample * depthPerMM; }
    let a = stepAlpha(c.a, stepMM);
    if (a < 0.0005) { // below 8-bit visibility even when many steps sum
      prevMag = 0.0;
      continue;
    }
    // Normal reuse (Bannerman): while the magnitude falls off past a boundary,
    // keep the normal from the boundary rather than the noisy interior one.
    var n = -g / max(mag, 1e-6);
    if (mag < prevMag) { n = prevN; }
    // A cut face is a surface whatever the tissue gradient says.
    if (onCut) { n = faceN; }
    prevMag = mag;
    prevN = n;
    if (dot(n, dir) > 0.0) { n = -n; }

    let spec = specular * P.view.w;
    let surf = select(surfBase, 1.0, onCut);
    let weight = (1.0 - acc.a) * a;
    let L = P.light.xyz;
    // Only samples that visibly contribute (> ~0.5/255) pay for secondary rays.
    let worth = weight > 0.002;
    // Secondary rays leave from a point lifted off the surface: otherwise the
    // coarse extinction voxels shadow the surface by its phase against the
    // grid, which shows as wood-grain rings. 1.5 voxels clears the trilinear
    // footprint of the surface's own extinction voxel.
    let lift = pf + (P.mm2frac * vec4f(n * (1.5 * P.ext.x), 0.0)).xyz;
    var shadow = 1.0;
    if (worth && shadowStrength > 0.0 && !onCut) {
      shadow = mix(1.0, coneTransmittance(lift, L, P.light.w, 1e5), shadowStrength);
    }
    var occl = 1.0;
    if (worth && aoStrength > 0.0) {
      let aoDir = sampleCosineHemisphere(n);
      occl = mix(1.0, coneTransmittance(lift, aoDir, P.ext.w, P.ao.y), aoStrength);
    }
    let albedo = srgbToLinear(c.rgb);
    let ndl = max(dot(n, L), 0.0);
    let diffuse = mix(volTerm, ndl, surf);
    let h = normalize(L - dir);
    let sp = spec * pow(max(dot(n, h), 0.0), shininess) * step(0.0, dot(n, L));
    var lit = albedo * (ambient * occl + lightI * shadow * diffuse) + vec3f(lightI * shadow * sp);
    // A lit cut face washes out (its plane normal often faces the light), so
    // like the classic renderer's clip surface it shows the plain colour, AO
    // only. 0.6 keeps tissue albedos (grey ~0.6, white matter ~0.9) on the
    // linear part of the ACES curve rather than its shoulder.
    if (onCut) { lit = albedo * occl * 0.6; }
    acc += vec4f(lit * weight, weight);
    if (acc.a > 0.995) { break; } // early termination: the rest is hidden
  }

  // Reuse the standard renderer's classified, registered overlay texture.
  // A separate march preserves activations in transparent/removed anatomy;
  // clipPlaneOverlay opts into clipping them with the background.
  if (P.overlayInfo.x > 0.5) {
    let overlayStep = max(stepMM, P.tf.w);
    let overlayVoxels = overlayStep * length(df * vec3f(textureDimensions(overlayTex)));
    let start = rayNear + overlayStep * rayJitter;
    var overlayT = start;
    let fastStep = 1.9 * overlayStep;
    for (var i = 0; i < 8192 && overlayT < rayFar; i++) {
      let p = ro + df * overlayT;
      if ((P.overlayInfo.y < 0.5 || isVisible(p)) && textureSampleLevel(overlayTex, samp, p, 0.0).a >= 0.01) { break; }
      overlayT += fastStep;
    }
    overlayT = start + max(0.0, floor((overlayT - fastStep - start) / overlayStep)) * overlayStep;
    var overlay = vec4f(0.0);
    var first = 1e30;
    var farthest = 0.0;
    for (var i = 0; i < 8192 && overlayT < rayFar; i++) {
      let p = ro + df * overlayT;
      if (P.overlayInfo.y < 0.5 || isVisible(p)) {
        let c = textureSampleLevel(overlayTex, samp, p, 0.0);
        if (c.a >= 0.01) {
          first = min(first, overlayT);
          farthest = overlayT;
          // Correct per overlay voxel crossed along the ray, like the classic
          // renderer; the anatomy's refStep (smallest voxel edge) would
          // over-darken thick-slice axes.
          let a = select(c.a, 1.0 - pow(1.0 - min(c.a, 0.9999), overlayVoxels), P.overlayInfo.w > 0.5);
          let rgb = srgbToLinear(pow(c.rgb, vec3f(P.overlayInfo.z)));
          overlay += (1.0 - overlay.a) * vec4f(rgb * a, a);
          if (overlay.a > 0.995) { break; }
        }
      }
      overlayT += overlayStep;
    }
    // Match the classic renderer's depth-aware overlay mix, in texture units.
    if (overlay.a > 0.001) {
      var amount = overlay.a;
      let behind = max(0.0, farthest - depth / depthPerMM) * length(df);
      if (acc.a <= 0.0) { amount = 1.0; }
      else { amount *= 1.0 - acc.a * pow(min(behind / 0.5, 1.0), 0.3); }
      acc = vec4f(mix(acc.rgb, overlay.rgb, amount), max(acc.a, overlay.a));
      depth = min(depth, first * depthPerMM);
    }
  }

  let idx = gid.y * res.x + gid.x;
  let prev = select(accum[idx], vec4f(0.0), frame == 0u);
  accum[idx] = prev + acc;
  // Not min-accumulated across jittered frames: frame 0 fixes the depth.
  if (frame == 0u) { depthOut[idx] = depth; }
}
