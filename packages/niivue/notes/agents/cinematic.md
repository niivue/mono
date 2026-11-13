# Cinematic render mode

Moved from `packages/niivue/AGENTS.md`; read it when working on cinematic (path-traced) rendering. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Cinematic render mode

`volumeRenderMode = VOLUME_RENDER_MODE.CINEMATIC` (3): progressive path
tracing of volumes[0] plus either one label volume or standard overlays, in the render tiles of both
view tile loops. Settings: `model.volume.cinematic` (`CinematicOptions`,
defaults in `VOLUME_DEFAULTS.cinematic`), controller `volumeCinematic` (setter
merges a partial object), constructor `volumeCinematic`, saved in NVD with the
volume group; setter, constructor and `loadDocument` pass it through
`clampCinematicOptions` (a zero `stepVoxels` never advances the ray, so its
floor is 0.05). nv-mcp exposes it as an object setting; ipyniivue's generator
skips it (no object types). `cinematicFrameMs` (read-only) is the mean GPU time
of the march, summed over tiles, for the first 10 frames after any tile
restarts (`CinematicFrameTimer`): WebGPU timestamp queries ('timestamp-query'
requested when the adapter has it), WebGL2 `EXT_disjoint_timer_query_webgl2`;
null without either. volumes[0] (and the label volume) are read at their
`frame4D`. Intensities upload as half-float bits (`halfFloatBits`, hand-rounded
where `Float16Array` is missing). Half floats stop at 65504, so `CinematicCpuCache`
first replaces non-finite voxels (`sanitizeIntensities`: NaN becomes the lower
of 0 and the finite minimum, Inf the finite extreme), then multiplies by a power
of two when needed (`halfFloatScale`). The TF window, `gMax` and label `lo`/`hi`
carry the same factor (no shader change), so gradient thresholds stay in data
units and the image matches a float pipeline. Precision is half float's:
about 1/1024 of the value, so a narrow window on top of a large offset bands.

**Files:** `view/NVCinematic.ts` (shared CPU side, unit-tested: TF bake, label
materials, dilation, calibration, clip rescale, light, uniform packing, and
`CinematicCpuCache`, which rebuilds only on version tokens: `_dataVersion`,
`colormapKey`, calMin/calMax, label volume identity + `hiddenLabels`, label
mode, `frac2mm` identity; `calculateRAS` clones it per affine, and only a changed
voxel order re-uploads intensities). `wgpu/cinematic.ts` + `cinematic*.wgsl` (`cinematicCommon` is prepended
to the march and extinction so primary and shadow rays classify identically).
`gl/cinematic.ts` + `gl/cinematicShader.ts` mirror them method for method and
statement for statement.

Each view builds the renderer (shaders, pipelines) on its first CINEMATIC
frame through `ensure()`, once, not at view init: WebGPU compiles pipelines at
creation (~0.5 s GPU per view on SwiftShader). Unsupported volumes (chunked,
RGB) fall back before it is built.

**Frame structure (WebGPU):** `beginFrame`; on the first cinematic tile
`prepare` (CPU cache update, uploads, gradient and extinction prep passes when
dirty) records into a SEPARATE command encoder; each RENDER tile calls `draw`,
which records one march dispatch (unless converged) into that encoder and draws
a triangle in the tile viewport of the main pass that resolves the mean colour
and writes `frag_depth` (pipeline: view sample count, `depth24plus`,
`depthCompare: 'always'`), so meshes and the crosshair drawn after it
depth-test against the volume. `queue.submit([cinematic, main])`. `endFrame`
frees tiles not drawn (and every volume resource when no tile was, e.g. after
leaving CINEMATIC) and reports whether a tile still refines; the view then
schedules one `render()` after `onSubmittedWorkDone` (one frame in flight), not
while `_isDragging` (each camera change draws one restarted frame). Each tile
(keyed by tile index, sized to it in device px; multiplanar and mosaic render
tiles each get one) restarts on any change of options, cache version, viewport,
MVP, clip planes, clip colour, cutaway, background or affine. First-hit depth is set on frame 0
(first sample with table alpha >= 0.01, as the classic march), not
min-accumulated. The light comes from each tile's own model matrix (mosaic
tiles use `calculateMvpMatrix2D`'s). The march assumes an orthographic camera.

