struct SliceUniforms {
    mvpMtx: mat4x4f,
    frac2mm: mat4x4f,
    opacity: f32,
    overlayAlphaShader: f32,
    slice: f32,
    overlayOpacity: f32,          // opacity of overlay volume (0-1)
    axCorSag: i32,
    isAlphaClipDark: i32,
    numVolumes: f32,              // number of loaded volumes (1 = no overlay, 2+ = has overlay)
    drawRimOpacity: f32,          // <0 = disabled, >=0 = edge voxels use this alpha
    numPaqd: f32,                 // >0 = PAQD overlay loaded
    isV1SliceShader: i32,         // >0 = render fiber lines from RGBA overlay direction
    overlayOutlineWidth: f32,     // >0 = draw black outline at overlay threshold boundary
    paqdUniforms: vec4f,          // easing parameters: [t0, t1, y1, y2]
};

@group(0) @binding(0) var<uniform> u: SliceUniforms;
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var overlay: texture_3d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var drawing: texture_3d<f32>;
@group(0) @binding(5) var paqdTex: texture_3d<f32>;
@group(0) @binding(6) var paqdLutTex: texture_2d<f32>;
@group(0) @binding(7) var paqdSampler: sampler;  // always linear, for smooth PAQD probabilities

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) texPos: vec3f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    // Define quad vertices: 0, 1, 2, 3 -> (0,0), (1,0), (0,1), (1,1) in triangle strip order
    var pos = vec2f(0.0);
    if (vIdx == 1u) { pos.x = 1.0; }
    else if (vIdx == 2u) { pos.y = 1.0; }
    else if (vIdx == 3u) { pos.x = 1.0; pos.y = 1.0; }

    // Construct texture position based on slice orientation
    // pos.xy are in 0-1 range, slice determines depth along the slice axis
    var texPos = vec3f(pos.x, pos.y, u.slice);
    if (u.axCorSag > 1) {
        // Sagittal: slice is X axis
        texPos = vec3f(u.slice, pos.x, pos.y);
    } else if (u.axCorSag > 0) {
        // Coronal: slice is Y axis
        texPos = vec3f(pos.x, u.slice, pos.y);
    }
    // Axial: slice is Z axis (default)

    // Transform from fractional to mm space, then apply MVP
    let mm = u.frac2mm * vec4f(texPos, 1.0);

    var out: VertexOutput;
    out.position = u.mvpMtx * mm;
    out.texPos = texPos;
    return out;
}

