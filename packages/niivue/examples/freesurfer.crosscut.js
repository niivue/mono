import NiiVue from '../src/index.ts'

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
// Line width applies only to the crosscut shaders.
const updateWidthSlider = () => {
  const isCrosscut = (s) => s.startsWith('crosscut')
  widthSlider.disabled = !(
    isCrosscut(shaderSelect.value) || isCrosscut(sliceShaderSelect.value)
  )
}
widthSlider.oninput = () => {
  nv1.meshCrosscutWidth = Number(widthSlider.value)
}
// Render-view mesh shader: drives the 3D panel (and slices when the slice
// shader is left at "Inherit").
shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
  updateWidthSlider()
}
// Slice-view mesh shader: an independent override for 2D slices. '' (Inherit)
// yokes slices to the render shader; 'crosscut' draws crosshair-aligned ribbons
// on slices while the render panel keeps its own shader.
sliceShaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { sliceShaderType: sliceShaderSelect.value })
  updateWidthSlider()
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
  webgpuCheck.checked = nv1.backend === 'webgpu'
}
const nv1 = new NiiVue({ backgroundColor: [0, 0, 0.1, 1] })
await nv1.attachToCanvas(gl1)
webgpuCheck.checked = nv1.backend === 'webgpu'
// Render-shader menu: all available mesh shaders; default to Phong (good in 3D).
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
shaderSelect.value = 'phong'
// Slice-shader menu: same shaders plus a "Same as render" ('') entry that
// yokes the slice view to the render shader.
const inheritOption = document.createElement('option')
inheritOption.value = ''
inheritOption.textContent = 'Same as render'
sliceShaderSelect.appendChild(inheritOption)
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  sliceShaderSelect.appendChild(option)
}
sliceShaderSelect.value = 'crosscut'
updateWidthSlider()
await nv1.loadVolumes([{ url: '/volumes/fs/brainmask.mgz' }])
await nv1.loadMeshes([
  {
    url: '/meshes/fs/rh.pial',
    color: [0.1, 1.0, 0.1, 1],
    // Phong in the 3D render panel, crosscut ribbons on the 2D slices.
    shaderType: 'phong',
    sliceShaderType: 'crosscut',
  },
])
nv1.setClipPlane([0.0, 180, 20])
nv1.clipPlaneColor = [1, 0, 0, -0.2]
// Always show the 3D render panel (SHOW_RENDER.ALWAYS).
nv1.showRender = 1