**Frame structure (WebGL2):** same calls and tile keys; `init` leaves the
renderer not ready without `EXT_color_buffer_float` or when its shaders fail
to compile (the view then draws COMPOSITE with one warning). Compute becomes fragment passes drawing a
fullscreen triangle: prep passes one per 3D layer (`framebufferTextureLayer`,
detached afterwards: a framebuffer that is not bound keeps a deleted texture alive),
extinction mips by rendering each level while `TEXTURE_BASE/MAX_LEVEL` pin
sampling to the previous one (no feedback loop), `LINEAR_MIPMAP_NEAREST` to
match WebGPU's default nearest mip filter. Uniforms are std140 blocks fed the
same `pack*Params` arrays. The march blends a running MEAN into a per-tile
RGBA16F target (`CONSTANT_ALPHA`, alpha 1/(n+1); an fp16 sum bands and RGBA32F
blending needs `EXT_float_blend`), so the display gets frames = 1. Frame 0
draws unblended into accum + an R32F depth target; later frames bind an
accum-only framebuffer. The march unprojects GL NDC z -1..1, so its depth is
window depth for both `orthoZO` (render tile) and `ortho` (mosaic tile) MVPs.
Integer and float32 textures are `NEAREST` (else incomplete: `texelFetch`
reads 0). Every pass saves and restores framebuffer, viewport, program, VAO,
blend, depth, scissor and cull state. Refinement waits on a fence
(`fenceSync`, polled each rAF) before the next frame, like WebGPU's
`onSubmittedWorkDone`: queued behind a 20-60 ms march, plain rAF blocked the
main thread (26 long tasks up to 99 ms in 8 s) and tripled the timed cost.

**Inputs:** transfer function = volumes[0]'s colormap mapped across its
calMin..calMax (scaled units: HU for CT). Optional colormap keys, kept by
`addColormap` (as are `min`/`max`): `E` (alpha at high gradient; `A` becomes
interior alpha), `S` (specular), `gradient {lo, hi}` (HU/mm interior-to-surface
ramp), `gMax`, `shininess`, `labelBlend`. Label volume: the first volume after
volumes[0] with a label colormap that is drawn and shares volumes[0]'s grid
(dims, frac2mm within 1e-3); values must be 0-254 (warned otherwise). Its label
colormap is the material table (`R G B A I labels` plus per-label `S`,
`surface`, `lo`/`hi`, `normalize`); `hiddenLabels` (legend toggle) hide labels.
In cinematic tiles the classic volume draw is skipped, so the label volume is
drawn only by cinematic; 2D tiles are unchanged. Calibration (`normalize`) maps
label medians piecewise linearly on the CPU; a calibrated volume's TF window is
the colormap's own `min`/`max` (else the calibrated calMin..calMax).

**Standard overlays:** without a visible label, PAQD or streamed overlay
(`canUseCinematicOverlays`), both cinematic
renderers borrow `volumeRenderer.overlayTexture`, whose prep path owns
registration, colormaps, asymmetric thresholds, opacity, visibility and stack
blending. A separate unlit march (no anatomical shadows/extinction) is mixed
with the anatomy by depth, as in the classic shader; clip planes apply only with
`clipPlaneOverlay`; gamma applies; opacity correction is per overlay voxel
crossed (`overlayStep * length(df * overlayDims)`), so anisotropic overlays
match classic. A hidden background (opacity 0 or `visible: false`) still draws
the overlays: the view passes `isBackgroundVisible` and the shader skips the
anatomy march (`labelInfo.w`). A visible label volume over a hidden background
draws as labelMode 'only' (`cinematicOptionsForFrame`): it needs the anatomy
march, since intensities shape its surfaces, but no unlabeled tissue shows or
casts shadows. The view bumps `_cinematicOverlayVersion` after
stack/affine updates so an in-place texture rewrite restarts accumulation; the
cinematic renderer never frees the borrowed texture.

