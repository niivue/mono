import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const dxSlider = document.getElementById('dxSlider')
const radioCheck = document.getElementById('radioCheck')
const webgpuCheck = document.getElementById('webgpuCheck')

dxSlider.oninput = function () {
  let dx = parseFloat(this.value)
  if (dx > 10) dx = Infinity
  nv1.meshThicknessOn2D = dx
}
radioCheck.onclick = function () {
  nv1.isRadiological = this.checked
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
const nv1 = new NiiVue({
  backgroundColor: [0.3, 0.2, 0.4, 1],
  isDragDropEnabled: false,
})
await nv1.attachToCanvas(gl1)
nv1.setClipPlanes([[0.1, 180, 20]])
await nv1.loadVolumes([{ url: '/volumes/fs/brainmask.mgz' }])
await nv1.loadMeshes([
  { url: '/meshes/fs/rh.pial', color: [0.8, 0.6, 1.0, 1.0] },
])
