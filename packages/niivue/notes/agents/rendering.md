# Volume rendering

Moved from `packages/niivue/AGENTS.md`; read it when working on the volume ray-march shaders or render variants. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Volume ray-march architecture

The 3D render shaders (`wgpu/render.wgsl`, `gl/renderShader.ts`) use a multi-pass ray-march:

1. **Background pass** (fast + fine): Gradient lighting via matcap. Handles clip planes.
2. **Optional passes** (overlay, PAQD, drawing): Each uses `rayMarchPass()` (fast skip + fine accumulation with premultiplied alpha), then `depthAwareMix()` for depth-correct compositing. When `gradientAmount > 0`, the drawing pass applies matcap lighting at first hit using a gradient sampled from the drawing volume (same uniform gate as the background pass).

Guards: Each optional pass checks `textureSize > 2` (placeholder is 2×2×2 all zeros).

Specialization: a uniform that is constant for a draw still costs per pixel (runtime branches block dead-code elimination; inactive clip planes alone cost ~20%), so gate features with the compile-time flags in `view/NVRenderVariant.ts` (WGSL `override`, GLSL `#define`), ANDed with the runtime test. On WebGPU, draws with an overlay, PAQD or drawing layer stay generic: specializing them measured up to 40% slower on Metal, so re-measure before extending it there.

Render modes: `renderMode` is one field holding a `VOLUME_RENDER_MODE`, so
always test it for EQUALITY (`isRenderMode()` in the shader preambles,
`=== VOLUME_RENDER_MODE.X` on the CPU). A `> 0.5` test reads `SLICES` as
`MAXIMUM` — which picks the MIP shader variant and, on a chunked volume, the MAX
blend equation. `CINEMATIC` never reaches the classic shaders: both views hand
the volume renderer COMPOSITE in that mode (used by its fallbacks), see
"Cinematic render mode".

`SLICES` does not march at all. It intersects the ray with the three crosshair
planes, samples the whole layer stack at each hit with `sampleSlice()` (the
order the 2D tiles blend in, not the march's per-layer passes), and composites
the hits front to back. Whether air is painted or dropped follows
`isAlphaClipDark`, the same flag the 2D tiles take, so the two agree on what a
plane shows; the render and BOTH depth picks have to apply the same rule, or a
click lands somewhere nothing is drawn. The planes arrive in the `sliceFrac`
GLSL uniform / three `.w` lanes of the WebGPU `Params` struct, and the flag in a
fourth (see `sliceFrac()` / `alphaClipDark()` in `wgpu/volumeShaderLib.ts`) —
lanes, not a bigger struct, because `Params` is 512 bytes with one
256-byte-aligned slot per tile AND per chunk. Geometry needs nothing chunk-specific: `start`/`dir`/`len` already come
from the drawn cube. The depth-pick shaders carry the same plane test, and
`NVTransforms.rayPlaneFirstVisibleMM` is its CPU twin for chunked volumes the
GPU pick cannot sample; a miss there falls through to the GPU pass, which is the
only one that picks MESHES.

Two things the march does, SLICES skips. The per-level LOD brightness exponent:
`_lodGamma()` on both renderers returns 1 in SLICES, because a plane takes one
sample whatever the brick's level, and applying it made a coarse floor brick's
planes read brighter than the resident fine ones beside them. And the background
`opacity`: in the independent hi-res overlay cube draw (`chunkOverlayOf`) the
bound texture is a LAYER, so `sampleSlice(pos, isLayer)` takes the sample's own
baked alpha instead.

### PAQD (probabilistic atlas with quantized distances)

GPU-side visualization: raw data (idx1, idx2, prob1, prob2 as rgba8unorm) uploaded with 256-entry label LUT texture. Shaders perform LUT lookup, probability-weighted blending, and alpha easing. **Split sampling**: label indices use nearest-neighbor; probabilities use linear interpolation.