**Limits:** not drawn, with one `log.warn`: standard overlays mixed with a
visible label volume (the same-grid label volume draws alone), and any visible
PAQD, streamed or off-grid label overlay (all standard overlays omitted).
Channel stacks draw no overlays. Chunked
(streamed) and RGB/RGBA backgrounds (no scalar intensity for the TF,
`hasScalarIntensity`) draw COMPOSITE (one `log.warn` each). The drawing layer is
not drawn in cinematic render tiles (one `log.warn`; 2D tiles still show it, and
no drawing pass exists yet). Memory per
cinematic volume: a duplicate r16float intensity texture, an rgba16float
gradient (8 B/voxel), a half-res rgba16float extinction mip chain, and an r8uint
label id texture; all freed when no tile is cinematic. Depth picking uses the
classic march. The TotalSegmentator tables (66-113 labels) fill a
multi-column, scrolling legend (see Legend visibility; grouping deferred). Meshes (streamlines too) keep their own shaders and only depth-composite:
they get no cinematic shadow or AO and cast none on the volume (deferred). Gradient thresholds (HU/mm) were tuned on ~1.5 mm data and are
not resolution invariant (fix: fixed-mm smoothing before Sobel). Extinction
classifies at voxel centres while the march interpolates, so a narrow band-pass
TF can be skipped where an edge crosses the band between voxels (fix if seen:
per-block min/max). Angio presets on non-contrast CT colour low-density bone
red (cancellous bone and contrast blood share 150-400 HU; a gradient probe was
tried and reverted 2026-10-31; research on branch `cinematic-blood-vs-bone`).

**Rendering details worth keeping:** 2D TF lookup is HU x sqrt-spaced gradient
magnitude. Shading blends volumetric (normal-free) and Blinn-Phong surface
terms by surfaceness; Bannerman normal reuse. Shadows and AO cone-trace the
extinction mips; empty-space skip reads mip `SKIP_LOD`. `isStochasticLighting` (default off,
demo "Fast light") moves the cones out of the march loop: lit = A x AO +
B x shadow per sample, the march sums A + B, and one sample per ray, picked
with probability proportional to weight x luminance(A + B), traces both cones
after the loop and subtracts its loss scaled by sum/share (unbiased). Cones
nested in the march were 60-75% of a frame and WebGL2 ran them ~2x slower than
WebGPU; CT_Abdo 900 px: WebGPU 16.8 -> 6.5, WebGL2 24.6 -> 9.4 ms/frame;
converged images match (mean |d| 0.3/255; the classic path skips samples
below weight 0.002 for secondary rays, the stochastic one does not, so a very
hazy table can converge slightly darker). Early frames speckle where the
picked sample's colour differs from the pixel's (white bone behind red tissue
tints a frame grey-green). Mip downsample reads 3
texels along odd axes (2 drops the last texel and coarse data drifts, so the
skip jumps over tissue). Secondary rays start 1.5 extinction voxels off the
surface (from the surface they show wood-grain self-shadow rings). Clip planes
are rescaled to mm and clip each ray to an interval (solid: march inside,
cutaway: jump over); cone traces skip clipped material. Samples within 1.5
voxels past a cut face use the TF's maximum-gradient row for opacity (edge
alpha), so a cut through translucent, low-gradient tissue (white matter, CSF)
reads as a solid face instead of wrinkled interior noise, and are unlit like
the classic clip surface: albedo x AO x 0.6, no direct light, shadow or
specular (lit, the plane normal often faced the light and tone-mapped grey and
white matter to near white; 0.6 keeps albedos off the ACES shoulder). A
negative `clipPlaneColor` alpha tints that albedo toward the clip colour by
|alpha| (`clipTint`, uniform `clipColor`), as the classic `shading` mode does;
a positive alpha draws nothing, since the classic translucent sheet over
empty space would be an unlit plane in a path-traced scene; in air
`E` is 0, so a cut through empty space only starts the ray. A label sample is the nearest voxel at a point jittered up to
half a voxel per frame, so boundaries average like trilinear weights. Each
visible label spreads one voxel (6-neighbours) into unlabeled/hidden voxels, so
the intensity ramp, not the categorical boundary, ends a surface; hidden labels
become id 255. Label 0 uses the base TF scaled by the label mode ('only' 0,
'unlabeled' 1). With `labelBlend` > 0 the intensity TF shapes labelled tissue
and the label tints it by that fraction and gates it; otherwise label material
ramps shape it (harder, mesh-like). ACES tone map in the display pass.

