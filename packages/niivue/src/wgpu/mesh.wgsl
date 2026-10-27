// 20260131: disable clip_distances: not yet supported by Safari
// 20260131 enable clip_distances;

struct Params {
  mvpMtx: mat4x4f,
  normMtx: mat4x4f,
  clipPlane: vec4f,
  opacity: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  crosscutMM: vec4f,
  // crosscut2 planes (see crosscutPlanes): columns 0-2 = [n, d],
  // column 3 = [tileWidthPx, tileHeightPx, lineWidthPx, planeCount].
  ccPlanes: mat4x4f,
};

@group(0) @binding(0) var<uniform> params: Params;
// crosscut2 only: the interleaved vertex buffer read as words
// (position f32x3, normal f32x3, color unorm8x4; 7 words per vertex).
@group(1) @binding(0) var<storage, read> vertWords: array<u32>;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec4f, 
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) vClr: vec4f,
  @location(1) vN: vec3f,
  @location(2) vP: vec3f,
  // 20260131 @builtin(clip_distances) clip_dist: array<f32, 1>,
};

struct FragmentInput {
  @builtin(position) position: vec4f,
  @location(0) vClr: vec4f,
  @location(1) vN: vec3f,
};

struct CrosscutFragmentInput {
  @builtin(position) position: vec4f,
  @location(0) vClr: vec4f,
  @location(1) vN: vec3f,
  @location(2) vP: vec3f,
};

// Flat-interpolated variants for flat shading (provoking vertex, no interpolation)
struct FlatVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) vClr: vec4f,
  @location(1) @interpolate(flat) vN: vec3f,
};

struct FlatFragmentInput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) vClr: vec4f,
  @location(1) @interpolate(flat) vN: vec3f,
};

@vertex
fn vertex_main(vert: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  out.position = params.mvpMtx * vec4f(vert.position, 1.0);
  let worldNormal = normalize((params.normMtx * vec4f(vert.normal, 0.0)).xyz);
  out.vN = worldNormal;
  out.vClr = vec4f(vert.color.rgb, params.opacity);
  out.vP = vert.position;

  // Dynamic clipping logic
  // If the normal (x,y,z) has length > 0, calculate the dot product.
  // Otherwise, set clip_dist to 1.0 (everything is "inside").
  /* 20260131
  let planeNormal = params.clipPlane.xyz;
  if (length(planeNormal) > 0.0) {
    out.clip_dist[0] = dot(vert.position, planeNormal) + params.clipPlane.w;
  } else {
    out.clip_dist[0] = 1.0; 
  }
  */
  return out;
}

@vertex
fn vertex_flat(vert: VertexInput) -> FlatVertexOutput {
  var out: FlatVertexOutput;
  out.position = params.mvpMtx * vec4f(vert.position, 1.0);
  let worldNormal = normalize((params.normMtx * vec4f(vert.normal, 0.0)).xyz);
  out.vN = worldNormal;
  out.vClr = vec4f(vert.color.rgb, params.opacity);
  return out;
}

// --- FRAGMENT SHADERS ---

@fragment
fn fragment_flat(in: FlatFragmentInput) -> @location(0) vec4f {
  let n = normalize(in.vN);
  let r = vec3f(0.0, 0.0, 1.0);
  let l = normalize(vec3f(0.0, 10.0, 5.0));
  let lightNormDot = dot(n, l);
  let ambient = in.vClr.rgb * 0.35;
  let diffuse = max(lightNormDot, 0.0) * in.vClr.rgb * 0.5;
  let s = 0.2 * pow(max(dot(reflect(-l, n), r), 0.0), 10.0);
  return vec4f(ambient + diffuse + s, in.vClr.a);
}

