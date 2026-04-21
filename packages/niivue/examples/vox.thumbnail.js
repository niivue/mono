import NiiVue from '../src/index.ts'

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
const nv1 = new NiiVue({
  thumbnail: '/volumes/thumbnail.png',
})
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})
await nv1.attachToCanvas(document.getElementById('gl1'))
await nv1.loadVolumes([{ url: '/volumes/mpld_asl.nii.gz' }])

document.getElementById('toggleBtn').onclick = () => {
  nv1.isThumbnailVisible = !nv1.isThumbnailVisible
}
