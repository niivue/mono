// Gradient precompute. Mirrors the two fragment passes in gl/gradient.ts
// statement for statement -- same channels, same 8-corner stencil, same
// summation order, same encoding -- because the two backends must produce a
// bit-identical texture. See view/NVGradient.ts.

@group(0) @binding(0) var inputTex: texture_3d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_3d<rgba8unorm, write>;
// LINEAR, clamp-to-edge: the fractional corner taps are trilinear blends.
@group(0) @binding(2) var inputSampler: sampler;

// Supplied from view/NVGradient.ts at pipeline creation.
override sobelRadius: f32;
override gradEps: f32;
override gradShift: f32;
override gradScale: f32;

fn corner(i: u32) -> vec3f {
	return vec3f(f32(i & 1u), f32((i >> 1u) & 1u), f32(i >> 2u)) * 2.0 - 1.0;
}

// Voxel-centre texture coordinate, the WebGL2 pass's fragment centre.
fn centre(pos: vec3<i32>) -> vec3f {
	return (vec3f(pos) + 0.5) / vec3f(textureDimensions(inputTex));
}

// Pass 1: 8-corner box blur of the colormapped ALPHA (monotonic in intensity
// for every LUT, unlike the colour channels) into a temp.
// 8, 8, 4 (256) rather than 8, 8, 8 (512) to meet default invocation limits.
@compute @workgroup_size(8, 8, 4)
fn blur(@builtin(global_invocation_id) id: vec3<u32>) {
	let size = vec3<i32>(textureDimensions(inputTex));
	let pos = vec3<i32>(id);
	if (pos.x >= size.x || pos.y >= size.y || pos.z >= size.z) { return; }
	let vPos = centre(pos);
	let d = sobelRadius / vec3f(size);
	var sum = 0.0;
	for (var i = 0u; i < 8u; i++) {
		sum += textureSampleLevel(inputTex, inputSampler, vPos + d * corner(i), 0.0).a;
	}
	textureStore(outputTex, pos, vec4f(sum * 0.125, 0.0, 0.0, 1.0));
}

// Pass 2: 8-corner Sobel of the blurred temp.
@compute @workgroup_size(8, 8, 4)
fn sobel(@builtin(global_invocation_id) id: vec3<u32>) {
	let size = vec3<i32>(textureDimensions(inputTex));
	let pos = vec3<i32>(id);
	if (pos.x >= size.x || pos.y >= size.y || pos.z >= size.z) { return; }
	let vPos = centre(pos);
	let d = sobelRadius / vec3f(size);
	var grad = vec3f(0.0);
	for (var i = 0u; i < 8u; i++) {
		let s = corner(i);
		grad += s * textureSampleLevel(inputTex, inputSampler, vPos + d * s, 0.0).r;
	}
	// Four taps per side: 0.25 gives the gain of one central difference at
	// this radius, which is what the magnitude encoding was tuned against.
	grad *= 0.25;

	// Guarded normalize; a flat voxel stores vec3(0.0) (encoded 0.5), which
	// the render shaders' own guarded normalize turns back into "no normal".
	let len = length(grad);
	var dir = vec3f(0.0);
	if (len > 0.0001) {
		dir = grad / len;
	}

	// Alpha carries the gradient MAGNITUDE, LOGARITHMIC in the squared
	// gradient; see view/NVGradient.ts for why a linear one is useless.
	let g2 = dot(grad, grad);
	let magnitude = (log2(g2 + gradEps) + gradShift) * gradScale;

	textureStore(outputTex, pos, vec4f(dir * 0.5 + 0.5, magnitude));
}
