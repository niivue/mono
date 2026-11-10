import NiiVue, { SHOW_RENDER } from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const axisColorCheck = document.getElementById('axisColorCheck')
const colormapSelect = document.getElementById('colormapSelect')
const darkCheck = document.getElementById('darkCheck')
const orientCheck = document.getElementById('orientCheck')
const sliceType = document.getElementById('sliceType')
const volumeSelect = document.getElementById('volumeSelect')
const webgpuCheck = document.getElementById('webgpuCheck')

orientCheck.onclick = async function () {
  nv1.isOrientCubeVisible = this.checked
  nv1.isOrientationTextVisible = this.checked
}
volumeSelect.onchange = async function () {
  await nv1.loadVolumes({ url: `/volumes/${this.value}.nii.gz` })
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
colormapSelect.onchange = async function () {
  nv1.setVolume(0, { colormap: this.value })
}
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}
// crosshairColorPerAxis tints each crosshair segment by the world axis it
// extends along: X red, Y green, Z blue, the same colors as the orient
// cube. An empty array restores the single crosshairColor.
axisColorCheck.onclick = function () {
  nv1.crosshairColorPerAxis = this.checked
    ? [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ]
    : []
}
const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
  showRender: SHOW_RENDER.ALWAYS,
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
for (const cmap of nv1.colormapNames('continuous')) {
  const option = document.createElement('option')
  option.value = cmap
  option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
  if (cmap.toLowerCase() === 'gray') {
    option.selected = true
  }
  colormapSelect.appendChild(option)
}
sliceType.onchange()
orientCheck.onclick()
volumeSelect.onchange()