@fragment
fn fragment_phong(in: FragmentInput) -> @location(0) vec4f {
  let r = vec3f(0.0, 0.0, 1.0);
  let n = normalize(in.vN);
  let l = normalize(vec3f(0.0, 10.0, 5.0));
  let lightNormDot = dot(n, l);
  let ambient = in.vClr.rgb * 0.35;
  let diffuse = max(lightNormDot, 0.0) * in.vClr.rgb * 0.5;
  let s = 0.2 * pow(max(dot(reflect(-l, n), r), 0.0), 10.0);
  return vec4f(ambient + diffuse + s, in.vClr.a);
}

@fragment
fn fragment_silhouette(in: FragmentInput) -> @location(0) vec4f {
  let edge0 = 0.1;
  let edge1 = 0.25;
  let viewDir = vec3f(0.0, 0.0, 1.0);
  let n = normalize(in.vN);
  let cosTheta = abs(dot(n, viewDir));
  let alpha = 1.0 - smoothstep(edge0, edge1, cosTheta);
  if (alpha <= 0.0) {
    discard;
  }
  return vec4f(0.0, 0.0, 0.0, in.vClr.a * alpha);
}

@fragment
fn fragment_rim(in: FragmentInput) -> @location(0) vec4f {
  let thresh = 0.4;
  let viewDir = vec3f(0.0, 0.0, 1.0);
  let n = normalize(in.vN);
  let cosTheta = abs(dot(n, viewDir));
  let edgeWidth = 0.05;
  let d = smoothstep(thresh - edgeWidth, thresh + edgeWidth, cosTheta) * in.vClr.rgb;
  return vec4f(d, in.vClr.a);
}

@fragment
fn fragment_crevice(in: FragmentInput) -> @location(0) vec4f {
  let n = normalize(in.vN);
  let dx = dpdx(n);
  let dy = dpdy(n);
  let xneg = n - dx;
  let xpos = n + dx;
  let yneg = n - dy;
  let ypos = n + dy;
  let depth = length(in.position.xyz);
  var curv = (cross(xneg, xpos).y - cross(yneg, ypos).x) / depth;
  curv = 1.0 - (curv + 0.5);
  curv = clamp(curv, 0.0, 1.0);
  curv = pow(curv, 0.5);
  let r = vec3f(0.0, 0.0, 1.0);
  let ambient = 0.6;
  let diffuse = 0.6;
  let specular = 0.2;
  let shininess = 10.0;
  let lightPosition = vec3f(0.0, 10.0, 2.0);
  let l = normalize(lightPosition);
  let lightNormDot = dot(n, l);
  let a = in.vClr.rgb * ambient * curv;
  let d = max(lightNormDot, 0.0) * in.vClr.rgb * diffuse;
  let s = specular * pow(max(dot(reflect(-l, n), r), 0.0), shininess);
  return vec4f(a + d + s, in.vClr.a);
}

@fragment
fn fragment_matte(in: FragmentInput) -> @location(0) vec4f {
  let ambient = 0.35;
  let diffuse = 0.6;
  let n = normalize(in.vN);
  let lightPosition = vec3f(0.0, 7.0, 5.0);
  let l = normalize(lightPosition);
  let lightNormDot = dot(n, l);
  let a = in.vClr.rgb * ambient;
  let d = max(lightNormDot, 0.0) * in.vClr.rgb * diffuse;
  return vec4f(a + d, in.vClr.a);
}

fn stepmix(a: f32, b: f32, E: f32, x: f32) -> f32 {
  return mix(a, b, smoothstep(a - E, a + E, x));
}

