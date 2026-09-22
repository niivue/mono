// Rig for the in-shader layer gradient (layerShade in wgpu/render.wgsl and
// gl/renderShader.ts). The overlay and drawing passes carry no precomputed
// gradient texture, so they estimate their own normals per sample -- that
// estimator is what volumeLayerGradientMode selects.
//
// Nothing else in examples/ exercises that path: the pages that load an
// overlay leave volumeIllumination at its 0.0 default, so layerShade never
// runs. This one turns it up and hands the overlay over as a lit surface.
//
// SPLIT SCREEN. Two NiiVue instances stacked on the same spot, each with its
// own volumeLayerGradientMode, mutually linked with broadcastTo so they share
// one camera. The top canvas is clipped to the right of a draggable seam, so
// the pair reads as one image cut down the middle. clip-path clips hit testing
// as well as pixels, so a drag on either half reaches the instance you can see
// there, and the broadcast carries the rotation to the other. Drag the seam
// over a feature to sweep one estimator across it.
//
// Mean angular error against an analytic sphere (4000 near-uniform directions):
//
//   legacy central difference (3 axes)      0.80 deg
//   old niivue 8-corner Sobel (4 diagonals) 0.68
//     ... plus its 27-tap blur prepass      0.55   (precompute; not in-shader)
//   Gaussian blob (both shells)             0.20
//
// so the old estimator sits between the legacy one and the blob. It beats the
// legacy path for the same reason the blob does: diagonals condition a 3D
// gradient better than axes. The two dropdowns pair any two of the three.
//
// What the split shows on this data: a difference you can measure but not see.
// The two sides are NOT pixel identical -- read back at 4112x2304 with the
// default camera, SOBEL8 vs BLOB differ on 775,672 pixels (8.2% of the canvas,
// all of them inside the brain's bounding box, i.e. wherever the lit overlay
// lands). But the differences are tiny: 88% of them are under 7 total across
// RGB (~2 per channel), only 2,069 pixels exceed 32, and the largest single
// channel delta is 47. That is why the seam reads as invisible -- a half-degree
// of normal error moves the matcap lookup by about one texel, so it costs a
// couple of 8-bit levels almost everywhere and a visible amount only on the
// handful of pixels sitting on a specular edge.
//
// The measurement is worth repeating rather than trusting, because the obvious
// way to take it is wrong. A WebGPU canvas has no pixels outside its own frame,
// so drawImage()-ing it from a later task reads all zeros and reports a
// perfectly convincing zero difference. Render on demand and read in the SAME
// task, the way saveBitmap() does:
//
//   const grab = (nv, cv) => { nv.view.render()
//     const c = document.createElement('canvas'); c.width = cv.width
//     c.height = cv.height; const cx = c.getContext('2d')
//     cx.drawImage(cv, 0, 0); return cx.getImageData(0, 0, c.width, c.height).data }
//
// and check the instrument first by setting BOTH sides to the same mode: two
// independent instances then agree bit for bit (ndiff 0 with a non-zero
// non-black count), which is the control that a zero from a dead readback fails.
//
// Two more traps worth knowing. A HIDDEN tab (minimised, occluded, or just not
// the foreground one) fires no requestAnimationFrame, so nothing renders on its
// own and WebGPU queue work can stall outright -- which reads as a hang in
// attachToCanvas rather than as a paused page. Check document.visibilityState
// before believing any of this. Calling view.render() directly sidesteps it,
// which is the other reason the readback above is written that way.
//
// The same measurement on WebGL2 (?backend=webgl2) agrees with WebGPU to well
// under a percent: 779,539 differing pixels of 9,934,592 (7.85%) for SOBEL8 vs
// BLOB against 8.19% on WebGPU, and the same-mode control is bit-exact on both.
// The two backends are running the same estimators, not merely similar ones.
//
// So the honest reading is that the win is real and sub-perceptual on smooth
// overlays; where it should matter is thin or high-curvature structure, where a
// half-degree of normal error lands on a specular highlight instead of next to
// it.
//
// One caveat when reading the SOBEL8 side: upstream runs its 8-corner Sobel
// over a 27-tap blurred copy of the volume, and that prepass is worth 0.13 of
// its 0.55. This page has no prepass, so it draws the 0.68 stencil alone --
// slightly harsh on the old method.
//
// Three overlays, because the estimators separate on some and not others:
//   spmMotor -- a continuous statistical map. Smooth iso-surfaces, which is
//     where a better-conditioned normal shows.
//   aal -- a categorical label atlas. Every boundary is a hard binary step, so
//     the normal is dominated by the voxel staircase and ALL the estimators are
//     poor (measured: 14 deg mean angular error vs 8 deg on an analytic sphere,
//     against 0.80 vs 0.20 for a smooth shell). Included as the counter-example.
//   hippo -- the overlay the OLD niivue's own gradient demo lights
//     (demos/features/gradient.custom.html: mni152 in gray with hippo in red).
//     It is here because it is the case the other two are not: a small, thin,
//     strongly curved structure, which is where a half-degree of normal error
//     was predicted to stop being sub-perceptual. Same scene as upstream's, so
//     the comparison is against the shape that estimator was tuned on. It did
//     NOT separate: SOBEL8 vs BLOB differs on 20,493 pixels with a maximum
//     delta of 8 across RGB, i.e. one 8-bit level per channel, and no pixel
//     anywhere over 32. High curvature alone is not the condition -- the
//     prediction was wrong about which case would show it.
//
// The condition that DOES show it is a CUT SURFACE. Turn on Clip (and Clip
// overlay, which is clipPlaneOverlay: it cuts the optional overlay/drawing
// passes with the base instead of leaving them whole) and the clip face becomes
// a fresh iso-surface that neither estimator has a smooth neighbourhood for.
// SOBEL8 vs BLOB on the clipped spmMotor scene: 466,244 differing pixels, 4,422
// of them over 32 across RGB and 308 over 96, with a maximum delta of 221 --
// against a maximum of 84 and 2,069 over 32 for the same scene uncut. That is
// two to three times the visible error, on the surface the ray-march lights
// with a one-sided neighbourhood. This is the view to compare on.

