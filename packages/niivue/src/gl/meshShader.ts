export const meshVertShader = `#version 300 es
precision highp float;
uniform mat4 mvpMtx;
uniform mat4 normMtx;
uniform float opacity;
in vec3 position;
in vec3 normal;
in vec4 color;
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
`;

// Vertex shader for flat shading - uses flat interpolation
export const meshVertShaderFlat = `#version 300 es
precision highp float;
uniform mat4 mvpMtx;
uniform mat4 normMtx;
uniform float opacity;
in vec3 position;
in vec3 normal;
in vec4 color;
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
`;

// Fragment shader: Flat shading
export const meshFragFlat = `#version 300 es
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
`;

// Fragment shader: Phong shading
export const meshFragPhong = `#version 300 es
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
`;

// Fragment shader: Silhouette
export const meshFragSilhouette = `#version 300 es
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
`;

// Fragment shader: Rim lighting
export const meshFragRim = `#version 300 es
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
`;

// Fragment shader: Crevice shading
export const meshFragCrevice = `#version 300 es
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
`;

// Fragment shader: Matte
export const meshFragMatte = `#version 300 es
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
`;

// Fragment shader: Toon
export const meshFragToon = `#version 300 es
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
`;

// Fragment shader: Outline
export const meshFragOutline = `#version 300 es
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
`;

export const meshFragVertexColor = `#version 300 es
precision highp float;
in vec4 vClr;
in vec3 vN;
out vec4 fragColor;

void main() {
    fragColor = vClr;
}
`;

// Fragment shader: Crosscut (crosshair ribbons on mesh surface)
export const meshFragCrosscut = `#version 300 es
precision highp float;
uniform vec4 crosscutMM;
in vec4 vClr;
in vec3 vN;
in vec3 vPos;
out vec4 fragColor;

void main() {
    const float LINE_WIDTH_PX = 4.0;
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
`;

// Map shader type names to fragment shaders
export const fragmentShaders = {
  phong: meshFragPhong,
  crevice: meshFragCrevice,
  crosscut: meshFragCrosscut,
  flat: meshFragFlat,
  matte: meshFragMatte,
  outline: meshFragOutline,
  rim: meshFragRim,
  silhouette: meshFragSilhouette,
  toon: meshFragToon,
  vertexColor: meshFragVertexColor,
};