@fragment
fn fragment_toon(in: FragmentInput) -> @location(0) vec4f {
  let r = vec3f(0.0, 0.0, 1.0);
  let ambient = 0.3;
  let diffuse = 0.6;
  let specular = 0.5;
  let shininess = 50.0;
  let n = normalize(in.vN);
  let lightPosition = vec3f(0.0, 10.0, 5.0);
  let l = normalize(lightPosition);
  var df = max(0.0, dot(n, l));
  var sf = pow(max(dot(reflect(-l, n), r), 0.0), shininess);
  const A = 0.1;
  const B = 0.3;
  const C = 0.6;
  const D = 1.0;
  let E_df = fwidth(df);
  if (df > A - E_df && df < A + E_df) {
    df = stepmix(A, B, E_df, df);
  } else if (df > B - E_df && df < B + E_df) {
    df = stepmix(B, C, E_df, df);
  } else if (df > C - E_df && df < C + E_df) {
    df = stepmix(C, D, E_df, df);
  } else if (df < A) {
    df = 0.0;
  } else if (df < B) {
    df = B;
  } else if (df < C) {
    df = C;
  } else {
    df = D;
  }
  let E_sf = fwidth(sf);
  if (sf > 0.5 - E_sf && sf < 0.5 + E_sf) {
    sf = smoothstep(0.5 - E_sf, 0.5 + E_sf, sf);
  } else {
    sf = step(0.5, sf);
  }
  let a = in.vClr.rgb * ambient;
  let d = df * in.vClr.rgb * diffuse;
  return vec4f(a + d + (specular * sf), in.vClr.a);
}

@fragment
fn fragment_vertexColor(in: FragmentInput) -> @location(0) vec4f {
  return in.vClr;
}

@fragment
fn fragment_outline(in: FragmentInput) -> @location(0) vec4f {
  let r = vec3f(0.0, 0.0, 1.0);
  let ambient = 0.3;
  let diffuse = 0.6;
  let specular = 0.25;
  let shininess = 10.0;
  let penWidth = 0.6;
  let n = normalize(in.vN);
  let lightPosition = vec3f(0.0, 10.0, 5.0);
  let l = normalize(lightPosition);
  let lightNormDot = dot(n, l);
  let view = abs(dot(n, r));
  if (penWidth < view) {
    discard;
  }
  let a = in.vClr.rgb * ambient;
  let d = max(lightNormDot, 0.0) * in.vClr.rgb * diffuse;
  let s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
  return vec4f(a + d + s, in.vClr.a);
}

@fragment
fn fragment_crosscut(in: CrosscutFragmentInput) -> @location(0) vec4f {
  let LINE_WIDTH_PX = params.ccPlanes[3].z;
  let TILT_STRENGTH = 1.0;
  let d = in.vP - params.crosscutMM.xyz;
  let ad = abs(d);
  let fd = fwidth(in.vP);
  let minDist = min(ad.x, min(ad.y, ad.z));
  if (minDist > params.crosscutMM.w) {
    discard;
  }
  let tiltX = length(fd.yz);
  let tiltY = length(fd.xz);
  let tiltZ = length(fd.xy);
  let tfX = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltX), 0.0, 1.0);
  let tfY = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltY), 0.0, 1.0);
  let tfZ = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltZ), 0.0, 1.0);
  let halfWidth = vec3f(
    (LINE_WIDTH_PX * 0.5) * fd.x * tfX,
    (LINE_WIDTH_PX * 0.5) * fd.y * tfY,
    (LINE_WIDTH_PX * 0.5) * fd.z * tfZ
  );
  let edgeA = 1.0 - smoothstep(vec3f(0.0), halfWidth, ad);
  let edgeAlpha = max(edgeA.x, max(edgeA.y, edgeA.z));
  if (edgeAlpha <= 1e-4) {
    discard;
  }
  return vec4f(in.vClr.rgb, in.vClr.a * edgeAlpha);
}

// Crosscut2: the mesh outline where it meets the displayed voxel plane(s).
// Mirrors meshVertCrosscut2 in gl/meshShader.ts: one instance per triangle,
// six vertices per plane; the vertex stage intersects the triangle with the
// plane and expands the segment into a screen-space quad, or collapses it
// when the triangle misses. Edge-on surfaces (no fragments of their own)
// still get an outline.
struct Crosscut2Output {
  @builtin(position) position: vec4f,
  @location(0) vClr: vec4f,
  @location(1) vEdgePx: f32,
  @location(2) @interpolate(flat) vHalfPx: f32,
};

