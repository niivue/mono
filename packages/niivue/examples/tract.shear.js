import NiiVue, { SHOW_RENDER } from '../src/index.ts'

// Live demo for https://github.com/niivue/mono/issues/451 (see About).
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
const updateSlab = () => {
  slabSlide.disabled = !slabCheck.checked
  slabLabel.textContent = `${slabSlide.value} mm`
  nv1.meshThicknessOn2D = slabCheck.checked ? Number(slabSlide.value) : Infinity
}
slabCheck.onchange = updateSlab
slabSlide.oninput = updateSlab
xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.1
}
radioCheck.onclick = function () {
  nv1.isRadiological = this.checked
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
  webgpuCheck.checked = nv1.backend === 'webgpu'
}
aboutBtn.onclick = () => {
  window.alert(
    'The volume was acquired about 10 degrees oblique, so its voxel planes ' +
      'tilt in world space. Slab limits the streamlines on 2D slices to those ' +
      'within that distance of the displayed slice. Clicking within a slice ' +
      'keeps the same slice, so the streamlines shown should not change. ' +
      'See niivue/mono issue #451.',
  )
}
const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  showRender: SHOW_RENDER.ALWAYS,
})
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
webgpuCheck.checked = nv1.backend === 'webgpu'
sliceType.onchange()
updateSlab()
await nv1.loadVolumes([{ url: '/volumes/fs/T1_oblique.nii.gz' }])
await nv1.loadMeshes([
  {
    url: '/meshes/TR_S_R.tt.gz',
    tractOptions: {
      fiberRadius: 0.5,
      colorBy: 'fixed',
      fixedColor: [0, 255, 255, 255],
    },
  },
])
