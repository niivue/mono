import NiiVue from '../src/index.ts'

nearestCheck.onclick = function () {
  nv1.volumeIsNearestInterpolation = this.checked
}
darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}
opacitySlider.oninput = function () {
  nv1.setVolume(1, {
    opacity: this.value * 0.01,
  })
}
legendCheck.onclick = async function () {
  await nv1.setVolume(1, { isLegendVisible: this.checked })
}
colorbarCheck.onclick = function () {
  nv1.isColorbarVisible = this.checked
}
colorBtn.addEventListener('input', (event) => {
  const input = event.target
  const hex = input.value
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  nv1.backgroundColor = [r, g, b, 1.0]
})
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
aboutBtn.onclick = () => {
  window.alert('The Automated Anatomical Labeling atlas PMID: 11771995.')
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
const nv1 = new NiiVue({ backgroundColor: [0.3, 0.3, 0.5, 1] })
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)

nv1.showRender = 1
var volumeList = [
  { url: '/volumes/bigbrain/ICBM2009asym.nii.gz' },
  { url: '/volumes/bigbrain/bigbrain.nii.gz' },
]
await nv1.loadVolumes(volumeList)
await nv1.setColormapLabelFromUrl(1, '/volumes/bigbrain/bigbrain.json')
darkCheck.onclick()
legendCheck.onclick()
nearestCheck.onclick()
opacitySlider.oninput()