fn crosscut2Vertex(idx: u32) -> vec3f {
  let w = idx * 7u;
  return bitcast<vec3f>(vec3u(vertWords[w], vertWords[w + 1u], vertWords[w + 2u]));
}

fn crosscut2Color(idx: u32) -> vec4f {
  return unpack4x8unorm(vertWords[idx * 7u + 6u]);
}

@vertex
fn vertex_crosscut2(
  @builtin(vertex_index) vid: u32,
  @location(0) tri: vec3u,
) -> Crosscut2Output {
  var out: Crosscut2Output;
  out.position = vec4f(2.0, 2.0, 2.0, 1.0);
  out.vClr = vec4f(0.0);
  out.vEdgePx = 0.0;
  out.vHalfPx = 0.0;
  let plane = vid / 6u;
  let corner = vid % 6u;
  if (f32(plane) >= params.ccPlanes[3].w) {
    return out;
  }
  let pl = params.ccPlanes[plane];
  var p = array<vec3f, 3>(crosscut2Vertex(tri.x), crosscut2Vertex(tri.y), crosscut2Vertex(tri.z));
  var c = array<vec4f, 3>(crosscut2Color(tri.x), crosscut2Color(tri.y), crosscut2Color(tri.z));
  let s = vec3f(dot(pl.xyz, p[0]), dot(pl.xyz, p[1]), dot(pl.xyz, p[2])) - pl.w;
  // Half-open side test (s >= 0) yields exactly 0 or 2 crossed edges.
  var hit: array<vec3f, 2>;
  var hitClr: array<vec4f, 2>;
  var n = 0u;
  for (var e = 0u; e < 3u; e++) {
    let f = (e + 1u) % 3u;
    if ((s[e] >= 0.0) != (s[f] >= 0.0)) {
      let t = s[e] / (s[e] - s[f]);
      hit[n] = mix(p[e], p[f], t);
      hitClr[n] = mix(c[e], c[f], t);
      n++;
    }
  }
  if (n < 2u) {
    return out;
  }
  let halfVp = 0.5 * params.ccPlanes[3].xy;
  let a = params.mvpMtx * vec4f(hit[0], 1.0);
  let b = params.mvpMtx * vec4f(hit[1], 1.0);
  let sa = a.xy / a.w * halfVp;
  let sb = b.xy / b.w * halfVp;
  let d = sb - sa;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-6) {
    dir = d / len;
  }
  let nrm = vec2f(-dir.y, dir.x);
  // Quad corners as two triangles: (0,1,2) (2,1,3) over A-/A+/B-/B+.
  var quad = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let q = quad[corner];
  let atB = q >= 2u;
  var side = 1.0;
  if (q == 0u || q == 2u) {
    side = -1.0;
  }
  let halfPx = 0.5 * params.ccPlanes[3].z;
  let extent = halfPx + 1.0; // one pixel fringe for antialiasing
  // Square caps (extend by the half width) close the joins between segments.
  var px = sa - dir * halfPx;
  var clr = hitClr[0];
  if (atB) {
    px = sb + dir * halfPx;
    clr = hitClr[1];
  }
  px += nrm * side * extent;
  out.position = vec4f(px / halfVp, 0.5, 1.0);
  out.vClr = vec4f(clr.rgb, params.opacity);
  out.vEdgePx = side * extent;
  out.vHalfPx = halfPx;
  return out;
}

@fragment
fn fragment_crosscut2(in: Crosscut2Output) -> @location(0) vec4f {
  let alpha = clamp(in.vHalfPx + 0.5 - abs(in.vEdgePx), 0.0, 1.0);
  if (alpha <= 0.0) {
    discard;
  }
  return vec4f(in.vClr.rgb, in.vClr.a * alpha);
}
