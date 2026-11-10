import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const meshSelect = document.getElementById('meshSelect')
const saveBtn = document.getElementById('saveBtn')
const shaderSelect = document.getElementById('shaderSelect')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
const parseNames = (input) => {
  if (!input || input === 'none') return []
  return input
    .split('+')
    .map((n) => n.trim())
    .filter(Boolean)
}
meshSelect.onchange = async () => {
  if (meshSelect.value === 'none') {
    await nv1.loadMeshes([])
    return
  }
  const names = parseNames(meshSelect.value)
  const meshList = names.map((n) => ({
    url: `/meshes/${n}.mz3`,
  }))
  await nv1.loadMeshes(meshList)
}
shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
saveBtn.onclick = () => {
  nv1.saveMesh(0, `myMesh.mz3`)
}
const nv1 = new NiiVue({ backgroundColor: [0.5, 0.3, 0.7, 1] })
await nv1.attachToCanvas(gl1)
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
meshSelect.onchange()
