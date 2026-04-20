struct PanelUniforms {
	canvasSize: vec2f,
};

struct Panel {
	rect: vec4f,
	color: vec4f,
	radius: f32,
	_pad0: f32,
	_pad1: f32,
	_pad2: f32,
};

@group(0) @binding(0) var<uniform> u: PanelUniforms;
@group(0) @binding(1) var<storage, read> panels: array<Panel>;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) color: vec4f,
	@location(1) localPos: vec2f,
	@location(2) size: vec2f,
	@location(3) radius: f32,
};

@vertex
fn vertex_main(
	@builtin(vertex_index) vIdx: u32,
	@builtin(instance_index) iIdx: u32
) -> VertexOutput {
	let panel = panels[iIdx];
	var pos = vec2f(0.0);
	if (vIdx == 1u) { pos.x = 1.0; }
	else if (vIdx == 2u) { pos.y = 1.0; }
	else if (vIdx == 3u) { pos = vec2f(1.0); }
	let pixelPos = panel.rect.xy + pos * panel.rect.zw;
	let ndc = (pixelPos / u.canvasSize) * 2.0 - 1.0;
	var out: VertexOutput;
	out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
	out.color = panel.color;
	out.localPos = pos * panel.rect.zw;
	out.size = panel.rect.zw;
	out.radius = panel.radius;
	return out;
}

fn roundedRectDistance(localPos: vec2f, size: vec2f, radius: f32) -> f32 {
	let r = max(radius, 0.0);
	let halfSize = size * 0.5;
	let q = abs(localPos - halfSize) - (halfSize - vec2f(r));
	return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
	let dist = roundedRectDistance(in.localPos, in.size, in.radius);
	let aa = fwidth(dist);
	let alpha = 1.0 - smoothstep(-aa, aa, dist);
	if (alpha <= 0.0) { discard; }
	return vec4f(in.color.rgb, in.color.a * alpha);
}
