// Render-specific functions (preamble is prepended by render.ts from volumeShaderLib)

// Drawing-gradient tuning constants. Shader authoring choices, not runtime
// uniforms. Offset widens vs sharpens the gradient stencil; non-integer
// exploits the linear sampler for Gaussian-like free smoothing. Epsilon
// below which gradient normalization is unreliable.
const DRAW_GRAD_OFFSET: f32 = 1.5;
const DRAW_GRAD_EPSILON: f32 = 1e-6;

// Weighted scalar projection of drawing RGBA. Luminance weights on RGB
// distinguish distinct label colors; heavy alpha weight (2.0) makes
// background→drawing transitions dominate. Switched from length(rgba) which
// missed label-to-label boundaries when two labels had similar-magnitude
// RGBA vectors (common when labels share alpha=255 and differ only in hue).
fn drawScalar(c: vec4f) -> f32 {
    return dot(c, vec4f(0.299, 0.587, 0.114, 2.0));
}

struct RayMarchResult {
    color: vec4f,
    firstHit: vec4f,
    farthest: f32,
}

// Shared fast+fine ray-march for overlay, PAQD, and drawing textures.
// Samples `tex` using `samp` (linear or nearest depending on caller).
fn rayMarchPass(
    tex: texture_3d<f32>, samp: sampler,
    start: vec3f, dir: vec3f, len: f32,
    deltaDir: vec4f, deltaDirFast: vec4f,
    ran: f32, earlyTermination: f32
) -> RayMarchResult {
    var result: RayMarchResult;
    result.color = vec4f(0.0);
    result.firstHit = vec4f(2.0 * len);
    result.farthest = 0.0;

    let stepSize = deltaDir.w;
    var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
    let samplePosStart = samplePos;

    // Fast pass
    for (var j: i32 = 0; j < 1024; j++) {
        if (samplePos.a > len) { break; }
        let alpha = textureSampleLevel(tex, samp, samplePos.xyz, 0.0).a;
        if (alpha >= 0.01) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }

    // Fine pass
    for (var i: i32 = 0; i < 2048; i++) {
        if (samplePos.a > len) { break; }
        let colorSample = textureSampleLevel(tex, samp, samplePos.xyz, 0.0);
        if (colorSample.a >= 0.01) {
            if (result.firstHit.a > len) {
                result.firstHit = samplePos;
            }
            result.farthest = samplePos.a;
            let premultiplied = vec4f(colorSample.rgb * colorSample.a, colorSample.a);
            result.color = (1.0 - result.color.a) * premultiplied + result.color;
            if (result.color.a > earlyTermination) { break; }
        }
        samplePos += deltaDir;
    }
    return result;
}

// PAQD easing function — piecewise linear alpha from primary probability.
fn paqdEaseAlpha(alpha: f32, u: vec4f) -> f32 {
    let t0 = u[0];
    let t1 = 0.5 * (u[0] + u[1]);
    let t2 = u[1];
    let y0 = 0.0;
    let y1 = abs(u[2]);
    let y2 = abs(u[3]);
    if (alpha <= t0) { return y0; }
    if (alpha <= t1) { return mix(y0, y1, (alpha - t0) / (t1 - t0)); }
    if (alpha <= t2) { return mix(y1, y2, (alpha - t1) / (t2 - t1)); }
    return y2;
}

