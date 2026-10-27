import NiiVue from '../src/index.ts'

// Live demo for https://github.com/niivue/mono/issues/92: a T1 acquired
// ~10 degrees oblique with its left mid-thickness surface in world space.
// 2D slices follow the volume's voxel plane while the crosscut follows
// world-aligned planes, so the contour shifts as the slice moves.
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
shaderSelect.onchange = () => {
  nv1.setMesh(0, { shaderType: shaderSelect.value })
}
sliceShaderSelect.onchange = () => {
  nv1.setMesh(0, { sliceShaderType: sliceShaderSelect.value })
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
aboutBtn.onclick = () => {
  window.alert(
    'The volume has a ~10 degree oblique voxel grid; the surface is in ' +
      'world (scanner RAS) space. A 2D slice samples the voxel plane, but the ' +
      'crosscut ribbon cuts the mesh with world-aligned planes, so the contour ' +
      'drifts against the anatomy as you move through slices. See niivue/mono ' +
      'issue #92.',
  )
}
const nv1 = new NiiVue({ backgroundColor: [0, 0, 0.1, 1] })
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
const addShaderOption = (select, value, text) => {
  const option = document.createElement('option')
  option.value = value
  option.textContent = text
  select.appendChild(option)
}
addShaderOption(sliceShaderSelect, '', 'Same as render')
for (const shader of nv1.meshShaders) {
  const text = shader.charAt(0).toUpperCase() + shader.slice(1)
  addShaderOption(shaderSelect, shader, text)
  addShaderOption(sliceShaderSelect, shader, text)
}
shaderSelect.value = 'phong'
sliceShaderSelect.value = 'crosscut'
nv1.sliceType = parseInt(sliceType.value, 10)
await nv1.loadVolumes([{ url: '/volumes/fs/T1_oblique.nii.gz' }])
await nv1.loadMeshes([
  {
    url: '/meshes/fs/T1_oblique.lh.mid.mz3',
    color: [0.3, 0.6, 1.0, 1],
    shaderType: 'phong',
    sliceShaderType: 'crosscut',
  },
])
// A scanner-RAS point through the left cortex.
nv1.setCrosshairPos([-26.2, 12.9, 18.3])
// Always show the 3D render panel (SHOW_RENDER.ALWAYS).
nv1.showRender = 1
// Sagittal clip plane cuts into the volume to expose the left surface.
nv1.setClipPlane([0.2, 270, 0])
nv1.clipPlaneColor = [1, 0, 0, -0.2]