**Demo** (`examples/cinematic.html`, public API only): presets `cr_skin_bone`,
`cr_bone`, `cr_angio`, `cr_angio_1d`, `cr_t1`, label-modulated `cr_ct_mod`/
`cr_t1_mod` (defaults for labelled samples), and two built per volume
(`VOLUME_PRESETS`): `cr_default` (greyscale over the robust range, for any
non-CT scan) and `cr_t1_extracted` ("extracted T1", the MNI152 samples'
default: a three-class Otsu split of the above-background histogram places
flesh-toned grey and white matter; brain-extracted T1 only, since scalp and
skull join the classes otherwise; both are disabled on label-calibrated samples,
whose table units a raw-intensity fit cannot match); in `cr_angio` the gradient
suppresses bone-edge partial volume in the vessel band (CT_Abdo: vessel-band
voxels near bone median 159 HU/mm vs 38 away). Label tables `ts_wholebody.json`
(TotalSegmentator, CC BY 4.0; v1 has no forearm/hand bones), `ts_abdopelvis.json`
(same numbering, alpha 0 for absent structures, which also drops them from the
legend), `siam_t1.json` (MR, BSD-2: `normalize` CSF 0, GM 100, WM 200; cortex
ramp 30-70; structures without reliable T1 contrast use an always-on ramp, `lo`
-1000 `hi` -999). The MNI152 sample loads `spmMotor.nii.gz` statistics
(`redyell` / `winter`, +3..+6 / -3..-6, as in `vox.stats.html`). `mr-mni152-tract` adds `TR_S_R.tt.gz` streamlines (`fiberRadius` 0.5) with clip plane 1 and `meshXRay` 0.05 (samples may set `meshes`, `clip`, `meshXRay`; `?clip=` wins). "Fast light" (`?fastlight=1`) sets `isStochasticLighting`. "Clip color" (`?clipcolor=`, default `transparent`) sets the alpha of `clipPlaneColor` as `vox.clip.html` does. A table's `settings` key (slider values) is demo-only. For
label-calibrated MR the classic view keeps the grey window. Samples by id
(`?sample=`: `ct-abdo`, `ct-philips`, `ct-electrodes`, `ct-wholebody`,
`ct-wholebody-labels`, `ct-abdopelvis-labels`, `mr-mni152`, `mr-mni152-tract`, `mr-t1-scalp` (`chris_t1.nii.gz`, not brain extracted, on `cr_default`), `mr-siam`); `index.html` links
"Cinematic CT" and "Cinematic Labeled MR", and under Tract Scenes "Cinematic streamlines" (`mr-mni152-tract`). Data: niivue-demo-images-lfs; LFS
objects load via `media.githubusercontent.com` with `?v=` (raw returns
pointers). Add a sample only after its LFS PR merges: requesting a media URL
before the file exists makes GitHub's CDN cache the 404 for that exact URL
(query included), and only a new `?v=` escapes it. LFS PR #7 (cleaned MR
segmentation) is pending: after it merges, move the MR URLs to `?v=2`, never
before. CT_AVM and CT_pitch are uint8, not HU: excluded. `window.nv1` is exposed
for scripted checks.

**Performance** (measured on the removed example prototype, march GPU time per frame, ~1400x605, M4 Pro,
azimuth 150 / elevation 15): CT_Philips bone 6 ms, CT_WholeBody skin+bone 37
ms, CT_Abdo angio 15 ms. Cone tracing replaced per-sample shadow rays (~10-17x
on translucent scenes). Light scenes can read ~3x slower in some sessions (GPU
clock scaling).