// PAQD easing function — piecewise linear alpha from primary probability.
fn paqdEaseAlpha(alpha: f32, pu: vec4f) -> f32 {
    let t0 = pu[0];
    let t1 = 0.5 * (pu[0] + pu[1]);
    let t2 = pu[1];
    let y0 = 0.0;
    let y1 = abs(pu[2]);
    let y2 = abs(pu[3]);
    if (alpha <= t0) { return y0; }
    if (alpha <= t1) { return mix(y0, y1, (alpha - t0) / (t1 - t0)); }
    if (alpha <= t2) { return mix(y1, y2, (alpha - t1) / (t2 - t1)); }
    return y2;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    // Sample background volume (use textureSampleLevel to avoid uniform control flow issues)
    let background = textureSampleLevel(volume, texSampler, in.texPos, 0.0);
    var color = vec4f(background.rgb, u.opacity);

    // Handle alpha clipping for dark values (FSLeyes style)
    if (u.isAlphaClipDark != 0 && background.a == 0.0) {
        color.a = 0.0;
    }

    // Apply overlay alpha modulation
    color.a *= u.overlayAlphaShader;

    // Overlay blending (only when overlay volumes are loaded)
    if (u.numVolumes > 1.0) {
        {
            var ocolor = textureSampleLevel(overlay, texSampler, in.texPos, 0.0);
            ocolor.a *= u.overlayOpacity;
            // V1 fiber line visualization: render colored line along fiber direction within each voxel
            if (u.isV1SliceShader != 0 && ocolor.a > 0.0) {
                // Decode sign polarity from alpha's 3 least-significant bits
                let alpha = u32(ocolor.a * 255.0);
                var xyzFlip = vec3f(f32((alpha & 1u) > 0u), f32((alpha & 2u) > 0u), f32((alpha & 4u) > 0u));
                xyzFlip = xyzFlip * 2.0 - 1.0;
                let v1dir = normalize(ocolor.rgb * xyzFlip);
                var vxl = fract(in.texPos * vec3f(textureDimensions(overlay, 0))) - 0.5;
                vxl.x = -vxl.x;
                var t = dot(vxl, v1dir);
                var P = t * v1dir;
                let dx = length(P - vxl);
                ocolor.a = (1.0 - smoothstep(0.2, 0.25, dx)) * length(ocolor.rgb);
                ocolor = vec4f(normalize(ocolor.rgb), ocolor.a);
                // Depth shading: compare distance half a voxel closer to viewer
                let pan = 0.5;
                if (u.axCorSag == 0) { vxl.z -= pan; }
                if (u.axCorSag == 1) { vxl.y -= pan; }
                if (u.axCorSag == 2) { vxl.x += pan; }
                t = dot(vxl, v1dir);
                P = t * v1dir;
                let dx2 = length(P - vxl);
                ocolor = vec4f(ocolor.rgb + vec3f(dx2 - dx - 0.5 * pan), ocolor.a);
            }
            // Overlay outline: draw black border at threshold boundary
            if (u.overlayOutlineWidth > 0.0) {
                let vx = u.overlayOutlineWidth / vec3f(textureDimensions(overlay, 0));
                let vxR = vec3f(in.texPos.x + vx.x, in.texPos.y, in.texPos.z);
                let vxL = vec3f(in.texPos.x - vx.x, in.texPos.y, in.texPos.z);
                let vxA = vec3f(in.texPos.x, in.texPos.y + vx.y, in.texPos.z);
                let vxP = vec3f(in.texPos.x, in.texPos.y - vx.y, in.texPos.z);
                let vxS = vec3f(in.texPos.x, in.texPos.y, in.texPos.z + vx.z);
                let vxI = vec3f(in.texPos.x, in.texPos.y, in.texPos.z - vx.z);
                if (ocolor.a < 1.0) {
                    // Sub-threshold voxel: check if any in-plane neighbor is supra-threshold
                    var na = 0.0;
                    if (u.axCorSag != 2) { na = max(na, textureSampleLevel(overlay, texSampler, vxR, 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vxL, 0.0).a); }
                    if (u.axCorSag != 1) { na = max(na, textureSampleLevel(overlay, texSampler, vxA, 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vxP, 0.0).a); }
                    if (u.axCorSag != 0) { na = max(na, textureSampleLevel(overlay, texSampler, vxS, 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vxI, 0.0).a); }
                    // In-plane diagonal corners
                    if (u.axCorSag == 0) { na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x + vx.x, in.texPos.y + vx.y, in.texPos.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x - vx.x, in.texPos.y + vx.y, in.texPos.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x + vx.x, in.texPos.y - vx.y, in.texPos.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x - vx.x, in.texPos.y - vx.y, in.texPos.z), 0.0).a); }
                    if (u.axCorSag == 1) { na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x + vx.x, in.texPos.y, in.texPos.z + vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x - vx.x, in.texPos.y, in.texPos.z + vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x + vx.x, in.texPos.y, in.texPos.z - vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x - vx.x, in.texPos.y, in.texPos.z - vx.z), 0.0).a); }
                    if (u.axCorSag == 2) { na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x, in.texPos.y + vx.y, in.texPos.z + vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x, in.texPos.y - vx.y, in.texPos.z + vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x, in.texPos.y + vx.y, in.texPos.z - vx.z), 0.0).a); na = max(na, textureSampleLevel(overlay, texSampler, vec3f(in.texPos.x, in.texPos.y - vx.y, in.texPos.z - vx.z), 0.0).a); }
                    if (na >= 1.0) { ocolor = vec4f(0.0, 0.0, 0.0, 1.0); }
                } else {
                    // Supra-threshold voxel: check if any in-plane neighbor is sub-threshold
                    var na = 1.0;
                    if (u.axCorSag != 2) { na = min(na, textureSampleLevel(overlay, texSampler, vxR, 0.0).a); na = min(na, textureSampleLevel(overlay, texSampler, vxL, 0.0).a); }
                    if (u.axCorSag != 1) { na = min(na, textureSampleLevel(overlay, texSampler, vxA, 0.0).a); na = min(na, textureSampleLevel(overlay, texSampler, vxP, 0.0).a); }
                    if (u.axCorSag != 0) { na = min(na, textureSampleLevel(overlay, texSampler, vxS, 0.0).a); na = min(na, textureSampleLevel(overlay, texSampler, vxI, 0.0).a); }
                    if (na < 1.0) { ocolor = vec4f(0.0, 0.0, 0.0, 1.0); }
                }
            }
            let a = color.a + ocolor.a * (1.0 - color.a);
            if (a > 0.0) {
                color = vec4f(mix(color.rgb, ocolor.rgb, ocolor.a / a), a);
            }
        }
    }

    // PAQD blending (raw data with GPU-side LUT lookup + easing)
    // Label indices use nearest-neighbor (textureLoad); probabilities use linear
    // interpolation (textureSampleLevel) for smooth distance-field boundaries.
    if (u.numPaqd > 0.0) {
        let pDims = vec3i(textureDimensions(paqdTex, 0));
        if (pDims.x > 2) {
            // Nearest: label indices (R,G) — interpolating discrete indices is meaningless
            let pCoord = clamp(vec3i(in.texPos * vec3f(pDims)), vec3i(0), pDims - 1);
            let raw = textureLoad(paqdTex, pCoord, 0);
            // Linear: probabilities (B,A) — smooth distance-field-like alpha
            let smoothProb = textureSampleLevel(paqdTex, paqdSampler, in.texPos, 0.0);
            let prob1 = smoothProb.b;
            let prob2 = smoothProb.a;
            let total = prob1 + prob2;
            if (total > 0.004) {
                let idx1 = i32(round(raw.r * 255.0));
                let idx2 = i32(round(raw.g * 255.0));
                let c1 = textureLoad(paqdLutTex, vec2i(clamp(idx1, 0, 255), 0), 0);
                let c2 = textureLoad(paqdLutTex, vec2i(clamp(idx2, 0, 255), 0), 0);
                let w = prob2 / total;
                let prgb = mix(c1.rgb, c2.rgb, w);
                let palpha = paqdEaseAlpha(prob1, u.paqdUniforms);
                if (palpha > 0.0) {
                    // Always blend PAQD in front for 2D slices (background is typically opaque)
                    let a = palpha + color.a * (1.0 - palpha);
                    color = vec4f(mix(color.rgb, prgb, palpha / max(a, 0.001)), a);
                }
            }
        }
    }

    // Discard fully transparent pixels so they don't write to the depth buffer
    // (allows meshes behind transparent slice areas to show through)
    if (color.a <= 0.0) {
        discard;
    }

    // Drawing overlay (nearest-neighbor via textureLoad) — always runs
    // dpdx/dpdy must be in uniform control flow, so compute before branching
    let drawOffsetX = dpdx(in.texPos);
    let drawOffsetY = dpdy(in.texPos);
    let drawDims = vec3i(textureDimensions(drawing, 0));
    let drawCoord = vec3i(in.texPos * vec3f(drawDims));
    let drawColor = textureLoad(drawing, clamp(drawCoord, vec3i(0), drawDims - 1), 0);
    if (drawColor.a > 0.0) {
        var da = drawColor.a;
        if (u.drawRimOpacity >= 0.0) {
            let L = textureLoad(drawing, clamp(vec3i((in.texPos - drawOffsetX) * vec3f(drawDims)), vec3i(0), drawDims - 1), 0);
            let R = textureLoad(drawing, clamp(vec3i((in.texPos + drawOffsetX) * vec3f(drawDims)), vec3i(0), drawDims - 1), 0);
            let T = textureLoad(drawing, clamp(vec3i((in.texPos - drawOffsetY) * vec3f(drawDims)), vec3i(0), drawDims - 1), 0);
            let B = textureLoad(drawing, clamp(vec3i((in.texPos + drawOffsetY) * vec3f(drawDims)), vec3i(0), drawDims - 1), 0);
            if (any(L.rgb != drawColor.rgb) || any(R.rgb != drawColor.rgb) ||
                any(T.rgb != drawColor.rgb) || any(B.rgb != drawColor.rgb)) {
                da = u.drawRimOpacity;
            }
        }
        color = vec4f(mix(color.rgb, drawColor.rgb, da), max(color.a, drawColor.a));
    }
    return color;
}
