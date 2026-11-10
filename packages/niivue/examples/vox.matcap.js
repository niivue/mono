import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue, { SHOW_RENDER } from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const colorBtn = document.getElementById('colorBtn')
const colormapSelect = document.getElementById('colormapSelect')
const darkCheck = document.getElementById('darkCheck')
const gradSlider = document.getElementById('gradSlider')
const matcapImg = document.getElementById('matcapImg')
const matcapSelect = document.getElementById('matcapSelect')
const sliceType = document.getElementById('sliceType')
const volumeSelect = document.getElementById('volumeSelect')
const webgpuCheck = document.getElementById('webgpuCheck')

// Pick `sphere` to check the lookup: a matcap IS a photograph of a
// sphere, so a correctly oriented render reproduces the image beside the
// dropdown exactly. That is how the 180-degree rotation this shader
// carried until 2026-09-22 was found.
//
// A matcap ("material capture") is a photograph of a lit sphere. The
// shader takes the surface normal at a sample, projects it to screen
// space, and reads the colour at that point of the sphere -- so the
// picture beside the dropdown is not a preview of the lighting, it IS
// the lighting: every shading decision in the render is a lookup into
// those pixels.
//
// The asset modules export the image URL Vite resolved, which is the
// same URL loadMatcap fetches, so showing it costs an <img> and cannot
// fall out of step with what the renderer is sampling.
const MATCAPS = { Cortex: cortex, Shiny: shiny }

const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
  meshXRay: 0.1,
  matcaps: MATCAPS,
  showRender: SHOW_RENDER.ALWAYS,
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)

matcapSelect.onchange = async () => {
  matcapImg.src = MATCAPS[matcapSelect.value]
  await nv1.loadMatcap(matcapSelect.value)
}
gradSlider.oninput = () => {
  const illumination = Number(gradSlider.value) / 100
  nv1.volumeIllumination = illumination
  // Below 1% nothing is lit, so the choice of matcap has no effect.
  matcapSelect.disabled = illumination < 0.01
  matcapImg.style.opacity = illumination < 0.01 ? 0.3 : 1
}
volumeSelect.onchange = async () => {
  await nv1.loadVolumes([{ url: `/volumes/${volumeSelect.value}.nii.gz` }])
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
colormapSelect.onchange = () => {
  nv1.setVolume(0, { colormap: colormapSelect.value })
}
darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}
document.getElementById('xrayCheck').onclick = function () {
  nv1.meshXRay = +this.checked * 0.1
}
colorBtn.oninput = function () {
  const hex = this.value
  const chan = (i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  nv1.backgroundColor = [chan(0), chan(1), chan(2), 1]
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

for (const cmap of nv1.colormapNames('continuous')) {
  const option = document.createElement('option')
  option.value = cmap
  option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
  option.selected = cmap.toLowerCase() === 'gray'
  colormapSelect.appendChild(option)
}

sliceType.onchange()
await matcapSelect.onchange()
gradSlider.oninput()
await volumeSelect.onchange()
