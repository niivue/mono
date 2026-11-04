import { CLUSTER_SIZE, PLANE_SHIFT } from '@/mesh/triangleClusters'

const CLUSTER_MASK = (1 << PLANE_SHIFT) - 1

export const meshVertShader = `#version 300 es
precision highp float;
uniform mat4 mvpMtx;
uniform mat4 normMtx;
uniform float opacity;
// Pin attribute locations so every mesh program shares the same layout. A mesh
// VAO is built once (createMeshGpu) and may be drawn with a different program
// (sliceShaderType on 2D tiles, the x-ray pass, depth picking), so the locations
// must match across all mesh shaders by construction, not by linker coincidence.
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec4 color;
out vec4 vClr;
out vec3 vN;
out vec3 vPos;

void main() {
    gl_Position = mvpMtx * vec4(position, 1.0);
    vec3 worldNormal = normalize((normMtx * vec4(normal, 0.0)).xyz);
    vN = worldNormal;
    vClr = vec4(color.rgb, opacity);
    vPos = position;
}
`

// Vertex shader for flat shading - uses flat interpolation
export const meshVertShaderFlat = `#version 300 es
precision highp float;
uniform mat4 mvpMtx;
uniform mat4 normMtx;
uniform float opacity;
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec4 color;
flat out vec4 vClr;
flat out vec3 vN;
out vec3 vPos;

void main() {
    gl_Position = mvpMtx * vec4(position, 1.0);
    vec3 worldNormal = normalize((normMtx * vec4(normal, 0.0)).xyz);
    vN = worldNormal;
    vClr = vec4(color.rgb, opacity);
    vPos = position;
}
`

// Fragment shader: Flat shading
const meshFragFlat = `#version 300 es
precision highp float;
flat in vec4 vClr;
flat in vec3 vN;
out vec4 fragColor;

void main() {
    vec3 r = vec3(0.0, 0.0, 1.0);
    vec3 n = normalize(vN);
    vec3 l = normalize(vec3(0.0, 10.0, 5.0));
    float lightNormDot = dot(n, l);
    vec3 ambient = vClr.rgb * 0.35;
    vec3 diffuse = max(lightNormDot, 0.0) * vClr.rgb * 0.5;
    float s = 0.2 * pow(max(dot(reflect(-l, n), r), 0.0), 10.0);
    fragColor = vec4(ambient + diffuse + s, vClr.a);
}
`

// Fragment shader: Phong shading
const meshFragPhong = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    vec3 r = vec3(0.0, 0.0, 1.0);
    vec3 n = normalize(vN);
    vec3 l = normalize(vec3(0.0, 10.0, 5.0));
    float lightNormDot = dot(n, l);
    vec3 ambient = vClr.rgb * 0.35;
    vec3 diffuse = max(lightNormDot, 0.0) * vClr.rgb * 0.5;
    float s = 0.2 * pow(max(dot(reflect(-l, n), r), 0.0), 10.0);
    fragColor = vec4(ambient + diffuse + s, vClr.a);
}
`

// Fragment shader: Silhouette
const meshFragSilhouette = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    float edge0 = 0.1;
    float edge1 = 0.25;
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 n = normalize(vN);
    float cosTheta = abs(dot(n, viewDir));
    float alpha = 1.0 - smoothstep(edge0, edge1, cosTheta);
    if (alpha <= 0.0) {
        discard;
    }
    fragColor = vec4(0.0, 0.0, 0.0, vClr.a * alpha);
}
`

// Fragment shader: Rim lighting
const meshFragRim = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    float thresh = 0.4;
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 n = normalize(vN);
    float cosTheta = abs(dot(n, viewDir));
    float edgeWidth = 0.05;
    vec3 d = smoothstep(thresh - edgeWidth, thresh + edgeWidth, cosTheta) * vClr.rgb;
    fragColor = vec4(d, vClr.a);
}
`

// Fragment shader: Crevice shading
const meshFragCrevice = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
in vec3 vPos;
out vec4 fragColor;

void main() {
    vec3 n = normalize(vN);
    vec3 dx = dFdx(n);
    vec3 dy = dFdy(n);
    vec3 xneg = n - dx;
    vec3 xpos = n + dx;
    vec3 yneg = n - dy;
    vec3 ypos = n + dy;
    float depth = length(gl_FragCoord.xyz);
    float curv = (cross(xneg, xpos).y - cross(yneg, ypos).x) / depth;
    curv = 1.0 - (curv + 0.5);
    curv = clamp(curv, 0.0, 1.0);
    curv = pow(curv, 0.5);
    
    vec3 r = vec3(0.0, 0.0, 1.0);
    float ambient = 0.6;
    float diffuse = 0.6;
    float specular = 0.2;
    float shininess = 10.0;
    vec3 lightPosition = vec3(0.0, 10.0, 2.0);
    vec3 l = normalize(lightPosition);
    float lightNormDot = dot(n, l);
    vec3 a = vClr.rgb * ambient * curv;
    vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
    float s = specular * pow(max(dot(reflect(-l, n), r), 0.0), shininess);
    fragColor = vec4(a + d + s, vClr.a);
}
`