import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'

const OVERLAYS = {
  spmMotor: {
    url: '/volumes/spmMotor.nii.gz',
    opts: { colormap: 'warm', calMin: 2, calMax: 6 },
  },
  aal: { url: '/volumes/aal.nii.gz', opts: {}, labels: '/volumes/aal.json' },
  hippo: { url: '/volumes/hippo.nii.gz', opts: { colormap: 'red' } },
}

// ?backend=webgl2 preselects the fallback, so the pair can be compared on
// either backend from the URL (repo convention) rather than only by clicking.
if (new URLSearchParams(location.search).get('backend') === 'webgl2') {
  webgpuCheck.checked = false
}

function makeNiivue() {
  return new NiiVue({
    backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
    backgroundColor: [0.1, 0.1, 0.12, 1],
    matcaps: { Cortex: cortex, Shiny: shiny },
  })
}

// nvL draws the left of the seam and nvR the right; nvR is the top canvas, so
// it is the one that gets clipped.
const nvL = makeNiivue()
const nvR = makeNiivue()
const both = [nvL, nvR]

nvL.addEventListener('locationChange', (e) => {
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})
await nvL.attachToCanvas(gl1)
await nvR.attachToCanvas(gl2)

// Both directions, so a drag on either half moves the other. The instances
// guard against the echo internally, so the mutual link does not loop.
const SYNC = { '2d': true, '3d': true, clipPlane: true }
nvL.broadcastTo(nvR, SYNC)
nvR.broadcastTo(nvL, SYNC)

