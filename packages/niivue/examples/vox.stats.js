import NiiVue from '../src/index.ts'

checkCutaway.onclick = function () {
  nv1.isClipPlaneCutaway = this.checked
}
clipSelect.onchange = function () {
  const index = parseInt(this.value, 10) // selected option value as integer
  let planes = [[2.0, 180, 20]]
  switch (index) {
    case 1:
      planes = [[0.1, 180, 20]]
      break
    case 2:
      planes = [
        [0.1, 180, 20],
        [0.1, 0, -20],
      ]
      break
    case 3:
      planes = [
        [0.0, 90, 0], //right center
        [0.0, 0, -20], //posterior oblique
        [0.1, 0, -90], //inferior
      ]
      break
    case 4:
      planes = [
        [0.3, 270, 0], //left
        [0.3, 90, 0], //right
        [0.0, 180, 0], //anterior
        [0.1, 0, 0], //posterior
      ]
      break
    case 5:
      planes = [
        [0.4, 270, 0], //left
        [0.4, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
      ]
      break
    case 6:
      planes = [
        [0.4, 270, 0], //left
        [-0.1, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
        [0.3, 0, 90], //superior
      ]
      break
  }
  nv1.setClipPlanes(planes)
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
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
aboutBtn.onclick = () => {
  window.alert(
    'NiiVue allows asymmetric positive and negative statistical thresholds.',
  )
}
colorSelect.onchange = function () {
  const index = this.selectedIndex
  const clr = nv1.clipPlaneColor
  switch (index) {
    case 0:
      clr[3] = 0.0
      break
    case 1:
      clr[3] = 0.3
      break
    case 2:
      clr[3] = -0.2
      break
  }
  nv1.clipPlaneColor = clr
}
function updateThresholds() {
  const minNeg = slideMinNeg.value * -0.1
  const maxNeg = minNeg + slideRangeNeg.value * -0.1
  const min = slideMin.value * 0.1
  const mx = min + slideRange.value * 0.1
  const cmapType = alphaMode.selectedIndex
  nv1.setVolume(1, {
    calMinNeg: minNeg,
    calMaxNeg: maxNeg,
    calMin: min,
    calMax: mx,
    colormapType: cmapType,
  })
}
slideMin.oninput = () => {
  updateThresholds()
}
slideRange.oninput = () => {
  updateThresholds()
}
slideMinNeg.oninput = () => {
  updateThresholds()
}
slideRangeNeg.oninput = () => {
  updateThresholds()
}
outlineSlide.oninput = function () {
  nv1.volumeOutlineWidth = 0.25 * this.value
}
alphaMode.onchange = () => {
  updateThresholds()
}
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.1, 0.1, 0.1, 1],
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
nv1.showRender = 1
var volumeList = [
  {
    url: '/volumes/mni152.nii.gz',
    isColorbarVisible: false,
    calMin: 30,
    calMax: 80,
  },
  {
    url: '/volumes/spmMotor.nii.gz',
    colormap: 'redyell',
    colormapNegative: 'winter',
  },
]
await nv1.loadVolumes(volumeList)
updateThresholds()
clipSelect.onchange()
checkCutaway.onclick()
colorSelect.onchange()
