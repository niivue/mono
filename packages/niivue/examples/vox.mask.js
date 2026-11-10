import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const darkCheck = document.getElementById('darkCheck')
const maskCheck = document.getElementById('maskCheck')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
maskCheck.onchange = async function () {
  nv1.volumeIsBackgroundMasking = this.checked
  await nv1.updateGLVolume()
}
darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  is3DCrosshairVisible: true,
})
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([
  {
    url: '/volumes/fslmean.nii.gz',
    colormap: 'gray',
    opacity: 1,
  },
  {
    url: '/volumes/fslt.nii.gz',
    colormap: 'redyell',
    calMin: 0.05,
    calMax: 5.05,
    opacity: 0.9,
  },
])
nv1.sliceType = 4
nv1.setClipPlane([0.15, 270, 0])
nv1.azimuth = 45
nv1.elevation = 45
sliceType.onchange()