// Fragment shader: Matte
const meshFragMatte = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    float ambient = 0.35;
    float diffuse = 0.6;
    vec3 n = normalize(vN);
    vec3 lightPosition = vec3(0.0, 7.0, 5.0);
    vec3 l = normalize(lightPosition);
    float lightNormDot = dot(n, l);
    vec3 a = vClr.rgb * ambient;
    vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
    fragColor = vec4(a + d, vClr.a);
}
`

// Fragment shader: Toon
const meshFragToon = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

float stepmix(float a, float b, float E, float x) {
    return mix(a, b, smoothstep(a - E, a + E, x));
}

void main() {
    vec3 r = vec3(0.0, 0.0, 1.0);
    float ambient = 0.3;
    float diffuse = 0.6;
    float specular = 0.5;
    float shininess = 50.0;
    vec3 n = normalize(vN);
    vec3 lightPosition = vec3(0.0, 10.0, 5.0);
    vec3 l = normalize(lightPosition);
    float df = max(0.0, dot(n, l));
    float sf = pow(max(dot(reflect(-l, n), r), 0.0), shininess);
    const float A = 0.1;
    const float B = 0.3;
    const float C = 0.6;
    const float D = 1.0;
    float E_df = fwidth(df);
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
    float E_sf = fwidth(sf);
    if (sf > 0.5 - E_sf && sf < 0.5 + E_sf) {
        sf = smoothstep(0.5 - E_sf, 0.5 + E_sf, sf);
    } else {
        sf = step(0.5, sf);
    }
    vec3 a = vClr.rgb * ambient;
    vec3 d = df * vClr.rgb * diffuse;
    fragColor = vec4(a + d + (specular * sf), vClr.a);
}
`

// Fragment shader: Outline
const meshFragOutline = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    vec3 r = vec3(0.0, 0.0, 1.0);
    float ambient = 0.3;
    float diffuse = 0.6;
    float specular = 0.25;
    float shininess = 10.0;
    float penWidth = 0.6;
    vec3 n = normalize(vN);
    vec3 lightPosition = vec3(0.0, 10.0, 5.0);
    vec3 l = normalize(lightPosition);
    float lightNormDot = dot(n, l);
    float view = abs(dot(n, r));
    
    if (penWidth < view) {
        discard;
    }
    vec3 a = vClr.rgb * ambient;
    vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
    float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
    fragColor = vec4(a + d + s, vClr.a);
}
`

const meshFragVertexColor = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    fragColor = vClr;
}
`

// Fragment shader: Crosscut (crosshair ribbons on mesh surface)
const meshFragCrosscut = `#version 300 es
precision highp float;
uniform vec4 crosscutMM;
uniform mat4 ccPlanes;
in vec4 vClr;
in vec3 vN;
in vec3 vPos;
out vec4 fragColor;

void main() {
    float LINE_WIDTH_PX = ccPlanes[3].z;
    if (LINE_WIDTH_PX <= 0.0) discard; // smoothstep(0, 0, x) is undefined
    const float TILT_STRENGTH = 1.0;
    vec3 d = vPos - crosscutMM.xyz;
    vec3 ad = abs(d);
    vec3 fd = fwidth(vPos);
    float minDist = min(ad.x, min(ad.y, ad.z));
    if (minDist > crosscutMM.w) discard;
    float tiltX = length(fd.yz);
    float tiltY = length(fd.xz);
    float tiltZ = length(fd.xy);
    float tfX = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltX), 0.0, 1.0);
    float tfY = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltY), 0.0, 1.0);
    float tfZ = clamp(1.0 / (1.0 + TILT_STRENGTH * tiltZ), 0.0, 1.0);
    vec3 halfWidth;
    halfWidth.x = (LINE_WIDTH_PX * 0.5) * fd.x * tfX;
    halfWidth.y = (LINE_WIDTH_PX * 0.5) * fd.y * tfY;
    halfWidth.z = (LINE_WIDTH_PX * 0.5) * fd.z * tfZ;
    vec3 edgeA = 1.0 - smoothstep(vec3(0.0), halfWidth, ad);
    float edgeAlpha = max(edgeA.x, max(edgeA.y, edgeA.z));
    if (edgeAlpha <= 1e-4) discard;
    fragColor = vec4(vClr.rgb, vClr.a * edgeAlpha);
}
`

