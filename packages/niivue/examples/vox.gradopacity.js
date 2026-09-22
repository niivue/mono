// Gradient opacity and silhouette enhancement -- the two background-volume alpha
// modulations that read the PRECOMPUTED gradient texture (the same texture the
// matcap illumination lights from, not the in-shader layer gradient that
// vox.blobgrad.js compares).
//
// Both live in the background fine pass of wgpu/render.wgsl and
// gl/renderShader.ts, applied to the per-sample alpha after the opacity
// correction:
//
//   volumeGradientOpacity  a *= magnitude ^ (gradientOpacity * 8)
//   volumeSilhouette       a *= (1 - |dot(normal, rayDir)|) ^ silhouette
//                          and a = 0 where |dot| > 1 - silhouette
//
// magnitude is the gradient texture's alpha channel, normal its RGB decoded from
// [0,1] back to [-1,1]. Gradient opacity suppresses homogeneous interior and
// keeps edges, so the volume reads as a set of surfaces rather than a fog.
// Silhouette then fades material whose normal faces the camera, leaving the rim
// where the surface turns away -- the Fresnel term of a classic non-photorealistic
// volume render.
//
// The old niivue does this with a 192-entry LUT, lut[i] = pow(i/191, amount*8),
// indexed by int(magnitude*192). That table IS pow() sampled at 192 points, so
// this port evaluates it analytically instead: no buffer to upload, no 192-step
// quantisation, and 0 is a no-op by construction (pow(m, 0) == 1). Both shaders
// still branch on > 0 so the untouched default costs nothing.
//
// Defaults here mirror the upstream demo (demos/features/gradient.opacity.html):
// mni152, clip plane [0.35, 290, 0], illumination 0.7, gradient opacity 0.7. Its
// sliders are 0..1 for gradient opacity and 0..0.95 for silhouette; the setters
// clamp to [0,1] either way.
//
// BACKEND PARITY NOTE. Both backends build the gradient texture with the SAME
// estimator, so the two produce the same image -- verified bit-for-bit by
// e2e/gradient-parity.spec.ts, which runs both passes over one volume and diffs
// the readbacks. Three fixes got them there, and all three were found by
// measuring rather than by reading the code.
//
// 1. Only WebGPU had ever stored a magnitude at all -- the GL pass wrote a
//    constant 1.0 in alpha, which made gradient opacity a silent no-op there.
//    Both now write one, and it is LOGARITHMIC in the squared gradient. A
//    LINEAR magnitude sits near zero through most of a volume, so pow(m, 5.6)
//    at gradient opacity 0.7 drives the whole render to black -- measured,
//    mean luminance 29 to under 1.
// 2. The two backends differentiated DIFFERENT CHANNELS: WebGL2 the
//    colormapped alpha, WebGPU the red. That is not a tuning difference. On the
//    `hot` LUT red saturates at 37% of the intensity range and is flat above
//    it, so WebGPU returned zero gradient -- no lighting, no silhouette, no
//    gradient opacity -- across the top 63% of the data; on `gray` the two
//    disagreed by a factor of 2 (red ramps to 255, alpha to 128). Alpha is
//    monotonic in intensity for every LUT, so both now read alpha.
// 3. WebGPU ran a different stencil (an 8-corner Sobel plus a 27-tap blur)
//    against WebGL2's three central differences at +-0.7 voxel. The blur was
//    the subtle one: it ran on the ENCODED texture, averaging already-
//    normalized normals and already-log-compressed magnitudes, so it biased the
//    magnitude field rather than smoothing it. WebGPU now runs WebGL2's
//    estimator -- WebGL2 has no compute shaders, so it defines what is
//    reachable -- and gets its smoothing the same way WebGL2 does, free from
//    the linear sampler at the fractional radius. The blur pass is gone.
//
// The shared constants live in src/view/NVGradient.ts; sobel.wgsl takes them as
// pipeline-overridable constants and gl/gradient.ts interpolates the same
// values into its GLSL, so the two encodings cannot drift. Toggle WebGPU (or
// ?backend=webgl2) to compare.

import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'
import { SHOW_RENDER } from '../src/NVConstants.ts'

// mni152 and chris_t1 are MR (a skull-stripped brain and a whole head); the two
// CT volumes are the interesting silhouette cases, because a CT's air/tissue and
// tissue/bone steps give the gradient something much sharper to work with.
const VOLUMES = {
  mni152: { url: '/volumes/mni152.nii.gz' },
  chris_t1: { url: '/volumes/chris_t1.nii.gz' },
  visiblehuman: { url: '/volumes/visiblehuman.nii.gz' },
  torso: { url: '/volumes/torso.nii.gz' },
}

// Repo convention: ?backend=webgl2 preselects the fallback so the same page can
// be verified on either backend from the URL.
if (new URLSearchParams(location.search).get('backend') === 'webgl2') {
  webgpuCheck.checked = false
}

const nv1 = new NiiVue({
  backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
  matcaps: { Cortex: cortex, Shiny: shiny },
  showRender: SHOW_RENDER.ALWAYS,
})
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})
await nv1.attachToCanvas(gl1)

opacitySlider.oninput = function () {
  nv1.volumeGradientOpacity = Number(this.value) / 100
}
silhouetteSlider.oninput = function () {
  nv1.volumeSilhouette = Number(this.value) / 100
}
gradSlider.oninput = function () {
  nv1.volumeIllumination = Number(this.value) / 100
  matcapSelect.disabled = Number(this.value) < 1
}
matcapSelect.onchange = async function () {
  await nv1.loadMatcap(this.value)
}
// A depth of 2 is the "no clip" sentinel (the shaders read clipPlane.a > 1 as
// off). 0.35/290/0 is upstream's plane: it opens the left hemisphere, which is
// where the interior suppression is easiest to read.
clipCheck.onclick = function () {
  nv1.setClipPlane([this.checked ? 0.35 : 2, 290, 0])
}
volumeSelect.onchange = async function () {
  await nv1.loadVolumes([VOLUMES[this.value]])
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
colorBtn.oninput = function () {
  const hex = this.value
  const chan = (i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  nv1.backgroundColor = [chan(0), chan(1), chan(2), 1]
}

nv1.sliceType = 4
await nv1.loadVolumes([VOLUMES[volumeSelect.value]])
await nv1.loadMatcap(matcapSelect.value)
opacitySlider.oninput()
silhouetteSlider.oninput()
gradSlider.oninput()
clipCheck.onclick()
// Explicit: assigning a property the value it already holds is a no-op, so the
// first frame can otherwise land before the volume is uploaded.
nv1.drawScene()

window.nv1 = nv1