sliceType.onchange = function () {
  for (const nv of both) nv.sliceType = parseInt(this.value, 10)
}
gradSlider.oninput = function () {
  for (const nv of both) nv.volumeIllumination = Number(this.value) / 100
  matcapSelect.disabled = Number(this.value) < 1
}
matcapSelect.onchange = async function () {
  await Promise.all(both.map((nv) => nv.loadMatcap(this.value)))
}
opacitySlider.oninput = function () {
  for (const nv of both) nv.setVolume(1, { opacity: Number(this.value) * 0.01 })
}
backCheck.onclick = function () {
  for (const nv of both) nv.setVolume(0, { opacity: this.checked ? 1 : 0 })
}
// A depth of 2 is the "no clip" sentinel (the shaders read clipPlane.a > 1 as
// off); 0 puts the plane through the centre of the scene. Right-dragging the
// render moves it from there, and clipPlane is in the broadcast set so both
// instances stay on the same cut.
clipCheck.onclick = function () {
  for (const nv of both) nv.setClipPlane([this.checked ? 0 : 2, 180, 20])
  clipOverlayCheck.disabled = !this.checked
}
// clipPlaneOverlay decides whether the optional passes (overlay, drawing) are
// cut with the background or left whole. Off, the overlay floats intact inside
// the cut background; on, it is sliced with it -- which is the useful view here,
// because the cut face is a fresh iso-surface for the two estimators to light.
clipOverlayCheck.onclick = function () {
  for (const nv of both) nv.clipPlaneOverlay = this.checked
}
overlaySelect.onchange = async function () {
  await loadOverlay(this.value)
}
webgpuCheck.onclick = function () {
  const backend = this.checked ? 'webgpu' : 'webgl2'
  for (const nv of both) nv.reinitializeView({ backend })
}
leftMode.onchange = () => {
  applyModes()
}
rightMode.onchange = () => {
  applyModes()
}

function applyModes() {
  nvL.volumeLayerGradientMode = parseInt(leftMode.value, 10)
  nvR.volumeLayerGradientMode = parseInt(rightMode.value, 10)
  labelLeft.textContent = leftMode.selectedOptions[0].textContent
  labelRight.textContent = rightMode.selectedOptions[0].textContent
}

async function loadOverlay(key) {
  const ov = OVERLAYS[key]
  await Promise.all(
    both.map(async (nv) => {
      await nv.loadVolumes([
        { url: '/volumes/mni152.nii.gz', calMin: 30, calMax: 80 },
        { url: ov.url, ...ov.opts },
      ])
      if (ov.labels) {
        await nv.setColormapLabelFromUrl(1, ov.labels)
      }
    }),
  )
  opacitySlider.oninput()
  backCheck.onclick()
}

// The seam is a percentage of the container, so it survives a window resize
// without any resize listener. Hyphenated ids get no implicit global, hence the
// lookup.
const container = document.getElementById('canvas-container')
function setSeam(clientX) {
  const r = container.getBoundingClientRect()
  const pct = ((clientX - r.left) / r.width) * 100
  container.style.setProperty('--seam', `${Math.min(100, Math.max(0, pct))}%`)
}
handle.addEventListener('pointerdown', (e) => {
  handle.setPointerCapture(e.pointerId)
  e.preventDefault()
})
handle.addEventListener('pointermove', (e) => {
  if (handle.hasPointerCapture(e.pointerId)) setSeam(e.clientX)
})
handle.addEventListener('pointerup', (e) =>
  handle.releasePointerCapture(e.pointerId),
)

for (const nv of both) nv.showRender = 1
await loadOverlay(overlaySelect.value)
await Promise.all(both.map((nv) => nv.loadMatcap(matcapSelect.value)))

for (const nv of both) nv.sliceType = parseInt(sliceType.value, 10)
gradSlider.oninput()
clipCheck.onclick()
clipOverlayCheck.onclick()
applyModes()
// Explicit: assigning a property the value it already holds is a no-op, so the
// initial frame can otherwise land before the volumes are uploaded and the
// canvases stay blank until something else nudges a redraw.
for (const nv of both) nv.drawScene()

// Handles for console-driven comparison.
window.nvL = nvL
window.nvR = nvR