// Crosscut2: the mesh outline where it meets the displayed voxel plane(s).
// Fragments cannot draw this: a surface seen edge-on (the medial wall on an
// axial slice) rasterizes to nothing. So each instance is one triangle,
// whose vertex shader intersects it with the cut plane and expands the
// segment into a screen-space quad of ccPlanes[3].z pixels (6 vertices).
// Triangles that miss collapse to a point and cost no fragments. Only
// clusters of CLUSTER_SIZE nearby triangles whose bounds cross a plane are
// drawn (mesh/triangleClusters.ts): each list entry, advancing once per
// cluster of instances, packs the cluster and the plane. Vertex words (position f32x3,
// normal f32x3, color unorm8x4; 7 per vertex) and the cluster-ordered
// triangle indices are read from R32UI textures, the same words WebGPU
// reads from storage.
export const meshVertCrosscut2 = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform mat4 mvpMtx;
uniform float opacity;
uniform mat4 ccPlanes;
uniform usampler2D vertWords;
uniform usampler2D triWords;
// Location 0: drawing with attribute 0 disabled is emulated (slowly) on
// desktop GL. crosscut2 has its own VAO, so this does not clash with position.
layout(location = 0) in uint entry;
out vec4 vClr;
out float vEdgePx;
flat out float vHalfPx;

uint word(usampler2D tex, uint w) {
    uint texW = uint(textureSize(tex, 0).x);
    return texelFetch(tex, ivec2(int(w % texW), int(w / texW)), 0).r;
}

void vertexAt(uint idx, out vec3 p, out vec4 c) {
    uint w = idx * 7u;
    p = uintBitsToFloat(uvec3(word(vertWords, w), word(vertWords, w + 1u), word(vertWords, w + 2u)));
    // unpackUnorm4x8 is GLSL ES 3.10; WebGL2 is 3.00.
    c = vec4((uvec4(word(vertWords, w + 6u)) >> uvec4(0u, 8u, 16u, 24u)) & 0xFFu) / 255.0;
}

void main() {
    int corner = gl_VertexID;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vClr = vec4(0.0);
    vEdgePx = 0.0;
    vHalfPx = 0.0;
    // Indices are padded to whole clusters, so every tri is in range.
    uint tri = (entry & ${CLUSTER_MASK}u) * ${CLUSTER_SIZE}u + uint(gl_InstanceID % ${CLUSTER_SIZE});
    vec4 pl = ccPlanes[int(entry >> ${PLANE_SHIFT}u)];
    vec3 p[3];
    vec4 c[3];
    vertexAt(word(triWords, tri * 3u), p[0], c[0]);
    vertexAt(word(triWords, tri * 3u + 1u), p[1], c[1]);
    vertexAt(word(triWords, tri * 3u + 2u), p[2], c[2]);
    vec3 s = vec3(dot(pl.xyz, p[0]), dot(pl.xyz, p[1]), dot(pl.xyz, p[2])) - pl.w;
    // Half-open side test (s >= 0) yields exactly 0 or 2 crossed edges.
    vec3 hit[2];
    vec4 hitClr[2];
    int n = 0;
    for (int e = 0; e < 3; e++) {
        int f = (e + 1) % 3;
        if ((s[e] >= 0.0) != (s[f] >= 0.0)) {
            float t = s[e] / (s[e] - s[f]);
            hit[n] = mix(p[e], p[f], t);
            hitClr[n] = mix(c[e], c[f], t);
            n++;
        }
    }
    if (n < 2) return;
    vec2 halfVp = 0.5 * ccPlanes[3].xy;
    vec4 a = mvpMtx * vec4(hit[0], 1.0);
    vec4 b = mvpMtx * vec4(hit[1], 1.0);
    vec2 sa = a.xy / a.w * halfVp;
    vec2 sb = b.xy / b.w * halfVp;
    vec2 d = sb - sa;
    float len = length(d);
    vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // Quad corners as two triangles: (0,1,2) (2,1,3) over A-/A+/B-/B+.
    const int QUAD[6] = int[6](0, 1, 2, 2, 1, 3);
    int q = QUAD[corner];
    bool atB = q >= 2;
    float side = (q == 0 || q == 2) ? -1.0 : 1.0;
    float halfPx = 0.5 * ccPlanes[3].z;
    float extent = halfPx + 1.0; // one pixel fringe for antialiasing
    // Square caps (extend by the half width) close the joins between segments.
    vec2 px = (atB ? sb + dir * halfPx : sa - dir * halfPx) + nrm * side * extent;
    gl_Position = vec4(px / halfVp, 0.0, 1.0);
    vClr = vec4((atB ? hitClr[1] : hitClr[0]).rgb, opacity);
    vEdgePx = side * extent;
    vHalfPx = halfPx;
}
`

const meshFragCrosscut2 = `#version 300 es
precision highp float;
in vec4 vClr;
in float vEdgePx;
flat in float vHalfPx;
out vec4 fragColor;

void main() {
    float alpha = clamp(vHalfPx + 0.5 - abs(vEdgePx), 0.0, 1.0);
    if (alpha <= 0.0) discard;
    fragColor = vec4(vClr.rgb, vClr.a * alpha);
}
`

// Map shader type names to fragment shaders
export const fragmentShaders = {
  phong: meshFragPhong,
  crevice: meshFragCrevice,
  crosscut: meshFragCrosscut,
  crosscut2: meshFragCrosscut2,
  flat: meshFragFlat,
  matte: meshFragMatte,
  outline: meshFragOutline,
  rim: meshFragRim,
  silhouette: meshFragSilhouette,
  toon: meshFragToon,
  vertexColor: meshFragVertexColor,
}