// Specialized PAQD ray-march: samples raw PAQD data (nearest-neighbor),
// performs LUT lookup, probability blending, and alpha easing per sample.
fn rayMarchPaqd(
    tex: texture_3d<f32>, lut: texture_2d<f32>,
    start: vec3f, dir: vec3f, len: f32,
    deltaDir: vec4f, deltaDirFast: vec4f,
    ran: f32, earlyTermination: f32,
    paqdUni: vec4f
) -> RayMarchResult {
    var result: RayMarchResult;
    result.color = vec4f(0.0);
    result.firstHit = vec4f(2.0 * len);
    result.farthest = 0.0;

    let texDims = vec3f(textureDimensions(tex, 0));
    let stepSize = deltaDir.w;
    var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
    let samplePosStart = samplePos;

    // Fast pass: skip until prob1 > easing threshold t0
    let t0 = paqdUni[0];
    for (var j: i32 = 0; j < 1024; j++) {
        if (samplePos.a > len) { break; }
        let coord = vec3i(clamp(samplePos.xyz * texDims, vec3f(0.0), texDims - 1.0));
        let raw = textureLoad(tex, coord, 0);
        if (raw.b > t0) { break; }
        samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) { return result; }

    samplePos -= deltaDirFast;
    if (samplePos.a < 0.0) { samplePos = samplePosStart; }

    // Fine pass: decode and accumulate PAQD colors
    for (var i: i32 = 0; i < 2048; i++) {
        if (samplePos.a > len) { break; }
        let coord = vec3i(clamp(samplePos.xyz * texDims, vec3f(0.0), texDims - 1.0));
        let raw = textureLoad(tex, coord, 0);
        let prob1 = raw.b;
        let prob2 = raw.a;
        let total = prob1 + prob2;
        if (total > 0.004) {
            let idx1 = i32(round(raw.r * 255.0));
            let idx2 = i32(round(raw.g * 255.0));
            let c1 = textureLoad(lut, vec2i(clamp(idx1, 0, 255), 0), 0);
            let c2 = textureLoad(lut, vec2i(clamp(idx2, 0, 255), 0), 0);
            let w = prob2 / total;
            let rgb = mix(c1.rgb, c2.rgb, w);
            let alpha = paqdEaseAlpha(prob1, paqdUni);
            if (alpha >= 0.01) {
                if (result.firstHit.a > len) {
                    result.firstHit = samplePos;
                }
                result.farthest = samplePos.a;
                let premultiplied = vec4f(rgb * alpha, alpha);
                result.color = (1.0 - result.color.a) * premultiplied + result.color;
                if (result.color.a > earlyTermination) { break; }
            }
        }
        samplePos += deltaDir;
    }
    return result;
}

// Depth-aware mixing of a ray-march result into the accumulated color.
fn depthAwareMix(
    colAcc: ptr<function, vec4f>,
    result: RayMarchResult,
    backNearest: f32,
    fragDepth: ptr<function, f32>,
    depthFactor: f32
) {
    if (result.color.a <= 0.001) { return; }
    var mixFactor = result.color.a;
    if ((*colAcc).a <= 0.0) {
        mixFactor = 1.0;
    } else if (result.farthest > backNearest) {
        var dx = min((result.farthest - backNearest) / 0.5, 1.0);
        dx = (*colAcc).a * pow(dx, depthFactor);
        mixFactor *= 1.0 - dx;
    }
    *colAcc = vec4f(mix((*colAcc).rgb, result.color.rgb, mixFactor), max((*colAcc).a, result.color.a));
    let passDepth = frac2ndc(result.firstHit.xyz);
    *fragDepth = min(*fragDepth, passDepth);
}

fn distance2Plane(samplePos: vec4f, clipPlane: vec4f) -> f32 {
    // treat clipPlane.a > 1 as "no clip" sentinel
    if (clipPlane.a > 1.0) {
        return 1000.0;
    }
    let n = clipPlane.xyz;
    let EPS = 1e-6;
    let nlen = length(n);
    if (nlen < EPS) {
        return 1000.0; // invalid plane normal
    }
    // signed plane value: dot(n, p-0.5) + a
    let signedDist = dot(n, samplePos.xyz - 0.5) - clipPlane.a;
    // perpendicular (Euclidean) distance is |signedDist| / |n|
    return abs(signedDist) / nlen;
}

