// Progressive cinematic ray march for calibrated (Hounsfield) CT.
// One sample per pixel per frame: jittered ray start, sub-pixel offset, soft
// light cone and a random AO direction all change every frame, so the running
// mean in `accum` converges to an anti-aliased image with soft shadows.

struct Params {
  mm2frac: mat4x4f,
  gradToMM: mat4x4f, // upper 3x3: dHU/dvoxel (RAS texture axes) -> dHU/dmm
  invMVP: mat4x4f, // NiiVue's render-tile MVP, inverted: NDC -> mm
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
  labelInfo: vec4f, // labels on (0/1), unlabeled tissue scale, -, -
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
@group(0) @binding(10) var<storage, read> materials: array<vec4f>;

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
  let dir = normalize(farW.xyz / farW.w - origin);

  let ro = (P.mm2frac * vec4f(origin, 1.0)).xyz;
  let df = (P.mm2frac * vec4f(dir, 0.0)).xyz;
  let inv = 1.0 / df;
  let ta = (vec3f(0.0) - ro) * inv;
  let tb = (vec3f(1.0) - ro) * inv;
  var tNear = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), max(min(ta.z, tb.z), 0.0));
  var tFar = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));

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
  let isCutaway = P.clipInfo.y > 0.5;
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

  var acc = vec4f(0.0);
  var prevMag = 0.0;
  var prevN = vec3f(0.0);
  var t = tNear + stepMM * rand();
  for (var i = 0; i < 8192; i++) {
    if (isCutaway && t >= clipLo && t < clipHi) {
      // Keep the jittered lattice so the cut face is sampled like any surface.
      t += ceil((clipHi - t) / stepMM) * stepMM;
    }
    if (t >= tFar) { break; }
    let tSample = t;
    let pf = ro + df * t;
    t += stepMM;
    let hu = textureSampleLevel(huTex, samp, pf, 0.0).r;
    let x = tfUV(hu, 0.0, P.tf).x;
    let isLabelOn = P.labelInfo.x > 0.5;
    var id = 0u;
    if (isLabelOn) { id = materialId(pf); }
    // Skip the gradient fetch where nothing can show: tfMaxA is the most
    // opaque this HU gets at any gradient in the base table (label 0).
    var isEmpty = labelAlpha(id, hu) < 0.001;
    if (id == 0u) {
      let unlabeled = select(1.0, P.labelInfo.y, isLabelOn);
      isEmpty = textureSampleLevel(tfMaxA, samp, vec2f(x, 0.5), 0.0).r * unlabeled < 0.001;
    }
    if (isEmpty) {
      prevMag = 0.0;
      // Empty-space skip: zero extinction at a coarse mip means the block
      // around this point is empty, so jump half a coarse texel.
      if (textureSampleLevel(extTex, samp, pf, P.ext.y).r <= 0.0) { t += P.ext.z; }
      continue;
    }
    let g = gradMM(pf);
    let mag = length(g);
    let uv = tfUV(hu, mag, P.tf);
    // m.g is surfaceness from the gradient ramp; labelled tissue uses it too.
    let m = textureSampleLevel(tfMat, samp, uv, 0.0);
    var c = textureSampleLevel(tfColor, samp, uv, 0.0);
    var specular = m.r;
    var surfBase = m.g;
    if (id == 0u) {
      c.a *= select(1.0, P.labelInfo.y, isLabelOn);
    } else {
      c = vec4f(materials[2u * id].rgb, labelAlpha(id, hu));
      // A label boundary is a surface even where the HU step is modest
      // (organ against fat): the label's surfaceness floor keeps it glossy.
      let mat = materials[2u * id + 1u];
      surfBase = max(m.g, mat.w);
      specular = mat.z * surfBase;
    }
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
    let onCut = tSample - faceT < 1.5 * P.tf.w;
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
    if (worth && shadowStrength > 0.0) {
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
    let lit = albedo * (ambient * occl + lightI * shadow * diffuse) + vec3f(lightI * shadow * sp);
    acc += vec4f(lit * weight, weight);
    if (acc.a > 0.995) { break; } // early termination: the rest is hidden
  }

  let idx = gid.y * res.x + gid.x;
  let prev = select(accum[idx], vec4f(0.0), frame == 0u);
  accum[idx] = prev + acc;
}