@fragment
fn fragment_main(in: VertexOutput) -> FragmentOutput {
	var start = in.vColor;
	let backPosition = GetBackPosition(start);
	let dirVec = backPosition - start;
	var len = length(dirVec);
	let dir = dirVec / len;
	let texVox = vec3f(textureDimensions(volume, 0));
	let lenVox = length(dirVec * texVox);
	if (lenVox < 0.5 || len > 3.0) {
		discard;
	}
	// Save original ray for overlay passes (overlay ignores clip planes)
	let origStart = start;
	let origLen = len;
	// Handle clip plane color (negative alpha means color plane is inside volume)
	var clipPlaneColorX = params.clipPlaneColor;
	if (clipPlaneColorX.a < 0.0) {
		clipPlaneColorX.a = 0.0;
	}
	let stepSize = len / lenVox;
	let deltaDir = vec4f(dir * stepSize, stepSize);
	var localGradientAmount = params.gradientAmount;
	var sampleRange = vec2f(0.0, len);
	let cutaway = params.isClipCutaway > 0.5;
	var hasClip = false;
	for (var i: i32 = 0; i < MAX_CLIP_PLANES; i++) {
		clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);
	}
	let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));
	// Check if clip plane configuration eliminates background entirely
	var skipBackground = false;
	if (cutaway) {
		if (hasClip && sampleRange.x <= 0.0 && sampleRange.y >= len) {
			skipBackground = true;
		}
	} else {
		if (sampleRange.x >= sampleRange.y) {
			skipBackground = true;
		}
	}
	// Shared values for all passes
	let ran = fract(sin(in.position.x * 12.9898 + in.position.y * 78.233) * 43758.5453);
	let stepSizeFast = stepSize * 1.9;
	let deltaDirFast = vec4f(dir * stepSizeFast, stepSizeFast);
	let earlyTermination = 0.95;
	// --- Background passes ---
	var colAcc = vec4f(0.0);
	var firstHit = vec4f(2.0 * origLen);
	var bgHasHit = false;
	var fragDepth = 0.9999;
	var clipOffset = 0.0;
	var clipSurfaceHit = false;
	if (!skipBackground) {
		if (!cutaway && isClip) {
			clipOffset = sampleRange.x;
			start += dir * sampleRange.x;
			len = sampleRange.y - sampleRange.x;
			let alpha = textureSampleLevel(volume, tex_sampler, start.xyz, 0.0).a;
			let alpha1 = textureSampleLevel(volume, tex_sampler, start.xyz - deltaDir.xyz, 0.0).a;
			if ((alpha > 0.01) && (alpha1 > 0.01)) {
				clipSurfaceHit = true;
			}
		}
		var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
		// --- Background Fast Pass ---
		let samplePosStart = samplePos;
		for (var j: i32 = 0; j < 1024; j++) {
			if (samplePos.a > len) { break; }
			if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
				samplePos += deltaDirFast;
				continue;
			}
			let alpha = textureSampleLevel(volume, tex_sampler, samplePos.xyz, 0.0).a;
			if (alpha >= 0.01) {
				break;
			}
			samplePos += deltaDirFast;
		}
		if (samplePos.a >= len) {
			// Background fast pass found nothing — use clip plane color as fallback
			if (isClip) {
				let clipAlpha = clipPlaneColorX.a;
				colAcc = vec4f(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
			}
		} else {
			// Background fast pass found something
			if (cutaway && isClip) {
				let dx = abs(sampleRange.x - samplePos.a);
				let dx2 = abs(sampleRange.y - samplePos.a);
				if (min(dx, dx2) < stepSizeFast) {
					clipSurfaceHit = true;
				}
			}
			if (clipSurfaceHit) {
				localGradientAmount = 0.0;
			}
			samplePos -= deltaDirFast;
			if (samplePos.a < 0.0) {
				samplePos = samplePosStart;
			}
			// --- Background Fine Pass ---
			let norm3 = mat3x3f(params.normMtx[0].xyz, params.normMtx[1].xyz, params.normMtx[2].xyz);
			let brighten = 1.0 + (localGradientAmount / 3.0);
			for (var fi: i32 = 0; fi < 2048; fi++) {
				if (samplePos.a > len) { break; }
				if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
					samplePos += deltaDir;
					continue;
				}
				let colorSample = textureSampleLevel(volume, tex_sampler, samplePos.xyz, 0.0);
				if (colorSample.a >= 0.01) {
					if (!bgHasHit) {
						bgHasHit = true;
						firstHit = samplePos;
					}
					let gradRaw = textureSampleLevel(volumeGradient, tex_sampler, samplePos.xyz, 0.0).rgb;
					let localNormal = normalize(gradRaw * 2.0 - 1.0);
					let n = norm3 * localNormal;
					let uv = n.xy * 0.5 + 0.5;
					let mc_rgb = textureSampleLevel(matcap, tex_sampler, uv, 0.0).rgb * brighten;
					let blendedRGB = mix(vec3f(1.0), mc_rgb, localGradientAmount);
					let finalRGB = blendedRGB * colorSample.rgb;
					let premultiplied = vec4f(finalRGB * colorSample.a, colorSample.a);
					colAcc = (1.0 - colAcc.a) * premultiplied + colAcc;
					if (colAcc.a > earlyTermination) { break; }
				}
				samplePos += deltaDir;
			}
			// Clip surface ambient occlusion
			if (clipSurfaceHit) {
				var min1 = 1000.0;
				var min2 = 1000.0;
				let firstHit1 = firstHit - deltaDir;
				for (var ci: i32 = 0; ci < MAX_CLIP_PLANES; ci++) {
					let d = distance2Plane(firstHit1, params.clipPlanes[ci]);
					if (d < min1) {
						min2 = min1;
						min1 = d;
					} else if (d < min2) {
						min2 = d;
					}
				}
				let thresh = 1.2 * stepSize;
				if (cutaway && min2 < thresh && sampleRange.x > 0.0) {
					if (abs(sampleRange.x - firstHit.a) > (2.0 * thresh) && abs(sampleRange.y - firstHit.a) > (2.0 * thresh)) {
						min2 = thresh;
					}
				}
				let aoFrac = 0.5;
				let factor = (1.0 - aoFrac) + aoFrac * clamp(min2 / thresh, 0.0, 1.0);
				colAcc = vec4f(colAcc.rgb * factor, colAcc.a);
			}
			if (clipSurfaceHit && params.clipPlaneColor.a < 0.0) {
				colAcc = vec4f(mix(colAcc.rgb, clipPlaneColorX.rgb, abs(params.clipPlaneColor.a)), colAcc.a);
			}
			// If fine pass produced nothing, use clip plane color as fallback
			if (colAcc.a <= 0.001 || !bgHasHit) {
				if (isClip) {
					let clipAlpha = clipPlaneColorX.a;
					colAcc = vec4f(clipPlaneColorX.rgb * clipAlpha, clipAlpha);
				}
			} else {
				fragDepth = frac2ndc(firstHit.xyz);
			}
		}
	}
	// --- Optional passes (no clip plane) ---
	let backNearest = clipOffset + firstHit.a;
	let depthFactor = 0.3;
	// Overlay pass
	if (textureDimensions(overlay, 0).x > 2) {
		let result = rayMarchPass(overlay, tex_sampler, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination);
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor);
	}
	// PAQD pass (raw data with GPU-side LUT lookup + easing)
	if (textureDimensions(paqd, 0).x > 2) {
		let result = rayMarchPaqd(paqd, paqdLut, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination, params.paqdUniforms);
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor);
	}
	// Drawing pass (nearest-neighbor sampling for ray-march, linear for gradient)
	if (textureDimensions(drawing, 0).x > 2) {
		var result = rayMarchPass(drawing, nearest_sampler, origStart, dir, origLen, deltaDir, deltaDirFast, ran, earlyTermination);
		// Matcap lighting at first hit. 6-tap central-difference gradient
		// sampled at 1.5 voxels out through the filtering sampler — each
		// tap is a trilinear blend of 8 texels ("Gaussian for free"),
		// which smooths away ray-march step jitter without any
		// precomputed drawingGradient texture. Sign: value(+X) - value(-X)
		// matches the volume gradient's inward-pointing convention.
		if (result.color.a > 0.001 && params.gradientAmount > 0.0) {
			let dv = DRAW_GRAD_OFFSET / vec3f(textureDimensions(drawing, 0));
			let hp = result.firstHit.xyz;
			let vXp = drawScalar(textureSampleLevel(drawing, tex_sampler, hp + vec3f(dv.x, 0.0, 0.0), 0.0));
			let vXm = drawScalar(textureSampleLevel(drawing, tex_sampler, hp - vec3f(dv.x, 0.0, 0.0), 0.0));
			let vYp = drawScalar(textureSampleLevel(drawing, tex_sampler, hp + vec3f(0.0, dv.y, 0.0), 0.0));
			let vYm = drawScalar(textureSampleLevel(drawing, tex_sampler, hp - vec3f(0.0, dv.y, 0.0), 0.0));
			let vZp = drawScalar(textureSampleLevel(drawing, tex_sampler, hp + vec3f(0.0, 0.0, dv.z), 0.0));
			let vZm = drawScalar(textureSampleLevel(drawing, tex_sampler, hp - vec3f(0.0, 0.0, dv.z), 0.0));
			let grad = vec3f(vXp - vXm, vYp - vYm, vZp - vZm);
			if (length(grad) > DRAW_GRAD_EPSILON) {
				let localNormal = normalize(grad);
				let norm3 = mat3x3f(params.normMtx[0].xyz, params.normMtx[1].xyz, params.normMtx[2].xyz);
				let n = norm3 * localNormal;
				let uv = n.xy * 0.5 + 0.5;
				let brighten = 1.0 + (params.gradientAmount / 3.0);
				let mc_rgb = textureSampleLevel(matcap, tex_sampler, uv, 0.0).rgb * brighten;
				let shade = mix(vec3f(1.0), mc_rgb, params.gradientAmount);
				// result.color is premultiplied (rgb = actualColor * alpha).
				// Clamp to alpha so the shade (which can exceed 1.0 via
				// brighten) can't push rgb > alpha and break the
				// premultiplied-alpha invariant that depthAwareMix and
				// framebuffer blending assume.
				let shadedRgb = min(result.color.rgb * shade, vec3f(result.color.a));
				result.color = vec4f(shadedRgb, result.color.a);
			}
		}
		depthAwareMix(&colAcc, result, backNearest, &fragDepth, depthFactor);
	}
	// Final output
	if (colAcc.a <= 0.001) {
		discard;
	}
	var output: FragmentOutput;
	output.color = vec4f(colAcc.rgb, colAcc.a / earlyTermination);
	output.fragDepth = fragDepth;
	return output;
}
